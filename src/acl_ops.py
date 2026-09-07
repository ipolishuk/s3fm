"""Object ACL helpers, caches, and batch-job builders."""

from __future__ import annotations

import os
import threading
import time
from operator import itemgetter

from botocore.exceptions import ClientError
from flask import session

from bucket_access import (
    check_bucket_access as _check_bucket_access,
    find_bucket_config_by_bucket_id,
    normalize_s3_object_key as _normalize_s3_object_key,
)
from file_ops import _job_cancelled_event
from logs import LOG_CONFIG, log_error, log_s3_exception, log_warning
from roles import role_edit_file_acl
from s3_client import get_s3_client as _get_s3_client, _map_s3_client_error
from translations import _

S3_GROUP_ALL_USERS_URI = 'http://acs.amazonaws.com/groups/global/AllUsers'
S3_GROUP_AUTHENTICATED_USERS_URI = 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'
S3_ACL_PERMISSIONS = frozenset({
    'READ', 'WRITE', 'READ_ACP', 'WRITE_ACP', 'FULL_CONTROL',
})

_acl_put_probe_cache = {}
_acl_put_probe_cache_lock = threading.Lock()
_acl_read_cache = {}
_acl_read_cache_lock = threading.Lock()


def _trf(key, **kwargs):
    text = _(key)
    for k, v in kwargs.items():
        text = text.replace('{' + str(k) + '}', str(v))
    return text


def _format_s3_acl_grantee(grantee: dict) -> str:
    if not grantee:
        return '—'
    gtype = grantee.get('Type', '')
    if gtype == 'Group':
        uri = grantee.get('URI', '')
        if 'AllUsers' in uri:
            return 'AllUsers'
        if 'AuthenticatedUsers' in uri:
            return 'AuthenticatedUsers'
        return uri or gtype
    name = (grantee.get('DisplayName') or '').strip()
    if name:
        return name
    ident = (grantee.get('ID') or '').strip()
    return ident or gtype or '—'


def _grantee_to_api(grantee: dict) -> dict:
    gtype = grantee.get('Type', '')
    if gtype == 'Group':
        uri = (grantee.get('URI') or '').strip()
        if S3_GROUP_ALL_USERS_URI in uri or uri.endswith('/AllUsers'):
            preset = 'all_users'
        elif S3_GROUP_AUTHENTICATED_USERS_URI in uri or uri.endswith('/AuthenticatedUsers'):
            preset = 'authenticated_users'
        else:
            preset = 'group_uri'
        return {
            'grantee_type': 'Group',
            'grantee_preset': preset,
            'grantee_uri': uri,
            'grantee_id': '',
            'grantee_label': _format_s3_acl_grantee(grantee),
        }
    return {
        'grantee_type': 'CanonicalUser',
        'grantee_preset': 'canonical_user',
        'grantee_uri': '',
        'grantee_id': (grantee.get('ID') or '').strip(),
        'grantee_label': _format_s3_acl_grantee(grantee),
    }


def _grantee_from_api(item: dict) -> dict:
    preset = (item.get('grantee_preset') or '').strip()
    if preset == 'all_users':
        return {'Type': 'Group', 'URI': S3_GROUP_ALL_USERS_URI}
    if preset == 'authenticated_users':
        return {'Type': 'Group', 'URI': S3_GROUP_AUTHENTICATED_USERS_URI}
    if preset == 'group_uri':
        uri = (item.get('grantee_uri') or '').strip()
        if not uri:
            raise ValueError('grantee_uri required')
        return {'Type': 'Group', 'URI': uri}
    grantee = {'Type': 'CanonicalUser'}
    gid = (item.get('grantee_id') or '').strip()
    if not gid:
        raise ValueError('grantee_id required')
    grantee['ID'] = gid
    return grantee


def _resolve_acl_owner_id_from_grants(grants: list) -> str:
    """Canonical ID владельца из грантов ACL (MinIO часто не отдаёт Owner.ID)."""
    fallback = ''
    for item in grants or []:
        grantee = item.get('Grantee') or {}
        if grantee.get('Type') != 'CanonicalUser':
            continue
        gid = (grantee.get('ID') or '').strip()
        if not gid:
            continue
        perm = (item.get('Permission') or '').strip()
        if perm == 'FULL_CONTROL':
            return gid
        if not fallback:
            fallback = gid
    return fallback


def _fetch_bucket_acl_owner_id(s3_client, bucket_name: str) -> str:
    try:
        acl = s3_client.get_bucket_acl(Bucket=bucket_name)
        return ((acl.get('Owner') or {}).get('ID') or '').strip()
    except Exception:
        return ''


