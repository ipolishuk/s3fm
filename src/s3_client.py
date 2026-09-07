"""S3 client factory, error mapping, and preview disposition helpers."""

from __future__ import annotations

import os
import re
import ssl
import threading
from urllib.parse import quote

import boto3
import urllib3
from botocore.config import Config
from botocore.session import Session as BotocoreSession

from logs import LOG_CONFIG, log_error, log_info, log_warning, trf_en
from translations import _


def _trf(key, **kwargs):
    """Локализованная строка с подстановкой {placeholders}."""
    text = _(key)
    for k, v in kwargs.items():
        text = text.replace('{' + str(k) + '}', str(v))
    return text


_PREVIEWABLE_CONTENT_TYPES = frozenset({
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'application/pdf',
    'application/json',
    'text/plain',
    'text/json',
    'text/markdown',
    'text/x-markdown',
    'text/css',
    'text/html',
    'application/xhtml+xml',
})
_PREVIEWABLE_EXTENSIONS = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/plain',
    '.markdown': 'text/plain',
    '.css': 'text/css',
    '.html': 'text/html',
    '.htm': 'text/html',
}
_PREVIEW_HTML_MIMETYPES = frozenset({
    'text/html',
    'application/xhtml+xml',
})


def _content_disposition(filename: str, disposition: str = 'attachment') -> str:
    """Content-Disposition (HTTP-заголовки только latin-1, RFC 5987 для Unicode)."""
    disp = disposition if disposition in ('attachment', 'inline') else 'attachment'
    name = (filename or 'download').replace('\r', '').replace('\n', '')
    if not name:
        name = 'download'
    try:
        name.encode('latin-1')
    except UnicodeEncodeError:
        encoded = quote(name, safe='')
        ascii_fallback = re.sub(r'[^\x20-\x7E]', '_', name).strip('._') or 'download'
        ascii_fallback = ascii_fallback.replace('\\', '\\\\').replace('"', '\\"')
        return f"{disp}; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}"
    escaped = name.replace('\\', '\\\\').replace('"', '\\"')
    return f'{disp}; filename="{escaped}"'


def _content_disposition_attachment(filename: str) -> str:
    """Content-Disposition для скачивания."""
    return _content_disposition(filename, 'attachment')


def _resolve_preview_mimetype(content_type: str, object_key: str):
    """MIME для inline-предпросмотра или None, если тип не поддерживается."""
    ct = (content_type or '').split(';')[0].strip().lower()
    if ct in ('text/markdown', 'text/x-markdown'):
        return 'text/plain'
    if ct in _PREVIEWABLE_CONTENT_TYPES:
        return ct
    ext = os.path.splitext(object_key or '')[1].lower()
    return _PREVIEWABLE_EXTENSIONS.get(ext)


def _map_s3_client_error(e, bucket_display=''):
    """Нормализует ClientError в (message, http_status)."""
    error = getattr(e, 'response', {}).get('Error', {}) if e else {}
    error_code = error.get('Code', '')
    error_message = error.get('Message') or str(e)
    name = bucket_display or 'bucket'
    if error_code in ('InvalidAccessKeyId', 'SignatureDoesNotMatch'):
        return _trf('error.bucket_credentials_invalid_for', name=name), 500
    if error_code == 'AccessDenied':
        return _trf('error.bucket_access_denied_for', name=name), 403
    if error_code == 'NoSuchBucket':
        return _trf('error.bucket_not_exists_for', name=name), 404
    if error_code == 'NoSuchKey':
        return _trf('error.s3_object_not_found', path=''), 404
    if str(error_message).strip().lower() == 'forbidden':
        return _trf('error.bucket_access_denied_for', name=name), 403
    return (str(error_message).strip() or _trf('error.unexpected')), 500


