"""LDAP/AD lookup for admin «Add user» form (adapted from ldap-viewer)."""
from __future__ import annotations

import os
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

try:
    from ldap3 import ALL, NONE, Connection, Server, SUBTREE, Tls
    from ldap3.utils.conv import escape_filter_chars
    _LDAP3_AVAILABLE = True
except ImportError:  # pragma: no cover
    ALL = NONE = Connection = Server = SUBTREE = Tls = None  # type: ignore
    escape_filter_chars = None  # type: ignore
    _LDAP3_AVAILABLE = False


LDAP_QUERY_MIN_LENGTH = 6
LDAP_LOOKUP_RESULT_LIMIT = 25
# LDAP_URI часто резолвится в несколько DC; из k8s доступны не все —
# ldap3 перебирает A-записи и «висит» десятки секунд. Кэшируем живой IP.
_REACHABLE_CACHE_TTL_SEC = 60.0
_reachable_cache: Dict[str, Any] = {}


class LDAPServiceError(Exception):
    """Ошибка конфигурации / подключения / поиска LDAP."""


class LDAPNotConfigured(LDAPServiceError):
    """LDAP lookup выключен или не заданы обязательные переменные."""


class LDAPUserNotFound(LDAPServiceError):
    """Пользователь с таким sAMAccountName не найден."""


class LDAPQueryTooShort(LDAPServiceError):
    """Слишком короткий поисковый запрос."""


def _env(name: str, default: str = '') -> str:
    return str(os.environ.get(name, default) or '').strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


def ldap_config() -> Dict[str, Any]:
    return {
        'uri': _env('LDAP_URI'),
        'base_dn': _env('LDAP_BASE_DN', 'DC=example,DC=com'),
        'domain': _env('LDAP_DOMAIN', 'example.com'),
        'bind_user': _env('LDAP_BIND_USER'),
        'bind_password': _env('LDAP_BIND_PASSWORD'),
        'size_limit': _env_int('LDAP_SEARCH_SIZE_LIMIT', 200),
        'time_limit': _env_int('LDAP_SEARCH_TIME_LIMIT', 5),
    }


def is_ldap3_available() -> bool:
    return bool(_LDAP3_AVAILABLE and Connection is not None)


def is_ldap_configured() -> bool:
    if not is_ldap3_available():
        return False
    cfg = ldap_config()
    return bool(cfg['uri'] and cfg['base_dn'] and cfg['bind_user'] and cfg['bind_password'])


def ldap_missing_config() -> List[str]:
    """Имена env-переменных, без которых lookup недоступен."""
    missing: List[str] = []
    if not is_ldap3_available():
        missing.append('ldap3')
    cfg = ldap_config()
    if not cfg['uri']:
        missing.append('LDAP_URI')
    if not cfg['base_dn']:
        missing.append('LDAP_BASE_DN')
    if not cfg['bind_user']:
        missing.append('LDAP_BIND_USER')
    if not cfg['bind_password']:
        missing.append('LDAP_BIND_PASSWORD')
    return missing


