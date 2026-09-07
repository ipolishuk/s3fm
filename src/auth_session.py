"""Сессия и auth-хелперы (общие для app.py и blueprints)."""

from __future__ import annotations

from datetime import datetime, timedelta
from functools import wraps

from flask import current_app, g, jsonify, session

from buckets import canonicalize_bucket_roles_map
from logs import log_error, log_info
from roles import build_bucket_permissions_map, permissions_for_role
from translations import _
from users import APP_SESSION_TIMEOUT_MINUTES, PERMANENT_SESSION_LIFETIME


def is_session_valid():
    """Проверяет, действительна ли текущая сессия."""
    if not session.get('logged_in'):
        return False

    last_activity = session.get('last_activity')
    if not last_activity:
        return False

    try:
        last_activity_time = datetime.fromisoformat(last_activity)
        timeout_delta = timedelta(minutes=APP_SESSION_TIMEOUT_MINUTES)
        if datetime.now() - last_activity_time >= timeout_delta:
            return False
        return True
    except Exception as e:
        log_error(f'Session time check failed: {str(e)}', 'session_check', e)
        return False


def update_session_activity():
    """Обновляет время последней активности в сессии."""
    try:
        session['last_activity'] = datetime.now().isoformat()
        session.permanent = True
        current_app.permanent_session_lifetime = PERMANENT_SESSION_LIFETIME
    except Exception as e:
        log_error(f'Failed to update session activity time: {str(e)}', 'session_update', e)


def login_required(f):
    """Декоратор для проверки авторизации (JSON 401)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({'error': _('error.auth_required')}), 401
        if not is_session_valid():
            session.clear()
            log_info(
                f"Session expired for user {session.get('username', 'Unknown')}",
                'session_timeout',
            )
            return jsonify({'error': _('error.session_expired')}), 401
        update_session_activity()
        return f(*args, **kwargs)
    return decorated_function


def session_allowed_list(val):
    """Списки облаков/бакетов из сессии: только list, иначе []."""
    return val if isinstance(val, list) else []


def bucket_roles_map_from_user(user):
    raw = (user or {}).get('bucket_roles') or []
    if isinstance(raw, dict):
        grants = {
            str(k).strip(): str(v).strip()
            for k, v in raw.items()
            if str(k).strip() and str(v).strip()
        }
    elif not isinstance(raw, list):
        grants = {}
    else:
        grants = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            bid = (item.get('bucket_id') or '').strip()
            role = (item.get('role') or '').strip()
            if bid and role:
                grants[bid] = role
    return canonicalize_bucket_roles_map(grants)


def auth_payload_for_user(user):
    bucket_roles = bucket_roles_map_from_user(user)
    default_role = (user or {}).get('role') or ''
    return {
        'permissions': permissions_for_role(default_role),
        'bucket_roles': bucket_roles,
        'bucket_permissions': build_bucket_permissions_map(bucket_roles),
    }


def bucket_roles_from_session():
    raw = session.get('bucket_roles')
    return raw if isinstance(raw, dict) else {}


def locale_cookie_kwargs():
    """Флаги для cookie locale (Secure/SameSite согласованы с session cookie)."""
    kwargs = {
        'max_age': 365 * 24 * 3600,
        'path': '/',
        'samesite': current_app.config.get('SESSION_COOKIE_SAMESITE') or 'Lax',
        'httponly': False,
    }
    if current_app.config.get('SESSION_COOKIE_SECURE'):
        kwargs['secure'] = True
    return kwargs


def expire_session_cookie(response):
    """Сбрасывает session cookie и с Secure, и без."""
    name = current_app.config.get('SESSION_COOKIE_NAME', 'session')
    path = current_app.config.get('SESSION_COOKIE_PATH') or '/'
    domain = current_app.config.get('SESSION_COOKIE_DOMAIN')
    samesite = current_app.config.get('SESSION_COOKIE_SAMESITE') or 'Lax'
    httponly = bool(current_app.config.get('SESSION_COOKIE_HTTPONLY', True))
    for secure in (False, True):
        response.set_cookie(
            name,
            '',
            expires=0,
            max_age=0,
            path=path,
            domain=domain,
            secure=secure,
            httponly=httponly,
            samesite=samesite,
        )
    return response


def rate_limit_response(retry_after: int):
    resp = jsonify({
        'error': _('error.rate_limited'),
        'retry_after': max(1, int(retry_after or 1)),
    })
    resp.status_code = 429
    resp.headers['Retry-After'] = str(max(1, int(retry_after or 1)))
    return resp