def _map_s3_runtime_error(e, bucket_display=''):
    """Нормализует runtime-исключения S3 в (message, http_status)."""
    error_msg = str(e).lower()
    name = bucket_display or 'bucket'
    if 'credentials' in error_msg or 'access key' in error_msg:
        return _trf('error.bucket_credentials_invalid_for', name=name), 500
    if 'ssl' in error_msg or 'certificate' in error_msg:
        return _trf('error.bucket_ssl_problem_for', name=name), 500
    if 'endpoint' in error_msg:
        return _trf('error.bucket_endpoint_invalid_for', name=name), 500
    if 'connection' in error_msg:
        return _trf('error.bucket_endpoint_unreachable_for', name=name), 500
    if 'timeout' in error_msg:
        return _trf('error.s3_timeout'), 500
    return _trf('error.unexpected'), 500


def create_s3_session_with_ca_bundle(ca_bundle_path=None):
    """Создает сессию с кастомным CA bundle"""
    if ca_bundle_path and os.path.exists(ca_bundle_path):
        # Создаем кастомную SSL контекст с CA bundle
        ssl_context = ssl.create_default_context(cafile=ca_bundle_path)

        # Создаем кастомную сессию botocore
        botocore_session = BotocoreSession()

        # Настраиваем HTTP клиент с кастомным SSL контекстом
        from botocore.httpession import URLLib3Session
        http_session = URLLib3Session()
        http_session._manager.poolmanager.connection_pool_kw['ssl_context'] = ssl_context

        # Сохраняем HTTP сессию в botocore сессии
        botocore_session._components.register_component('http_session', lambda: http_session)

        return botocore_session
    return None

def _skip_tls_verify_enabled(bucket_config):
    """True, если в конфиге бакета явно отключена проверка TLS (как в БД: bool или строки)."""
    v = bucket_config.get('skip_tls_verify')
    if v is True:
        return True
    if isinstance(v, str):
        return v.lower() in ('true', '1', 'yes')
    return False


def _reindex_s3_read_timeout():
    try:
        import meilisearch as meili_mod
        return meili_mod._reindex_s3_read_timeout()
    except Exception:
        raw = os.environ.get('MEILI_REINDEX_S3_READ_TIMEOUT', '900').strip()
        try:
            return max(60, int(raw))
        except ValueError:
            return 900


def get_s3_client_for_reindex(bucket_config):
    """S3-клиент с увеличенным read_timeout для полного листинга больших бакетов."""
    return get_s3_client(bucket_config, read_timeout=_reindex_s3_read_timeout())


_s3_client_cache = {}
_s3_client_cache_lock = threading.Lock()