def connection_status() -> Dict[str, Any]:
    """
    Статус LDAP для админ-панели: configured / connected / detail.
    Делает bind (без поиска пользователей).
    """
    cfg = ldap_config()
    missing = ldap_missing_config()
    ldap3_ok = is_ldap3_available()
    bind_user = (cfg['bind_user'] or '').strip()
    # LDAP_DOMAIN нужен, если bind — короткий логин (не UPN и не DN).
    domain_required = bool(bind_user) and ('@' not in bind_user) and ('=' not in bind_user)
    domain_ok = bool(cfg['domain']) if domain_required else True
    vars_list = [
        {'name': 'ldap3', 'ok': ldap3_ok, 'required': True},
        {'name': 'LDAP_URI', 'ok': bool(cfg['uri']), 'required': True},
        {'name': 'LDAP_BASE_DN', 'ok': bool(cfg['base_dn']), 'required': True},
        {'name': 'LDAP_DOMAIN', 'ok': domain_ok and bool(cfg['domain']), 'required': domain_required},
        {'name': 'LDAP_BIND_USER', 'ok': bool(cfg['bind_user']), 'required': True},
        {'name': 'LDAP_BIND_PASSWORD', 'ok': bool(cfg['bind_password']), 'required': True},
    ]
    if domain_required and not cfg['domain'] and 'LDAP_DOMAIN' not in missing:
        missing = list(missing) + ['LDAP_DOMAIN']
    meta = {
        'uri': cfg['uri'] or None,
        'base_dn': cfg['base_dn'] or None,
        'domain': cfg['domain'] or None,
        'bind_user': cfg['bind_user'] or None,
        'ldap3_installed': ldap3_ok,
        'missing': missing,
        'query_min_length': LDAP_QUERY_MIN_LENGTH,
    }
    base = {
        'id': 'ldap',
        'vars': vars_list,
        'meta': meta,
    }
    if missing:
        return {
            **base,
            'configured': False,
            'connected': False,
            'status': 'not_configured',
            'detail': '',
        }

    # Bind в daemon-thread: страховка, если SSL/ldap3 всё же зависнет.
    box: Dict[str, Any] = {}

    def _probe() -> None:
        try:
            conn = _create_service_connection(
                connect_timeout=5, receive_timeout=10, get_schema=False,
            )
            try:
                bound = bool(getattr(conn, 'bound', True))
            finally:
                try:
                    conn.unbind()
                except Exception:
                    pass
            if not bound:
                box['result'] = {
                    **base,
                    'configured': True,
                    'connected': False,
                    'status': 'error',
                    'detail': 'LDAP bind failed',
                }
                return
            endpoint = _reachable_cache.get('ip')
            if not endpoint and cfg['uri']:
                try:
                    endpoint = _parse_ldap_uri(cfg['uri'])[0]
                except Exception:
                    endpoint = cfg['uri']
            endpoint = endpoint or 'ldap'
            box['result'] = {
                **base,
                'configured': True,
                'connected': True,
                'status': 'ok',
                'detail': f'Connected to {endpoint}',
            }
        except LDAPServiceError as exc:
            box['result'] = {
                **base,
                'configured': True,
                'connected': False,
                'status': 'error',
                'detail': str(exc)[:240],
            }
        except Exception as exc:
            box['result'] = {
                **base,
                'configured': True,
                'connected': False,
                'status': 'error',
                'detail': f'LDAP probe failed: {exc}'[:240],
            }

    thr = threading.Thread(target=_probe, name='ldap-status-probe', daemon=True)
    thr.start()
    thr.join(12.0)
    if thr.is_alive():
        return {
            **base,
            'configured': True,
            'connected': False,
            'status': 'error',
            'detail': 'LDAP bind timed out',
        }
    return box.get('result') or {
        **base,
        'configured': True,
        'connected': False,
        'status': 'error',
        'detail': 'LDAP probe failed',
    }


def _warn_insecure_ldap_uri(uri: str) -> None:
    """Log once if URI is cleartext ldap:// (bind password would not be TLS-protected)."""
    if not uri.lower().startswith('ldap://'):
        return
    # Avoid spamming: attribute on function
    if getattr(_warn_insecure_ldap_uri, '_done', False):
        return
    _warn_insecure_ldap_uri._done = True  # type: ignore[attr-defined]
    try:
        from logs import log_warning
        log_warning(
            'LDAP_URI uses ldap:// (not ldaps://); bind credentials are not TLS-protected',
            'ldap_client',
        )
    except Exception:
        pass


def build_bind_user(login_or_dn: str, domain: str) -> str:
    clean = (login_or_dn or '').strip()
    if not clean:
        raise LDAPServiceError('LDAP bind user is empty')
    # Full DN or already UPN
    if '=' in clean or '@' in clean:
        return clean
    domain = (domain or '').strip()
    if not domain:
        raise LDAPServiceError('LDAP_DOMAIN is required when LDAP_BIND_USER is a short login')
    return f'{clean}@{domain}'


def _parse_ldap_uri(uri: str) -> Tuple[str, int, bool]:
    raw = (uri or '').strip()
    if not raw:
        raise LDAPServiceError('LDAP_URI is empty')
    if '://' not in raw:
        raw = 'ldaps://' + raw
    parsed = urlparse(raw)
    host = parsed.hostname
    if not host:
        raise LDAPServiceError('LDAP_URI has no host')
    use_ssl = (parsed.scheme or 'ldaps').lower() == 'ldaps'
    port = parsed.port or (636 if use_ssl else 389)
    return host, int(port), use_ssl


