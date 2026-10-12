"""Bucket size/objects from Prometheus / VictoriaMetrics (Ceph RGW metrics)."""

from __future__ import annotations

import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from logs import log_info, log_warning


_prom_down_until = 0.0
_prom_down_lock = threading.Lock()


def prometheus_base_url() -> str:
    """Base URL like https://host/select/0/prometheus. Empty disables metrics fetch."""
    return (os.environ.get('BUCKET_METRICS_PROMETHEUS_URL') or '').strip().rstrip('/')


def _prom_escape_label(value: str) -> str:
    return (
        str(value)
        .replace('\\', '\\\\')
        .replace('\n', '\\n')
        .replace('"', '\\"')
    )


def _query_timeout_sec() -> float:
    try:
        return max(1.0, float(os.environ.get('BUCKET_METRICS_TIMEOUT', '5')))
    except (TypeError, ValueError):
        return 5.0


def _fetch_timeout_sec() -> float:
    """Shorter timeout for bucket-size path so S3 fallback can finish before proxy 504."""
    try:
        return max(1.0, float(os.environ.get('BUCKET_METRICS_FETCH_TIMEOUT', '2')))
    except (TypeError, ValueError):
        return 2.0


def _fail_cooldown_sec() -> float:
    try:
        return max(0.0, float(os.environ.get('BUCKET_METRICS_FAIL_COOLDOWN', '60')))
    except (TypeError, ValueError):
        return 60.0


def _mark_prom_down() -> None:
    cooldown = _fail_cooldown_sec()
    if cooldown <= 0:
        return
    global _prom_down_until
    with _prom_down_lock:
        _prom_down_until = time.time() + cooldown


def _clear_prom_down() -> None:
    global _prom_down_until
    with _prom_down_lock:
        _prom_down_until = 0.0


def _prom_is_down() -> bool:
    with _prom_down_lock:
        return time.time() < _prom_down_until


def _env_flag(name: str, default: bool = True) -> bool:
    raw = (os.environ.get(name) or '').strip().lower()
    if not raw:
        return default
    return raw in ('1', 'true', 'yes', 'on')


def _ssl_context() -> ssl.SSLContext:
    """TLS context for VictoriaMetrics. Corp CA often needs verify=false or custom bundle."""
    if not _env_flag('BUCKET_METRICS_TLS_VERIFY', default=True):
        return ssl._create_unverified_context()
    cafile = (
        (os.environ.get('BUCKET_METRICS_CA_BUNDLE') or '').strip()
        or (os.environ.get('REQUESTS_CA_BUNDLE') or '').strip()
        or (os.environ.get('SSL_CERT_FILE') or '').strip()
        or None
    )
    if cafile and os.path.isfile(cafile):
        return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


class _PromTransportError(Exception):
    """Prometheus endpoint unreachable; abort the whole metrics batch."""


def _instant_query(
    base_url: str,
    query: str,
    timeout: Optional[float] = None,
) -> Optional[float]:
    """Run Prometheus instant query; return first sample value or None."""
    url = (
        base_url.rstrip('/')
        + '/api/v1/query?'
        + urllib.parse.urlencode({'query': query})
    )
    req = urllib.request.Request(url, headers={'Accept': 'application/json'}, method='GET')
    try:
        with urllib.request.urlopen(
            req,
            timeout=_query_timeout_sec() if timeout is None else timeout,
            context=_ssl_context(),
        ) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise _PromTransportError(str(exc)) from exc
    except urllib.error.HTTPError as exc:
        log_warning(
            f'Prometheus query HTTP {exc.code} for {base_url}: {query[:120]}',
            'bucket_metrics',
        )
        return None
    if not raw:
        return None
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        log_warning(
            f'Prometheus query returned invalid JSON from {base_url}: {exc}',
            'bucket_metrics',
        )
        return None
    if not isinstance(payload, dict) or payload.get('status') != 'success':
        log_warning(
            f'Prometheus query failed status from {base_url}: {query[:120]}',
            'bucket_metrics',
        )
        return None
    data = payload.get('data') or {}
    result = data.get('result') if isinstance(data, dict) else None
    if not isinstance(result, list) or not result:
        return None
    first = result[0]
    if not isinstance(first, dict):
        return None
    value = first.get('value')
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    try:
        return float(value[1])
    except (TypeError, ValueError):
        return None


def _quota_or_none(value: Optional[float]) -> Optional[float]:
    """Ceph: 0 / negative quota means unlimited or unset."""
    if value is None:
        return None
    if value <= 0:
        return None
    return value


