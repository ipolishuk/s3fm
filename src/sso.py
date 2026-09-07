# sso.py — авторизация через OIDC (Keycloak и совместимые IdP)
import logging
import os
import secrets
from functools import wraps
from urllib.parse import urlencode

import requests
from flask import Blueprint, redirect, request, session, url_for

from db import insert_user
from roles import ROLE_STORAGE_VIEWER, VALID_ROLES, normalize_role_name
from users import establish_logged_in_session, get_user, hash_password

logger = logging.getLogger('s3-file-manager.sso')

bp = Blueprint('sso', __name__)

_DEFAULT_SCOPES = 'openid profile email'
_DEFAULT_USERNAME_CLAIMS = ('preferred_username', 'username', 'sub', 'email')
_OIDC_HTTP_TIMEOUT = int(os.environ.get('OIDC_HTTP_TIMEOUT', '30'))


def _env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, '').strip().lower() in ('1', 'true', 'yes', 'on')


def _normalize_issuer(issuer: str) -> str:
    return (issuer or '').strip().rstrip('/')


def is_sso_enabled() -> bool:
    if not _env_bool('SSO_ENABLED'):
        return False
    issuer = _normalize_issuer(os.environ.get('OIDC_ISSUER', ''))
    client_id = (os.environ.get('OIDC_CLIENT_ID') or '').strip()
    client_secret = (os.environ.get('OIDC_CLIENT_SECRET') or '').strip()
    return bool(issuer and client_id and client_secret)


def is_sso_only() -> bool:
    return is_sso_enabled() and _env_bool('SSO_ONLY')


def connection_status() -> dict:
    """
    Статус OIDC/SSO для админ-панели.
    Probe: GET {issuer}/.well-known/openid-configuration (без token exchange).
    """
    enabled_flag = _env_bool('SSO_ENABLED')
    issuer = _issuer_url()
    client_id = (os.environ.get('OIDC_CLIENT_ID') or '').strip()
    client_secret = (os.environ.get('OIDC_CLIENT_SECRET') or '').strip()
    redirect_explicit = (os.environ.get('OIDC_REDIRECT_URI') or '').strip()
    external_base = _external_base_url()
    redirect_ok = bool(redirect_explicit or external_base)

    vars_list = [
        {'name': 'SSO_ENABLED', 'ok': enabled_flag, 'required': True},
        {'name': 'OIDC_ISSUER', 'ok': bool(issuer), 'required': True},
        {'name': 'OIDC_CLIENT_ID', 'ok': bool(client_id), 'required': True},
        {'name': 'OIDC_CLIENT_SECRET', 'ok': bool(client_secret), 'required': True},
        {
            'name': 'OIDC_REDIRECT_URI / APP_EXTERNAL_URL',
            'ok': redirect_ok,
            'required': True,
        },
    ]
    meta = {
        'issuer': issuer or None,
        'sso_only': _env_bool('SSO_ONLY'),
        'redirect_uri': redirect_explicit or (
            f'{external_base}/api/auth/sso/callback' if external_base else None
        ),
    }
    base = {
        'id': 'sso',
        'vars': vars_list,
        'meta': meta,
        'enabled': enabled_flag and bool(issuer and client_id and client_secret),
    }

    if not enabled_flag:
        return {
            **base,
            'configured': False,
            'connected': False,
            'status': 'disabled',
            'detail': '',
        }

    missing = []
    if not issuer:
        missing.append('OIDC_ISSUER')
    if not client_id:
        missing.append('OIDC_CLIENT_ID')
    if not client_secret:
        missing.append('OIDC_CLIENT_SECRET')
    if not redirect_ok:
        missing.append('OIDC_REDIRECT_URI / APP_EXTERNAL_URL')
    if missing:
        return {
            **base,
            'configured': False,
            'connected': False,
            'status': 'not_configured',
            'detail': '',
        }

    discovery = f'{issuer}/.well-known/openid-configuration'
    try:
        resp = requests.get(discovery, timeout=min(5, max(1, _OIDC_HTTP_TIMEOUT)))
        if resp.status_code >= 400:
            return {
                **base,
                'configured': True,
                'connected': False,
                'status': 'error',
                'detail': f'OIDC discovery HTTP {resp.status_code} ({discovery})',
            }
        return {
            **base,
            'configured': True,
            'connected': True,
            'status': 'ok',
            'detail': f'Connected to {issuer}',
        }
    except Exception as exc:
        return {
            **base,
            'configured': True,
            'connected': False,
            'status': 'error',
            'detail': f'{exc} ({discovery})'[:240],
        }


def federated_logout_enabled() -> bool:
    """Выход через Keycloak end_session — только если явно включён и URI заведён в IdP."""
    return is_sso_enabled() and _env_bool('SSO_FEDERATED_LOGOUT')


def _issuer_url() -> str:
    return _normalize_issuer(os.environ.get('OIDC_ISSUER', ''))


def _oidc_base() -> str:
    return f'{_issuer_url()}/protocol/openid-connect'


def _scopes() -> str:
    return (os.environ.get('OIDC_SCOPES') or _DEFAULT_SCOPES).strip()


