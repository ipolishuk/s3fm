# app.py — Flask application factory, middleware, blueprint registration, startup.
import json
import os
import re
import time
import threading
from urllib.parse import unquote
from dotenv import load_dotenv
from flask import Flask, request, jsonify, session, g, Response, redirect, url_for
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from werkzeug.middleware.proxy_fix import ProxyFix

# Загружаем переменные окружения из .env рядом с app.py.
_APP_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(dotenv_path=os.path.join(_APP_DIR, '.env'), override=False)

from users import (
    resolve_app_secret_key,
    APP_SESSION_TIMEOUT_MINUTES,
    PERMANENT_SESSION_LIFETIME,
    SESSION_PERMANENT,
)
from auth_session import (
    is_session_valid,
    update_session_activity,
    locale_cookie_kwargs as _locale_cookie_kwargs,
    expire_session_cookie as _expire_session_cookie,
)
import sso as sso_module
from logs import (
    configure_werkzeug_access_log,
    log_error,
    log_info,
    log_warning,
    set_log_username,
)
from db import (
    init_schema as db_init_schema,
    ensure_startup_admin,
)
from buckets import get_buckets_config
from security import (
    ensure_csrf_token,
    validate_csrf,
    CSRF_SAFE_METHODS,
)
from rate_limit import (
    check_metrics_rate,
    client_ip_from_request,
)
import meilisearch
from s3_client import get_s3_client_for_reindex
from translations import (
    get_locale_from_request,
    get_translations,
    _,
    SUPPORTED_LOCALES,
)

app = Flask(__name__, static_folder='css', template_folder='html')

app.secret_key = resolve_app_secret_key()
app.config['JSON_AS_ASCII'] = False
# Flask 2.3+: кириллица в JSON без экранирования \uXXXX
app.json.ensure_ascii = False

# Лимит размера тела запроса для загрузки файлов (в байтах). По умолчанию 512 МБ.
# Для загрузки больших файлов также увеличьте client_max_body_size в nginx.
MAX_UPLOAD_MB = int(os.environ.get('MAX_UPLOAD_MB', '100'))
app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_MB * 1024 * 1024

# НАСТРОЙКИ СЕССИИ FLASK
app.config['PERMANENT_SESSION_LIFETIME'] = PERMANENT_SESSION_LIFETIME
app.config['SESSION_PERMANENT'] = SESSION_PERMANENT
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = (
    os.environ.get('SESSION_COOKIE_SAMESITE', 'Lax').strip() or 'Lax'
)
# Secure cookie: по умолчанию включён; для локального HTTP — SESSION_COOKIE_SECURE=false
# или ALLOW_INSECURE_DEV_SECRET=true.
_session_secure_env = (os.environ.get('SESSION_COOKIE_SECURE') or '').strip().lower()
if _session_secure_env in ('0', 'false', 'no', 'off'):
    app.config['SESSION_COOKIE_SECURE'] = False
elif _session_secure_env in ('1', 'true', 'yes', 'on'):
    app.config['SESSION_COOKIE_SECURE'] = True
else:
    app.config['SESSION_COOKIE_SECURE'] = os.environ.get(
        'ALLOW_INSECURE_DEV_SECRET', '',
    ).strip().lower() not in ('1', 'true', 'yes', 'on')

# За reverse-proxy (TLS terminator): X-Forwarded-Proto / For / Host
_trust_proxy = (os.environ.get('APP_TRUST_PROXY', 'true') or '').strip().lower() in (
    '1', 'true', 'yes', 'on',
)
if _trust_proxy:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

app.register_blueprint(sso_module.bp)
from blueprints.health import bp as health_bp
app.register_blueprint(health_bp)
from blueprints.auth import bp as auth_bp
app.register_blueprint(auth_bp)
from blueprints.files import bp as files_bp
app.register_blueprint(files_bp)
from blueprints.settings import bp as settings_bp
app.register_blueprint(settings_bp)
from blueprints.buckets import bp as buckets_bp
app.register_blueprint(buckets_bp)
from blueprints.search import bp as search_bp
app.register_blueprint(search_bp)
from blueprints.pages import bp as pages_bp
app.register_blueprint(pages_bp)

configure_werkzeug_access_log()

HTTP_REQUESTS_TOTAL = Counter(
    's3_file_manager_http_requests_total',
    'Total HTTP requests handled by the service.',
    ['method', 'endpoint', 'status'],
)
HTTP_REQUEST_DURATION_SECONDS = Histogram(
    's3_file_manager_http_request_duration_seconds',
    'HTTP request latency in seconds.',
    ['method', 'endpoint'],
)


