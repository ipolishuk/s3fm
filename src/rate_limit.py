"""Простой in-memory rate limiter (per-process)."""

from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Tuple


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or '').strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Login: N failures per IP (and per username) within window → 429
LOGIN_RATE_LIMIT = _env_int('LOGIN_RATE_LIMIT', 5)
LOGIN_RATE_WINDOW_SECONDS = _env_int('LOGIN_RATE_WINDOW_SECONDS', 300)

# Metrics scrape: generous enough for Prometheus every 15–30s
METRICS_RATE_LIMIT = _env_int('METRICS_RATE_LIMIT', 60)
METRICS_RATE_WINDOW_SECONDS = _env_int('METRICS_RATE_WINDOW_SECONDS', 60)


class SlidingWindowLimiter:
    """Скользящее окно: не больше `limit` событий за `window_seconds` на ключ."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)

    def _prune(self, q: Deque[float], now: float, window_seconds: float) -> None:
        cutoff = now - window_seconds
        while q and q[0] < cutoff:
            q.popleft()

    def allow(self, key: str, limit: int, window_seconds: int) -> Tuple[bool, int]:
        """
        Returns (allowed, retry_after_seconds).
        On allow — событие уже учтено. On deny — не учитывается повторно.
        """
        if limit <= 0:
            return True, 0
        now = time.monotonic()
        window = max(1, int(window_seconds))
        with self._lock:
            q = self._hits[key]
            self._prune(q, now, window)
            if len(q) >= limit:
                retry = max(1, int(window - (now - q[0])) + 1)
                return False, retry
            q.append(now)
            return True, 0

    def peek_blocked(self, key: str, limit: int, window_seconds: int) -> Tuple[bool, int]:
        """True если уже превышен лимит (без записи нового hit)."""
        if limit <= 0:
            return False, 0
        now = time.monotonic()
        window = max(1, int(window_seconds))
        with self._lock:
            q = self._hits[key]
            self._prune(q, now, window)
            if len(q) >= limit:
                retry = max(1, int(window - (now - q[0])) + 1)
                return True, retry
            return False, 0


_limiter = SlidingWindowLimiter()


def client_ip_from_request(request) -> str:
    """IP клиента с учётом X-Forwarded-For (первый hop), иначе remote_addr."""
    forwarded = (request.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
    if forwarded:
        return forwarded
    return (request.remote_addr or 'unknown').strip() or 'unknown'


def check_login_rate(ip: str, username: str = '') -> Tuple[bool, int]:
    """Перед попыткой входа: False → 429. Hit пишется только при неуспехе (record_login_failure)."""
    blocked, retry = _limiter.peek_blocked(
        f'login:ip:{ip}', LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS,
    )
    if blocked:
        return False, retry
    uname = (username or '').strip().lower()
    if uname:
        blocked, retry = _limiter.peek_blocked(
            f'login:user:{uname}', LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS,
        )
        if blocked:
            return False, retry
    return True, 0


def record_login_failure(ip: str, username: str = '') -> None:
    """Учесть неудачную попытку входа в окне rate limit."""
    _limiter.allow(f'login:ip:{ip}', LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS)
    uname = (username or '').strip().lower()
    if uname:
        _limiter.allow(f'login:user:{uname}', LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS)


def check_metrics_rate(ip: str) -> Tuple[bool, int]:
    return _limiter.allow(
        f'metrics:ip:{ip}', METRICS_RATE_LIMIT, METRICS_RATE_WINDOW_SECONDS,
    )