def _pick_reachable_ldap_endpoint(
    uri: str,
    *,
    per_try_timeout: float = 1.5,
) -> Tuple[str, str, int, bool]:
    """
    Вернуть (tls_hostname, ip, port, use_ssl).
    Берём первый TCP-доступный A/AAAA — иначе open() к multi-homed AD занимает ~N×timeout.
    """
    host, port, use_ssl = _parse_ldap_uri(uri)
    now = time.time()
    if (
        _reachable_cache.get('uri') == uri
        and _reachable_cache.get('ip')
        and float(_reachable_cache.get('expires') or 0) > now
    ):
        return (
            str(_reachable_cache['host']),
            str(_reachable_cache['ip']),
            int(_reachable_cache['port']),
            bool(_reachable_cache['use_ssl']),
        )

    # FQDN + trailing dot: в k8s часто search=…,example.com и ndots:5 —
    # getaddrinfo('example.com') без точки даёт Name does not resolve,
    # а 'example.com.' резолвится нормально.
    lookup_host = host if host.endswith('.') else (f'{host}.' if '.' in host else host)
    try:
        infos = socket.getaddrinfo(lookup_host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise LDAPServiceError(f'LDAP DNS lookup failed for {host}: {exc}') from exc

    candidates: List[str] = []
    for info in infos:
        ip = info[4][0]
        if ip not in candidates:
            candidates.append(ip)
    if not candidates:
        raise LDAPServiceError(f'No addresses for LDAP host {host}')

    def _probe(ip: str) -> Optional[str]:
        try:
            sock = socket.create_connection((ip, port), timeout=per_try_timeout)
            sock.close()
            return ip
        except OSError:
            return None

    # Параллельный probe: иначе при 8 DC и одном живом ждём до ~N×timeout.
    from concurrent.futures import ThreadPoolExecutor, as_completed

    winner: Optional[str] = None
    with ThreadPoolExecutor(max_workers=min(8, len(candidates))) as pool:
        futures = {pool.submit(_probe, ip): ip for ip in candidates}
        for fut in as_completed(futures):
            ip = fut.result()
            if ip:
                winner = ip
                for other in futures:
                    other.cancel()
                break

    if not winner:
        raise LDAPServiceError(
            f'No reachable LDAP endpoint for {host}:{port} '
            f'(tried {len(candidates)} address(es))'
        )

    _reachable_cache.update(
        uri=uri,
        host=host,
        ip=winner,
        port=port,
        use_ssl=use_ssl,
        expires=now + _REACHABLE_CACHE_TTL_SEC,
    )
    return host, winner, port, use_ssl


def _create_service_connection(
    *,
    connect_timeout: int = 5,
    receive_timeout: int = 15,
    get_schema: bool = False,
) -> Connection:
    if Connection is None or Server is None:
        raise LDAPNotConfigured('ldap3 is not installed')
    if not is_ldap_configured():
        raise LDAPNotConfigured('LDAP is not configured')

    cfg = ldap_config()
    _warn_insecure_ldap_uri(cfg['uri'])
    bind_user = build_bind_user(cfg['bind_user'], cfg['domain'])
    # NONE — без загрузки schema (ALL сильно тормозит статус/поиск)
    info = ALL if get_schema else NONE
    tls_hostname, ip, port, use_ssl = _pick_reachable_ldap_endpoint(cfg['uri'])

    tls: Optional[Any] = None
    if use_ssl and Tls is not None:
        # Подключаемся по IP, сертификат проверяем на исходный hostname из LDAP_URI.
        try:
            tls = Tls(validate=ssl.CERT_REQUIRED, valid_names=[tls_hostname])
        except TypeError:
            tls = Tls(validate=ssl.CERT_REQUIRED)

    server = Server(
        ip,
        port=port,
        use_ssl=use_ssl,
        get_info=info,
        connect_timeout=max(1, int(connect_timeout)),
        tls=tls,
    )
    try:
        conn = Connection(
            server,
            user=bind_user,
            password=cfg['bind_password'],
            auto_bind=False,
            auto_referrals=False,
            receive_timeout=max(1, int(receive_timeout)),
        )
        if not conn.bind(read_server_info=bool(get_schema)):
            err = getattr(conn, 'last_error', None) or 'bind rejected'
            raise LDAPServiceError(f'LDAP bind failed: {err}')
        return conn
    except LDAPServiceError:
        raise
    except Exception as exc:
        # Сбросить кэш IP — возможно выбранный DC снова недоступен.
        _reachable_cache.clear()
        raise LDAPServiceError(f'LDAP bind failed: {exc}') from exc


def _entry_values(entry: object, attribute_name: str) -> list:
    if attribute_name not in entry:
        return []
    try:
        values = getattr(entry, attribute_name).values
    except Exception:
        return []
    return [str(value) for value in values if str(value)]


def _first(entry: object, *attribute_names: str) -> str:
    for name in attribute_names:
        values = _entry_values(entry, name)
        if values:
            return values[0].strip()
    return ''


@dataclass(frozen=True)
class LdapUser:
    username: str
    display_name: str
    email: str

    def as_dict(self) -> Dict[str, str]:
        return {
            'username': self.username,
            'display_name': self.display_name,
            'email': self.email,
        }


def _normalize_query(query: str) -> str:
    clean = (query or '').strip()
    if not clean:
        raise LDAPServiceError('Username is required')
    if len(clean) < LDAP_QUERY_MIN_LENGTH:
        raise LDAPQueryTooShort(
            f'Query must be at least {LDAP_QUERY_MIN_LENGTH} characters'
        )
    if '*' in clean or '(' in clean or ')' in clean:
        raise LDAPServiceError('Invalid username')
    return clean


def _entry_to_user(entry: object, fallback_username: str = '') -> LdapUser | None:
    login = _first(entry, 'sAMAccountName') or fallback_username
    if not login:
        return None
    display_name = _first(entry, 'displayName', 'cn') or login
    email = _first(entry, 'mail')
    return LdapUser(username=login, display_name=display_name, email=email)


def search_users(query: str, limit: int | None = None) -> Dict[str, Any]:
    """Partial AD lookup by sAMAccountName / displayName / cn / mail."""
    clean = _normalize_query(query)
    if escape_filter_chars is None or SUBTREE is None:
        raise LDAPNotConfigured('ldap3 is not installed')

    cfg = ldap_config()
    max_results = max(1, min(limit or LDAP_LOOKUP_RESULT_LIMIT, cfg['size_limit'] or LDAP_LOOKUP_RESULT_LIMIT))
    escaped = escape_filter_chars(clean)
    search_filter = (
        '(&(objectCategory=person)(objectClass=user)'
        f'(|(sAMAccountName=*{escaped}*)(displayName=*{escaped}*)'
        f'(cn=*{escaped}*)(mail=*{escaped}*)))'
    )

    conn = _create_service_connection()
    try:
        conn.search(
            cfg['base_dn'],
            search_filter,
            SUBTREE,
            attributes=['sAMAccountName', 'displayName', 'cn', 'mail'],
            size_limit=max_results,
            time_limit=cfg['time_limit'],
        )
        users: List[Dict[str, str]] = []
        seen = set()
        for entry in conn.entries or []:
            user = _entry_to_user(entry)
            if not user or user.username.lower() in seen:
                continue
            seen.add(user.username.lower())
            users.append(user.as_dict())
            if len(users) >= max_results:
                break

        return {
            'query': clean,
            'count': len(users),
            'users': users,
        }
    finally:
        try:
            conn.unbind()
        except Exception:
            pass


def lookup_user(username: str) -> LdapUser:
    """Backward-compatible single-user lookup (first partial match)."""
    payload = search_users(username, limit=1)
    users = payload.get('users') or []
    if not users:
        raise LDAPUserNotFound(f'User not found: {(username or "").strip()}')
    data = users[0]
    return LdapUser(
        username=data['username'],
        display_name=data['display_name'],
        email=data['email'],
    )


def lookup_user_payload(username: str) -> Dict[str, Any]:
    """Search payload for Flask jsonify: query, count, users[]."""
    return search_users(username)