def _request_log_context(method, path):
    """Map HTTP method/path to log context tag (replaces generic http_request where applicable)."""
    if method == 'DELETE':
        if path == '/files/delete':
            return 'delete_objects'
        if path.startswith('/api/settings/users/'):
            return 'delete_objects'
        if path.startswith('/api/settings/roles/'):
            return 'delete_objects'
        if path.startswith('/api/settings/clouds/'):
            return 'delete_objects'
        if path.startswith('/api/settings/buckets/'):
            return 'delete_objects'
    if method == 'POST':
        if path == '/api/login':
            return 'login'
        if path.startswith('/api/auth/sso/'):
            return 'sso_login'
        if path == '/files/upload':
            return 'upload_objects'
        if path in (
            '/api/settings/users',
            '/api/settings/roles',
            '/api/settings/buckets',
            '/api/settings/clouds',
        ):
            return 'create_objects'
    if method == 'GET':
        if path == '/api/buckets':
            return 'list_buckets'
        if path.startswith('/api/bucket-size/'):
            return 'bucket_size'
        if path == '/files':
            return 'list_objects'
    return 'http_request'


def _format_request_path_for_log(path, query_string):
    """Decode percent-encoding in URL for readable logs (Cyrillic paths, etc.)."""
    path = unquote(path)
    if not query_string:
        return path
    qs = query_string.decode('utf-8', errors='replace')
    parts = []
    for pair in qs.split('&'):
        if not pair:
            continue
        if '=' in pair:
            key, value = pair.split('=', 1)
            parts.append(f"{unquote(key, errors='replace')}={unquote(value, errors='replace')}")
        else:
            parts.append(unquote(pair, errors='replace'))
    return f"{path}?{'&'.join(parts)}"


# Без входа доступны только логин, статика и перечисленные ниже обработчики.
PUBLIC_ENDPOINTS = frozenset({
    'auth.login_page',
    'auth.login',
    'auth.logout',
    'auth.check_auth',
    'auth.set_locale',
    'health.healthz_live',
    'health.healthz_ready',
    'health.metrics',
    'pages.serve_css',
    'pages.serve_js',
    'pages.serve_img',
    'static',
}) | sso_module.public_endpoint_names()


def _auth_failure_returns_json():
    """Для HTTP API отвечаем 401 JSON; для обычных URL в браузере — редирект на страницу входа."""
    p = request.path
    if p.startswith('/api/'):
        return True
    if p == '/files' or p.startswith('/files/upload') or p.startswith('/files/create-folder') \
            or p.startswith('/files/delete') or p.startswith('/files/download-archive'):
        return True
    return False


def _is_public_request():
    if request.endpoint in PUBLIC_ENDPOINTS:
        return True
    p = request.path
    if p in ('/health', '/healthz/live', '/healthz/ready', '/metrics'):
        return True
    if p.startswith('/css/') or p.startswith('/js/') or p.startswith('/img/') or p.startswith('/static/'):
        return True
    return False


def _auth_required_response(session_expired=False):
    if _auth_failure_returns_json():
        key = 'error.session_expired' if session_expired else 'error.auth_required'
        return jsonify({'error': _(key)}), 401
    return redirect(url_for('auth.login_page'))


def _csrf_required_for_request() -> bool:
    """CSRF для mutating-методов при активной сессии (кроме login)."""
    if request.method in CSRF_SAFE_METHODS:
        return False
    if not session.get('logged_in'):
        return False
    # Логин не требует CSRF (сессии ещё нет / перелогин)
    if request.endpoint in ('login', 'auth.login') or request.path == '/api/login':
        return False
    # SSO browser redirects — GET; POST token exchange идёт server-side
    if request.endpoint and str(request.endpoint).startswith('sso.'):
        return False
    return True


def _csrf_failure_response():
    return jsonify({'error': _('error.csrf_invalid')}), 403


# Middleware для установки username в контексте и логирования запросов
@app.before_request
def before_request_metrics():
    g.metrics_start_time = time.perf_counter()


