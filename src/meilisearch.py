"""Полнотекстовый поиск объектов S3 через Meilisearch (HTTP API, без внешнего SDK)."""
import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from contextlib import nullcontext
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_reindex_log_tls = threading.local()


def set_reindex_log_context(context: str) -> None:
    _reindex_log_tls.context = context


def reset_reindex_log_context() -> None:
    if hasattr(_reindex_log_tls, 'context'):
        del _reindex_log_tls.context


def _reindex_log_context() -> str:
    return getattr(_reindex_log_tls, 'context', 'meilisearch')


def _log_reindex_info(message: str) -> None:
    try:
        from logs import log_info
        log_info(message, _reindex_log_context())
    except Exception:
        logger.info(message)


def _log_reindex_warning(message: str) -> None:
    try:
        from logs import log_warning
        log_warning(message, _reindex_log_context())
    except Exception:
        logger.warning(message)


_INDEX_UID_MAX_LEN = 400
_DEFAULT_HOST = 'http://127.0.0.1:7700'
_BATCH_SIZE = 1000
_SEARCH_LIMIT = 2000
_DEFAULT_LARGE_BUCKET_THRESHOLD = 500_000
_DEFAULT_INDEX_PART_SIZE = 500_000
_DEFAULT_REINDEX_WORKERS = 2
_DEFAULT_HTTP_TIMEOUT = 30
_DEFAULT_REINDEX_HTTP_TIMEOUT = 600
_DEFAULT_REINDEX_S3_READ_TIMEOUT = 900

# Дефолты для public.meilisearch (seed) и fallback, если строки в БД ещё нет.
MEILI_SETTING_DEFAULTS = {
    'MEILI_ENABLED': 'false',
    'MEILI_HOST': '',
    'MEILI_API_KEY': '',
    'MEILI_PERIODIC_SYNC': 'true',
    'MEILI_SYNC_AT': '03:00',
    'MEILI_REINDEX_WORKERS': str(_DEFAULT_REINDEX_WORKERS),
    'MEILI_REINDEX_ON_STARTUP': 'false',
    'MEILI_SYNC_TIMEZONE': 'UTC',
    'MEILI_HTTP_TIMEOUT': str(_DEFAULT_HTTP_TIMEOUT),
    'MEILI_REINDEX_HTTP_TIMEOUT': str(_DEFAULT_REINDEX_HTTP_TIMEOUT),
    'MEILI_REINDEX_S3_READ_TIMEOUT': str(_DEFAULT_REINDEX_S3_READ_TIMEOUT),
    'MEILI_LARGE_BUCKET_THRESHOLD': str(_DEFAULT_LARGE_BUCKET_THRESHOLD),
    'MEILI_INDEX_PART_SIZE': str(_DEFAULT_INDEX_PART_SIZE),
    'MEILI_INDEX_EXCLUDE_PREFIXES': '',
}

_db_settings_cache: Optional[Dict[str, str]] = None
_db_settings_lock = threading.Lock()


def invalidate_meili_settings_cache() -> None:
    global _db_settings_cache
    with _db_settings_lock:
        _db_settings_cache = None


def reset_meili_runtime() -> None:
    """Сброс кэшей после изменения настроек в БД — чтобы применилось сразу."""
    global _http_client, _exclude_rules_cache
    invalidate_meili_settings_cache()
    with _init_lock:
        _http_client = None
        _bucket_indexes.clear()
    _exclude_rules_cache = None


_MEILI_BOOL_KEYS = frozenset({
    'MEILI_ENABLED',
    'MEILI_REINDEX_ON_STARTUP',
    'MEILI_PERIODIC_SYNC',
})

_MEILI_INT_KEYS = frozenset({
    'MEILI_REINDEX_WORKERS',
    'MEILI_HTTP_TIMEOUT',
    'MEILI_REINDEX_HTTP_TIMEOUT',
    'MEILI_REINDEX_S3_READ_TIMEOUT',
    'MEILI_LARGE_BUCKET_THRESHOLD',
    'MEILI_INDEX_PART_SIZE',
})


def _normalize_setting_value(key: str, value: Any) -> str:
    raw = '' if value is None else str(value).strip()
    if key in _MEILI_BOOL_KEYS:
        if raw.lower() in ('1', 'true', 'yes', 'on'):
            return 'true'
        if raw.lower() in ('0', 'false', 'no', 'off', ''):
            return 'false'
        raise ValueError(f'Invalid boolean for {key}: {value!r}')
    if key in _MEILI_INT_KEYS:
        if not raw:
            return str(MEILI_SETTING_DEFAULTS.get(key, '0'))
        cleaned = raw.strip('"').strip("'")
        try:
            number = int(cleaned)
        except ValueError as exc:
            raise ValueError(f'Invalid integer for {key}: {value!r}') from exc
        if key == 'MEILI_REINDEX_WORKERS':
            number = max(1, min(number, 32))
        elif key == 'MEILI_INDEX_PART_SIZE':
            number = max(_BATCH_SIZE, number)
        elif key == 'MEILI_LARGE_BUCKET_THRESHOLD':
            number = max(1, number)
        elif key in ('MEILI_HTTP_TIMEOUT', 'MEILI_REINDEX_HTTP_TIMEOUT'):
            number = max(5, number)
        elif key == 'MEILI_REINDEX_S3_READ_TIMEOUT':
            number = max(60, number)
        return str(number)
    return raw


def editable_settings_payload() -> Dict[str, Any]:
    """Настройки из БД для формы Settings."""
    invalidate_meili_settings_cache()
    try:
        from db import get_meilisearch_settings
        db_vals = get_meilisearch_settings() or {}
    except Exception as exc:
        logger.warning('Failed to load meilisearch settings: %s', exc)
        db_vals = {}

    settings: Dict[str, str] = {}
    env_placeholders: Dict[str, str] = {}
    for key, default in MEILI_SETTING_DEFAULTS.items():
        settings[key] = db_vals[key] if key in db_vals else default
        env_val = _env_raw(key)
        if env_val is not None:
            env_placeholders[key] = env_val
    version = None
    if is_configured():
        client = _get_http_client()
        if client is not None:
            version = _pkg_version_from_client(client)
    return {
        'settings': settings,
        'env_placeholders': env_placeholders,
        'defaults': dict(MEILI_SETTING_DEFAULTS),
        'config_error': configuration_error(),
        'env': admin_env_display(),
        'version': version,
    }


def update_settings(updates: Dict[str, Any]) -> Dict[str, Any]:
    """Сохранить настройки в БД и сбросить runtime-кэши."""
    if not isinstance(updates, dict):
        raise ValueError('settings must be an object')
    cleaned: Dict[str, str] = {}
    for key, value in updates.items():
        key = str(key or '').strip()
        if key not in MEILI_SETTING_DEFAULTS:
            continue
        cleaned[key] = _normalize_setting_value(key, value)

    try:
        from db import get_meilisearch_settings
        current = get_meilisearch_settings() or {}
    except Exception:
        current = {}
    merged = {key: current.get(key, default) for key, default in MEILI_SETTING_DEFAULTS.items()}
    merged.update(cleaned)
    # Env перекрывает DB при проверке ENABLE+HOST
    enabled_raw = _env_raw('MEILI_ENABLED')
    if enabled_raw is None:
        enabled_raw = str(merged.get('MEILI_ENABLED', 'false'))
    enabled = enabled_raw.strip().lower() in ('1', 'true', 'yes', 'on')
    host_raw = _env_raw('MEILI_HOST')
    if host_raw is None:
        host_raw = str(merged.get('MEILI_HOST') or '')
    if enabled and not host_raw.strip():
        raise ValueError('MEILI_HOST is required when MEILI_ENABLED=true')

    if cleaned:
        from db import set_meilisearch_settings
        set_meilisearch_settings(cleaned)
    reset_meili_runtime()
    return editable_settings_payload()

def _db_settings() -> Dict[str, str]:
    global _db_settings_cache
    with _db_settings_lock:
        if _db_settings_cache is not None:
            return _db_settings_cache
        try:
            from db import get_meilisearch_settings
            _db_settings_cache = get_meilisearch_settings() or {}
        except Exception as exc:
            logger.warning('Failed to load meilisearch settings from DB: %s', exc)
            _db_settings_cache = {}
        return _db_settings_cache


def _strip_env_value(raw: Any) -> str:
    return str(raw or '').strip().strip('"').strip("'")