def connection_status() -> dict[str, Any]:
    """Status probe for Settings → Status (Prometheus / VictoriaMetrics)."""
    base = prometheus_base_url()
    tls_verify = _env_flag('BUCKET_METRICS_TLS_VERIFY', default=True)
    timeout_sec = _query_timeout_sec()
    ca_bundle = (
        (os.environ.get('BUCKET_METRICS_CA_BUNDLE') or '').strip()
        or (os.environ.get('REQUESTS_CA_BUNDLE') or '').strip()
        or (os.environ.get('SSL_CERT_FILE') or '').strip()
    )
    vars_list = [
        {'name': 'BUCKET_METRICS_PROMETHEUS_URL', 'ok': bool(base), 'required': True},
        {'name': 'BUCKET_METRICS_TLS_VERIFY', 'ok': True, 'required': False},
        {'name': 'BUCKET_METRICS_TIMEOUT', 'ok': True, 'required': False},
    ]
    if ca_bundle:
        vars_list.append({
            'name': 'BUCKET_METRICS_CA_BUNDLE',
            'ok': os.path.isfile(ca_bundle),
            'required': False,
        })

    if not base:
        log_warning(
            'Prometheus status: BUCKET_METRICS_PROMETHEUS_URL is not set',
            'prometheus_status',
        )
        return {
            'configured': False,
            'connected': False,
            'status': 'not_configured',
            'detail': '',
            'vars': vars_list,
            'meta': {
                'url': None,
                'tls_verify': tls_verify,
                'timeout_sec': timeout_sec,
            },
        }

    url = (
        base.rstrip('/')
        + '/api/v1/query?'
        + urllib.parse.urlencode({'query': 'vector(1)'})
    )
    req = urllib.request.Request(url, headers={'Accept': 'application/json'}, method='GET')
    try:
        with urllib.request.urlopen(
            req, timeout=timeout_sec, context=_ssl_context()
        ) as resp:
            raw = resp.read()
        payload = json.loads(raw.decode('utf-8')) if raw else {}
        ok = isinstance(payload, dict) and payload.get('status') == 'success'
        if ok:
            _clear_prom_down()
            log_info(
                f'Prometheus status: connected to {base} '
                f'(tls_verify={tls_verify}, timeout={timeout_sec}s)',
                'prometheus_status',
            )
            return {
                'configured': True,
                'connected': True,
                'status': 'ok',
                'detail': f'Connected to {base}',
                'vars': vars_list,
                'meta': {
                    'url': base,
                    'tls_verify': tls_verify,
                    'timeout_sec': timeout_sec,
                },
            }
        detail = 'Prometheus returned an unexpected response'
    except urllib.error.HTTPError as exc:
        ok = False
        detail = f'HTTP {exc.code}'
    except (urllib.error.URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        ok = False
        detail = str(exc)[:240] or 'Unreachable'

    _mark_prom_down()
    log_warning(
        f'Prometheus status: probe failed for {base} '
        f'(tls_verify={tls_verify}, timeout={timeout_sec}s): {detail}',
        'prometheus_status',
    )
    return {
        'configured': True,
        'connected': False,
        'status': 'error',
        'detail': f'{detail} ({base})' if detail else f'Unreachable ({base})',
        'vars': vars_list,
        'meta': {
            'url': base,
            'tls_verify': tls_verify,
            'timeout_sec': timeout_sec,
            'probe_error': detail,
        },
    }


def fetch_ceph_bucket_metrics(bucket_name: str) -> Optional[dict[str, Any]]:
    """
    Read Ceph S3 bucket metrics for the given bucket name (RGW label ``bucket``).

    Returns dict with size/size_max in bytes and objects_count/objects_max, or None
    if Prometheus is disabled or metrics are unavailable.
    """
    base = prometheus_base_url()
    if not base or not (bucket_name or '').strip():
        return None

    if _prom_is_down():
        return None

    label = _prom_escape_label(bucket_name.strip())
    timeout = _fetch_timeout_sec()
    try:
        size_kb = _instant_query(
            base, f'ceph_s3_bucket_size_kb_actual{{bucket="{label}"}}', timeout=timeout
        )
        size_max_kb = _quota_or_none(
            _instant_query(
                base, f'ceph_s3_bucket_quota_max_size_kb{{bucket="{label}"}}', timeout=timeout
            )
        )
        objects_count = _instant_query(
            base, f'ceph_s3_bucket_objects_count{{bucket="{label}"}}', timeout=timeout
        )
        objects_max = _quota_or_none(
            _instant_query(
                base, f'ceph_s3_bucket_quota_max_objects{{bucket="{label}"}}', timeout=timeout
            )
        )
    except _PromTransportError as exc:
        _mark_prom_down()
        log_warning(
            f'Prometheus metrics unavailable for bucket {bucket_name!r} via {base}: {exc}',
            'bucket_metrics',
        )
        return None

    if size_kb is None and objects_count is None:
        return None

    _clear_prom_down()
    size_bytes = int(round((size_kb or 0.0) * 1024.0))
    size_max_bytes = int(round(size_max_kb * 1024.0)) if size_max_kb is not None else None
    return {
        'size': size_bytes,
        'size_max': size_max_bytes,
        'objects_count': int(round(objects_count or 0.0)),
        'objects_max': int(round(objects_max)) if objects_max is not None else None,
        'source': 'prometheus',
        'truncated': False,
    }