def _resolve_acl_owner_fields(owner: dict, grants: list, s3_client=None, bucket_name: str = '') -> dict:
    owner_id = (owner.get('ID') or owner.get('id') or '').strip()
    if not owner_id:
        owner_id = _resolve_acl_owner_id_from_grants(grants)
    if not owner_id and s3_client and bucket_name:
        owner_id = _fetch_bucket_acl_owner_id(s3_client, bucket_name)
    display = (owner.get('DisplayName') or owner.get('display_name') or '').strip()
    if not display:
        display = owner_id or '—'
    return {'id': owner_id, 'display_name': display}


def _acl_policy_from_api_payload(owner: dict, grants: list) -> dict:
    owner_id = (owner.get('id') or owner.get('ID') or '').strip()
    if not owner_id:
        raise ValueError('owner id required')
    owner_out = {'ID': owner_id}
    if (owner.get('display_name') or '').strip():
        owner_out['DisplayName'] = owner['display_name'].strip()

    s3_grants = []
    for raw in grants or []:
        if not isinstance(raw, dict):
            continue
        perm = (raw.get('permission') or '').strip().upper()
        if perm not in S3_ACL_PERMISSIONS:
            raise ValueError(f'invalid permission: {perm}')
        s3_grants.append({
            'Grantee': _grantee_from_api(raw),
            'Permission': perm,
        })
    return {'Owner': owner_out, 'Grants': s3_grants}


def _grantee_to_grant_header_value(grantee: dict) -> str:
    gtype = grantee.get('Type', '')
    if gtype == 'Group':
        uri = (grantee.get('URI') or '').strip()
        return f'uri={uri}' if uri else ''
    if gtype == 'CanonicalUser':
        gid = (grantee.get('ID') or '').strip()
        return f'id={gid}' if gid else ''
    email = (grantee.get('EmailAddress') or '').strip()
    if email:
        return f'email={email}'
    return ''


def _acl_policy_to_grant_headers(acl_policy: dict) -> dict:
    """Параметры Grant* для put_object_acl (без AccessControlPolicy)."""
    perm_to_param = {
        'FULL_CONTROL': 'GrantFullControl',
        'READ': 'GrantRead',
        'WRITE': 'GrantWrite',
        'READ_ACP': 'GrantReadACP',
        'WRITE_ACP': 'GrantWriteACP',
    }
    grouped = {param: [] for param in perm_to_param.values()}
    for item in acl_policy.get('Grants') or []:
        perm = (item.get('Permission') or '').strip()
        param = perm_to_param.get(perm)
        if not param:
            continue
        value = _grantee_to_grant_header_value(item.get('Grantee') or {})
        if value:
            grouped[param].append(value)
    kwargs = {}
    for param, values in grouped.items():
        if values:
            kwargs[param] = ','.join(values)
    return kwargs


def _grant_signature(acl_policy: dict) -> frozenset:
    sig = set()
    owner_id = ((acl_policy.get('Owner') or {}).get('ID') or '').strip()
    for item in acl_policy.get('Grants') or []:
        grantee = item.get('Grantee') or {}
        perm = (item.get('Permission') or '').strip()
        gtype = grantee.get('Type', '')
        if gtype == 'Group':
            key = ('G', grantee.get('URI', ''), perm)
        elif gtype == 'CanonicalUser':
            gid = (grantee.get('ID') or '').strip()
            key = ('C', gid, perm)
        else:
            continue
        sig.add(key)
    return frozenset(sig)


def _detect_canned_acl(acl_policy: dict) -> str:
    """Стандартные canned ACL, если набор грантов им соответствует."""
    owner_id = ((acl_policy.get('Owner') or {}).get('ID') or '').strip()
    if not owner_id:
        return ''
    sig = _grant_signature(acl_policy)
    owner_fc = frozenset({('C', owner_id, 'FULL_CONTROL')})
    public_read = owner_fc | {('G', S3_GROUP_ALL_USERS_URI, 'READ')}
    private = owner_fc | {
        ('C', owner_id, 'READ'),
        ('C', owner_id, 'READ_ACP'),
        ('C', owner_id, 'WRITE_ACP'),
    }
    auth_read = owner_fc | {('G', S3_GROUP_AUTHENTICATED_USERS_URI, 'READ')}
    if sig == public_read:
        return 'public-read'
    if sig == auth_read:
        return 'authenticated-read'
    if sig == owner_fc or sig == private:
        return 'private'
    return ''