def _env_raw(name: str) -> Optional[str]:
    """Непустое значение из os.environ или None."""
    if name not in os.environ:
        return None
    cleaned = _strip_env_value(os.environ.get(name))
    return cleaned if cleaned else None


def _config_raw(name: str) -> Tuple[str, str]:
    """
    Эффективное строковое значение настройки.
    Приоритет: env (непустой) → DB → MEILI_SETTING_DEFAULTS.
    Возвращает (value, source) где source: env|db|default.
    """
    env = _env_raw(name)
    if env is not None:
        return env, 'env'
    db_map = _db_settings()
    if name in db_map:
        return str(db_map.get(name) if db_map.get(name) is not None else ''), 'db'
    return str(MEILI_SETTING_DEFAULTS.get(name, '')), 'default'


def _config_bool(name: str, *, code_default: bool = False) -> bool:
    raw, source = _config_raw(name)
    if source == 'default' and name not in MEILI_SETTING_DEFAULTS:
        return code_default
    if raw == '' and source != 'db':
        return code_default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def _config_int(
    name: str,
    *,
    code_default: int,
    minimum: Optional[int] = None,
    maximum: Optional[int] = None,
) -> int:
    raw, _source = _config_raw(name)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        logger.warning('Invalid %s=%r, using default %s', name, raw, code_default)
        value = code_default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _setting_display(
    name: str,
    *,
    effective: Optional[str] = None,
    empty_display: str = '—',
) -> str:
    """Строка для Info modal: default-маркер и raw → effective при нормализации."""
    env = _env_raw(name)
    value, source = _config_raw(name)
    shown = effective if effective is not None else value
    if shown == '' or shown is None:
        if source == 'default' and env is None:
            return f'{empty_display} (default)'
        return empty_display
    if source == 'default' and env is None:
        return f'{shown} (default)'
    if env is not None and env != str(shown):
        return f'{env} → {shown}'
    return str(shown)


def _request_timeout_sec(*, reindex: bool = False) -> int:
    if not reindex:
        return _config_int('MEILI_HTTP_TIMEOUT', code_default=_DEFAULT_HTTP_TIMEOUT, minimum=5)
    # Как раньше: явный REINDEX timeout → HTTP timeout → default 600
    if _env_raw('MEILI_REINDEX_HTTP_TIMEOUT') is not None:
        return _config_int(
            'MEILI_REINDEX_HTTP_TIMEOUT',
            code_default=_DEFAULT_REINDEX_HTTP_TIMEOUT,
            minimum=5,
        )
    if _env_raw('MEILI_HTTP_TIMEOUT') is not None:
        return _config_int(
            'MEILI_HTTP_TIMEOUT',
            code_default=_DEFAULT_REINDEX_HTTP_TIMEOUT,
            minimum=5,
        )
    return _config_int(
        'MEILI_REINDEX_HTTP_TIMEOUT',
        code_default=_DEFAULT_REINDEX_HTTP_TIMEOUT,
        minimum=5,
    )

_http_client: Optional['_MeiliHTTPClient'] = None
_bucket_indexes: Dict[str, '_MeiliIndex'] = {}
_init_lock = threading.Lock()


class MeiliHTTPError(Exception):
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f'Meilisearch HTTP {status}: {body[:500]}')


def _format_probe_error(exc: Exception) -> str:
    """Короткое описание ошибки probe без тела ответа и секретов."""
    if isinstance(exc, MeiliHTTPError):
        return f'HTTP {exc.status}'
    reason = getattr(exc, 'reason', None)
    text = str(reason if reason is not None else exc).strip() or exc.__class__.__name__
    if text.startswith('<urlopen error ') and text.endswith('>'):
        text = text[len('<urlopen error '):-1].strip()
    if text.startswith('[Errno ') and ']' in text:
        text = text.split(']', 1)[1].strip() or text
    return text[:240]


class _MeiliHTTPClient:
    def __init__(self, host: str, api_key: Optional[str]):
        self._host = host.rstrip('/')
        self._api_key = api_key

    def request(self, method: str, path: str, body: Any = None, *, timeout: Optional[int] = None) -> Any:
        url = f'{self._host}{path}'
        data = None
        headers = {'Accept': 'application/json'}
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if self._api_key:
            headers['Authorization'] = f'Bearer {self._api_key}'

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        if timeout is None:
            timeout = _request_timeout_sec()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if not raw:
                    return None
                return json.loads(raw.decode('utf-8'))
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode('utf-8', errors='replace')
            raise MeiliHTTPError(exc.code, err_body) from exc


class _MeiliIndex:
    def __init__(self, client: _MeiliHTTPClient, uid: str):
        self._client = client
        self._uid = uid
        self._request_timeout: Optional[int] = None

    @property
    def uid(self) -> str:
        return self._uid

    def set_request_timeout(self, timeout: Optional[int]) -> None:
        self._request_timeout = timeout

    def _req_timeout(self) -> int:
        return self._request_timeout if self._request_timeout is not None else _request_timeout_sec()

    def add_documents(self, docs: List[Dict[str, Any]]) -> None:
        self._client.request(
            'POST', f'/indexes/{self._uid}/documents', docs, timeout=self._req_timeout(),
        )

    def search(self, query: str, params: Dict[str, Any]) -> Dict[str, Any]:
        body = {'q': query}
        body.update(params)
        return self._client.request('POST', f'/indexes/{self._uid}/search', body) or {}

    def delete_document(self, doc_id: str) -> None:
        self._client.request('DELETE', f'/indexes/{self._uid}/documents/{doc_id}')

    def delete_documents(self, body: Dict[str, Any]) -> None:
        self._client.request('POST', f'/indexes/{self._uid}/documents/delete', body)

    def delete_all_documents(self) -> None:
        self._client.request(
            'DELETE', f'/indexes/{self._uid}/documents', timeout=self._req_timeout(),
        )

    def number_of_documents(self) -> int:
        try:
            stats = self._client.request('GET', f'/indexes/{self._uid}/stats', timeout=self._req_timeout()) or {}
            return int(stats.get('numberOfDocuments') or 0)
        except MeiliHTTPError as exc:
            if exc.status == 404:
                return 0
            raise

    def fetch_documents_by_paths(self, fields: List[str]) -> Dict[str, Dict[str, Any]]:
        """path → выбранные поля документа (пагинация /documents/fetch)."""
        by_path: Dict[str, Dict[str, Any]] = {}
        offset = 0
        limit = _BATCH_SIZE
        while True:
            body: Dict[str, Any] = {'offset': offset, 'limit': limit, 'fields': fields}
            resp = self._client.request(
                'POST', f'/indexes/{self._uid}/documents/fetch', body, timeout=self._req_timeout(),
            ) or {}
            batch = resp.get('results') or []
            for doc in batch:
                path = (doc.get('path') or '').strip()
                if path:
                    by_path[path] = doc
            if not batch:
                break
            total = resp.get('total')
            offset += len(batch)
            if total is not None:
                if offset >= int(total):
                    break
            elif len(batch) < limit:
                break
        return by_path

    def delete_documents_batch(self, doc_ids: List[str]) -> None:
        if not doc_ids:
            return
        for i in range(0, len(doc_ids), _BATCH_SIZE):
            chunk = doc_ids[i:i + _BATCH_SIZE]
            self._client.request(
                'POST', f'/indexes/{self._uid}/documents/delete-batch', chunk, timeout=self._req_timeout(),
            )

    def update_searchable_attributes(self, attrs: List[str]) -> None:
        self._client.request('PUT', f'/indexes/{self._uid}/settings/searchable-attributes', attrs)

    def update_filterable_attributes(self, attrs: List[str]) -> None:
        self._client.request('PUT', f'/indexes/{self._uid}/settings/filterable-attributes', attrs)

    def update_sortable_attributes(self, attrs: List[str]) -> None:
        self._client.request('PUT', f'/indexes/{self._uid}/settings/sortable-attributes', attrs)

    def update_ranking_rules(self, rules: List[str]) -> None:
        self._client.request('PUT', f'/indexes/{self._uid}/settings/ranking-rules', rules)


def _env_bool(name: str, default: bool = False) -> bool:
    """Совместимость: bool из env → DB → default."""
    return _config_bool(name, code_default=default)


_GLOB_METACHARS = frozenset('*?[')
_REGEX_PREFIXES = ('regex:', 're:')


