"""Helpers shared by settings API handlers."""

from __future__ import annotations

import re

from flask import session

from auth_session import (
    bucket_roles_map_from_user as _bucket_roles_map_from_user,
    session_allowed_list as _session_allowed_list,
)
from users import sync_logged_in_session_from_db
from buckets import canonicalize_bucket_roles_map
from db import (
    bucket_s3_target_exists,
    get_cloud_row,
    get_role,
    get_user,
    list_buckets_rows,
    list_roles,
    update_user,
)
from logs import log_info, log_warning
from roles import (
    ROLE_ADMIN,
    ROLE_STORAGE_ADMIN,
    ROLE_STORAGE_VIEWER,
    VALID_ROLES,
    is_reserved_role_name,
    KNOWN_PERMISSION_IDS,
    normalize_role_name,
    role_add_bucket,
)
from security import validate_endpoint_url


def _session_accessible_buckets():
    from bucket_access import _build_session_accessible_buckets
    return _build_session_accessible_buckets(False)


_ROLE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _normalize_role_permissions(raw):
    if not isinstance(raw, list):
        return []
    known = set(KNOWN_PERMISSION_IDS)
    return sorted(p for p in raw if p in known)


def _role_valid_for_user(role):
    """Роль существует в таблице roles или входит во встроенный набор admin/storage_*."""
    if not role:
        return False
    if is_reserved_role_name(role):
        return False
    role = normalize_role_name(role)
    if role in VALID_ROLES:
        return True
    return get_role(role) is not None


def _is_bucket_access_assignable_role(role):
    """В ACL бакета можно назначать только роли storage_*."""
    role = normalize_role_name(role or '')
    if not role.startswith('storage_'):
        return False
    return _role_valid_for_user(role)


def _normalize_bucket_access_role(role):
    """Роль для назначения новому пользователю в ACL (не admin)."""
    role = normalize_role_name(role or '')
    if role == ROLE_ADMIN or not role:
        return ROLE_STORAGE_ADMIN
    if role.startswith('storage_') and _role_valid_for_user(role):
        return role
    return ROLE_STORAGE_VIEWER


def _roles_for_bucket_access():
    """Список ролей для dropdown ACL бакета — только storage_*."""
    return [
        {'id': r['name']}
        for r in list_roles()
        if _is_bucket_access_assignable_role(r.get('name'))
    ]


def _parse_user_email_field(data):
    """email из JSON: None — очистить; False — некорректный формат."""
    if not isinstance(data, dict) or 'email' not in data:
        return None
    raw = data.get('email')
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if '@' not in s or '.' not in s.rsplit('@', 1)[-1]:
        return False
    return s


def _dt_iso(value):
    if value is None:
        return None
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    s = str(value).strip()
    return s or None


def _normalize_bucket_roles_payload(raw):
    if raw is None:
        return None
    grants = {}
    if isinstance(raw, dict):
        grants = {
            str(k).strip(): str(v).strip()
            for k, v in raw.items()
            if str(k).strip() and str(v).strip()
        }
    elif isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            bid = (item.get('bucket_id') or item.get('bucket') or '').strip()
            role = (item.get('role') or item.get('role_name') or '').strip()
            if bid and role:
                grants[bid] = role
    else:
        return []
    canonical = canonicalize_bucket_roles_map(grants)
    return [{'bucket_id': k, 'role': v} for k, v in canonical.items()]


def _validate_bucket_roles_list(bucket_roles):
    """Проверяет, что все роли в grants существуют в БД."""
    if bucket_roles is None:
        return True
    if not isinstance(bucket_roles, list):
        return False
    for item in bucket_roles:
        if not isinstance(item, dict):
            return False
        role = (item.get('role') or '').strip()
        if role and not _role_valid_for_user(role):
            return False
    return True


def _can_add_bucket():
    """Admin / storage_admin или право add_bucket у роли по умолчанию."""
    if session.get('role') == ROLE_ADMIN:
        return True
    if session.get('role') == ROLE_STORAGE_ADMIN:
        return True
    return role_add_bucket()


def _is_settings_admin():
    return session.get('role') == ROLE_ADMIN


