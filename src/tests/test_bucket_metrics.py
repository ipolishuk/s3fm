"""Unit tests for Prometheus bucket metrics helper."""

from __future__ import annotations

import json
import urllib.error
from unittest.mock import patch

import bucket_metrics as bm


class _Resp:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode('utf-8')

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_prom_escape_label():
    assert bm._prom_escape_label('a"b\\c') == 'a\\"b\\\\c'


def test_fetch_disabled_without_url(monkeypatch):
    bm._clear_prom_down()
    monkeypatch.delenv('BUCKET_METRICS_PROMETHEUS_URL', raising=False)
    assert bm.fetch_ceph_bucket_metrics('demo') is None


def test_fetch_success(monkeypatch):
    bm._clear_prom_down()
    monkeypatch.setenv('BUCKET_METRICS_PROMETHEUS_URL', 'https://vm.example/select/0/prometheus')

    def fake_urlopen(req, timeout=None, context=None):
        url = req.full_url
        if 'size_kb_actual' in url:
            val = '2048'
        elif 'quota_max_size_kb' in url:
            val = '4096'
        elif 'objects_count' in url:
            val = '3000'
        elif 'quota_max_objects' in url:
            val = '10000'
        else:
            val = '0'
        return _Resp({
            'status': 'success',
            'data': {'resultType': 'vector', 'result': [{'value': [1, val]}]},
        })

    with patch('bucket_metrics.urllib.request.urlopen', side_effect=fake_urlopen):
        out = bm.fetch_ceph_bucket_metrics('my-bucket')
    assert out is not None
    assert out['source'] == 'prometheus'
    assert out['size'] == 2048 * 1024
    assert out['size_max'] == 4096 * 1024
    assert out['objects_count'] == 3000
    assert out['objects_max'] == 10000


def test_fetch_unlimited_quota(monkeypatch):
    bm._clear_prom_down()
    monkeypatch.setenv('BUCKET_METRICS_PROMETHEUS_URL', 'https://vm.example/select/0/prometheus')

    def fake_urlopen(req, timeout=None, context=None):
        url = req.full_url
        if 'quota_max' in url:
            val = '0'
        elif 'size_kb_actual' in url:
            val = '100'
        else:
            val = '50'
        return _Resp({
            'status': 'success',
            'data': {'resultType': 'vector', 'result': [{'value': [1, val]}]},
        })

    with patch('bucket_metrics.urllib.request.urlopen', side_effect=fake_urlopen):
        out = bm.fetch_ceph_bucket_metrics('b')
    assert out['size_max'] is None
    assert out['objects_max'] is None


def test_fetch_network_error_returns_none(monkeypatch):
    bm._clear_prom_down()
    monkeypatch.setenv('BUCKET_METRICS_PROMETHEUS_URL', 'https://vm.example/select/0/prometheus')
    monkeypatch.setenv('BUCKET_METRICS_FAIL_COOLDOWN', '60')

    def boom(*args, **kwargs):
        raise urllib.error.URLError('down')

    with patch('bucket_metrics.urllib.request.urlopen', side_effect=boom) as mocked:
        assert bm.fetch_ceph_bucket_metrics('b') is None
        assert mocked.call_count >= 1
        mocked.reset_mock()
        # Cooldown: skip Prometheus after transport failure.
        assert bm.fetch_ceph_bucket_metrics('b') is None
        assert mocked.call_count == 0
    bm._clear_prom_down()


def test_connection_status_not_configured(monkeypatch):
    bm._clear_prom_down()
    monkeypatch.delenv('BUCKET_METRICS_PROMETHEUS_URL', raising=False)
    st = bm.connection_status()
    assert st['status'] == 'not_configured'
    assert st['configured'] is False
    assert st['connected'] is False


def test_connection_status_ok(monkeypatch):
    bm._clear_prom_down()
    monkeypatch.setenv('BUCKET_METRICS_PROMETHEUS_URL', 'https://vm.example/select/0/prometheus')
    monkeypatch.setenv('BUCKET_METRICS_TLS_VERIFY', 'false')

    def fake_urlopen(req, timeout=None, context=None):
        return _Resp({'status': 'success', 'data': {'resultType': 'vector', 'result': []}})

    with patch('bucket_metrics.urllib.request.urlopen', side_effect=fake_urlopen):
        st = bm.connection_status()
    assert st['status'] == 'ok'
    assert st['connected'] is True
    assert 'vm.example' in st['detail']