def _put_object_acl_s3(s3_client, bucket_name: str, key: str, acl_policy: dict) -> None:
    """Применить ACL: canned → Grant* → AccessControlPolicy."""
    attempts = []
    canned = _detect_canned_acl(acl_policy)
    if canned:
        attempts.append({'ACL': canned})
    grant_headers = _acl_policy_to_grant_headers(acl_policy)
    if grant_headers:
        attempts.append(grant_headers)
    attempts.append({'AccessControlPolicy': acl_policy})

    last_error = None
    for extra in attempts:
        try:
            s3_client.put_object_acl(Bucket=bucket_name, Key=key, **extra)
            return
        except ClientError as e:
            last_error = e
            code = e.response.get('Error', {}).get('Code', '')
            if code in ('AccessDenied', 'InvalidArgument', 'MalformedACLError'):
                continue
            raise
    if last_error:
        raise last_error


def _ensure_owner_full_control_in_policy(acl_policy: dict) -> dict:
    """S3 требует, чтобы владелец объекта имел FULL_CONTROL в ACL."""
    owner_id = ((acl_policy.get('Owner') or {}).get('ID') or '').strip()
    if not owner_id:
        return acl_policy
    grants = list(acl_policy.get('Grants') or [])
    owner_grantee = {'Type': 'CanonicalUser', 'ID': owner_id}
    for item in grants:
        grantee = item.get('Grantee') or {}
        if (
            grantee.get('Type') == 'CanonicalUser'
            and (grantee.get('ID') or '').strip() == owner_id
            and (item.get('Permission') or '').strip() == 'FULL_CONTROL'
        ):
            return acl_policy
    grants.insert(0, {'Grantee': owner_grantee, 'Permission': 'FULL_CONTROL'})
    acl_policy['Grants'] = grants
    return acl_policy


def _apply_object_acl_from_grants(s3_client, bucket_name, bucket_id, file_path, grants_raw):
    """Применить ACL к одному объекту; обновить кэш. ClientError/ValueError наружу."""
    current_acl = s3_client.get_object_acl(Bucket=bucket_name, Key=file_path)
    owner_fields = _resolve_acl_owner_fields(
        current_acl.get('Owner') or {},
        current_acl.get('Grants') or [],
        None,
        '',
    )
    if not owner_fields.get('id'):
        raise ValueError(_trf('files.info_acl_owner_missing'))

    acl_policy = _acl_policy_from_api_payload(owner_fields, grants_raw)
    acl_policy = _ensure_owner_full_control_in_policy(acl_policy)
    _put_object_acl_s3(s3_client, bucket_name, file_path, acl_policy)

    acl_data, acl_error = _fetch_object_acl_payload(s3_client, bucket_name, file_path)
    _invalidate_cached_object_acl(bucket_id, file_path)
    if acl_data is not None or acl_error:
        _store_cached_object_acl(bucket_id, file_path, {
            'acl': acl_data,
            'acl_error': acl_error,
            'acl_readable': bool(acl_data and not acl_error),
        })
    return acl_data, acl_error


def _map_acl_put_client_error(e, bucket_display=''):
    error = getattr(e, 'response', {}).get('Error', {}) if e else {}
    error_code = error.get('Code', '')
    name = bucket_display or 'bucket'
    if error_code in ('AccessControlListNotSupported', 'AccessDenied', 'AllAccessDisabled'):
        if error_code == 'AccessControlListNotSupported':
            return _trf('files.info_acl_not_supported', name=name), 403
        return _trf('files.info_acl_put_denied', name=name), 403
    return _map_s3_client_error(e, bucket_display)


def _bucket_object_acls_writable(s3_client, bucket_name: str) -> bool:
    """False только если ACL на бакете явно отключены (BucketOwnerEnforced)."""
    try:
        resp = s3_client.get_bucket_ownership_controls(Bucket=bucket_name)
        for rule in resp.get('OwnershipControlsRules') or []:
            if rule.get('ObjectOwnership') == 'BucketOwnerEnforced':
                return False
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code == 'AccessControlListNotSupported':
            return False
        # Нет прав на API ownership / MinIO без API — не блокируем редактирование ACL
    except Exception:
        pass
    return True


def _acl_put_probe_enabled() -> bool:
    """Живая проба PutObjectAcl — только при ACL_PUT_PROBE=1."""
    return os.environ.get('ACL_PUT_PROBE', '').strip().lower() in ('1', 'true', 'yes')


