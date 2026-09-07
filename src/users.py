# users.py — настройки сессии, пароли и загрузка пользователей из PostgreSQL
import hashlib
import os
import re
import secrets
from datetime import datetime, timedelta
from werkzeug.security import check_password_hash, generate_password_hash

from db import get_user as _get_user_from_db, touch_user_last_login, update_user_sso_profile

_LEGACY_SHA256_HEX_RE = re.compile(r'^[a-f0-9]{64}$')

_INSECURE_SECRET_PLACEHOLDER = 'fallback-secret-key-change-me'


def get_required_env(var_name, default=None):
    value = os.environ.get(var_name, default)
    if value is None:
        raise ValueError(f"Требуется переменная окружения: {var_name}")
    return value


def get_optional_env(var_name, default=None):
    return os.environ.get(var_name, default)


def _allow_insecure_dev_secret() -> bool:
    return os.environ.get('ALLOW_INSECURE_DEV_SECRET', '').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )


def resolve_app_secret_key() -> str:
    """Обязательный секрет Flask-сессии (кроме явного dev-режима)."""
    key = (os.environ.get('APP_SECRET_KEY') or '').strip()
    if not key:
        if _allow_insecure_dev_secret():
            return 'dev-insecure-secret-not-for-production'
        raise RuntimeError(
            'APP_SECRET_KEY is required. Set a long random value, or for local dev only: '
            'ALLOW_INSECURE_DEV_SECRET=true',
        )
    if key == _INSECURE_SECRET_PLACEHOLDER and not _allow_insecure_dev_secret():
        raise RuntimeError(
            'APP_SECRET_KEY must not use the default placeholder. Set a strong random value.',
        )
    return key


def _is_legacy_sha256_hash(stored_hash: str) -> bool:
    return bool(_LEGACY_SHA256_HEX_RE.match((stored_hash or '').strip().lower()))


def hash_password(password: str) -> str:
    """Хэш пароля для хранения в БД (pbkdf2:sha256 — совместимо с Python 3.9/alpine)."""
    return generate_password_hash(password, method='pbkdf2:sha256')


def verify_password(stored_hash: str, password: str) -> bool:
    """Проверка пароля: новый формат werkzeug или legacy SHA-256 hex."""
    stored = (stored_hash or '').strip()
    if not stored or not password:
        return False
    if _is_legacy_sha256_hash(stored):
        return hashlib.sha256(password.encode()).hexdigest() == stored.lower()
    return check_password_hash(stored, password)


def password_needs_upgrade(stored_hash: str) -> bool:
    """True, если после входа стоит перезаписать хэш в БД (legacy SHA-256)."""
    return _is_legacy_sha256_hash(stored_hash or '')


def get_password_hash(password_env_var):
    """Хэш пароля из переменной окружения (для seed-скрипта)."""
    password = get_required_env(password_env_var)
    return hash_password(password)


# НАСТРОЙКИ СЕССИИ
APP_SESSION_TIMEOUT_MINUTES = int(get_optional_env('APP_SESSION_TIMEOUT_MINUTES', 60))
SESSION_PERMANENT = False
PERMANENT_SESSION_LIFETIME = timedelta(minutes=APP_SESSION_TIMEOUT_MINUTES)


def get_user(username):
    """
    Возвращает пользователя из БД в формате, ожидаемом app.py:
    {'password_hash', 'role', 'allowed_buckets', 'allowed_clouds'} или None.
    """
    return _get_user_from_db(username)


def _session_allowed_list(val):
    return val if isinstance(val, list) else []


def _bucket_roles_grants_for_session(user):
    bucket_roles_raw = (user or {}).get('bucket_roles') or []
    if isinstance(bucket_roles_raw, list):
        grants = {
            (g.get('bucket_id') or '').strip(): (g.get('role') or '').strip()
            for g in bucket_roles_raw
            if (g.get('bucket_id') or '').strip() and (g.get('role') or '').strip()
        }
    elif isinstance(bucket_roles_raw, dict):
        grants = bucket_roles_raw
    else:
        grants = {}
    try:
        from buckets import canonicalize_bucket_roles_map
        return canonicalize_bucket_roles_map(grants)
    except Exception:
        return grants


def apply_user_acl_to_session(user):
    """Записать в session роль, ACL бакетов/облаков и per-bucket grants из записи пользователя."""
    from flask import session

    if not isinstance(user, dict):
        return
    session['role'] = user['role']
    session['allowed_buckets'] = _session_allowed_list(user.get('allowed_buckets', []))
    session['allowed_clouds'] = _session_allowed_list(user.get('allowed_clouds', []))
    session['bucket_roles'] = _bucket_roles_grants_for_session(user)


def sync_logged_in_session_from_db():
    """
    Подтянуть права пользователя из БД в session без перелогина.
    Возвращает True, если сессия остаётся валидной (пользователь найден).
    """
    from flask import session

    username = (session.get('username') or '').strip()
    if not session.get('logged_in') or not username:
        return False
    user = get_user(username)
    if not user:
        session.clear()
        return False
    apply_user_acl_to_session(user)
    _apply_user_profile_to_session(user)
    return True


def user_display_name(user):
    """Отображаемое ФИО: full_name из SSO или «Фамилия Имя Отчество»."""
    if not isinstance(user, dict):
        return None
    full = (user.get('full_name') or '').strip()
    if full:
        return full
    parts = [
        (user.get('family_name') or '').strip(),
        (user.get('given_name') or '').strip(),
        (user.get('middle_name') or '').strip(),
    ]
    joined = ' '.join(part for part in parts if part)
    return joined or None


def _apply_user_profile_to_session(user):
    from flask import session

    if not isinstance(user, dict):
        return
    db_email = _normalize_user_email_from_user(user)
    if db_email:
        session['email'] = db_email
    else:
        session.pop('email', None)
    if user.get('has_custom_roles'):
        session['has_custom_roles'] = True
    else:
        session.pop('has_custom_roles', None)
    display = user_display_name(user)
    if display:
        session['display_name'] = display
    else:
        session.pop('display_name', None)


def _normalize_user_email_from_user(user):
    if not isinstance(user, dict):
        return None
    return (user.get('email') or '').strip() or None


def establish_logged_in_session(user, username, auth_method='local', id_token=None, email=None, given_name=None, family_name=None, full_name=None, middle_name=None):
    """Заполняет Flask-session после успешной локальной или SSO-аутентификации."""
    from flask import session

    if not username or not isinstance(user, dict):
        raise ValueError('establish_logged_in_session requires user dict and username')

    touch_user_last_login(username)
    if auth_method == 'sso':
        update_user_sso_profile(
            username,
            email=email,
            given_name=given_name,
            family_name=family_name,
            full_name=full_name,
            middle_name=middle_name,
        )
    fresh = _get_user_from_db(username)
    if fresh:
        user = fresh

    session['logged_in'] = True
    session['username'] = username
    apply_user_acl_to_session(user)
    session['csrf_token'] = secrets.token_hex(16)
    session['login_time'] = datetime.now().isoformat()
    session['last_activity'] = datetime.now().isoformat()
    session['auth_method'] = auth_method if auth_method in ('local', 'sso') else 'local'
    session.permanent = True
    # id_token не храним в cookie-сессии: JWT Keycloak часто >4KB и ломает последующие запросы (502).
    session.pop('oidc_id_token', None)
    _apply_user_profile_to_session(user)
