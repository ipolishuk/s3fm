"""Auth routes: login page, local login, logout, check-auth, set-locale."""

from flask import Blueprint, g, jsonify, redirect, render_template, request, session, url_for

import sso as sso_module
from auth_session import (
    auth_payload_for_user,
    bucket_roles_from_session,
    expire_session_cookie,
    is_session_valid,
    locale_cookie_kwargs,
    rate_limit_response,
    session_allowed_list,
    update_session_activity,
)
from db import update_user
from logs import LOG_CONFIG, log_error, log_info, log_warning
from rate_limit import check_login_rate, client_ip_from_request, record_login_failure
from roles import build_bucket_permissions_map, get_current_permissions
from security import ensure_csrf_token
from translations import _, SUPPORTED_LOCALES
from users import (
    APP_SESSION_TIMEOUT_MINUTES,
    establish_logged_in_session,
    get_user,
    hash_password,
    password_needs_upgrade,
    sync_logged_in_session_from_db,
    verify_password,
)

bp = Blueprint('auth', __name__)


@bp.route('/login', methods=['GET'])
def login_page():
    """Страница входа."""
    if session.get('logged_in'):
        return redirect(url_for('pages.index'))
    return render_template(
        'login.html',
        sso_enabled=sso_module.is_sso_enabled(),
        sso_only=sso_module.is_sso_only(),
        sso_login_url=url_for('sso.sso_login') if sso_module.is_sso_enabled() else None,
    )


@bp.route('/api/login', methods=['POST'])
def login():
    """API для входа в систему."""
    if sso_module.is_sso_only():
        return jsonify({'error': _('error.sso_only')}), 403

    context = 'login'
    client_ip = client_ip_from_request(request)
    try:
        data = request.get_json() or {}
        username = data.get('username', '').strip()
        password = data.get('password', '')

        allowed, retry_after = check_login_rate(client_ip, username)
        if not allowed:
            log_warning(f'Login rate limited for ip={client_ip} user={username or "-"}', context)
            return rate_limit_response(retry_after)

        if not username or not password:
            record_login_failure(client_ip, username)
            log_error('Username and password are required', context)
            return jsonify({'error': _('error.username_password_required')}), 400

        user = get_user(username)
        if not user:
            record_login_failure(client_ip, username)
            log_warning(f'Invalid credentials for user {username}', context)
            return jsonify({'error': _('error.invalid_credentials')}), 401

        if not verify_password(user['password_hash'], password):
            record_login_failure(client_ip, username)
            log_warning(f'Invalid password for user {username}', context)
            return jsonify({'error': _('error.invalid_credentials')}), 401

        if password_needs_upgrade(user['password_hash']):
            update_user(
                username,
                user['role'],
                session_allowed_list(user.get('allowed_buckets', [])),
                session_allowed_list(user.get('allowed_clouds', [])),
                password_hash=hash_password(password),
                email=user.get('email'),
            )

        establish_logged_in_session(user, username, auth_method='local')

        log_info(f"User '{username}' logged in successfully", context)
        log_info(f'Session timeout set to {APP_SESSION_TIMEOUT_MINUTES} minutes', context)

        return jsonify({
            'message': _('msg.login_success'),
            'username': username,
            'role': user['role'],
            'allowed_buckets': session_allowed_list(user.get('allowed_buckets', [])),
            'allowed_clouds': session_allowed_list(user.get('allowed_clouds', [])),
            **auth_payload_for_user(user),
            'APP_SESSION_TIMEOUT_MINUTES': APP_SESSION_TIMEOUT_MINUTES,
            'csrf_token': ensure_csrf_token(session),
        })

    except Exception as e:
        log_error(f'Login error: {str(e)}', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.login')}), 500


@bp.route('/api/logout', methods=['POST'])
def logout():
    """Выход из системы."""
    context = 'logout'
    username = session.get('username', 'Unknown user')
    sso_logout = session.get('auth_method') == 'sso'
    session.clear()
    session.modified = True
    log_info(f"User '{username}' logged out", context)

    payload = {'message': _('msg.logout_success')}
    if sso_logout and sso_module.federated_logout_enabled():
        federated_url = sso_module.build_federated_logout_url()
        if federated_url:
            payload['redirect'] = federated_url
    return expire_session_cookie(jsonify(payload))


@bp.route('/api/check-auth')
def check_auth():
    """Проверка статуса авторизации."""
    if session.get('logged_in'):
        if not is_session_valid():
            session.clear()
            return jsonify({'authenticated': False, 'session_expired': True})

        update_session_activity()

        if not sync_logged_in_session_from_db():
            return jsonify({'authenticated': False, 'session_expired': True})

        payload = {
            'authenticated': True,
            'username': session.get('username'),
            'role': session.get('role'),
            'permissions': get_current_permissions(),
            'allowed_buckets': session_allowed_list(session.get('allowed_buckets', [])),
            'allowed_clouds': session_allowed_list(session.get('allowed_clouds', [])),
            'bucket_roles': bucket_roles_from_session(),
            'bucket_permissions': build_bucket_permissions_map(bucket_roles_from_session()),
            'APP_SESSION_TIMEOUT_MINUTES': APP_SESSION_TIMEOUT_MINUTES,
            'login_time': session.get('login_time'),
            'last_activity': session.get('last_activity'),
        }
        email = (session.get('email') or '').strip()
        if email:
            payload['email'] = email
        display_name = (session.get('display_name') or '').strip()
        if display_name:
            payload['display_name'] = display_name
        if session.get('has_custom_roles'):
            payload['has_custom_roles'] = True
        payload['csrf_token'] = ensure_csrf_token(session)
        return jsonify(payload)
    return jsonify({'authenticated': False})


@bp.route('/api/set-locale', methods=['POST'])
def set_locale():
    """Установить язык интерфейса (ru/en)."""
    data = request.get_json() or {}
    locale = (data.get('locale') or request.form.get('locale') or '').strip().lower()
    if locale in SUPPORTED_LOCALES:
        session['locale'] = locale
        g.locale = locale
        resp = jsonify({'ok': True, 'locale': locale})
        resp.set_cookie('locale', locale, **locale_cookie_kwargs())
        return resp
    return jsonify({'ok': False, 'error': _('error.unsupported_locale')}), 400