def _glob_rule_to_regex(glob: str) -> str:
    """Glob с * и ? → regex (^…$). * — любая подстрока пути, ? — один символ."""
    out: List[str] = ['^']
    i = 0
    while i < len(glob):
        ch = glob[i]
        if ch == '*':
            out.append('.*')
            i += 1
        elif ch == '?':
            out.append('.')
            i += 1
        elif ch == '[':
            j = glob.find(']', i + 1)
            if j == -1:
                out.append(re.escape(ch))
                i += 1
            else:
                out.append(glob[i:j + 1])
                i = j + 1
        else:
            j = i
            while j < len(glob) and glob[j] not in _GLOB_METACHARS:
                j += 1
            out.append(re.escape(glob[i:j]))
            i = j
    out.append('$')
    return ''.join(out)


def _parse_index_exclude_rules(raw: str) -> Tuple[List[str], List[re.Pattern[str]]]:
    """
    Правила из MEILI_INDEX_EXCLUDE_PREFIXES (через запятую):
    - префикс: wals или backup/wals/ — как раньше;
    - glob: */wals/* — сегмент «wals» на любой глубине пути;
    - regex:… или re:… — явное регулярное выражение (проверка по всему ключу).
    """
    prefixes: List[str] = []
    regexes: List[re.Pattern[str]] = []
    seen_prefix: set = set()
    seen_regex: set = set()

    for part in (raw or '').split(','):
        rule = part.strip()
        if not rule:
            continue
        lower = rule.lower()
        explicit_regex = False
        for prefix in _REGEX_PREFIXES:
            if lower.startswith(prefix):
                pattern = rule[len(prefix):].strip()
                explicit_regex = True
                break
        else:
            pattern = rule

        if explicit_regex:
            if not pattern:
                continue
            try:
                compiled = re.compile(pattern)
            except re.error as exc:
                logger.warning('Invalid MEILI_INDEX_EXCLUDE_PREFIXES regex %r: %s', pattern, exc)
                continue
            key = compiled.pattern
            if key not in seen_regex:
                seen_regex.add(key)
                regexes.append(compiled)
            continue

        path_rule = pattern.lstrip('/')
        if not path_rule:
            continue

        if _GLOB_METACHARS.intersection(path_rule):
            try:
                compiled = re.compile(_glob_rule_to_regex(path_rule))
            except re.error as exc:
                logger.warning('Invalid MEILI_INDEX_EXCLUDE_PREFIXES glob %r: %s', path_rule, exc)
                continue
            key = compiled.pattern
            if key not in seen_regex:
                seen_regex.add(key)
                regexes.append(compiled)
            continue

        if not path_rule.endswith('/'):
            path_rule = path_rule + '/'
        if path_rule not in seen_prefix:
            seen_prefix.add(path_rule)
            prefixes.append(path_rule)

    return prefixes, regexes


_exclude_rules_cache: Optional[Tuple[str, List[str], List[re.Pattern[str]]]] = None


def _index_exclude_rules() -> Tuple[List[str], List[re.Pattern[str]]]:
    global _exclude_rules_cache
    raw, _source = _config_raw('MEILI_INDEX_EXCLUDE_PREFIXES')
    raw = raw or ''
    if _exclude_rules_cache is not None and _exclude_rules_cache[0] == raw:
        return _exclude_rules_cache[1], _exclude_rules_cache[2]
    prefixes, regexes = _parse_index_exclude_rules(raw)
    _exclude_rules_cache = (raw, prefixes, regexes)
    return prefixes, regexes


def index_exclude_prefixes() -> List[str]:
    """Краткое описание активных правил исключения (для логов и Info)."""
    prefixes, regexes = _index_exclude_rules()
    out: List[str] = []
    for p in prefixes:
        out.append(f'prefix:{p}')
    for rx in regexes:
        out.append(f'regex:{rx.pattern}')
    return out


def is_path_excluded_from_index(key: str) -> bool:
    """True, если объект S3 (ключ) не должен индексироваться."""
    key = (key or '').lstrip('/')
    if not key:
        return False
    prefixes, regexes = _index_exclude_rules()
    for prefix in prefixes:
        folder = prefix.rstrip('/')
        if key == folder or key.startswith(prefix):
            return True
    for rx in regexes:
        if rx.search(key):
            return True
    return False


def _configured_host() -> str:
    """Заданный HOST (env → DB), без подстановки встроенного default."""
    host, _source = _config_raw('MEILI_HOST')
    return (host or '').strip().rstrip('/')


def configuration_error() -> Optional[str]:
    """Ошибка конфигурации Meilisearch или None, если всё ок / выключено."""
    if not _config_bool('MEILI_ENABLED', code_default=False):
        return None
    if not _configured_host():
        return 'MEILI_ENABLED=true but MEILI_HOST is not set'
    return None


def is_configured() -> bool:
    """Meilisearch включён (MEILI_ENABLED=true) и задан MEILI_HOST."""
    return configuration_error() is None and _config_bool('MEILI_ENABLED', code_default=False)

def is_enabled() -> bool:
    return is_configured()


def _sanitize_uid_part(value: str, fallback_source: str) -> str:
    safe = re.sub(r'[^a-zA-Z0-9_-]', '_', (value or '').strip())
    safe = re.sub(r'_+', '_', safe).strip('_')
    if not safe:
        safe = hashlib.sha256(fallback_source.encode('utf-8')).hexdigest()[:32]
    return safe


def _lookup_bucket_name(bucket_id: str) -> Optional[str]:
    bucket_id = (bucket_id or '').strip()
    if not bucket_id:
        return None
    try:
        from buckets import get_buckets_config
        for group_data in get_buckets_config().values():
            for _display_name, bucket_config in group_data.get('buckets', {}).items():
                bid = (bucket_config.get('bucket_id') or _display_name or '').strip()
                if bid == bucket_id:
                    name = (bucket_config.get('bucket_name') or '').strip()
                    return name or None
    except Exception as exc:
        logger.warning('Failed to resolve bucket_name for %s: %s', bucket_id, exc)
    return None


def index_uid_for_bucket(bucket_name: str, bucket_id: str) -> str:
    """UID индекса Meilisearch: <bucket_name>_<bucket_id>."""
    bid = (bucket_id or '').strip()
    if not bid:
        raise ValueError('bucket_id is required for Meilisearch index')
    bname = (bucket_name or '').strip() or _lookup_bucket_name(bid) or bid
    part_name = _sanitize_uid_part(bname, f'name:{bid}')
    part_id = _sanitize_uid_part(bid, f'id:{bid}')
    uid = f'{part_name}_{part_id}'
    if len(uid) > _INDEX_UID_MAX_LEN:
        digest = hashlib.sha256(f'{bname}\0{bid}'.encode('utf-8')).hexdigest()[:32]
        uid = f'{digest[:16]}_{digest[16:]}'
    return uid


def _pkg_version_from_client(
    client: '_MeiliHTTPClient',
    *,
    timeout: Optional[int] = None,
) -> Optional[str]:
    """pkgVersion from GET /version, or None if unavailable."""
    try:
        body = client.request('GET', '/version', timeout=timeout) or {}
        if not isinstance(body, dict):
            return None
        return str(body.get('pkgVersion') or '').strip() or None
    except Exception as exc:
        logger.warning('Meilisearch /version failed: %s', exc)
        return None