def _resolve_s3_ca_verify_path(bucket_config):
    """Путь к CA bundle для S3-клиента (из конфига бакета или env).

    Если у бакета нет ca_bundle_path, всё равно берём REQUESTS_CA_BUNDLE /
    SSL_CERT_FILE / AWS_CA_BUNDLE — иначе boto3 verify=True ходит в certifi
    без CA и падает на idp с self-signed in chain.
    """
    context = 's3_client'
    ca_configured = (bucket_config.get('ca_bundle_path') or '').strip()
    if ca_configured and os.path.isfile(ca_configured):
        return ca_configured
    if ca_configured:
        log_warning(
            f'CA bundle from config not found on this host: {ca_configured}. '
            f'Falling back to REQUESTS_CA_BUNDLE / SSL_CERT_FILE / AWS_CA_BUNDLE.',
            context,
        )
    for env_key in ('REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'AWS_CA_BUNDLE'):
        ev = (os.environ.get(env_key) or '').strip()
        if ev and os.path.isfile(ev):
            if ca_configured:
                log_info(f'Using CA bundle from {env_key}: {ev}', context)
            return ev
    # Системный bundle (Debian/RHEL) — если ENV не задан, но CA уже в образе
    for candidate in (
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs/ca-bundle.crt',
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def _create_s3_client(
    *,
    access_key,
    secret_key,
    s3_base_url,
    region_name,
    ca_verify_path,
    skip_tls_verify,
    read_timeout,
):
    """Создаёт новый boto3 S3-клиент (без кэша)."""
    context = 's3_client'
    if ca_verify_path:
        log_info(f'TLS verification with CA bundle: {ca_verify_path}', context)
        config = Config(
            signature_version='s3v4',
            connect_timeout=10,
            read_timeout=read_timeout,
            retries={
                'max_attempts': 2,
                'mode': 'standard',
            },
            max_pool_connections=10,
        )
        return boto3.client(
            's3',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            endpoint_url=s3_base_url,
            region_name=region_name,
            config=config,
            verify=ca_verify_path,
        )

    verify_ssl = not skip_tls_verify
    if skip_tls_verify:
        log_warning(f'TLS verification disabled (skip_tls_verify) for endpoint: {s3_base_url}', context)
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    return boto3.client(
        's3',
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        endpoint_url=s3_base_url,
        region_name=region_name,
        config=boto3.session.Config(
            signature_version='s3v4',
            connect_timeout=30,
            read_timeout=read_timeout,
            retries={'max_attempts': 3},
        ),
        verify=verify_ssl,
    )


def get_s3_client(bucket_config, *, read_timeout=None):
    """Создает и возвращает клиент S3 для конкретного бакета (кэш по параметрам подключения)."""
    context = 's3_client'
    try:
        if not bucket_config:
            error_msg = _trf('error.bucket_config_missing')
            log_error(trf_en('error.bucket_config_missing'), context)
            raise ValueError(error_msg)

        # Проверяем наличие credentials
        access_key = bucket_config.get('aws_access_key_id')
        secret_key = bucket_config.get('aws_secret_access_key')

        if not access_key or not secret_key:
            error_msg = _trf('error.bucket_credentials_missing')
            log_error(trf_en('error.bucket_credentials_missing'), context)
            raise ValueError(error_msg)

        # URL S3 из конфига бакета (уже должен быть унаследован из группы)
        s3_base_url = bucket_config.get('endpoint_url')

        if not s3_base_url:
            error_msg = _trf('error.bucket_endpoint_missing')
            log_error(trf_en('error.bucket_endpoint_missing'), context)
            raise ValueError(error_msg)

        # Базовый регион для совместимости с различными S3-совместимыми хранилищами
        region_name = bucket_config.get('region_name', 'us-east-1')
        ca_verify_path = _resolve_s3_ca_verify_path(bucket_config)
        skip_tls_verify = _skip_tls_verify_enabled(bucket_config)
        if read_timeout is not None:
            s3_read_timeout = read_timeout
        elif ca_verify_path:
            s3_read_timeout = 30
        else:
            s3_read_timeout = 60

        cache_key = (
            s3_base_url,
            access_key,
            secret_key,
            region_name,
            ca_verify_path or '',
            skip_tls_verify,
            s3_read_timeout,
        )
        with _s3_client_cache_lock:
            cached = _s3_client_cache.get(cache_key)
            if cached is not None:
                return cached
            s3_client = _create_s3_client(
                access_key=access_key,
                secret_key=secret_key,
                s3_base_url=s3_base_url,
                region_name=region_name,
                ca_verify_path=ca_verify_path,
                skip_tls_verify=skip_tls_verify,
                read_timeout=s3_read_timeout,
            )
            _s3_client_cache[cache_key] = s3_client
            return s3_client

    except Exception as e:
        error_msg = str(e).lower()
        if 'credentials' in error_msg:
            full_msg = _trf('error.bucket_credentials_problem')
            raise ValueError(full_msg)
        elif 'endpoint' in error_msg or 'url' in error_msg:
            full_msg = _trf('error.bucket_endpoint_problem')
            raise ValueError(full_msg)
        elif 'certificate' in error_msg or 'ssl' in error_msg:
            full_msg = _trf('error.bucket_ssl_problem')
            log_error(trf_en('error.bucket_ssl_problem'), context, e)
            raise ValueError(full_msg)
        else:
            full_msg = _trf('error.s3_client_create_failed')
            log_error(trf_en('error.s3_client_create_failed'), context, e, LOG_CONFIG['show_traceback'])
            raise ValueError(full_msg)