def _username_claims() -> tuple:
    raw = (os.environ.get('SSO_USERNAME_CLAIM') or '').strip()
    if raw:
        return tuple(c.strip() for c in raw.split(',') if c.strip())
    return _DEFAULT_USERNAME_CLAIMS


def _auto_provision() -> bool:
    return _env_bool('SSO_AUTO_PROVISION')


def _default_provision_role() -> str:
    role = normalize_role_name(os.environ.get('SSO_DEFAULT_ROLE') or ROLE_STORAGE_VIEWER)
    return role if role in VALID_ROLES else ROLE_STORAGE_VIEWER


def _strip_email_domain() -> bool:
    return _env_bool('SSO_STRIP_EMAIL_DOMAIN', default=True)


def get_redirect_uri() -> str:
    explicit = (os.environ.get('OIDC_REDIRECT_URI') or '').strip()
    if explicit:
        return explicit
    base = _external_base_url()
    if base:
        return f'{base}/api/auth/sso/callback'
    return url_for('sso.sso_callback', _external=True)


def _external_base_url():
    base = (os.environ.get('OIDC_EXTERNAL_URL') or os.environ.get('APP_EXTERNAL_URL') or '').strip()
    return base.rstrip('/') if base else None


def build_post_logout_redirect_uri() -> str:
    explicit = (os.environ.get('SSO_POST_LOGOUT_REDIRECT_URI') or '').strip()
    if explicit:
        return explicit
    base = _external_base_url()
    if base:
        # Корень приложения (часто уже в Valid post logout redirect URIs IdP); / → /login без сессии.
        return f'{base}/'
    return url_for('index', _external=True)


def resolve_email_from_userinfo(userinfo):
    """Email из OIDC userinfo / claims (scope email)."""
    if not isinstance(userinfo, dict):
        return None
    raw = userinfo.get('email')
    if raw is None:
        return None
    email = str(raw).strip()
    if '@' not in email:
        return None
    local, _, domain = email.partition('@')
    if not local or not domain or '.' not in domain:
        return None
    return email


def resolve_given_name_from_userinfo(userinfo):
    """Имя из OIDC userinfo (scope profile)."""
    if not isinstance(userinfo, dict):
        return None
    raw = userinfo.get('given_name')
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


def resolve_family_name_from_userinfo(userinfo):
    """Фамилия из OIDC userinfo (scope profile)."""
    if not isinstance(userinfo, dict):
        return None
    raw = userinfo.get('family_name')
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


def resolve_middle_name_from_userinfo(userinfo):
    """Отчество из OIDC userinfo (scope profile)."""
    if not isinstance(userinfo, dict):
        return None
    raw = userinfo.get('middle_name')
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


def resolve_full_name_from_userinfo(userinfo):
    """Полное имя из OIDC userinfo (claim name)."""
    if not isinstance(userinfo, dict):
        return None
    raw = userinfo.get('name')
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


def resolve_username_from_userinfo(userinfo):
    if not isinstance(userinfo, dict):
        return None

    for claim in _username_claims():
        raw = userinfo.get(claim)
        if raw is None:
            continue
        value = str(raw).strip()
        if not value:
            continue
        if claim == 'email' or ('@' in value and _strip_email_domain()):
            value = value.split('@', 1)[0].strip()
        if value:
            return value
    return None


def load_or_provision_user(username: str):
    user = get_user(username)
    if user:
        return user

    if not _auto_provision():
        return None

    role = _default_provision_role()
    password_hash = hash_password(secrets.token_urlsafe(32))
    insert_user(username, password_hash, role, [], [])
    return get_user(username)


def build_federated_logout_url():
    """URL end_session Keycloak. Требует Valid post logout redirect URIs в клиенте IdP."""
    if not federated_logout_enabled():
        return None

    issuer = _issuer_url()
    if not issuer:
        return None

    end_session = f'{issuer}/protocol/openid-connect/logout'
    params = {'post_logout_redirect_uri': build_post_logout_redirect_uri()}

    client_id = (os.environ.get('OIDC_CLIENT_ID') or '').strip()
    if client_id:
        params['client_id'] = client_id

    return f'{end_session}?{urlencode(params)}'