@app.before_request
def before_request():
    """Устанавливает имя пользователя для логов и логирует запросы"""
    p = request.path
    if p.startswith('/css/') or p.startswith('/js/') or p.startswith('/img/') or p in ('/health', '/healthz/live', '/healthz/ready', '/metrics'):
        return None

    # Устанавливаем имя пользователя для логов
    if session.get('logged_in'):
        set_log_username(session.get('username', 'ANONYMOUS'))
    else:
        set_log_username('ANONYMOUS')

    # Логируем запрос (статика уже отфильтрована выше)
    context = _request_log_context(request.method, request.path)
    path_for_log = _format_request_path_for_log(request.path, request.query_string)
    log_info(f"{request.method} {path_for_log}", context)

    # Локализация: определяем язык из ?lang=, session или Accept-Language
    g.locale = get_locale_from_request(request)
    session['locale'] = g.locale

    # Гостю любой URL (кроме логина и статики) ведёт на /login; API — 401 JSON.
    if _is_public_request():
        if session.get('logged_in') and is_session_valid():
            update_session_activity()
            if _csrf_required_for_request() and not validate_csrf(session, request):
                return _csrf_failure_response()
        return None

    if not session.get('logged_in'):
        return _auth_required_response(session_expired=False)

    if not is_session_valid():
        username = session.get('username', 'Unknown')
        session.clear()
        log_info(f'Session expired for user {username}', 'session_timeout')
        return _auth_required_response(session_expired=True)

    update_session_activity()
    if _csrf_required_for_request() and not validate_csrf(session, request):
        return _csrf_failure_response()
    return None


@app.context_processor
def inject_i18n():
    """Передаёт в шаблоны локаль, словарь переводов и функцию _."""
    locale = getattr(g, 'locale', 'en')
    csrf = ''
    if session.get('logged_in'):
        csrf = ensure_csrf_token(session)
    return {
        'locale': locale,
        'i18n': get_translations(locale),
        '_': _,
        'SUPPORTED_LOCALES': SUPPORTED_LOCALES,
        'csrf_token': csrf,
    }


@app.errorhandler(413)
def request_entity_too_large(error):
    """Ответ JSON для 413 (файл слишком большой). Лимит задаётся MAX_UPLOAD_MB и nginx client_max_body_size."""
    msg = _('error.upload_too_large').replace('{max_mb}', str(MAX_UPLOAD_MB))
    return jsonify({'error': msg, 'max_mb': MAX_UPLOAD_MB}), 413

# Срок жизни cookie языка (1 год), чтобы выбранный язык сохранялся постоянно
LOCALE_COOKIE_MAX_AGE = 365 * 24 * 3600



@app.after_request
def after_request_metrics(response):
    start = getattr(g, 'metrics_start_time', None)
    if start is not None:
        duration = max(0.0, time.perf_counter() - start)
        endpoint = request.endpoint or 'unknown'
        method = request.method
        status = str(response.status_code)
        HTTP_REQUESTS_TOTAL.labels(method=method, endpoint=endpoint, status=status).inc()
        HTTP_REQUEST_DURATION_SECONDS.labels(method=method, endpoint=endpoint).observe(duration)
    return response


@app.after_request
def set_locale_cookie_from_query(response):
    """При заходе с ?lang= устанавливаем постоянную cookie, чтобы язык сохранялся при следующих визитах."""
    if request.args.get('lang') in SUPPORTED_LOCALES:
        response.set_cookie('locale', request.args.get('lang'), **_locale_cookie_kwargs())
    return response