def _can_open_settings():
    """Полный admin или пользователь с правом добавлять бакеты (Settings → Buckets)."""
    return _is_settings_admin() or _can_add_bucket()


def _settings_buckets_only():
    """Не-admin видит только вкладку бакетов."""
    return _can_open_settings() and not _is_settings_admin()


def _current_username():
    return (session.get('username') or '').strip()


def _is_bucket_creator(row):
    if not row:
        return False
    creator = (row.get('created_by') or '').strip()
    user = _current_username()
    if not creator or not user:
        return False
    return creator.lower() == user.lower()


def _can_manage_bucket_row(row):
    """Смотреть/менять настройки бакета: admin или создатель."""
    if _is_settings_admin():
        return True
    return _is_bucket_creator(row)


def _can_manage_bucket_access(row):
    """ACL пользователей бакета: global admin или создатель с правом add_bucket."""
    if _is_settings_admin():
        return True
    if not row or not _can_add_bucket():
        return False
    return _can_manage_bucket_row(row)


def _session_allowed_cloud_ids():
    clouds = _session_allowed_list(session.get('allowed_clouds', []))
    if '*' in clouds:
        return None
    return set(clouds)


def _filter_items_by_allowed_clouds(items, cloud_key='cloud_id'):
    allowed = _session_allowed_cloud_ids()
    if allowed is None:
        return items
    return [
        item for item in items
        if (item.get(cloud_key) or item.get('id') or '') in allowed
    ]


def _accessible_bucket_ids():
    ids = set()
    for bucket in _session_accessible_buckets():
        bid = (bucket.get('bucket_id') or '').strip()
        if bid:
            ids.add(bid)
    return ids


def _list_buckets_for_add_form():
    """Список бакетов для Settings → Buckets: admin — все, иначе только созданные текущим пользователем."""
    if _is_settings_admin():
        return list_buckets_rows()
    username = _current_username().lower()
    if not username:
        return []
    items = []
    for row in list_buckets_rows():
        creator = (row.get('created_by') or '').strip().lower()
        if creator == username:
            items.append(row)
    return items


def _resolve_bucket_form_endpoint_url(cloud_id, endpoint_url):
    resolved = (endpoint_url or '').strip()
    if resolved:
        return resolved
    cloud_row = get_cloud_row(cloud_id)
    cloud_endpoint = (cloud_row or {}).get('endpoint_url')
    if isinstance(cloud_endpoint, list):
        return (cloud_endpoint[0] if cloud_endpoint else '').strip()
    return str(cloud_endpoint or '').strip()


def _validate_bucket_endpoint_for_form(cloud_id, endpoint_url, *, is_admin):
    cid = (cloud_id or '').strip()
    ep = (endpoint_url or '').strip()
    if not ep:
        return 'error.endpoint_url_required'
    ok, err_key = validate_endpoint_url(
        ep,
        cloud_id=cid,
        require_allowlist=not is_admin,
    )
    if not ok:
        return err_key
    if not is_admin and not get_cloud_row(cid):
        return 'error.cloud_not_registered'
    # Не требуем cloud в allowed_clouds сессии: форма бакета показывает весь каталог,
    # доступ к облаку выдаётся создателю через _grant_created_bucket_to_current_user.
    return None


def _validate_bucket_create_payload(cloud_id, bucket_name, endpoint_url, *, is_admin):
    err = _validate_bucket_endpoint_for_form(cloud_id, endpoint_url, is_admin=is_admin)
    if err:
        return err
    if bucket_s3_target_exists((bucket_name or '').strip(), (endpoint_url or '').strip()):
        return 'error.bucket_s3_target_exists'
    return None


def _validate_bucket_update_s3_target(bucket_name, endpoint_url, *, exclude_cloud_id, exclude_display_name):
    """Как при создании: нельзя перевести запись на уже зарегистрированный S3-бакет."""
    if bucket_s3_target_exists(
        (bucket_name or '').strip(),
        (endpoint_url or '').strip(),
        exclude_cloud_id=exclude_cloud_id,
        exclude_display_name=exclude_display_name,
    ):
        return 'error.bucket_s3_target_exists'
    return None