def _can_put_object_acl_for_edit(
    s3_client, bucket_name: str, bucket_id: str, key: str, raw_acl: dict,
) -> bool:
    """
    Можно ли предлагать редактирование ACL: ACL читается, на бакете не BucketOwnerEnforced,
    и (по умолчанию) успешная проба put_object_acl с кэшем на bucket_id.
    ACL_PUT_PROBE=0 — только проверка бакета без пробы (как раньше).
    """
    if not raw_acl:
        return False
    if not _bucket_object_acls_writable(s3_client, bucket_name):
        return False
    if not _acl_put_probe_enabled():
        return True
    return _cached_probe_s3_put_object_acl(s3_client, bucket_name, bucket_id, key, raw_acl)


def _acl_policy_from_s3_acl(raw_acl: dict, owner_fields: dict) -> dict:
    owner_out = {'ID': owner_fields['id']}
    if (owner_fields.get('display_name') or '').strip():
        dn = owner_fields['display_name'].strip()
        if dn != '—':
            owner_out['DisplayName'] = dn
    return {
        'Owner': owner_out,
        'Grants': list(raw_acl.get('Grants') or []),
    }


def _probe_s3_put_object_acl(s3_client, bucket_name: str, key: str, raw_acl: dict) -> bool:
    """Проверка s3:PutObjectAcl: повторная запись текущего ACL без изменений."""
    if not _bucket_object_acls_writable(s3_client, bucket_name):
        return False
    owner_fields = _resolve_acl_owner_fields(
        raw_acl.get('Owner') or {},
        raw_acl.get('Grants') or [],
        None,
        '',
    )
    if not owner_fields.get('id'):
        return False
    try:
        policy = _ensure_owner_full_control_in_policy(
            _acl_policy_from_s3_acl(raw_acl, owner_fields),
        )
        _put_object_acl_s3(s3_client, bucket_name, key, policy)
        return True
    except ClientError:
        return False


def _acl_put_probe_cache_ttl() -> int:
    return int(os.environ.get('ACL_PUT_PROBE_CACHE_TTL', '300'))


def _ensure_acl_put_probe_cache():
    return


def _peek_cached_put_object_acl(bucket_id: str):
    """Результат пробы PutObjectAcl из кэша или None, если кэша нет."""
    ttl = _acl_put_probe_cache_ttl()
    with _acl_put_probe_cache_lock:
        cached = _acl_put_probe_cache.get(bucket_id)
        if cached and time.time() - cached[1] < ttl:
            return cached[0]
    return None


def _cached_probe_s3_put_object_acl(
    s3_client, bucket_name: str, bucket_id: str, key: str, raw_acl: dict,
) -> bool:
    peeked = _peek_cached_put_object_acl(bucket_id)
    if peeked is not None:
        return peeked
    allowed = _probe_s3_put_object_acl(s3_client, bucket_name, key, raw_acl)
    with _acl_put_probe_cache_lock:
        _acl_put_probe_cache[bucket_id] = (allowed, time.time())
    return allowed


def _acl_read_cache_ttl() -> int:
    try:
        return max(10, int(os.environ.get('ACL_READ_CACHE_TTL', '90')))
    except ValueError:
        return 90


def _ensure_acl_read_cache():
    return


def _acl_read_cache_key(bucket_id: str, file_path: str) -> str:
    return f'{bucket_id}\0{file_path}'


def _peek_cached_object_acl(bucket_id: str, file_path: str):
    key = _acl_read_cache_key(bucket_id, file_path)
    ttl = _acl_read_cache_ttl()
    with _acl_read_cache_lock:
        cached = _acl_read_cache.get(key)
        if cached and time.time() - cached[1] < ttl:
            return cached[0]
        _acl_read_cache.pop(key, None)
    return None


def _store_cached_object_acl(bucket_id: str, file_path: str, payload: dict):
    key = _acl_read_cache_key(bucket_id, file_path)
    with _acl_read_cache_lock:
        _acl_read_cache[key] = (payload, time.time())


def _invalidate_cached_object_acl(bucket_id: str, file_path: str):
    key = _acl_read_cache_key(bucket_id, file_path)
    with _acl_read_cache_lock:
        _acl_read_cache.pop(key, None)


def _object_acl_payload_from_raw(
    s3_client, bucket_name: str, acl: dict, *, resolve_bucket_owner: bool = True,
) -> tuple:
    """Разобрать ответ get_object_acl в (acl_dict | None, error_message | None)."""
    owner = acl.get('Owner') or {}
    raw_grants = acl.get('Grants') or []
    if resolve_bucket_owner:
        owner_fields = _resolve_acl_owner_fields(owner, raw_grants, s3_client, bucket_name)
    else:
        owner_fields = _resolve_acl_owner_fields(owner, raw_grants, None, '')
    grants = []
    for item in raw_grants:
        grantee_api = _grantee_to_api(item.get('Grantee') or {})
        grants.append({
            'permission': (item.get('Permission') or '').strip(),
            'grantee_label': grantee_api['grantee_label'],
            **grantee_api,
        })
    return {
        'owner': owner_fields,
        'grants': grants,
    }, None


