"""Settings API handler implementations (users/roles/buckets/clouds/status)."""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone

from botocore.exceptions import ClientError
from flask import jsonify, request, session

from bucket_access import find_bucket_config_by_bucket_id
from buckets import get_buckets_config, reset_buckets_config_cache
from db import (
    count_buckets_with_cloud,
    count_users_with_role,
    delete_bucket,
    delete_cloud,
    delete_role,
    delete_user,
    ensure_cloud,
    get_bucket_row,
    get_bucket_row_by_id,
    get_cloud_row,
    get_role,
    get_user,
    insert_bucket,
    insert_cloud,
    insert_role,
    insert_user,
    list_bucket_options,
    list_cloud_endpoints,
    list_cloud_rows,
    list_clouds,
    list_endpoints,
    list_roles,
    list_users,
    list_users_for_bucket_access,
    update_bucket,
    update_cloud,
    update_role,
    update_user,
    connection_status as db_connection_status,
    set_bucket_search_index_enabled,
)
import ldap_client
from logs import LOG_CONFIG, log_error, log_info, log_s3_exception, log_user_action, log_warning, trf_en
import meilisearch
from roles import KNOWN_PERMISSION_IDS, ROLE_ADMIN, ROLE_PERMISSIONS, ROLE_STORAGE_VIEWER, is_reserved_role_name
from security import validate_endpoint_url
import sso as sso_module
from translations import _
from settings_helpers import (
    _ROLE_NAME_RE,
    _accessible_bucket_ids,
    _can_add_bucket,
    _can_manage_bucket_access,
    _can_manage_bucket_row,
    _current_username,
    _dt_iso,
    _grant_created_bucket_to_current_user,
    _is_bucket_access_assignable_role,
    _is_settings_admin,
    _list_buckets_for_add_form,
    _normalize_bucket_access_role,
    _normalize_bucket_roles_payload,
    _normalize_role_permissions,
    _parse_user_email_field,
    _resolve_bucket_form_endpoint_url,
    _role_valid_for_user,
    _roles_for_bucket_access,
    _validate_bucket_create_payload,
    _validate_bucket_endpoint_for_form,
    _validate_bucket_roles_list,
    _validate_bucket_update_s3_target,
    grant_user_bucket_access,
    revoke_user_bucket_access,
)
from users import (
    _session_allowed_list,
    hash_password,
    sync_logged_in_session_from_db,
    user_display_name,
)


from s3_client import get_s3_client, _map_s3_client_error, _map_s3_runtime_error


def _trf(key, **kwargs):
    text = _(key)
    for k, v in kwargs.items():
        text = text.replace('{' + str(k) + '}', str(v))
    return text