def _grant_created_bucket_to_current_user(bucket_id, cloud_id):
    """После создания бакета — выдать создателю доступ с его дефолтной ролью.

    Добавляет bucket_id (и cloud_id при необходимости) в ACL пользователя и
    пишет grant в user_roles с users.role. Admin с полным доступом ('*') пропускается.
    """
    username = (session.get('username') or '').strip()
    bid = (bucket_id or '').strip()
    cid = (cloud_id or '').strip()
    if not username or not bid:
        return False
    user = get_user(username)
    if not user:
        log_warning(f'Cannot grant created bucket {bid}: user {username} not found', 'grant_created_bucket')
        return False

    role = (user.get('role') or session.get('role') or '').strip()
    ok = grant_user_bucket_access(username, bid, cloud_id=cid, role=role, skip_wildcard=True)
    if not ok:
        return False
    sync_logged_in_session_from_db()
    log_info(f'Granted bucket {bid} to {username} with role {role or "(default)"}', 'grant_created_bucket')
    return True


def grant_user_bucket_access(username, bucket_id, cloud_id=None, role=None, skip_wildcard=False):
    """Выдать пользователю доступ к бакету (ACL + user_roles).

    skip_wildcard=True — не добавлять grant пользователям с buckets=['*']
    (но cloud_id при необходимости всё равно добавляется).
    Возвращает True, если запись обновлена.
    """
    username = (username or '').strip()
    bid = (bucket_id or '').strip()
    cid = (cloud_id or '').strip()
    if not username or not bid:
        return False
    user = get_user(username)
    if not user:
        return False

    default_role = (user.get('role') or '').strip()
    grant_role = (role or '').strip() or default_role
    if grant_role and not _role_valid_for_user(grant_role):
        return False

    buckets = list(_session_allowed_list(user.get('allowed_buckets', [])))
    clouds = list(_session_allowed_list(user.get('allowed_clouds', [])))
    email = user.get('email')
    full_name = user.get('full_name')

    if '*' in buckets:
        changed = False
        if cid and '*' not in clouds and cid not in clouds:
            clouds.append(cid)
            changed = True
        if skip_wildcard:
            if not changed:
                return False
            return update_user(
                username, default_role, buckets, clouds,
                bucket_roles=None, email=email, full_name=full_name,
            )
        grants = dict(_bucket_roles_map_from_user(user))
        if grant_role and grants.get(bid) != grant_role:
            grants[bid] = grant_role
            changed = True
        if not changed:
            return False
        payload = [{'bucket_id': k, 'role': v} for k, v in grants.items()]
        return update_user(
            username, default_role, buckets, clouds,
            bucket_roles=payload, email=email, full_name=full_name,
        )

    changed = False
    if bid not in buckets:
        buckets.append(bid)
        changed = True
    if cid and '*' not in clouds and cid not in clouds:
        clouds.append(cid)
        changed = True

    grants = dict(_bucket_roles_map_from_user(user))
    if grant_role and grants.get(bid) != grant_role:
        grants[bid] = grant_role
        changed = True

    if not changed:
        return False

    payload = [{'bucket_id': k, 'role': v} for k, v in grants.items()]
    return update_user(
        username, default_role, buckets, clouds,
        bucket_roles=payload, email=email, full_name=full_name,
    )


def revoke_user_bucket_access(username, bucket_id):
    """Забрать у пользователя явный доступ к бакету. Wildcard ('*') не трогаем."""
    username = (username or '').strip()
    bid = (bucket_id or '').strip()
    if not username or not bid:
        return False
    user = get_user(username)
    if not user:
        return False

    buckets = list(_session_allowed_list(user.get('allowed_buckets', [])))
    clouds = list(_session_allowed_list(user.get('allowed_clouds', [])))
    if '*' in buckets:
        return False

    changed = False
    if bid in buckets:
        buckets = [b for b in buckets if b != bid]
        changed = True

    grants = dict(_bucket_roles_map_from_user(user))
    if bid in grants:
        del grants[bid]
        changed = True

    if not changed:
        return False

    payload = [{'bucket_id': k, 'role': v} for k, v in grants.items()]
    return update_user(
        username,
        (user.get('role') or '').strip(),
        buckets,
        clouds,
        bucket_roles=payload,
        email=user.get('email'),
        full_name=user.get('full_name'),
    )