def _fetch_object_acl_payload(s3_client, bucket_name: str, key: str) -> tuple:
    """Вернуть (acl_dict | None, error_message | None)."""
    try:
        acl = s3_client.get_object_acl(Bucket=bucket_name, Key=key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('AccessDenied', 'AllAccessDisabled'):
            return None, _trf('files.info_acl_denied')
        msg = e.response.get('Error', {}).get('Message') or str(e)
        return None, msg
    except Exception as e:
        return None, str(e)
    return _object_acl_payload_from_raw(s3_client, bucket_name, acl)


def _metadata_acl_capability_flags(s3_client, bucket_name: str, bucket_id: str) -> tuple:
    """Быстрая проверка кнопки «Редактировать» без get_object_acl."""
    if not role_edit_file_acl(bucket_id):
        return False, False
    peeked = _peek_cached_put_object_acl(bucket_id)
    if peeked is not None:
        return True, peeked
    return True, _bucket_object_acls_writable(s3_client, bucket_name)


def _build_acl_batch_job(data):
    bucket_id = (data.get('bucket') or data.get('bucket_id') or '').strip()
    raw_paths = data.get('paths') or []
    grants_raw = data.get('grants')

    if not bucket_id:
        return None, (_('error.bucket_id_required'), 400, {})
    if not isinstance(raw_paths, list) or not raw_paths:
        return None, (_('error.object_path_required'), 400, {})
    if not isinstance(grants_raw, list):
        return None, (_('files.info_acl_grants_invalid'), 400, {})

    if not role_edit_file_acl(bucket_id):
        return None, (_('error.acl_access_denied'), 403, {})

    bucket_info = find_bucket_config_by_bucket_id(bucket_id)
    if not bucket_info:
        return None, (_('error.bucket_not_found'), 404, {})

    if not _check_bucket_access(bucket_id):
        return None, (_('error.acl_access_denied'), 403, {})

    normalized_paths = []
    for raw_path in raw_paths:
        path = _normalize_s3_object_key(str(raw_path or '').strip())
        if not path or path.endswith('/'):
            continue
        normalized_paths.append(path)

    if not normalized_paths:
        return None, (_('error.object_path_required'), 400, {})

    bucket_config = bucket_info['bucket_config']
    return {
        'bucket_id': bucket_id,
        'bucket_name': bucket_config.get('bucket_name'),
        'display_name': bucket_info['display_name'],
        's3_client': _get_s3_client(bucket_config),
        'paths': normalized_paths,
        'grants': grants_raw,
        'username': session.get('username', 'unknown'),
    }, None


def _iter_acl_batch_events(batch_job, context, cancel_check=None):
    paths = batch_job['paths']
    total = len(paths)
    yield {'type': 'start', 'total': total, 'item_count': total}

    applied_count = 0
    errors = []
    for index, path in enumerate(paths):
        if cancel_check and cancel_check():
            yield _job_cancelled_event(current=applied_count, total=total, applied=applied_count)
            return
        yield {'type': 'item_start', 'index': index}
        try:
            _apply_object_acl_from_grants(
                batch_job['s3_client'],
                batch_job['bucket_name'],
                batch_job['bucket_id'],
                path,
                batch_job['grants'],
            )
            applied_count += 1
            yield {'type': 'progress', 'current': index + 1, 'total': total, 'item_index': index}
            yield {'type': 'item_done', 'index': index, 'success': True}
        except ClientError as e:
            log_s3_exception(context, e, batch_job['display_name'])
            errors.append(f"{path}: {e.response.get('Error', {}).get('Code', 'Error')}")
            yield {'type': 'item_done', 'index': index, 'success': False}
        except ValueError as e:
            errors.append(f"{path}: {str(e)}")
            yield {'type': 'item_done', 'index': index, 'success': False}
        except Exception as e:
            log_error('ACL batch item failed', context, e, LOG_CONFIG['show_traceback'])
            errors.append(f"{path}: {str(e)}")
            yield {'type': 'item_done', 'index': index, 'success': False}

    yield {
        'type': 'done',
        'applied': applied_count,
        'total': total,
        'errors': errors,
    }