def _exchange_authorization_code(code: str) -> dict:
    redirect_uri = get_redirect_uri()
    token_url = f'{_oidc_base()}/token'
    data = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirect_uri,
        'client_id': os.environ['OIDC_CLIENT_ID'].strip(),
        'client_secret': os.environ['OIDC_CLIENT_SECRET'].strip(),
    }
    try:
        resp = requests.post(token_url, data=data, timeout=_OIDC_HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise RuntimeError(
            f'OIDC token endpoint unreachable ({token_url}): {exc}'
        ) from exc

    if resp.status_code >= 400:
        body = (resp.text or '')[:500]
        # Keycloak обычно отдаёт JSON: {"error":"...","error_description":"..."}
        detail = body
        try:
            err = resp.json()
            if isinstance(err, dict):
                detail = (
                    f"{err.get('error') or resp.status_code}: "
                    f"{err.get('error_description') or body}"
                )
        except Exception:
            pass
        raise RuntimeError(
            f'OIDC token exchange HTTP {resp.status_code} '
            f'(redirect_uri={redirect_uri!r}): {detail}'
        )

    payload = resp.json()
    if not isinstance(payload, dict):
        raise ValueError('OIDC token response is not JSON object')
    return payload


def _fetch_userinfo(access_token: str) -> dict:
    resp = requests.get(
        f'{_oidc_base()}/userinfo',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=_OIDC_HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    payload = resp.json()
    return payload if isinstance(payload, dict) else {}


def _userinfo_from_token(token_payload: dict) -> dict:
    userinfo = token_payload.get('userinfo')
    if isinstance(userinfo, dict) and userinfo:
        return userinfo

    access_token = (token_payload.get('access_token') or '').strip()
    if not access_token:
        return {}

    try:
        return _fetch_userinfo(access_token)
    except Exception as exc:
        logger.warning('OIDC userinfo request failed: %s', exc)
        return {}


def _sso_disabled():
    return redirect(url_for('auth.login_page'))


def require_sso_enabled(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_sso_enabled():
            return _sso_disabled()
        return view(*args, **kwargs)
    return wrapper


def _log_app(level, message, context='sso'):
    try:
        from logs import log_error, log_info, log_warning
        fn = {'error': log_error, 'warn': log_warning}.get(level, log_info)
        if level == 'error':
            fn(message, context)
        else:
            fn(message, context)
    except Exception:
        logger.log(
            logging.ERROR if level == 'error' else logging.INFO,
            message,
        )


@bp.route('/api/auth/sso/login')
@require_sso_enabled
def sso_login():
    """Редирект на Keycloak (Authorization Code), без Authlib."""
    try:
        state = secrets.token_urlsafe(32)
        session['oidc_state'] = state
        params = {
            'client_id': os.environ['OIDC_CLIENT_ID'].strip(),
            'response_type': 'code',
            'scope': _scopes(),
            'redirect_uri': get_redirect_uri(),
            'state': state,
        }
        auth_url = f"{_oidc_base()}/auth?{urlencode(params)}"
        return redirect(auth_url)
    except Exception as exc:
        logger.exception('SSO login redirect failed')
        _log_app('error', f'SSO login redirect failed: {exc}', 'sso_login')
        return redirect(url_for('auth.login_page', sso_error='generic'))


@bp.route('/api/auth/sso/callback')
@require_sso_enabled
def sso_callback():
    """Callback OIDC: обмен code, маппинг пользователя, редирект в приложение."""
    if request.args.get('error'):
        idp_err = request.args.get('error')
        idp_desc = request.args.get('error_description') or ''
        _log_app(
            'warn',
            f"OIDC error from IdP: {idp_err} {idp_desc}".strip(),
            'sso_callback',
        )
        return redirect(url_for('auth.login_page', sso_error='idp'))

    expected_state = session.pop('oidc_state', None)
    state = request.args.get('state')
    if not expected_state or state != expected_state:
        _log_app(
            'warn',
            'OIDC state mismatch (session cookie lost or APP_SECRET_KEY differs across pods)',
            'sso_callback',
        )
        return redirect(url_for('auth.login_page', sso_error='state'))

    code = (request.args.get('code') or '').strip()
    if not code:
        _log_app('warn', 'OIDC callback without code', 'sso_callback')
        return redirect(url_for('auth.login_page', sso_error='token'))

    try:
        token_payload = _exchange_authorization_code(code)
    except Exception as exc:
        logger.exception('OIDC token exchange failed')
        _log_app('error', f'OIDC token exchange failed: {exc}', 'sso_callback')
        return redirect(url_for('auth.login_page', sso_error='token'))

    userinfo = _userinfo_from_token(token_payload)
    username = resolve_username_from_userinfo(userinfo)
    if not username:
        _log_app('warn', 'OIDC: username claim not found in userinfo', 'sso_callback')
        return redirect(url_for('auth.login_page', sso_error='username'))

    user = load_or_provision_user(username)
    if not user:
        _log_app('warn', f'OIDC: user {username!r} is not provisioned in DB', 'sso_callback')
        return redirect(url_for('auth.login_page', sso_error='provision', sso_user=username))

    email = resolve_email_from_userinfo(userinfo)
    given_name = resolve_given_name_from_userinfo(userinfo)
    family_name = resolve_family_name_from_userinfo(userinfo)
    middle_name = resolve_middle_name_from_userinfo(userinfo)
    full_name = resolve_full_name_from_userinfo(userinfo)

    establish_logged_in_session(
        user,
        username,
        auth_method='sso',
        id_token=token_payload.get('id_token'),
        email=email,
        given_name=given_name,
        family_name=family_name,
        full_name=full_name,
        middle_name=middle_name,
    )
    _log_app('info', f"User '{username}' logged in via SSO", 'sso_callback')
    return redirect(url_for('pages.index'))


def public_endpoint_names() -> frozenset:
    return frozenset({'sso.sso_login', 'sso.sso_callback'})