def connection_status(
    *,
    include_stats: bool = True,
    timeout: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Статус Meilisearch.
    include_stats=False / timeout=N — быстрый probe для Settings → Status.
    """
    config_error = configuration_error()
    configured = is_configured()
    host = _meili_host() if configured else (_configured_host() or None)
    available = False
    database_size = None
    version = None
    probe_error = None
    client: Optional[_MeiliHTTPClient] = None

    if configured:
        if timeout is not None:
            try:
                http = _MeiliHTTPClient(_meili_host(), _meili_api_key())
                probed = False
                for path in ('/health', '/version'):
                    try:
                        http.request('GET', path, timeout=timeout)
                        probed = True
                        break
                    except MeiliHTTPError as exc:
                        if exc.status not in (404, 405):
                            raise
                available = probed
                client = http if probed else None
                if not probed:
                    probe_error = 'Health and version endpoints are unavailable'
            except Exception as exc:
                logger.warning('Meilisearch quick probe failed at %s: %s', host, exc)
                available = False
                probe_error = _format_probe_error(exc)
        else:
            client = _get_http_client()
            available = client is not None
            if not available:
                probe_error = 'Client is not available'

    if client is not None:
        ver_timeout = timeout if timeout is not None else _request_timeout_sec()
        version = _pkg_version_from_client(client, timeout=ver_timeout)

    if include_stats and client is not None:
        try:
            stats_timeout = timeout if timeout is not None else _request_timeout_sec()
            stats = client.request('GET', '/stats', timeout=stats_timeout) or {}
            raw = stats.get('databaseSize')
            if raw is None:
                raw = stats.get('usedDatabaseSize')
            if raw is not None:
                database_size = int(raw)
        except Exception as exc:
            logger.warning('Meilisearch /stats failed: %s', exc)

    return {
        'configured': configured,
        'available': available,
        'enabled': _config_bool('MEILI_ENABLED', code_default=False),
        'enabled_from_env': _env_raw('MEILI_ENABLED') is not None,
        'host': host,
        'database_size': database_size,
        'version': version,
        'config_error': config_error,
        'probe_error': probe_error,
        'env': admin_env_display(),
    }


def _env_bool_display(name: str, *, default: bool = False) -> str:
    """Строка true/false для Info: env → DB → default."""
    raw, source = _config_raw(name)
    effective = 'true' if _config_bool(name, code_default=default) else 'false'
    if source == 'default' and _env_raw(name) is None:
        return f'{effective} (default)'
    s = raw.strip().lower()
    if s in ('1', 'true', 'yes', 'on'):
        return 'true'
    if s in ('0', 'false', 'no', 'off'):
        return 'false'
    if not s:
        return 'true' if default else 'false'
    return raw.strip()


_SYNC_AT_DISABLED = frozenset({'', '0', '-', 'off', 'disabled', 'false', 'no'})


def _periodic_sync_timezone() -> ZoneInfo:
    raw, _source = _config_raw('MEILI_SYNC_TIMEZONE')
    raw = (raw or 'UTC').strip() or 'UTC'
    try:
        return ZoneInfo(raw)
    except Exception:
        logger.warning('Invalid MEILI_SYNC_TIMEZONE=%r, using UTC', raw)
        return ZoneInfo('UTC')


def _parse_periodic_sync_at() -> Optional[Tuple[int, int]]:
    """Время суток (hour, minute) для ежедневного sync или None, если отключено."""
    raw, _source = _config_raw('MEILI_SYNC_AT')
    raw = (raw or '').strip()
    if raw.lower() in _SYNC_AT_DISABLED:
        return None
    match = re.fullmatch(r'(\d{1,2}):(\d{2})', raw)
    if not match:
        logger.warning('Invalid MEILI_SYNC_AT=%r, periodic sync disabled', raw)
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        logger.warning('Invalid MEILI_SYNC_AT=%r (out of range), periodic sync disabled', raw)
        return None
    return hour, minute


def _periodic_sync_at_env_display() -> str:
    """Значение MEILI_SYNC_AT для Info (как в окружении / DB / default)."""
    return _setting_display('MEILI_SYNC_AT')


def _periodic_sync_timezone_display() -> str:
    effective = _periodic_sync_timezone().key
    return _setting_display('MEILI_SYNC_TIMEZONE', effective=effective)


def _periodic_sync_next_display() -> str:
    """Следующий запуск ежедневной синхронизации для Info."""
    if not periodic_sync_enabled():
        return '— (MEILI_PERIODIC_SYNC=false)'
    parsed = _parse_periodic_sync_at()
    if parsed is None:
        return '— (schedule disabled)'
    hour, minute = parsed
    tz = _periodic_sync_timezone()
    delay = _seconds_until_next_periodic_sync(hour, minute, tz)
    next_run = datetime.now(tz) + timedelta(seconds=delay)
    return f'{next_run.strftime("%Y-%m-%d %H:%M:%S")} {tz.key}'


def _seconds_until_next_periodic_sync(hour: int, minute: int, tz: ZoneInfo) -> float:
    now = datetime.now(tz)
    next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(days=1)
    return (next_run - now).total_seconds()


def admin_env_display() -> Dict[str, str]:
    """Значения переменных Meilisearch для панели настроек (admin)."""
    invalidate_meili_settings_cache()

    exclude_raw, exclude_source = _config_raw('MEILI_INDEX_EXCLUDE_PREFIXES')
    if not exclude_raw:
        exclude_display = '— (default)' if exclude_source == 'default' else '—'
    else:
        exclude_display = exclude_raw
        try:
            normalized = index_exclude_prefixes()
            if normalized and exclude_raw != '; '.join(normalized):
                exclude_display = f'{exclude_raw} → {"; ".join(normalized)}'
        except Exception:
            pass
        if exclude_source == 'default' and _env_raw('MEILI_INDEX_EXCLUDE_PREFIXES') is None:
            exclude_display = f'{exclude_display} (default)'

    api_key = _meili_api_key() or ''

    return {
        'MEILI_ENABLED': _env_bool_display('MEILI_ENABLED', default=False),
        'MEILI_HOST': _setting_display('MEILI_HOST', effective=_configured_host() or '—'),
        'MEILI_API_KEY': api_key if api_key else (
            '— (default)' if _config_raw('MEILI_API_KEY')[1] == 'default' else '—'
        ),
        'MEILI_PERIODIC_SYNC': _env_bool_display('MEILI_PERIODIC_SYNC', default=True),
        'MEILI_SYNC_AT': _periodic_sync_at_env_display(),
        'MEILI_SYNC_NEXT': _periodic_sync_next_display(),
        'MEILI_REINDEX_WORKERS': _setting_display(
            'MEILI_REINDEX_WORKERS',
            effective=str(_reindex_workers()),
        ),
        'MEILI_REINDEX_ON_STARTUP': _env_bool_display('MEILI_REINDEX_ON_STARTUP', default=False),
        'MEILI_SYNC_TIMEZONE': _periodic_sync_timezone_display(),
        'MEILI_HTTP_TIMEOUT': _setting_display(
            'MEILI_HTTP_TIMEOUT',
            effective=str(_request_timeout_sec(reindex=False)),
        ),
        'MEILI_REINDEX_HTTP_TIMEOUT': _reindex_http_timeout_display(),
        'MEILI_REINDEX_S3_READ_TIMEOUT': _setting_display(
            'MEILI_REINDEX_S3_READ_TIMEOUT',
            effective=str(_reindex_s3_read_timeout()),
        ),
        'MEILI_LARGE_BUCKET_THRESHOLD': _setting_display(
            'MEILI_LARGE_BUCKET_THRESHOLD',
            effective=str(_large_bucket_threshold()),
        ),
        'MEILI_INDEX_PART_SIZE': _setting_display(
            'MEILI_INDEX_PART_SIZE',
            effective=str(_index_part_size()),
        ),
        'MEILI_INDEX_EXCLUDE_PREFIXES': exclude_display,
    }


def _reindex_s3_read_timeout() -> int:
    return _config_int(
        'MEILI_REINDEX_S3_READ_TIMEOUT',
        code_default=_DEFAULT_REINDEX_S3_READ_TIMEOUT,
        minimum=60,
    )


def _reindex_http_timeout_display() -> str:
    effective = str(_request_timeout_sec(reindex=True))
    if _env_raw('MEILI_REINDEX_HTTP_TIMEOUT') is not None:
        return _setting_display('MEILI_REINDEX_HTTP_TIMEOUT', effective=effective)
    if _env_raw('MEILI_HTTP_TIMEOUT') is not None:
        return f'{effective} (via MEILI_HTTP_TIMEOUT)'
    return _setting_display('MEILI_REINDEX_HTTP_TIMEOUT', effective=effective)


def _meili_host() -> str:
    """URL Meilisearch для исходящих HTTP-запросов (не bind-адрес вида 0.0.0.0)."""
    host = _configured_host() or _DEFAULT_HOST
    if '://0.0.0.0' in host:
        host = host.replace('://0.0.0.0:', '://127.0.0.1:').replace('://0.0.0.0', '://127.0.0.1')
    return host

def _meili_api_key() -> Optional[str]:
    # Пустой ключ из DB/default — это «нет ключа»
    if _env_raw('MEILI_API_KEY') is not None:
        return _env_raw('MEILI_API_KEY')
    raw, _source = _config_raw('MEILI_API_KEY')
    return raw or None


def _document_id(path: str) -> str:
    return hashlib.sha256(path.encode('utf-8')).hexdigest()


def _object_name_from_key(key: str) -> str:
    if key.endswith('/'):
        clean_key = key.rstrip('/')
        return clean_key.split('/')[-1] if clean_key else ''
    return key.split('/')[-1] if key else ''


def _implicit_folder_paths(object_key: str) -> List[str]:
    """Промежуточные папки по ключу объекта (S3 часто не хранит отдельный marker на каждую папку)."""
    key = (object_key or '').lstrip('/')
    if not key:
        return []
    if object_key.endswith('/'):
        clean = key.rstrip('/')
        if not clean:
            return []
        segments = clean.split('/')
        return ['/'.join(segments[:i]) + '/' for i in range(1, len(segments))]
    segments = key.split('/')
    if len(segments) <= 1:
        return []
    return ['/'.join(segments[:i]) + '/' for i in range(1, len(segments))]


def document_from_s3_object(bucket_id: str, key: str, obj: Dict[str, Any]) -> Dict[str, Any]:
    is_folder = key.endswith('/')
    name = _object_name_from_key(key)
    if is_folder and not name:
        name = key.rstrip('/').split('/')[-1] if key.rstrip('/') else key
    last_modified = obj.get('LastModified')
    if hasattr(last_modified, 'isoformat'):
        last_modified = last_modified.isoformat()
    elif last_modified is None:
        last_modified = datetime.utcnow().isoformat()
    return {
        'id': _document_id(key),
        'bucket_id': bucket_id,
        'name': name,
        'path': key,
        'object_type': 'folder' if is_folder else 'file',
        'size': int(obj.get('Size', 0) or 0),
        'last_modified': last_modified,
    }


def _ping_meilisearch(client: _MeiliHTTPClient) -> None:
    for path in ('/health', '/version'):
        try:
            client.request('GET', path)
            return
        except MeiliHTTPError as exc:
            if exc.status not in (404, 405):
                raise
    raise MeiliHTTPError(0, 'no reachable Meilisearch endpoint (/health, /version)')


def _ensure_bucket_index_exists(
    client: _MeiliHTTPClient,
    bucket_name: str,
    bucket_id: str,
) -> str:
    uid = index_uid_for_bucket(bucket_name, bucket_id)
    try:
        client.request('GET', f'/indexes/{uid}')
    except MeiliHTTPError as exc:
        if exc.status != 404:
            raise
        client.request('POST', '/indexes', {'uid': uid, 'primaryKey': 'id'})
    return uid


def _ensure_index_settings(index: _MeiliIndex) -> None:
    # Поиск только по имени файла/папки; path — для фильтров и отображения в UI.
    index.update_searchable_attributes(['name'])
    index.update_filterable_attributes(['object_type', 'path'])
    index.update_sortable_attributes(['last_modified', 'size', 'name'])
    index.update_ranking_rules([
        'words',
        'typo',
        'proximity',
        'attribute',
        'sort',
        'exactness',
    ])


def _get_http_client() -> Optional[_MeiliHTTPClient]:
    global _http_client
    if not is_configured():
        return None
    with _init_lock:
        if _http_client is not None:
            return _http_client
        try:
            host = _meili_host()
            http = _MeiliHTTPClient(host, _meili_api_key())
            _ping_meilisearch(http)
            _http_client = http
            return _http_client
        except Exception as exc:
            logger.warning('Meilisearch unavailable at %s: %s', _meili_host(), exc)
            _http_client = None
            return None


def _get_bucket_index(bucket_id: str, bucket_name: Optional[str] = None) -> Optional[_MeiliIndex]:
    """Индекс Meilisearch, привязанный к бакету (uid: <bucket_name>_<bucket_id>)."""
    bucket_id = (bucket_id or '').strip()
    if not bucket_id:
        return None
    resolved_name = (bucket_name or '').strip() or _lookup_bucket_name(bucket_id) or bucket_id
    http = _get_http_client()
    if http is None:
        return None
    uid = index_uid_for_bucket(resolved_name, bucket_id)
    with _init_lock:
        cached = _bucket_indexes.get(bucket_id)
        if cached is not None and cached.uid != uid:
            _bucket_indexes.pop(bucket_id, None)
            cached = None
        if cached is not None:
            _ensure_index_settings(cached)
            return cached
        try:
            _ensure_bucket_index_exists(http, resolved_name, bucket_id)
            index = _MeiliIndex(http, uid)
            _ensure_index_settings(index)
            _bucket_indexes[bucket_id] = index
            return index
        except Exception as exc:
            logger.warning('Meilisearch index for bucket %s unavailable: %s', bucket_id, exc)
            return None


def _escape_filter_value(value: str) -> str:
    return value.replace('\\', '\\\\').replace('"', '\\"')


def upsert_document(bucket_id: str, path: str, *, size: int = 0, last_modified: Optional[str] = None) -> bool:
    if is_path_excluded_from_index(path):
        return False
    try:
        from db import is_bucket_search_index_enabled
        if not is_bucket_search_index_enabled(bucket_id):
            return False
    except Exception:
        pass
    index = _get_bucket_index(bucket_id)
    if index is None:
        return False
    doc = document_from_s3_object(
        bucket_id,
        path,
        {
            'Size': size,
            'LastModified': last_modified or datetime.utcnow().isoformat(),
        },
    )
    try:
        index.add_documents([doc])
        return True
    except Exception as exc:
        logger.warning('Failed to index %s/%s: %s', bucket_id, path, exc)
        return False


def upsert_documents(bucket_id: str, docs: List[Dict[str, Any]]) -> bool:
    try:
        from db import is_bucket_search_index_enabled
        if not is_bucket_search_index_enabled(bucket_id):
            return False
    except Exception:
        pass
    index = _get_bucket_index(bucket_id)
    if index is None or not docs:
        return False
    try:
        for i in range(0, len(docs), _BATCH_SIZE):
            index.add_documents(docs[i:i + _BATCH_SIZE])
        return True
    except Exception as exc:
        logger.warning('Failed to batch-index %s documents for bucket %s: %s', len(docs), bucket_id, exc)
        return False


def remove_document(bucket_id: str, path: str) -> bool:
    index = _get_bucket_index(bucket_id)
    if index is None:
        return False
    try:
        index.delete_document(_document_id(path))
        return True
    except Exception as exc:
        logger.warning('Failed to remove index entry %s/%s: %s', bucket_id, path, exc)
        return False


def remove_by_path_prefix(bucket_id: str, prefix: str) -> bool:
    index = _get_bucket_index(bucket_id)
    if index is None:
        return False
    prefix_esc = _escape_filter_value(prefix)
    try:
        index.delete_documents({
            'filter': f'path STARTS WITH "{prefix_esc}"',
        })
        return True
    except Exception as exc:
        logger.warning('Failed to remove index entries by prefix %s/%s: %s', bucket_id, prefix, exc)
        return False


def search_bucket(bucket_id: str, query: str, *, limit: int = _SEARCH_LIMIT) -> Optional[Tuple[List[Dict], List[Dict]]]:
    """Вернуть (folders, files) или None, если Meilisearch недоступен."""
    index = _get_bucket_index(bucket_id)
    if index is None:
        return None
    try:
        result = index.search(query, {
            'limit': limit,
            'attributesToSearchOn': ['name'],
        })
    except Exception as exc:
        logger.warning('Meilisearch search failed for bucket %s: %s', bucket_id, exc)
        return None

    folders: List[Dict] = []
    files: List[Dict] = []
    seen_folder_paths = set()
    seen_file_paths = set()

    for hit in result.get('hits', []):
        path = hit.get('path', '')
        if not path:
            continue
        item = {
            'name': hit.get('name', _object_name_from_key(path)),
            'path': path,
            'size': hit.get('size', 0),
            'last_modified': hit.get('last_modified', ''),
        }
        if hit.get('object_type') == 'folder' or path.endswith('/'):
            if path not in seen_folder_paths:
                folders.append(item)
                seen_folder_paths.add(path)
        else:
            if path not in seen_file_paths:
                files.append(item)
                seen_file_paths.add(path)

    return folders, files


def _document_fingerprint(doc: Dict[str, Any]) -> Tuple[int, str]:
    return (int(doc.get('size') or 0), str(doc.get('last_modified') or ''))


def _large_bucket_threshold() -> int:
    return _config_int(
        'MEILI_LARGE_BUCKET_THRESHOLD',
        code_default=_DEFAULT_LARGE_BUCKET_THRESHOLD,
        minimum=1,
    )


def _index_part_size() -> int:
    return _config_int(
        'MEILI_INDEX_PART_SIZE',
        code_default=_DEFAULT_INDEX_PART_SIZE,
        minimum=_BATCH_SIZE,
    )


def _flush_pending_upsert(index: '_MeiliIndex', pending: List[Dict[str, Any]]) -> int:
    if not pending:
        return 0
    index.add_documents(pending)
    n = len(pending)
    pending.clear()
    return n


def _stream_upsert_from_s3(
    s3_client,
    bucket_name: str,
    bucket_id: str,
    index: '_MeiliIndex',
    *,
    meili_by_path: Optional[Dict[str, Dict[str, Any]]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    operation: str = 'Index',
) -> Tuple[int, set, int]:
    """
    Потоковая отправка документов в Meilisearch батчами.
    Возвращает (число объектов S3, множество path, число upsert).
    При > part_size объектов пишет в лог завершение части (part 1, 2, …).
    """
    part_size = _index_part_size()
    s3_paths: set = set()
    pending: List[Dict[str, Any]] = []
    upserted = 0
    scanned = 0
    part_num = 0
    cancelled = False

    for doc in _iter_documents_from_s3(s3_client, bucket_name, bucket_id):
        if cancel_check and cancel_check():
            cancelled = True
            break
        path = doc['path']
        s3_paths.add(path)
        scanned += 1
        need_upsert = True
        if meili_by_path is not None:
            prev = meili_by_path.get(path)
            need_upsert = prev is None or _document_fingerprint(doc) != _document_fingerprint(prev)
        if need_upsert:
            pending.append(doc)
            if len(pending) >= _BATCH_SIZE:
                upserted += _flush_pending_upsert(index, pending)
        if scanned > 0 and scanned % part_size == 0:
            part_num += 1
            upserted += _flush_pending_upsert(index, pending)
            _log_reindex_info(
                f'{operation} part {part_num} done: bucket_id={bucket_id} '
                f'scanned={scanned} upserted={upserted} (part_size={part_size})',
            )

    upserted += _flush_pending_upsert(index, pending)
    if cancelled:
        _log_reindex_info(
            f'{operation} cancelled: bucket_id={bucket_id} scanned={scanned} upserted={upserted}',
        )
    return scanned, s3_paths, upserted


def _delete_stale_index_documents(
    index: '_MeiliIndex',
    s3_paths: set,
    bucket_id: str,
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> int:
    """Удалить из индекса документы, которых нет в s3_paths (пагинация, без загрузки всего индекса)."""
    deleted = 0
    offset = 0
    limit = _BATCH_SIZE
    part_size = _index_part_size()
    scanned = 0
    part_num = 0

    while True:
        if cancel_check and cancel_check():
            break
        body: Dict[str, Any] = {'offset': offset, 'limit': limit, 'fields': ['path']}
        resp = index._client.request(
            'POST', f'/indexes/{index.uid}/documents/fetch', body, timeout=index._req_timeout(),
        ) or {}
        batch = resp.get('results') or []
        if not batch:
            break
        delete_ids: List[str] = []
        for doc in batch:
            path = (doc.get('path') or '').strip()
            if path and path not in s3_paths:
                delete_ids.append(_document_id(path))
        if delete_ids:
            index.delete_documents_batch(delete_ids)
            deleted += len(delete_ids)
        scanned += len(batch)
        total = resp.get('total')
        offset += len(batch)
        if total is not None:
            if offset >= int(total):
                break
        elif len(batch) < limit:
            break
        if scanned > 0 and scanned % part_size == 0:
            part_num += 1
            _log_reindex_info(
                f'Delete stale part {part_num}: bucket_id={bucket_id} '
                f'meili_scanned={scanned} deleted={deleted}',
            )

    return deleted


def _iter_documents_from_s3(
    s3_client, bucket_name: str, bucket_id: str,
) -> Any:
    paginator = s3_client.get_paginator('list_objects_v2')
    skipped = 0
    seen_folders: set = set()
    for page in paginator.paginate(Bucket=bucket_name):
        for obj in page.get('Contents', []):
            key = obj.get('Key') or ''
            if is_path_excluded_from_index(key):
                skipped += 1
                continue
            for folder_path in _implicit_folder_paths(key):
                if folder_path in seen_folders or is_path_excluded_from_index(folder_path):
                    continue
                seen_folders.add(folder_path)
                yield document_from_s3_object(
                    bucket_id,
                    folder_path,
                    {'Size': 0, 'LastModified': obj.get('LastModified')},
                )
            yield document_from_s3_object(bucket_id, key, obj)
            if key.endswith('/'):
                folder_key = key if key.endswith('/') else key + '/'
                seen_folders.add(folder_key)
    if skipped:
        logger.info(
            'Reindex skip excluded paths: bucket_id=%s skipped_objects=%s prefixes=%s',
            bucket_id, skipped, index_exclude_prefixes(),
        )


def collect_documents_from_s3(s3_client, bucket_name: str, bucket_id: str) -> List[Dict[str, Any]]:
    return list(_iter_documents_from_s3(s3_client, bucket_name, bucket_id))


def sync_bucket(
    s3_client,
    bucket_name: str,
    bucket_id: str,
    *,
    index: Optional[_MeiliIndex] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> int:
    """Синхронизация индекса с S3 без wipe: upsert изменений, удаление лишних в Meili."""
    if index is None:
        index = _get_bucket_index(bucket_id, bucket_name)
    if index is None:
        logger.warning('Sync aborted: Meilisearch index unavailable for bucket_id=%s', bucket_id)
        return 0
    index.set_request_timeout(_request_timeout_sec(reindex=True))
    threshold = _large_bucket_threshold()
    meili_doc_count = index.number_of_documents()
    large_index = meili_doc_count >= threshold
    _log_reindex_info(
        f'Sync start: bucket_name={bucket_name} bucket_id={bucket_id} '
        f'meili_docs={meili_doc_count} large_mode={large_index}',
    )

    meili_by_path: Optional[Dict[str, Dict[str, Any]]] = None
    if not large_index:
        meili_by_path = index.fetch_documents_by_paths(['path', 'size', 'last_modified'])

    scanned, s3_paths, upserted = _stream_upsert_from_s3(
        s3_client,
        bucket_name,
        bucket_id,
        index,
        meili_by_path=meili_by_path,
        cancel_check=cancel_check,
        operation='Sync',
    )

    use_chunked_delete = large_index or scanned >= threshold
    if use_chunked_delete:
        deleted = _delete_stale_index_documents(
            index, s3_paths, bucket_id, cancel_check=cancel_check,
        )
    elif meili_by_path is not None:
        delete_ids = [
            _document_id(path) for path in meili_by_path if path not in s3_paths
        ]
        if delete_ids:
            index.delete_documents_batch(delete_ids)
        deleted = len(delete_ids)
    else:
        deleted = 0

    _log_reindex_info(
        f'Sync done: bucket_name={bucket_name} bucket_id={bucket_id} '
        f'objects={scanned} upserted={upserted} deleted={deleted} '
        f'chunked_delete={use_chunked_delete}',
    )
    return scanned


def reindex_or_sync_bucket(
    s3_client,
    bucket_name: str,
    bucket_id: str,
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> int:
    """Старт приложения: пустой индекс → полный reindex, иначе sync с S3."""
    index = _get_bucket_index(bucket_id, bucket_name)
    if index is None:
        logger.warning('Index startup aborted: Meilisearch unavailable for bucket_id=%s', bucket_id)
        return 0
    index.set_request_timeout(_request_timeout_sec(reindex=True))
    if index.number_of_documents() == 0:
        _log_reindex_info(
            f'Startup index empty, full reindex: bucket_name={bucket_name} bucket_id={bucket_id}',
        )
        return reindex_bucket(s3_client, bucket_name, bucket_id, cancel_check=cancel_check)
    _log_reindex_info(
        f'Startup index non-empty, sync: bucket_name={bucket_name} bucket_id={bucket_id}',
    )
    return sync_bucket(
        s3_client, bucket_name, bucket_id, index=index, cancel_check=cancel_check,
    )


def reindex_bucket(
    s3_client,
    bucket_name: str,
    bucket_id: str,
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> int:
    index = _get_bucket_index(bucket_id, bucket_name)
    if index is None:
        logger.warning('Reindex aborted: Meilisearch index unavailable for bucket_id=%s', bucket_id)
        return 0
    index.set_request_timeout(_request_timeout_sec(reindex=True))
    part_size = _index_part_size()
    _log_reindex_info(
        f'Reindex start: bucket_name={bucket_name} bucket_id={bucket_id} part_size={part_size}',
    )
    try:
        index.delete_all_documents()
    except Exception as exc:
        logger.warning('Failed to clear index for bucket %s (%s): %s', bucket_id, index.uid, exc)

    scanned, _, upserted = _stream_upsert_from_s3(
        s3_client,
        bucket_name,
        bucket_id,
        index,
        meili_by_path=None,
        cancel_check=cancel_check,
        operation='Reindex',
    )
    _log_reindex_info(
        f'Reindex done: bucket_name={bucket_name} bucket_id={bucket_id} '
        f'objects={scanned} upserted={upserted}',
    )
    return scanned


def delete_bucket_index(bucket_id: str, bucket_name: Optional[str] = None) -> bool:
    """Удалить индекс Meilisearch бакета (при удалении бакета из настроек)."""
    bucket_id = (bucket_id or '').strip()
    if not bucket_id:
        return False
    http = _get_http_client()
    if http is None:
        return False
    resolved_name = (bucket_name or '').strip() or _lookup_bucket_name(bucket_id) or bucket_id
    uid = index_uid_for_bucket(resolved_name, bucket_id)
    try:
        http.request('DELETE', f'/indexes/{uid}')
        with _init_lock:
            _bucket_indexes.pop(bucket_id, None)
        logger.info('Deleted Meilisearch index %s for bucket %s', uid, bucket_id)
        return True
    except MeiliHTTPError as exc:
        if exc.status == 404:
            with _init_lock:
                _bucket_indexes.pop(bucket_id, None)
            return True
        logger.warning('Failed to delete Meilisearch index %s: %s', uid, exc)
        return False
    except Exception as exc:
        logger.warning('Failed to delete Meilisearch index for bucket %s: %s', bucket_id, exc)
        return False


def _reindex_workers() -> int:
    return _config_int(
        'MEILI_REINDEX_WORKERS',
        code_default=_DEFAULT_REINDEX_WORKERS,
        minimum=1,
        maximum=32,
    )


def filter_search_index_enabled_bucket_ids(bucket_ids: List[str]) -> List[str]:
    """Оставить только bucket_id с включённой индексацией."""
    try:
        from db import get_search_index_disabled_bucket_ids
        disabled = get_search_index_disabled_bucket_ids()
    except Exception as exc:
        logger.warning('Could not load search_index_enabled flags: %s', exc)
        disabled = set()
    if not disabled:
        return list(bucket_ids)
    return [bid for bid in bucket_ids if bid not in disabled]


def bucket_config_by_id(buckets_iter: Callable[[], Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """bucket_id → конфиг бакета из настроек."""
    out: Dict[str, Dict[str, Any]] = {}
    for group_data in buckets_iter().values():
        for display_name, bucket_config in group_data.get('buckets', {}).items():
            bucket_id = (bucket_config.get('bucket_id') or display_name or '').strip()
            if bucket_id:
                out[bucket_id] = bucket_config
    return out


def _reindex_one_bucket(
    bucket_id: str,
    config_by_id: Dict[str, Dict[str, Any]],
    get_s3_client_fn: Callable[[Dict], Any],
    *,
    index_mode: str = 'full',
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Tuple[str, int]:
    bucket_config = config_by_id.get(bucket_id)
    if not bucket_config:
        logger.warning('Reindex skipped: bucket_id=%s (not in config)', bucket_id)
        return bucket_id, -2
    try:
        from db import is_bucket_search_index_enabled
        if not is_bucket_search_index_enabled(bucket_id):
            _log_reindex_info(f'Reindex skipped: bucket_id={bucket_id} (search_index_enabled=false)')
            return bucket_id, -3
    except Exception as exc:
        logger.warning('search_index_enabled check failed for %s: %s', bucket_id, exc)
    bucket_name = bucket_config.get('bucket_name')
    if not bucket_name:
        logger.warning('Reindex skipped: bucket_id=%s (no bucket_name)', bucket_id)
        return bucket_id, 0
    try:
        s3_client = get_s3_client_fn(bucket_config)
        if index_mode == 'auto':
            count = reindex_or_sync_bucket(
                s3_client, bucket_name, bucket_id, cancel_check=cancel_check,
            )
        else:
            count = reindex_bucket(
                s3_client, bucket_name, bucket_id, cancel_check=cancel_check,
            )
        return bucket_id, count
    except Exception as exc:
        logger.warning('Reindex failed: bucket_id=%s bucket_name=%s: %s', bucket_id, bucket_name, exc)
        return bucket_id, -1


def _with_app_context(app, fn):
    if app is not None:
        with app.app_context():
            return fn()
    return fn()


_batch_job_lock = threading.Lock()
_batch_job: Dict[str, Any] = {
    'active': False,
    'cancel_requested': False,
    'total': 0,
    'completed': 0,
    'workers': 0,
    'bucket_ids': [],
    'stats': {},
    'error': None,
}
_batch_listener_lock = threading.Lock()
_batch_listeners: List[queue.Queue] = []
_BATCH_SSE_HEARTBEAT_SEC = 25.0


def _batch_listeners_publish(payload: Dict[str, Any]) -> None:
    with _batch_listener_lock:
        listeners = list(_batch_listeners)
    for listener in listeners:
        try:
            listener.put_nowait(payload)
        except queue.Full:
            pass


def _batch_reindex_emit_progress(bucket_id: str, count: int) -> None:
    _batch_listeners_publish({
        'type': 'progress',
        'bucket_id': bucket_id,
        'count': count,
        'job': batch_reindex_status(),
    })


def _batch_reindex_emit_done() -> None:
    _batch_listeners_publish({'type': 'done', 'job': batch_reindex_status()})


def iter_batch_reindex_events() -> Any:
    """Генератор событий фоновой переиндексации для SSE (snapshot → progress → done)."""
    listener: queue.Queue = queue.Queue(maxsize=256)
    with _batch_listener_lock:
        _batch_listeners.append(listener)
    try:
        job = batch_reindex_status()
        yield {'type': 'snapshot', 'job': job}
        if not job.get('active'):
            return
        while True:
            try:
                event = listener.get(timeout=_BATCH_SSE_HEARTBEAT_SEC)
            except queue.Empty:
                if not batch_reindex_status().get('active'):
                    yield {'type': 'done', 'job': batch_reindex_status()}
                    return
                yield {'type': 'ping'}
                continue
            yield event
            if event.get('type') == 'done':
                return
    finally:
        with _batch_listener_lock:
            try:
                _batch_listeners.remove(listener)
            except ValueError:
                pass


def _batch_reindex_cancel_requested() -> bool:
    with _batch_job_lock:
        return bool(_batch_job.get('cancel_requested'))


def _batch_reindex_record_done(bucket_id: str, count: int) -> None:
    with _batch_job_lock:
        _batch_job['stats'][bucket_id] = count
        _batch_job['completed'] = int(_batch_job.get('completed') or 0) + 1
    _batch_reindex_emit_progress(bucket_id, count)


def _batch_reindex_finish() -> None:
    with _batch_job_lock:
        _batch_job['active'] = False
    _batch_reindex_emit_done()


def _batch_reindex_set_error(exc: BaseException) -> None:
    with _batch_job_lock:
        _batch_job['error'] = str(exc)


def batch_reindex_status() -> Dict[str, Any]:
    with _batch_job_lock:
        return {
            'active': bool(_batch_job.get('active')),
            'cancel_requested': bool(_batch_job.get('cancel_requested')),
            'total': int(_batch_job.get('total') or 0),
            'completed': int(_batch_job.get('completed') or 0),
            'workers': int(_batch_job.get('workers') or 0),
            'bucket_ids': list(_batch_job.get('bucket_ids') or []),
            'stats': dict(_batch_job.get('stats') or {}),
            'error': _batch_job.get('error'),
        }


def request_batch_reindex_cancel() -> bool:
    """Запросить остановку после текущих бакетов. True, если шла переиндексация."""
    with _batch_job_lock:
        if not _batch_job.get('active'):
            return False
        _batch_job['cancel_requested'] = True
        return True


def start_batch_reindex_background(
    bucket_ids: List[str],
    buckets_iter: Callable[[], Dict[str, Any]],
    get_s3_client_fn: Callable[[Dict], Any],
    *,
    app=None,
    log_context: str = 'reindex_search',
    on_bucket_complete: Optional[Callable[[str, int], None]] = None,
    index_mode: str = 'full',
) -> bool:
    """Запустить переиндексацию в фоне. False, если задача уже выполняется."""
    seen = set()
    ordered_ids: List[str] = []
    for raw in bucket_ids:
        bid = (raw or '').strip()
        if bid and bid not in seen:
            seen.add(bid)
            ordered_ids.append(bid)
    ordered_ids = filter_search_index_enabled_bucket_ids(ordered_ids)
    if not ordered_ids:
        return False

    with _batch_job_lock:
        if _batch_job.get('active'):
            return False
        _batch_job.clear()
        _batch_job.update({
            'active': True,
            'cancel_requested': False,
            'total': len(ordered_ids),
            'completed': 0,
            'workers': _reindex_workers(),
            'bucket_ids': list(ordered_ids),
            'stats': {},
            'error': None,
        })

    def _worker() -> None:
        set_reindex_log_context(log_context)
        ctx = app.app_context() if app is not None else nullcontext()

        def _on_done(bucket_id: str, count: int) -> None:
            _batch_reindex_record_done(bucket_id, count)
            if on_bucket_complete:
                try:
                    on_bucket_complete(bucket_id, count)
                except Exception as exc:
                    logger.warning('on_bucket_complete failed for %s: %s', bucket_id, exc)

        try:
            with ctx:
                reindex_buckets_parallel(
                    ordered_ids,
                    buckets_iter,
                    get_s3_client_fn,
                    app=app,
                    cancel_check=_batch_reindex_cancel_requested,
                    on_bucket_complete=_on_done,
                    index_mode=index_mode,
                )
        except Exception as exc:
            _batch_reindex_set_error(exc)
            _log_reindex_warning(f'Reindex batch failed: {exc}')
        finally:
            _batch_reindex_finish()
            reset_reindex_log_context()

    threading.Thread(target=_worker, name='meili-batch-reindex', daemon=True).start()
    return True


def reindex_buckets_parallel(
    bucket_ids: List[str],
    buckets_iter: Callable[[], Dict[str, Any]],
    get_s3_client_fn: Callable[[Dict], Any],
    *,
    max_workers: Optional[int] = None,
    app=None,
    cancel_check: Optional[Callable[[], bool]] = None,
    on_bucket_complete: Optional[Callable[[str, int], None]] = None,
    index_mode: str = 'full',
) -> Dict[str, int]:
    """Переиндексировать список бакетов в пуле потоков (MEILI_REINDEX_WORKERS)."""
    seen = set()
    ordered_ids: List[str] = []
    for raw in bucket_ids:
        bid = (raw or '').strip()
        if bid and bid not in seen:
            seen.add(bid)
            ordered_ids.append(bid)
    ordered_ids = filter_search_index_enabled_bucket_ids(ordered_ids)
    if not ordered_ids:
        return {}

    config_by_id = bucket_config_by_id(buckets_iter)
    workers = max_workers if max_workers is not None else _reindex_workers()
    total = len(ordered_ids)
    stats: Dict[str, int] = {}
    batch_started = time.monotonic()

    _log_reindex_info(f'Reindex batch start: buckets={total} workers={workers}')

    def _run_bucket(bid: str) -> Tuple[str, int]:
        return _with_app_context(
            app,
            lambda bid=bid: _reindex_one_bucket(
                bid,
                config_by_id,
                get_s3_client_fn,
                index_mode=index_mode,
                cancel_check=cancel_check,
            ),
        )

    pending = list(ordered_ids)
    inflight: Dict[Any, str] = {}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        while pending or inflight:
            if cancel_check and cancel_check():
                for fut in list(inflight.keys()):
                    fut.cancel()
                break
            while pending and len(inflight) < workers:
                bid = pending.pop(0)
                inflight[pool.submit(_run_bucket, bid)] = bid
            if not inflight:
                break
            done_set, _ = wait(inflight.keys(), return_when=FIRST_COMPLETED)
            for fut in done_set:
                bid = inflight.pop(fut)
                try:
                    bucket_id, count = fut.result()
                except Exception as exc:
                    logger.warning('Reindex batch worker failed: bucket_id=%s: %s', bid, exc)
                    bucket_id, count = bid, -1
                stats[bucket_id] = count
                if on_bucket_complete:
                    on_bucket_complete(bucket_id, count)

    ok = sum(1 for n in stats.values() if n is not None and n >= 0)
    failed = total - ok
    _log_reindex_info(
        f'Reindex batch done: total={total} ok={ok} failed={failed} '
        f'duration={time.monotonic() - batch_started:.1f}s',
    )

    return stats


def reindex_all_buckets(
    buckets_iter: Callable[[], Dict[str, Any]],
    get_s3_client_fn: Callable[[Dict], Any],
    *,
    check_access_fn: Optional[Callable[[str], bool]] = None,
    app=None,
) -> Dict[str, int]:
    """Переиндексировать все бакеты из конфигурации."""
    config_by_id = bucket_config_by_id(buckets_iter)
    bucket_ids = filter_search_index_enabled_bucket_ids(list(config_by_id.keys()))
    if check_access_fn:
        bucket_ids = [bid for bid in bucket_ids if check_access_fn(bid)]
    return reindex_buckets_parallel(
        bucket_ids, buckets_iter, get_s3_client_fn, app=app,
    )


_periodic_sync_lock = threading.Lock()
_periodic_sync_started = False


def periodic_sync_enabled() -> bool:
    return _env_bool('MEILI_PERIODIC_SYNC', default=True)


def _on_bucket_index_complete(bucket_id: str, count: int) -> None:
    if count is not None and count >= 0:
        try:
            from db import set_bucket_search_reindexed_at
            set_bucket_search_reindexed_at(bucket_id, datetime.now(timezone.utc))
        except Exception as exc:
            logger.warning('Failed to update search_reindexed_at for %s: %s', bucket_id, exc)


def schedule_all_buckets_background_sync(
    buckets_iter: Callable[[], Dict[str, Any]],
    get_s3_client_fn: Callable[[Dict], Any],
    *,
    app=None,
    log_context: str = 'meilisearch',
    index_mode: str = 'auto',
) -> bool:
    """Фоновая индексация всех бакетов (auto: пустой индекс → full, иначе sync). False, если job уже идёт."""
    if not is_configured():
        return False
    bucket_ids = filter_search_index_enabled_bucket_ids(
        list(bucket_config_by_id(buckets_iter).keys()),
    )
    if not bucket_ids:
        return False
    return start_batch_reindex_background(
        bucket_ids,
        buckets_iter,
        get_s3_client_fn,
        app=app,
        log_context=log_context,
        on_bucket_complete=_on_bucket_index_complete,
        index_mode=index_mode,
    )


def schedule_startup_reindex(
    buckets_iter: Callable[[], Dict[str, Any]],
    get_s3_client_fn: Callable[[Dict], Any],
    *,
    app=None,
) -> None:
    if not _env_bool('MEILI_REINDEX_ON_STARTUP', default=False):
        return
    if not is_configured():
        return

    if not schedule_all_buckets_background_sync(
        buckets_iter,
        get_s3_client_fn,
        app=app,
        log_context='reindex_search',
        index_mode='auto',
    ):
        logger.warning('Meilisearch startup reindex skipped: batch already active')
        return

    _log_reindex_info(
        'Meilisearch startup index scheduled (empty index=full reindex, else sync)',
    )


def schedule_periodic_sync(
    buckets_iter: Callable[[], Dict[str, Any]],
    get_s3_client_fn: Callable[[Dict], Any],
    *,
    app=None,
) -> None:
    """Ежедневный sync всех бакетов в MEILI_SYNC_AT (MEILI_PERIODIC_SYNC, MEILI_SYNC_TIMEZONE)."""
    global _periodic_sync_started
    if not periodic_sync_enabled():
        return
    if not is_configured():
        return
    sync_at = _parse_periodic_sync_at()
    if sync_at is None:
        return
    hour, minute = sync_at
    tz = _periodic_sync_timezone()

    with _periodic_sync_lock:
        if _periodic_sync_started:
            return
        _periodic_sync_started = True

    def _loop() -> None:
        while True:
            delay_sec = _seconds_until_next_periodic_sync(hour, minute, tz)
            time.sleep(delay_sec)
            if not is_configured():
                continue
            if not schedule_all_buckets_background_sync(
                buckets_iter,
                get_s3_client_fn,
                app=app,
                log_context='meilisearch_periodic',
                index_mode='auto',
            ):
                logger.info('Meilisearch periodic sync skipped: batch already active')

    threading.Thread(target=_loop, name='meili-periodic-sync', daemon=True).start()
    _log_reindex_info(
        f'Meilisearch periodic sync enabled: daily at {hour:02d}:{minute:02d} '
        f'{tz.key} (empty index=full reindex, else sync)',
    )
