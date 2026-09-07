"""Проверки безопасности URL и endpoint (облака, бакеты, публичные ссылки на объекты)."""

import hmac
import ipaddress
import os
import secrets
import socket
from urllib.parse import quote, urlparse, urlunparse

from db import get_cloud_row

CSRF_HEADER = 'X-CSRF-Token'
CSRF_FORM_FIELD = 'csrf_token'
CSRF_SAFE_METHODS = frozenset({'GET', 'HEAD', 'OPTIONS', 'TRACE'})


def ensure_csrf_token(session) -> str:
    """Гарантирует наличие csrf_token в session и возвращает его."""
    token = session.get('csrf_token')
    if not token or not isinstance(token, str):
        token = secrets.token_hex(16)
        session['csrf_token'] = token
    return token


def _extract_csrf_from_request(request) -> str:
    header = (request.headers.get(CSRF_HEADER) or '').strip()
    if header:
        return header
    if request.form is not None:
        form_val = (request.form.get(CSRF_FORM_FIELD) or '').strip()
        if form_val:
            return form_val
    # JSON body (если уже распарсен / можно безопасно прочитать)
    if request.is_json:
        try:
            data = request.get_json(silent=True) or {}
            if isinstance(data, dict):
                return str(data.get(CSRF_FORM_FIELD) or '').strip()
        except Exception:
            pass
    return ''


def validate_csrf(session, request) -> bool:
    """Сравнение CSRF из session с заголовком/формой (constant-time)."""
    expected = session.get('csrf_token')
    if not expected or not isinstance(expected, str):
        return False
    provided = _extract_csrf_from_request(request)
    if not provided:
        return False
    return hmac.compare_digest(expected, provided)


def normalize_endpoint_url(url):
    """Нормализация endpoint URL для сравнения."""
    raw = (url or '').strip()
    if not raw:
        return ''
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return raw.rstrip('/').lower()
    path = (parsed.path or '').rstrip('/')
    return urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        path,
        '',
        '',
        '',
    ))


def build_object_url(bucket_name, endpoint_url, object_key):
    """Публичный URL объекта: {endpoint_host}/{bucket_name}/{object_key}."""
    bn = (bucket_name or '').strip()
    ep = (endpoint_url or '').strip()
    key = (object_key or '').strip().lstrip('/')
    if not bn or not ep or not key:
        return ''

    if '://' not in ep:
        ep = 'https://' + ep

    parsed = urlparse(ep)
    if not parsed.scheme or not parsed.netloc:
        return ''

    encoded_bucket = quote(bn, safe='')
    encoded_key = '/'.join(quote(part, safe='') for part in key.split('/'))
    path = f'/{encoded_bucket}/{encoded_key}'
    return urlunparse((parsed.scheme, parsed.netloc, path, '', '', ''))


def is_forbidden_endpoint_host(hostname):
    """Блокирует localhost, link-local, private и metadata-хосты."""
    host = (hostname or '').strip().lower().rstrip('.')
    if not host:
        return True
    if host in ('localhost', 'metadata.google.internal', 'metadata'):
        return True
    if host.endswith('.localhost') or host.endswith('.local'):
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def is_always_forbidden_ip(addr) -> bool:
    """IP, запрещённые всегда (metadata / loopback), даже при allow_private."""
    return (
        addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
        or addr.is_reserved
    )


def _env_allow_private_resolve() -> bool:
    """Разрешить RFC1918 после DNS (внутренние S3). По умолчанию true."""
    return (os.environ.get('ENDPOINT_ALLOW_PRIVATE_RESOLVE') or 'true').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )


def resolve_hostname_addresses(hostname, *, timeout_sec=3.0):
    """DNS resolve → список ipaddress. Пустой список — resolve не удался."""
    host = (hostname or '').strip().rstrip('.')
    if not host:
        return []
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass
    prev_timeout = socket.getdefaulttimeout()
    try:
        socket.setdefaulttimeout(timeout_sec)
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, OSError):
        return []
    finally:
        socket.setdefaulttimeout(prev_timeout)

    addrs = []
    seen = set()
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        ip_str = sockaddr[0]
        if ip_str in seen:
            continue
        seen.add(ip_str)
        try:
            addrs.append(ipaddress.ip_address(ip_str))
        except ValueError:
            continue
    return addrs


def hostname_dns_forbidden(hostname, *, allow_private=False):
    """
    True, если после DNS hostname указывает на запрещённый адрес (rebinding).
    allow_private=True — RFC1918 допустимы; loopback/link-local/metadata — всегда нет.
    """
    host = (hostname or '').strip().lower().rstrip('.')
    if not host:
        return True
    try:
        addr = ipaddress.ip_address(host)
        if is_always_forbidden_ip(addr):
            return True
        if addr.is_private and not allow_private:
            return True
        return False
    except ValueError:
        pass

    addrs = resolve_hostname_addresses(host)
    if not addrs:
        return False
    for addr in addrs:
        if is_always_forbidden_ip(addr):
            return True
        if addr.is_private and not allow_private:
            return True
    return False


def endpoint_url_scheme_allowed(url):
    parsed = urlparse((url or '').strip())
    return parsed.scheme in ('http', 'https') and bool(parsed.netloc)


def allowed_endpoints_for_cloud(cloud_id):
    """Разрешённые endpoint URL для облака — только из записи clouds."""
    urls = set()
    cloud = get_cloud_row(cloud_id)
    if not cloud:
        return urls
    endpoints = cloud.get('endpoint_url')
    if isinstance(endpoints, list):
        for item in endpoints:
            normalized = normalize_endpoint_url(item)
            if normalized:
                urls.add(normalized)
    else:
        normalized = normalize_endpoint_url(endpoints)
        if normalized:
            urls.add(normalized)
    return urls


def validate_endpoint_url(
    endpoint_url,
    *,
    cloud_id=None,
    require_allowlist=False,
    check_dns=True,
):
    """
    Проверка endpoint URL.
    require_allowlist=True — URL должен быть зарегистрирован у cloud_id в clouds.
    check_dns — после DNS блокируются loopback/link-local/metadata;
    private после DNS: для allowlist разрешены; иначе — ENDPOINT_ALLOW_PRIVATE_RESOLVE.
    """
    normalized = normalize_endpoint_url(endpoint_url)
    if not normalized:
        return False, 'error.endpoint_url_required'
    if not endpoint_url_scheme_allowed(normalized):
        return False, 'error.endpoint_url_invalid'
    parsed = urlparse(normalized)
    if is_forbidden_endpoint_host(parsed.hostname):
        return False, 'error.endpoint_host_forbidden'

    allow_private = False
    if require_allowlist:
        cid = (cloud_id or '').strip()
        if not cid:
            return False, 'error.cloud_id_invalid'
        allowed = allowed_endpoints_for_cloud(cid)
        if not allowed:
            return False, 'error.cloud_not_registered'
        if normalized not in allowed:
            return False, 'error.endpoint_not_allowed'
        allow_private = True
    else:
        allow_private = _env_allow_private_resolve()

    if check_dns and hostname_dns_forbidden(parsed.hostname, allow_private=allow_private):
        return False, 'error.endpoint_host_forbidden'
    return True, None