def settings_list_users_impl():
    """Список пользователей из БД или добавление нового (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        try:
            users = list_users()
            items = []
            for user in users:
                item = dict(user)
                item['last_login_at'] = _dt_iso(user.get('last_login_at'))
                items.append(item)
            return jsonify({'items': items})
        except Exception as e:
            log_error('Failed to list users in settings', 'settings_users', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    # POST — добавить пользователя
    try:
        data = request.get_json() or {}
        username = (data.get('username') or '').strip()
        password = data.get('password')
        role = (data.get('role') or ROLE_STORAGE_VIEWER).strip()
        buckets = data.get('buckets')
        clouds = data.get('clouds')
        if not username:
            return jsonify({'error': _('error.username_password_required')}), 400
        if not password:
            return jsonify({'error': _('error.username_password_required')}), 400
        if not _role_valid_for_user(role):
            return jsonify({'error': _('error.role_not_found')}), 400
        if not isinstance(buckets, list):
            buckets = []
        if not isinstance(clouds, list):
            clouds = []
        bucket_roles = _normalize_bucket_roles_payload(data.get('bucket_roles'))
        if not _validate_bucket_roles_list(bucket_roles):
            return jsonify({'error': _('error.role_not_found')}), 400
        email = _parse_user_email_field(data)
        if email is False:
            return jsonify({'error': _('error.user_email_invalid')}), 400
        display_name = (data.get('display_name') or '').strip() or None
        if get_user(username):
            return jsonify({'error': _('error.user_exists')}), 400
        password_hash = hash_password(password)
        insert_user(
            username, password_hash, role, buckets, clouds,
            bucket_roles=bucket_roles, email=email, full_name=display_name,
        )
        log_info(f"Created user: {username}", 'create_objects')
        return jsonify({'ok': True})
    except Exception as e:
        log_error('Failed to add user in settings', 'settings_users_post', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_services_status_impl():
    """Статус подключений Database / LDAP / Meilisearch / SSO / S3 (только admin)."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError, as_completed

        def _timeout_payload(service_id):
            return {
                'id': service_id,
                'configured': False,
                'connected': False,
                'enabled': False,
                'status': 'error',
                'detail': 'Timed out',
                'vars': [],
                'meta': {},
            }

        def _error_payload(service_id, exc):
            return {
                'id': service_id,
                'configured': False,
                'connected': False,
                'status': 'error',
                'detail': str(exc),
                'vars': [],
                'meta': {},
            }

        def _meili_status_payload():
            meili_raw = meilisearch.connection_status(include_stats=False, timeout=3)
            meili_enabled = bool(meili_raw.get('enabled'))
            meili_configured = bool(meili_raw.get('configured'))
            meili_available = bool(meili_raw.get('available'))
            meili_host = (meili_raw.get('host') or '').strip() or None
            meili_api_key_ok = bool(meilisearch._meili_api_key())
            if not meili_enabled:
                meili_status = 'disabled'
                meili_detail = ''
            elif not meili_configured:
                meili_status = 'not_configured'
                meili_detail = ''
            elif meili_available:
                meili_status = 'ok'
                meili_version = (meili_raw.get('version') or '').strip()
                if meili_host and meili_version:
                    meili_detail = f'Connected to {meili_host} (v{meili_version})'
                elif meili_host:
                    meili_detail = f'Connected to {meili_host}'
                elif meili_version:
                    meili_detail = f'v{meili_version}'
                else:
                    meili_detail = ''
            else:
                meili_status = 'error'
                probe_err = (meili_raw.get('probe_error') or meili_raw.get('config_error') or '').strip()
                if probe_err and meili_host:
                    meili_detail = f'{probe_err} ({meili_host})'
                elif probe_err:
                    meili_detail = probe_err
                elif meili_host:
                    meili_detail = f'Unreachable ({meili_host})'
                else:
                    meili_detail = 'Meilisearch is unreachable'
            return {
                'id': 'meilisearch',
                'configured': meili_configured,
                'connected': meili_available,
                'enabled': meili_enabled,
                'status': meili_status,
                'detail': meili_detail,
                'vars': [
                    {'name': 'MEILI_ENABLED', 'ok': meili_enabled, 'required': True},
                    {'name': 'MEILI_HOST', 'ok': bool(meili_host), 'required': True},
                    {'name': 'MEILI_API_KEY', 'ok': meili_api_key_ok, 'required': True},
                ],
                'meta': {
                    'host': meili_host,
                    'enabled_from_env': bool(meili_raw.get('enabled_from_env')),
                    'database_size': meili_raw.get('database_size'),
                    'version': meili_raw.get('version'),
                    'config_error': meili_raw.get('config_error'),
                    'probe_error': meili_raw.get('probe_error'),
                },
            }

        def _s3_status_payload():
            """S3 Status: уникальные cloud endpoints (один head_bucket на endpoint)."""
            try:
                import boto3 as _boto3  # noqa: F401
                boto_ok = True
            except ImportError:
                boto_ok = False

            clouds = get_buckets_config() or {}
            # endpoint_lower → representative bucket_config (один probe на URL)
            by_endpoint = {}
            for _cid, cloud in clouds.items():
                cloud_ep = (cloud.get('endpoint_url') or '').strip()
                for _dname, bc in (cloud.get('buckets') or {}).items():
                    ep = (bc.get('endpoint_url') or cloud_ep or '').strip()
                    ak = (bc.get('aws_access_key_id') or '').strip()
                    sk = (bc.get('aws_secret_access_key') or '').strip()
                    bn = (bc.get('bucket_name') or '').strip()
                    if not (ep and ak and sk and bn):
                        continue
                    key = ep.lower()
                    if key not in by_endpoint:
                        cfg = dict(bc)
                        cfg['endpoint_url'] = ep
                        by_endpoint[key] = cfg

            vars_list = [
                {'name': 'boto3', 'ok': boto_ok, 'required': True},
            ]
            base = {
                'id': 's3',
                'vars': vars_list,
                'meta': {
                    'endpoint_count': len(by_endpoint),
                },
            }
            if not boto_ok:
                return {
                    **base,
                    'configured': False,
                    'connected': False,
                    'status': 'not_configured',
                    'detail': '',
                }
            if not by_endpoint:
                return {
                    **base,
                    'configured': False,
                    'connected': False,
                    'status': 'not_configured',
                    'detail': '',
                }

            ok_eps = []
            fail_eps = []

            def _probe_one(bc):
                ep = (bc.get('endpoint_url') or '').strip()
                bn = (bc.get('bucket_name') or '').strip()
                try:
                    client = get_s3_client(bc)
                    client.head_bucket(Bucket=bn)
                    return ep, True, None
                except Exception as exc:
                    return ep, False, str(exc)

            to_probe = list(by_endpoint.values())[:16]
            with ThreadPoolExecutor(max_workers=min(4, len(to_probe))) as pool:
                futs = [pool.submit(_probe_one, bc) for bc in to_probe]
                try:
                    for fut in as_completed(futs, timeout=20):
                        try:
                            ep, ok, _err = fut.result(timeout=8)
                        except Exception as exc:
                            fail_eps.append(('?', str(exc)))
                            continue
                        if ok:
                            ok_eps.append(ep)
                        else:
                            fail_eps.append((ep, _err))
                except FuturesTimeoutError:
                    fail_eps.append(('?', 'S3 probe timed out'))

            # Уникальные endpoint в vars (без дублей)
            seen = set()
            for ep in ok_eps:
                key = (ep or '').lower()
                if key in seen:
                    continue
                seen.add(key)
                vars_list.append({'name': ep, 'ok': True, 'required': False})
            for ep, _err in fail_eps:
                key = (ep or '(endpoint)').lower()
                if key in seen:
                    continue
                seen.add(key)
                vars_list.append({'name': ep or '(endpoint)', 'ok': False, 'required': False})

            # Endpoint checks only (boto3 already in vars_list)
            endpoint_vars = [v for v in vars_list if v['name'] != 'boto3']
            total = len(endpoint_vars)
            ok_count = len([v for v in endpoint_vars if v['ok']])
            connected = ok_count > 0
            if total == 0:
                status = 'error'
                detail = ''
            elif ok_count and ok_count < total:
                status = 'degraded'
                detail = f'Connected to {ok_count}/{total} endpoints'
            elif not ok_count:
                status = 'error'
                first_err = next((err for _ep, err in fail_eps if err), '')
                detail = (first_err or 'All S3 endpoints are unreachable')[:240]
            else:
                status = 'ok'
                if ok_count == 1:
                    detail = f'Connected to {ok_eps[0]}'
                else:
                    detail = f'Connected to {ok_count} endpoints'

            return {
                **base,
                'vars': vars_list,
                'configured': True,
                'connected': connected,
                'status': status,
                'detail': detail,
                'meta': {
                    **base['meta'],
                    'ok_endpoints': ok_eps,
                    'failed_endpoints': [ep for ep, _ in fail_eps],
                },
            }

        def _take(fut, service_id, timeout_sec):
            try:
                return fut.result(timeout=timeout_sec)
            except FuturesTimeoutError:
                return _timeout_payload(service_id)
            except Exception as exc:
                log_error(
                    f'Service status check failed: {service_id}: {exc}',
                    'settings_services_status',
                    exc,
                    LOG_CONFIG['show_traceback'],
                )
                return _error_payload(service_id, exc)

        # wait=False: иначе зависание LDAP/SSL/S3 блокирует ответ после timeout
        pool = ThreadPoolExecutor(max_workers=5)
        try:
            fut_db = pool.submit(db_connection_status)
            fut_ldap = pool.submit(ldap_client.connection_status)
            fut_meili = pool.submit(_meili_status_payload)
            fut_sso = pool.submit(sso_module.connection_status)
            fut_s3 = pool.submit(_s3_status_payload)
            database = _take(fut_db, 'database', 5)
            ldap = _take(fut_ldap, 'ldap', 15)
            meilisearch_status = _take(fut_meili, 'meilisearch', 5)
            sso_status = _take(fut_sso, 'sso', 8)
            s3_status = _take(fut_s3, 's3', 25)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

        services = [database, ldap, meilisearch_status, sso_status, s3_status]
        optional_ids = {'meilisearch', 'ldap', 'sso'}
        overall = 'ok'
        for svc in services:
            st = svc.get('status')
            sid = svc.get('id')
            if sid == 'sso' and st == 'disabled':
                continue
            if sid == 'meilisearch' and st == 'disabled':
                if overall == 'ok':
                    overall = 'degraded'
                continue
            if st == 'error':
                if sid in optional_ids and not (sid == 'sso' and sso_module.is_sso_only()):
                    if overall == 'ok':
                        overall = 'degraded'
                else:
                    overall = 'error'
                    break
            elif st == 'not_configured':
                if sid == 'database' or sid == 's3':
                    overall = 'error'
                    break
                if overall == 'ok':
                    overall = 'degraded'
            elif st == 'degraded' and overall == 'ok':
                overall = 'degraded'
        return jsonify({
            'ok': True,
            'overall': overall,
            'checked_at': datetime.now(timezone.utc).isoformat(),
            'services': {
                'database': database,
                'ldap': ldap,
                'meilisearch': meilisearch_status,
                'sso': sso_status,
                's3': s3_status,
            },
        })
    except Exception as e:
        log_error('Failed to collect services status', 'settings_services_status', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_users_ldap_lookup_impl():
    """Частичный поиск пользователей в LDAP/AD (только admin). Минимум 5 символов."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    username = (request.args.get('username') or '').strip()
    if not username:
        return jsonify({'error': _('error.username_required')}), 400
    if len(username) < ldap_client.LDAP_QUERY_MIN_LENGTH:
        return jsonify({
            'error': _('error.ldap_query_too_short'),
            'min_length': ldap_client.LDAP_QUERY_MIN_LENGTH,
        }), 400
    if not ldap_client.is_ldap_configured():
        return jsonify({'error': _('error.ldap_not_configured')}), 503
    try:
        payload = ldap_client.lookup_user_payload(username)
        if not payload.get('count'):
            return jsonify({'error': _('error.ldap_user_not_found'), **payload}), 404
        return jsonify(payload)
    except ldap_client.LDAPQueryTooShort:
        return jsonify({
            'error': _('error.ldap_query_too_short'),
            'min_length': ldap_client.LDAP_QUERY_MIN_LENGTH,
        }), 400
    except ldap_client.LDAPUserNotFound:
        return jsonify({'error': _('error.ldap_user_not_found'), 'query': username, 'count': 0, 'users': []}), 404
    except ldap_client.LDAPNotConfigured:
        return jsonify({'error': _('error.ldap_not_configured')}), 503
    except ldap_client.LDAPServiceError as exc:
        log_error(f'LDAP lookup failed: {exc}', 'settings_users_ldap_lookup', exc, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.ldap_lookup_failed')}), 502
    except Exception as e:
        log_error('LDAP lookup unexpected error', 'settings_users_ldap_lookup', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_user_by_name_impl(username):
    """Получение (GET), редактирование (PUT) или удаление (DELETE) пользователя (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        try:
            is_target_admin = (username or '').strip().lower() == 'admin'
            is_current_admin_user = (session.get('username') or '').strip().lower() == 'admin'
            if is_target_admin and not is_current_admin_user:
                return jsonify({'error': _('error.cannot_edit_admin')}), 403
            user = get_user(username)
            if not user:
                return jsonify({'error': _('error.bucket_not_found')}), 404
            return jsonify({
                'username': username,
                'role': user['role'],
                'buckets': _session_allowed_list(user.get('allowed_buckets', [])),
                'clouds': _session_allowed_list(user.get('allowed_clouds', [])),
                'bucket_roles': user.get('bucket_roles') or [],
                'email': user.get('email'),
                'display_name': user_display_name(user),
                'created_at': _dt_iso(user.get('created_at')),
                'last_login_at': _dt_iso(user.get('last_login_at')),
                'has_custom_roles': bool(user.get('has_custom_roles')),
            })
        except Exception as e:
            log_error('Failed to get user in settings', 'settings_users_get', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    if request.method == 'DELETE':
        try:
            if (username or '').strip().lower() == 'admin':
                return jsonify({'error': _('error.cannot_delete_admin')}), 400
            if username == session.get('username'):
                return jsonify({'error': _('error.cannot_delete_self')}), 400
            delete_user(username)
            log_info(f"Deleted user: {username}", 'delete_objects')
            return jsonify({'ok': True})
        except Exception as e:
            log_error('Failed to delete user in settings', 'settings_users_delete', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    # PUT — обновить пользователя
    try:
        is_target_admin = (username or '').strip().lower() == 'admin'
        is_current_admin_user = (session.get('username') or '').strip().lower() == 'admin'
        if is_target_admin and not is_current_admin_user:
            return jsonify({'error': _('error.cannot_edit_admin')}), 403
        data = request.get_json() or {}
        role = (data.get('role') or ROLE_STORAGE_VIEWER).strip()
        buckets = data.get('buckets')
        clouds = data.get('clouds')
        bucket_roles = _normalize_bucket_roles_payload(data.get('bucket_roles'))
        if not _validate_bucket_roles_list(bucket_roles):
            return jsonify({'error': _('error.role_not_found')}), 400
        password = data.get('password')
        if not get_user(username):
            return jsonify({'error': _('error.bucket_not_found')}), 404
        if not _role_valid_for_user(role):
            return jsonify({'error': _('error.role_not_found')}), 400
        if not isinstance(buckets, list):
            buckets = []
        if not isinstance(clouds, list):
            clouds = []
        password_hash = None
        if password and str(password).strip():
            password_hash = hash_password(password)
        email = _parse_user_email_field(data)
        if email is False:
            return jsonify({'error': _('error.user_email_invalid')}), 400
        display_name = (data.get('display_name') or '').strip() or None
        if not update_user(
            username, role, buckets, clouds,
            password_hash=password_hash, bucket_roles=bucket_roles, email=email, full_name=display_name,
        ):
            return jsonify({'error': _('error.bucket_not_found')}), 404
        session_updated = False
        if username == session.get('username'):
            session_updated = sync_logged_in_session_from_db()
        return jsonify({'ok': True, 'session_updated': session_updated})
    except Exception as e:
        log_error('Failed to update user in settings', 'settings_users_put', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_roles_impl():
    """Список ролей из БД или создание новой (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        try:
            items = list_roles()
            for item in items:
                item['permissions'] = _normalize_role_permissions(item.get('permissions'))
            return jsonify({'items': items})
        except Exception as e:
            log_error('Failed to list roles in settings', 'settings_roles', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    try:
        data = request.get_json() or {}
        name = (data.get('name') or '').strip()
        if not _ROLE_NAME_RE.match(name):
            return jsonify({'error': _('error.role_name_invalid')}), 400
        if is_reserved_role_name(name):
            return jsonify({'error': _('error.role_name_reserved')}), 400
        if get_role(name):
            return jsonify({'error': _('error.role_exists')}), 400
        perms = _normalize_role_permissions(data.get('permissions'))
        insert_role(name, perms)
        log_info(f"Created role: {name}", 'create_objects')
        return jsonify({'ok': True})
    except Exception as e:
        log_error('Failed to create role in settings', 'settings_roles_post', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_role_by_name_impl(role_name):
    """Получение (GET), обновление прав (PUT) или удаление (DELETE) роли (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        try:
            row = get_role(role_name)
            if not row:
                return jsonify({'error': _('error.role_not_found')}), 404
            if (role_name or '').strip().lower() == 'admin' and (session.get('username') or '').strip().lower() != 'admin':
                return jsonify({'error': _('error.cannot_edit_admin_role')}), 403
            row['permissions'] = _normalize_role_permissions(row.get('permissions'))
            return jsonify(row)
        except Exception as e:
            log_error('Failed to get role in settings', 'settings_roles_get', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    if request.method == 'DELETE':
        try:
            if not get_role(role_name):
                return jsonify({'error': _('error.role_not_found')}), 404
            if (role_name or '').strip().lower() == 'admin':
                return jsonify({'error': _('error.cannot_delete_admin_role')}), 400
            if count_users_with_role(role_name) > 0:
                return jsonify({'error': _('error.role_in_use')}), 400
            delete_role(role_name)
            log_info(f"Deleted role: {role_name}", 'delete_objects')
            return jsonify({'ok': True})
        except Exception as e:
            log_error('Failed to delete role in settings', 'settings_roles_delete', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    try:
        if not get_role(role_name):
            return jsonify({'error': _('error.role_not_found')}), 404
        if (role_name or '').strip().lower() == 'admin' and (session.get('username') or '').strip().lower() != 'admin':
            return jsonify({'error': _('error.cannot_edit_admin_role')}), 403
        data = request.get_json() or {}
        perms = _normalize_role_permissions(data.get('permissions'))
        update_role(role_name, perms)
        return jsonify({'ok': True})
    except Exception as e:
        log_error('Failed to update role in settings', 'settings_roles_put', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_options_roles_impl():
    """Имена ролей из БД для выпадающего списка пользователя (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        items = [{'id': r['name']} for r in list_roles()]
        return jsonify({'items': items})
    except Exception as e:
        log_error('Failed to list roles for settings options', 'settings_options_roles', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_options_role_permissions_impl():
    """Справочник прав для формы роли (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        items = [{'id': pid, 'label': _(f'perm.{pid}')} for pid in KNOWN_PERMISSION_IDS]
        return jsonify({'items': items})
    except Exception as e:
        log_error('Failed to list permissions for settings options', 'settings_options_role_perms', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_buckets_impl():
    """Список бакетов из БД или добавление нового (admin / add_bucket / storage_admin)."""
    if not _can_add_bucket():
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        try:
            rows = _list_buckets_for_add_form()
            items = []
            for r in rows:
                item = dict(r)
                if _is_settings_admin():
                    ts = item.get('search_reindexed_at')
                    if ts is not None and hasattr(ts, 'isoformat'):
                        item['search_reindexed_at'] = ts.isoformat()
                    item['search_index_enabled'] = bool(item.get('search_index_enabled', True))
                items.append(item)
            return jsonify({'items': items})
        except Exception as e:
            log_error('Failed to list buckets in settings', 'settings_buckets', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    # POST — добавить бакет
    try:
        data = request.get_json() or {}
        cloud_id = (data.get('cloud_id') or '').strip()
        display_name = (data.get('display_name') or '').strip()
        bucket_name = (data.get('bucket_name') or '').strip()
        if not cloud_id or not display_name or not bucket_name:
            return jsonify({'error': _('error.bucket_create_required_fields')}), 400
        cn = (data.get('cloud_name') or data.get('cloud_display_name') or '').strip() or None
        _st = data.get('skip_tls_verify')
        if isinstance(_st, bool):
            skip_tls = _st
        elif _st is None:
            skip_tls = None
        elif str(_st).lower() in ('true', '1', 'yes'):
            skip_tls = True
        elif str(_st).lower() in ('false', '0', 'no'):
            skip_tls = False
        else:
            skip_tls = None
        if get_bucket_row(cloud_id, display_name):
            return jsonify({'error': _('error.bucket_exists')}), 400
        endpoint_url = _resolve_bucket_form_endpoint_url(
            cloud_id, (data.get('endpoint_url') or '').strip(),
        ) or None
        is_admin = _is_settings_admin()
        security_error = _validate_bucket_create_payload(
            cloud_id, bucket_name, endpoint_url or '', is_admin=is_admin,
        )
        if security_error:
            return jsonify({'error': _(security_error)}), 400
        # Bucket ID только с сервера (поле в UI readonly)
        new_id = insert_bucket(
            cloud_id=cloud_id,
            display_name=display_name,
            bucket_name=bucket_name,
            bucket_id=None,
            aws_access_key_id=data.get('aws_access_key_id') or None,
            aws_secret_access_key=data.get('aws_secret_access_key') or None,
            cloud_name=cn,
            endpoint_url=endpoint_url,
            ca_bundle_path=(data.get('ca_bundle_path') or '').strip() or None,
            region_name=(data.get('region_name') or '').strip() or None,
            skip_tls_verify=skip_tls,
            created_by=_current_username() or None,
        )
        reset_buckets_config_cache()
        _grant_created_bucket_to_current_user(new_id, cloud_id)
        log_info(f"Created bucket: {display_name} ({cloud_id})", 'create_objects')
        return jsonify({'ok': True, 'bucket_id': new_id})
    except Exception as e:
        log_error('Failed to add bucket in settings', 'settings_buckets_post', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_bucket_by_key_impl(cloud_id, display_name):
    """GET/PUT — admin или создатель бакета; DELETE — только admin."""
    if request.method == 'DELETE':
        if not _is_settings_admin():
            return jsonify({'error': _('error.access_denied')}), 403
    else:
        # Для не-admin одинаковый 404 при «нет строки» и «нет прав»,
        # чтобы не раскрывать существование чужих бакетов (403 vs 404).
        row_probe = get_bucket_row(cloud_id, display_name)
        if not row_probe or not _can_manage_bucket_row(row_probe):
            if row_probe:
                log_warning(
                    f"Bucket settings denied for user={_current_username() or '?'} "
                    f"cloud_id={cloud_id} display_name={display_name}",
                    'settings_bucket_authz',
                )
            return jsonify({'error': _('error.bucket_not_found')}), 404

    if request.method == 'GET':
        try:
            row = get_bucket_row(cloud_id, display_name)
            if not row:
                return jsonify({'error': _('error.bucket_not_found')}), 404
            return jsonify(row)
        except Exception as e:
            log_error('Failed to get bucket in settings', 'settings_bucket_get', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    if request.method == 'DELETE':
        try:
            row = get_bucket_row(cloud_id, display_name)
            bucket_id = (row or {}).get('bucket_id')
            bucket_name = (row or {}).get('bucket_name')
            delete_bucket(cloud_id, display_name)
            if bucket_id and meilisearch.is_enabled():
                meilisearch.delete_bucket_index(bucket_id, bucket_name)
            reset_buckets_config_cache()
            log_info(f"Deleted bucket: {display_name} ({cloud_id})", 'delete_objects')
            return jsonify({'ok': True})
        except Exception as e:
            log_error('Failed to delete bucket in settings', 'settings_bucket_delete', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    # PUT — обновить бакет (Bucket ID не меняем)
    try:
        data = request.get_json() or {}
        row = get_bucket_row(cloud_id, display_name)
        if not row:
            return jsonify({'error': _('error.bucket_not_found')}), 404
        old_bucket_id = (row.get('bucket_id') or '').strip() or None
        old_bucket_name = (row.get('bucket_name') or '').strip() or None
        is_admin = _is_settings_admin()
        # Bucket name при редактировании может менять только admin
        if is_admin:
            bucket_name = (data.get('bucket_name') or '').strip() or None
            if bucket_name is None:
                bucket_name = row.get('bucket_name')
        else:
            bucket_name = row.get('bucket_name')
        # Не-admin не может сменить облако/display key — только credentials и параметры строки
        if is_admin:
            target_cid = (data.get('cloud_id') or '').strip() or cloud_id
            target_disp = (data.get('display_name') or '').strip() or display_name
        else:
            target_cid = cloud_id
            target_disp = display_name
        if (target_cid, target_disp) != (cloud_id, display_name) and get_bucket_row(target_cid, target_disp):
            return jsonify({'error': _('error.bucket_exists')}), 400
        endpoint_url = data.get('endpoint_url') if data.get('endpoint_url') is not None else row.get('endpoint_url')
        endpoint_url = _resolve_bucket_form_endpoint_url(target_cid, (endpoint_url or '').strip()) or ''
        security_error = _validate_bucket_endpoint_for_form(
            target_cid, endpoint_url, is_admin=is_admin,
        )
        if security_error:
            return jsonify({'error': _(security_error)}), 400
        s3_dup = _validate_bucket_update_s3_target(
            bucket_name,
            endpoint_url,
            exclude_cloud_id=cloud_id,
            exclude_display_name=display_name,
        )
        if s3_dup:
            return jsonify({'error': _(s3_dup)}), 400
        _cn_put = (data.get('cloud_name') or data.get('cloud_display_name') or '').strip() or None
        ensure_cloud(target_cid, _cn_put)
        _cloud_name_update = None
        if is_admin and ('cloud_name' in data or 'cloud_display_name' in data):
            _cloud_name_update = (data.get('cloud_name') or data.get('cloud_display_name') or '').strip() or None
        update_bucket(
            cloud_id=cloud_id,
            display_name=display_name,
            bucket_name=bucket_name,
            bucket_id=None,
            aws_access_key_id=data.get('aws_access_key_id') if 'aws_access_key_id' in data else None,
            aws_secret_access_key=data.get('aws_secret_access_key') if 'aws_secret_access_key' in data else None,
            cloud_name=_cloud_name_update,
            cloud_icon=data.get('cloud_icon') if (is_admin and data.get('cloud_icon') is not None) else None,
            endpoint_url=endpoint_url if data.get('endpoint_url') is not None else None,
            ca_bundle_path=data.get('ca_bundle_path') if 'ca_bundle_path' in data else None,
            region_name=data.get('region_name') if 'region_name' in data else None,
            skip_tls_verify=data.get('skip_tls_verify') if 'skip_tls_verify' in data else None,
            target_cloud_id=target_cid,
            target_display_name=target_disp,
        )
        if meilisearch.is_enabled() and old_bucket_id:
            updated = get_bucket_row(target_cid, target_disp) or row
            new_bucket_id = (updated.get('bucket_id') or '').strip() or None
            new_bucket_name = (updated.get('bucket_name') or '').strip() or None
            if new_bucket_id != old_bucket_id or new_bucket_name != old_bucket_name:
                meilisearch.delete_bucket_index(old_bucket_id, old_bucket_name)
        reset_buckets_config_cache()
        return jsonify({'ok': True})
    except Exception as e:
        log_error('Failed to update bucket in settings', 'settings_bucket_put', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_options_clouds_impl():
    """Все облака из каталога для формы бакета (admin или право add_bucket).

    Не ограничиваем allowed_clouds пользователя: при создании бакета можно
    выбрать любое зарегистрированное облако; доступ выдаётся через grant.
    """
    if not _can_add_bucket():
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        return jsonify({'items': list_clouds()})
    except Exception as e:
        log_error('Failed to list clouds for settings options', 'settings_options_clouds', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_test_bucket_connection_impl():
    """Проверка подключения к бакету из формы (admin или право add_bucket)."""
    if not (_is_settings_admin() or _can_add_bucket()):
        return jsonify({'error': _('error.access_denied')}), 403
    context = 'settings_bucket_test'
    try:
        data = request.get_json() or {}
        cloud_id = (data.get('cloud_id') or '').strip()
        display_name = (data.get('display_name') or '').strip()
        bucket_name = (data.get('bucket_name') or '').strip()
        bucket_display = display_name or bucket_name or cloud_id or 'bucket'
        is_admin = _is_settings_admin()
        endpoint_url = _resolve_bucket_form_endpoint_url(
            cloud_id, (data.get('endpoint_url') or '').strip(),
        )
        aws_access_key_id = (data.get('aws_access_key_id') or '').strip()
        aws_secret_access_key = (data.get('aws_secret_access_key') or '').strip()
        ca_bundle_path = (data.get('ca_bundle_path') or '').strip()
        region_name = (data.get('region_name') or '').strip()
        skip_tls_verify = data.get('skip_tls_verify', False)
        if isinstance(skip_tls_verify, str):
            skip_tls_verify = skip_tls_verify.lower() in ('true', '1', 'yes')

        if not cloud_id:
            return jsonify({'error': _('error.cloud_id_invalid')}), 400
        if not bucket_name:
            return jsonify({'error': _('error.bucket_name_required')}), 400

        security_error = _validate_bucket_endpoint_for_form(
            cloud_id, endpoint_url, is_admin=is_admin,
        )
        if security_error:
            return jsonify({'error': _(security_error)}), 400

        bucket_config = {
            'bucket_name': bucket_name,
            'endpoint_url': endpoint_url,
            'aws_access_key_id': aws_access_key_id,
            'aws_secret_access_key': aws_secret_access_key,
            'ca_bundle_path': ca_bundle_path or None,
            'region_name': region_name or 'us-east-1',
            'skip_tls_verify': bool(skip_tls_verify),
        }
        s3_client = get_s3_client(bucket_config)
        s3_client.head_bucket(Bucket=bucket_name)
        return jsonify({'ok': True, 'message': _('modal.test_connection_success')})
    except ClientError as e:
        full_msg, status_code = _map_s3_client_error(e, bucket_display)
        log_s3_exception(context, e, bucket_display)
        return jsonify({'error': full_msg}), status_code
    except Exception as e:
        full_msg, status_code = _map_s3_runtime_error(e, bucket_display)
        log_s3_exception(context, e, bucket_display)
        return jsonify({'error': full_msg}), status_code


def settings_options_buckets_impl():
    """Список бакетов для формы бакета (admin или право add_bucket)."""
    if not _can_add_bucket():
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        items = list_bucket_options()
        if not _is_settings_admin():
            allowed_ids = _accessible_bucket_ids()
            items = [item for item in items if (item.get('id') or '') in allowed_ids]
        return jsonify({'items': items})
    except Exception as e:
        log_error('Failed to list buckets for settings options', 'settings_options_buckets', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_options_endpoints_impl():
    """Список endpoint URL для формы бакета (admin или право add_bucket)."""
    if not _can_add_bucket():
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        # Все endpoint'ы каталога облаков — иначе при выборе «чужого» облака список URL пуст
        return jsonify({'items': list_endpoints() if _is_settings_admin() else list_cloud_endpoints()})
    except Exception as e:
        log_error('Failed to list endpoints for settings options', 'settings_options_endpoints', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_clouds_impl():
    """Список облаков из БД или создание нового облака (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        try:
            return jsonify({'items': list_cloud_rows()})
        except Exception as e:
            log_error('Failed to list clouds in settings', 'settings_clouds', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    try:
        data = request.get_json() or {}
        cloud_id = (data.get('cloud_id') or '').strip()
        if not cloud_id:
            return jsonify({'error': _('error.cloud_id_invalid')}), 400
        if get_cloud_row(cloud_id):
            return jsonify({'error': _('error.cloud_exists')}), 400
        display_name = (data.get('display_name') or '').strip() or cloud_id
        endpoint_raw = data.get('endpoint_url')
        if endpoint_raw is not None and not isinstance(endpoint_raw, list):
            return jsonify({'error': _('error.endpoint_url_array_required')}), 400
        endpoint_urls = [str(v).strip() for v in (endpoint_raw or []) if str(v).strip()]
        public_url_enabled = bool(data.get('public_url_enabled'))
        insert_cloud(
            cloud_id=cloud_id,
            display_name=display_name,
            endpoint_url=endpoint_urls,
            public_url_enabled=public_url_enabled,
        )
        log_info(f"Created cloud: {cloud_id}", 'create_objects')
        return jsonify({'ok': True})
    except Exception as e:
        log_error('Failed to create cloud in settings', 'settings_clouds_post', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_cloud_by_id_impl(cloud_id):
    """Получение/обновление/удаление облака (только admin)."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        try:
            row = get_cloud_row(cloud_id)
            if not row:
                return jsonify({'error': _('error.cloud_not_found')}), 404
            return jsonify(row)
        except Exception as e:
            log_error('Failed to get cloud in settings', 'settings_cloud_get', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    if request.method == 'DELETE':
        try:
            if not get_cloud_row(cloud_id):
                return jsonify({'error': _('error.cloud_not_found')}), 404
            if count_buckets_with_cloud(cloud_id) > 0:
                return jsonify({'error': _('error.cloud_in_use')}), 400
            delete_cloud(cloud_id)
            log_info(f"Deleted cloud: {cloud_id}", 'delete_objects')
            return jsonify({'ok': True})
        except Exception as e:
            log_error('Failed to delete cloud in settings', 'settings_cloud_delete', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500
    try:
        if not get_cloud_row(cloud_id):
            return jsonify({'error': _('error.cloud_not_found')}), 404
        data = request.get_json() or {}
        display_name = data.get('display_name') if 'display_name' in data else None
        endpoint_url = None
        public_url_enabled = None
        if 'endpoint_url' in data:
            endpoint_raw = data.get('endpoint_url')
            if endpoint_raw is not None and not isinstance(endpoint_raw, list):
                return jsonify({'error': _('error.endpoint_url_array_required')}), 400
            endpoint_urls = [str(v).strip() for v in (endpoint_raw or []) if str(v).strip()]
            endpoint_url = endpoint_urls
        if 'public_url_enabled' in data:
            public_url_enabled = bool(data.get('public_url_enabled'))
        update_cloud(
            cloud_id=cloud_id,
            display_name=display_name,
            endpoint_url=endpoint_url,
            public_url_enabled=public_url_enabled,
        )
        return jsonify({'ok': True})
    except Exception as e:
        log_error('Failed to update cloud in settings', 'settings_cloud_put', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500

def settings_bucket_search_index_enabled_impl():
    """Включить/отключить индексацию Meilisearch для бакета (только admin)."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    data = request.get_json(silent=True) or {}
    bucket_id = (data.get('bucket_id') or '').strip()
    if not bucket_id:
        return jsonify({'error': _('error.bucket_id_required')}), 400
    if 'enabled' not in data:
        return jsonify({'error': _('error.search_index_enabled_required')}), 400
    enabled = data.get('enabled')
    if isinstance(enabled, str):
        enabled = enabled.strip().lower() in ('1', 'true', 'yes', 'on')
    else:
        enabled = bool(enabled)
    if not find_bucket_config_by_bucket_id(bucket_id):
        return jsonify({'error': _('error.bucket_not_found')}), 404
    if not set_bucket_search_index_enabled(bucket_id, enabled):
        return jsonify({'error': _('error.bucket_not_found')}), 404
    return jsonify({'ok': True, 'bucket_id': bucket_id, 'search_index_enabled': enabled})


def settings_bucket_access_impl(bucket_id):
    """Список / выдача / отзыв доступа пользователей к бакету (admin или создатель)."""
    bid = (bucket_id or '').strip()
    if not bid:
        return jsonify({'error': _('error.bucket_not_found')}), 404
    row = get_bucket_row_by_id(bid)
    if not row:
        return jsonify({'error': _('error.bucket_not_found')}), 404
    if not _can_manage_bucket_access(row):
        return jsonify({'error': _('error.access_denied')}), 403

    if request.method == 'GET':
        try:
            payload = list_users_for_bucket_access(bid)
            roles = _roles_for_bucket_access()
            return jsonify({
                'bucket_id': bid,
                'cloud_id': row.get('cloud_id'),
                'display_name': row.get('display_name'),
                'bucket_name': row.get('bucket_name'),
                'users': payload.get('users') or [],
                'candidates': payload.get('candidates') or [],
                'roles': roles,
            })
        except Exception as e:
            log_error('Failed to list bucket access', 'settings_bucket_access', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500

    data = request.get_json(silent=True) or {}
    username = (data.get('username') or request.args.get('username') or '').strip()
    if not username:
        return jsonify({'error': _('error.username_required')}), 400
    if not get_user(username):
        return jsonify({'error': _('error.bucket_not_found')}), 404

    if request.method == 'POST':
        try:
            role = (data.get('role') or '').strip() or None
            if role and not _is_bucket_access_assignable_role(role):
                return jsonify({'error': _('error.role_not_found')}), 400
            if role:
                role = _normalize_bucket_access_role(role)
            cloud_id = (row.get('cloud_id') or '').strip()
            if not grant_user_bucket_access(username, bid, cloud_id=cloud_id, role=role):
                # Уже есть доступ / без изменений — не ошибка
                pass
            if username == session.get('username'):
                sync_logged_in_session_from_db()
            log_info(f'Granted bucket {bid} access to {username}', 'settings_bucket_access')
            payload = list_users_for_bucket_access(bid)
            return jsonify({
                'ok': True,
                'users': payload.get('users') or [],
                'candidates': payload.get('candidates') or [],
            })
        except Exception as e:
            log_error('Failed to grant bucket access', 'settings_bucket_access_post', e, LOG_CONFIG['show_traceback'])
            return jsonify({'error': _('error.unexpected')}), 500

    # DELETE
    try:
        target = get_user(username) or {}
        buckets = _session_allowed_list(target.get('allowed_buckets', []))
        if '*' in buckets:
            return jsonify({'error': _('error.bucket_access_wildcard')}), 400
        if not revoke_user_bucket_access(username, bid):
            return jsonify({'error': _('error.bucket_not_found')}), 404
        if username == session.get('username'):
            sync_logged_in_session_from_db()
        log_info(f'Revoked bucket {bid} access from {username}', 'settings_bucket_access')
        payload = list_users_for_bucket_access(bid)
        return jsonify({
            'ok': True,
            'users': payload.get('users') or [],
            'candidates': payload.get('candidates') or [],
        })
    except Exception as e:
        log_error('Failed to revoke bucket access', 'settings_bucket_access_delete', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def settings_bucket_access_draft_impl():
    """Черновик ACL для Add/Copy bucket (admin / storage_admin / add_bucket)."""
    if not _can_add_bucket():
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        payload = list_users_for_bucket_access('__bucket_access_draft__')
        users = list(payload.get('users') or [])
        candidates = list(payload.get('candidates') or [])
        me = _current_username()
        me_l = me.lower() if me else ''
        if me_l and not any((u.get('username') or '').strip().lower() == me_l for u in users):
            user = get_user(me)
            if user:
                role = (user.get('role') or session.get('role') or '').strip()
                candidates = [
                    c for c in candidates
                    if (c.get('username') or '').strip().lower() != me_l
                ]
                users.append({
                    'username': me,
                    'display_name': user_display_name(user) or me,
                    'role': role,
                    'via_wildcard': False,
                })
        if not any((u.get('username') or '').strip().lower() == 'admin' for u in users):
            admin_u = get_user('admin')
            if admin_u:
                admin_buckets = _session_allowed_list(admin_u.get('allowed_buckets', []))
                users.insert(0, {
                    'username': 'admin',
                    'display_name': user_display_name(admin_u) or 'admin',
                    'role': (admin_u.get('role') or 'admin').strip() or 'admin',
                    'via_wildcard': '*' in admin_buckets,
                })
                candidates = [
                    c for c in candidates
                    if (c.get('username') or '').strip().lower() != 'admin'
                ]
        users.sort(
            key=lambda u: (
                0 if (u.get('username') or '').strip().lower() == 'admin' else 1,
                (u.get('username') or '').lower(),
            )
        )
        return jsonify({
            'users': users,
            'candidates': candidates,
            'roles': _roles_for_bucket_access(),
        })
    except Exception as e:
        log_error('Failed to build bucket access draft', 'settings_bucket_access_draft', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500