def _run_app_startup():
    with app.app_context():
        set_log_username('SYSTEM')
        log_info('Starting S3 File Manager...', 'app_info')
        log_info(f'Session timeout: {APP_SESSION_TIMEOUT_MINUTES} minutes', 'app_info')
        if sso_module.is_sso_enabled():
            log_info(
                f"SSO (OIDC): enabled, sso_only={sso_module.is_sso_only()} "
                '(client initializes on first SSO login)',
                'app_info',
            )
        else:
            log_info('SSO (OIDC): disabled (SSO_ENABLED unset or incomplete configuration)', 'app_info')
        last_db_err = None
        for attempt in range(1, 31):
            try:
                db_init_schema()
                ensure_startup_admin()
                log_info('Database schema verified/created', 'app_info')
                last_db_err = None
                break
            except Exception as e:
                last_db_err = e
                log_warning(
                    f'Database unavailable (attempt {attempt}/30): {e}',
                    'app_info',
                )
                time.sleep(2)
        if last_db_err:
            log_warning(
                f'Database unavailable or schema not created: {last_db_err}',
                'app_info',
            )
        log_info('Checking bucket configuration...', 'app_info')

        total_buckets = 0
        buckets_with_creds = 0
        buckets_with_ids = 0
        bucket_id_usage = {}

        for group_id, group_data in get_buckets_config().items():
            group_buckets = len(group_data['buckets'])
            total_buckets += group_buckets

            for display_name, bucket_config in group_data['buckets'].items():
                bucket_name = bucket_config.get('bucket_name', '')
                bucket_id = bucket_config.get('bucket_id', display_name)

                has_creds = bool(bucket_config.get('aws_access_key_id')) and bool(bucket_config.get('aws_secret_access_key'))
                if has_creds:
                    buckets_with_creds += 1

                if bucket_id != display_name:
                    buckets_with_ids += 1

                if bucket_id in bucket_id_usage:
                    bucket_id_usage[bucket_id].append(f"{group_id}/{display_name}")
                else:
                    bucket_id_usage[bucket_id] = [f"{group_id}/{display_name}"]

                if not bucket_name:
                    log_warning(f'Bucket missing bucket_name: {display_name}', 'app_info')

        for bucket_id, locations in bucket_id_usage.items():
            if len(locations) > 1:
                log_warning(
                    f"Non-unique bucket_id '{bucket_id}' used in {len(locations)} places: {', '.join(locations)}",
                    'app_info',
                )

        log_info(
            f'Total buckets: {total_buckets}, with credentials: {buckets_with_creds}, '
            f'without credentials: {total_buckets - buckets_with_creds}',
            'app_info',
        )
        log_info(f'Buckets with custom bucket_id: {buckets_with_ids}', 'app_info')

        if total_buckets - buckets_with_creds > 0:
            log_warning(
                f'Found {total_buckets - buckets_with_creds} buckets without configured credentials',
                'app_info',
            )

        meili = meilisearch.connection_status()
        if meili.get('config_error'):
            log_error(f"Meilisearch: {meili['config_error']}", 'app_info')
        elif meili['configured']:
            if meili['available']:
                log_info(f"Meilisearch: connected ({meili['host']})", 'app_info')
                meili_env = meili.get('env') or {}
                if meili_env.get('MEILI_PERIODIC_SYNC') == 'true':
                    log_info(
                        'Meilisearch: auto-sync '
                        f"{meili_env.get('MEILI_SYNC_AT', '—')} "
                        f"({meili_env.get('MEILI_SYNC_TIMEZONE', 'UTC')}), "
                        f"next run: {meili_env.get('MEILI_SYNC_NEXT', '—')}",
                        'app_info',
                    )
                meilisearch.schedule_startup_reindex(
                    get_buckets_config, get_s3_client_for_reindex, app=app,
                )
                meilisearch.schedule_periodic_sync(
                    get_buckets_config, get_s3_client_for_reindex, app=app,
                )
            else:
                log_warning(
                    f"Meilisearch: unavailable at {meili['host']}, search via S3",
                    'app_info',
                )
        else:
            log_info('Meilisearch: disabled, search via S3 (set MEILI_ENABLED=true and MEILI_HOST)', 'app_info')

_startup_lock = threading.Lock()
_startup_started = False


def start_background_init():
    """Запуск фоновой инициализации один раз на процесс (Flask / gunicorn post_fork)."""
    global _startup_started
    with _startup_lock:
        if _startup_started:
            return
        _startup_started = True
    threading.Thread(target=_run_app_startup, name='app-startup', daemon=True).start()


if __name__ == '__main__':
    # Debug/reloader только при явном FLASK_DEBUG/APP_DEBUG=true (в prod по умолчанию выключено).
    _dev_debug = os.environ.get('FLASK_DEBUG', os.environ.get('APP_DEBUG', 'false')).strip().lower() in (
        '1', 'true', 'yes', 'on',
    )
    _dev_use_reloader = _dev_debug

    # Werkzeug reloader: родитель только перезапускает воркер, логи/инициализацию делаем один раз —
    # в дочернем процессе (WERKZEUG_RUN_MAIN=true). Если reloader выключён — один процесс, env не выставлен.
    _run_startup_block = (
        os.environ.get('WERKZEUG_RUN_MAIN') == 'true'
        or not (_dev_debug and _dev_use_reloader)
    )

    if _run_startup_block:
        start_background_init()

    app.run(debug=_dev_debug, host='0.0.0.0', port=3000, use_reloader=_dev_use_reloader)
