"""Фоновые задачи upload/delete/copy/move/acl с SSE-прогрессом (переживают обрыв HTTP).

Состояние дублируется в PostgreSQL (operation_jobs), чтобы переживать рестарт воркера.
Live SSE listeners — in-memory; при нескольких gunicorn workers недостающие события
и терминальный статус добираются из БД на poll.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, List, Optional

_jobs_lock = threading.Lock()
_jobs: Dict[str, Dict[str, Any]] = {}
_listeners_lock = threading.Lock()
_listeners: Dict[str, List[queue.Queue]] = {}

_SSE_HEARTBEAT_SEC = 25.0
_SSE_DB_POLL_SEC = 2.0
_MAX_HISTORY = 500
_JOB_RETENTION_SEC = 3600
_UPLOAD_IDLE_FINISH_SEC = 3.0
# Progress UPSERT в PG на каждый файл блокирует /active (DELETE/SELECT).
# Терминальные события пишем всегда; progress — не чаще интервала.
_PROGRESS_PERSIST_MIN_INTERVAL_SEC = float(
    os.environ.get('OPERATION_PROGRESS_PERSIST_SEC', '2.0')
)
_PURGE_MIN_INTERVAL_SEC = float(os.environ.get('OPERATION_PURGE_MIN_INTERVAL_SEC', '60'))
# pending без claim: worker poll ~1с; запас если worker временно выключен.
_STALE_PENDING_SEC = int(os.environ.get('OPERATION_STALE_PENDING_SEC', '120'))
# любой running без updated_at: progress в PG ~каждые OPERATION_PROGRESS_PERSIST_SEC (2с).
# Worker после рестарта НЕ reclaim'ит running — idle = мёртвый исполнитель.
_STALE_RUNNING_SEC = int(os.environ.get('OPERATION_STALE_RUNNING_SEC', '60'))
_last_purge_at = 0.0


def _now() -> float:
    return time.time()


def _ts_to_dt(ts: Optional[float]):
    if ts is None:
        return None
    return datetime.fromtimestamp(float(ts), tz=timezone.utc)


def _dt_to_ts(value) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    except Exception:
        return None


def _persist_job(job: Dict[str, Any]) -> None:
    """Best-effort запись снимка job в PostgreSQL."""
    try:
        from db import get_connection
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO operation_jobs (
                        id, username, op, status, meta, history, error,
                        cancel_requested, created_at, started_at, finished_at, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s,
                        %s, %s, %s, %s, NOW()
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        status = EXCLUDED.status,
                        meta = EXCLUDED.meta,
                        history = EXCLUDED.history,
                        error = EXCLUDED.error,
                        cancel_requested = EXCLUDED.cancel_requested,
                        started_at = COALESCE(EXCLUDED.started_at, operation_jobs.started_at),
                        finished_at = COALESCE(EXCLUDED.finished_at, operation_jobs.finished_at),
                        updated_at = NOW()
                    """,
                    (
                        job['id'],
                        job.get('username') or '',
                        job.get('op') or '',
                        job.get('status') or 'pending',
                        json.dumps(job.get('meta') or {}, ensure_ascii=False),
                        json.dumps((job.get('history') or [])[-_MAX_HISTORY:], ensure_ascii=False),
                        job.get('error'),
                        bool(job.get('cancel_requested')),
                        _ts_to_dt(job.get('created_at')),
                        _ts_to_dt(job.get('started_at')),
                        _ts_to_dt(job.get('finished_at')),
                    ),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        # Не ломаем операции из‑за БД; in-memory остаётся источником истины для текущего процесса
        pass


def _load_job_from_db(job_id: str) -> Optional[Dict[str, Any]]:
    try:
        from db import get_connection
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, username, op, status, meta, history, error,
                           cancel_requested, created_at, started_at, finished_at,
                           updated_at
                    FROM operation_jobs
                    WHERE id = %s
                    """,
                    (job_id,),
                )
                row = cur.fetchone()
            if not row:
                return None
            meta = row.get('meta') or {}
            history = row.get('history') or []
            if isinstance(meta, str):
                meta = json.loads(meta) if meta else {}
            if isinstance(history, str):
                history = json.loads(history) if history else []
            return {
                'id': str(row['id']),
                'username': row.get('username') or '',
                'op': row.get('op') or '',
                'meta': meta if isinstance(meta, dict) else {},
                'status': row.get('status') or 'pending',
                'created_at': _dt_to_ts(row.get('created_at')) or _now(),
                'started_at': _dt_to_ts(row.get('started_at')),
                'finished_at': _dt_to_ts(row.get('finished_at')),
                'updated_at': _dt_to_ts(row.get('updated_at')),
                'history': history if isinstance(history, list) else [],
                'error': row.get('error'),
                'cancel_requested': bool(row.get('cancel_requested')),
            }
        finally:
            conn.close()
    except Exception:
        return None


def _job_is_stale(job: Dict[str, Any], now: float) -> bool:
    status = job.get('status')
    if status == 'pending' and _STALE_PENDING_SEC > 0:
        age = now - float(job.get('created_at') or now)
        return age > _STALE_PENDING_SEC
    if status == 'running' and _STALE_RUNNING_SEC > 0:
        # По last activity (updated_at), не по started_at —
        # длинный reindex с прогрессом не должен считаться stale.
        age = now - float(
            job.get('updated_at')
            or job.get('started_at')
            or job.get('created_at')
            or now
        )
        return age > _STALE_RUNNING_SEC
    return False


def _purge_stale_jobs() -> None:
    now = _now()
    with _jobs_lock:
        for job_id in list(_jobs.keys()):
            job = _jobs[job_id]
            finished_at = job.get('finished_at')
            if finished_at is not None and now - finished_at > _JOB_RETENTION_SEC:
                del _jobs[job_id]
                with _listeners_lock:
                    _listeners.pop(job_id, None)
            elif _job_is_stale(job, now):
                job['status'] = 'error'
                job['error'] = 'stale_timeout'
                job['finished_at'] = now
    try:
        from db import get_connection
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                # Не ждать вечно за UPSERT progress с другого процесса
                cur.execute("SET LOCAL lock_timeout = '2s'")
                cur.execute("SET LOCAL statement_timeout = '10s'")
                # cancel запрошен, worker мёртв / не взял — не держим singleton (reindex и т.п.)
                cur.execute(
                    """
                    UPDATE operation_jobs
                    SET status = 'cancelled',
                        finished_at = COALESCE(finished_at, NOW()),
                        updated_at = NOW()
                    WHERE cancel_requested = true
                      AND status = 'pending'
                    """
                )
                # running + cancel: даём worker время остановиться; иначе — orphan
                if _STALE_PENDING_SEC > 0:
                    cur.execute(
                        """
                        UPDATE operation_jobs
                        SET status = 'cancelled',
                            finished_at = COALESCE(finished_at, NOW()),
                            updated_at = NOW()
                        WHERE cancel_requested = true
                          AND status = 'running'
                          AND COALESCE(updated_at, started_at, created_at)
                              < NOW() - (%s * INTERVAL '1 second')
                        """,
                        (int(_STALE_PENDING_SEC),),
                    )
                if _STALE_PENDING_SEC > 0:
                    cur.execute(
                        """
                        UPDATE operation_jobs
                        SET status = 'error',
                            error = COALESCE(NULLIF(error, ''), 'stale_timeout'),
                            finished_at = COALESCE(finished_at, NOW()),
                            updated_at = NOW()
                        WHERE status = 'pending'
                          AND created_at < NOW() - (%s * INTERVAL '1 second')
                        """,
                        (int(_STALE_PENDING_SEC),),
                    )
                if _STALE_RUNNING_SEC > 0:
                    cur.execute(
                        """
                        UPDATE operation_jobs
                        SET status = 'error',
                            error = COALESCE(NULLIF(error, ''), 'stale_timeout'),
                            finished_at = COALESCE(finished_at, NOW()),
                            updated_at = NOW()
                        WHERE status = 'running'
                          AND COALESCE(updated_at, started_at, created_at)
                              < NOW() - (%s * INTERVAL '1 second')
                        """,
                        (int(_STALE_RUNNING_SEC),),
                    )
                cur.execute(
                    """
                    DELETE FROM operation_jobs
                    WHERE finished_at IS NOT NULL
                      AND finished_at < NOW() - (%s * INTERVAL '1 second')
                    """,
                    (int(_JOB_RETENTION_SEC),),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def _purge_stale_jobs_maybe(*, force: bool = False) -> None:
    """Rate-limit purge: на каждый /active DELETE под нагрузкой лочит таблицу."""
    global _last_purge_at
    now = _now()
    if (
        not force
        and _PURGE_MIN_INTERVAL_SEC > 0
        and (now - _last_purge_at) < _PURGE_MIN_INTERVAL_SEC
    ):
        return
    _last_purge_at = now
    _purge_stale_jobs()


def purge_stale_jobs(*, force: bool = False) -> None:
    """Публичный вход для enqueue/singleton-проверок (force — без rate-limit)."""
    _purge_stale_jobs_maybe(force=force)


def create_job(username: str, op: str, meta: Optional[Dict[str, Any]] = None) -> str:
    _purge_stale_jobs_maybe()
    job_id = str(uuid.uuid4())
    job = {
        'id': job_id,
        'username': username,
        'op': op,
        'meta': dict(meta or {}),
        'status': 'pending',
        'created_at': _now(),
        'started_at': None,
        'finished_at': None,
        'updated_at': _now(),
        'history': [],
        'error': None,
        'cancel_requested': False,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    _persist_job(job)
    return job_id


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Снимок job. При external worker всегда подтягиваем PG — иначе web
    отдаёт устаревший in-memory status/meta без result от worker-процесса.
    """
    loaded = _sync_job_from_db(job_id)
    if loaded:
        return {
            'id': loaded['id'],
            'username': loaded['username'],
            'op': loaded['op'],
            'meta': dict(loaded.get('meta') or {}),
            'status': loaded['status'],
            'created_at': loaded['created_at'],
            'started_at': loaded.get('started_at'),
            'finished_at': loaded.get('finished_at'),
            'history': list(loaded.get('history') or []),
            'error': loaded.get('error'),
        }
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return None
        return {
            'id': job['id'],
            'username': job['username'],
            'op': job['op'],
            'meta': dict(job.get('meta') or {}),
            'status': job['status'],
            'created_at': job['created_at'],
            'started_at': job.get('started_at'),
            'finished_at': job.get('finished_at'),
            'history': list(job.get('history') or []),
            'error': job.get('error'),
        }


def job_belongs_to_user(job_id: str, username: str) -> bool:
    job = get_job(job_id)
    return bool(job and job.get('username') == username)


def is_job_active(job_id: str) -> bool:
    job = get_job(job_id)
    return bool(job and job.get('status') in ('pending', 'running'))


def _sync_job_from_db(job_id: str) -> Optional[Dict[str, Any]]:
    """Подтянуть актуальный status/meta/history/cancel из БД (web ↔ worker)."""
    loaded = _load_job_from_db(job_id)
    if not loaded:
        return None
    with _jobs_lock:
        mem = _jobs.get(job_id)
        if mem is None:
            _jobs[job_id] = dict(loaded)
            _jobs[job_id].setdefault('cancel_requested', False)
            # upload_state живёт только in-memory на worker, создавшем job
        else:
            mem['status'] = loaded.get('status')
            mem['meta'] = dict(loaded.get('meta') or {})
            mem['history'] = list(loaded.get('history') or [])
            mem['error'] = loaded.get('error')
            mem['finished_at'] = loaded.get('finished_at')
            mem['started_at'] = loaded.get('started_at')
            mem['updated_at'] = loaded.get('updated_at')
            mem['cancel_requested'] = bool(loaded.get('cancel_requested'))
    return {
        'id': loaded['id'],
        'username': loaded['username'],
        'op': loaded['op'],
        'meta': dict(loaded.get('meta') or {}),
        'status': loaded['status'],
        'created_at': loaded['created_at'],
        'started_at': loaded.get('started_at'),
        'finished_at': loaded.get('finished_at'),
        'updated_at': loaded.get('updated_at'),
        'history': list(loaded.get('history') or []),
        'error': loaded.get('error'),
        'cancel_requested': bool(loaded.get('cancel_requested')),
    }


def is_cancel_requested(job_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and job.get('cancel_requested'):
            return True
    # Cancel мог выставить другой gunicorn worker через БД
    loaded = _load_job_from_db(job_id)
    if not loaded or not loaded.get('cancel_requested'):
        return False
    with _jobs_lock:
        mem = _jobs.get(job_id)
        if mem:
            mem['cancel_requested'] = True
            if mem.get('op') == 'upload':
                state = mem.get('upload_state')
                if state:
                    state['sealed'] = True
                    _cancel_upload_idle_timer(state)
    return True


def request_cancel(job_id: str) -> bool:
    # Job мог быть создан на другом worker — подтянем из БД
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        if not _sync_job_from_db(job_id):
            return False
    publish_cancelled_now = False
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job.get('status') not in ('pending', 'running'):
            return False
        job['cancel_requested'] = True
        # pending: worker ещё не взял job — сразу terminal, иначе висит в /active
        if job.get('status') == 'pending':
            publish_cancelled_now = True
        elif job.get('op') == 'upload':
            state = job.get('upload_state')
            if state:
                state['sealed'] = True
                # Idle-timer сам бы вызвал finish, но при cancel мы его гасим —
                # если ничего не обрабатывается, terminal нужно опубликовать сразу,
                # иначе тост upload зависает навсегда.
                _cancel_upload_idle_timer(state)
                if int(state.get('processing') or 0) == 0:
                    publish_cancelled_now = True
            else:
                publish_cancelled_now = True
        snapshot = {
            'id': job['id'],
            'username': job.get('username'),
            'op': job.get('op'),
            'meta': dict(job.get('meta') or {}),
            'status': job.get('status'),
            'created_at': job.get('created_at'),
            'started_at': job.get('started_at'),
            'finished_at': job.get('finished_at'),
            'history': list(job.get('history') or []),
            'error': job.get('error'),
            'cancel_requested': True,
        }
    _persist_job(snapshot)
    if publish_cancelled_now:
        publish(job_id, {'type': 'cancelled'})
    return True


def publish(job_id: str, event: Dict[str, Any]) -> None:
    snapshot = None
    should_persist = True
    etype = None
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        history = job.setdefault('history', [])
        history.append(event)
        if len(history) > _MAX_HISTORY:
            job['history'] = history[-_MAX_HISTORY:]
        etype = event.get('type')
        now = _now()
        job['updated_at'] = now
        if etype == 'error':
            job['status'] = 'error'
            job['error'] = event.get('error')
            job['finished_at'] = now
        elif etype == 'done':
            job['status'] = 'done'
            job['finished_at'] = now
        elif etype == 'cancelled':
            job['status'] = 'cancelled'
            job['finished_at'] = now
        elif etype == 'progress':
            # In-memory + SSE всегда; в PG — throttled, иначе /active ждёт row lock
            last_persist = float(job.get('_last_progress_persist_at') or 0)
            if (
                _PROGRESS_PERSIST_MIN_INTERVAL_SEC > 0
                and (now - last_persist) < _PROGRESS_PERSIST_MIN_INTERVAL_SEC
            ):
                should_persist = False
            else:
                job['_last_progress_persist_at'] = now
        if should_persist:
            snapshot = {
                'id': job['id'],
                'username': job.get('username'),
                'op': job.get('op'),
                'meta': dict(job.get('meta') or {}),
                'status': job.get('status'),
                'created_at': job.get('created_at'),
                'started_at': job.get('started_at'),
                'finished_at': job.get('finished_at'),
                'history': list(job.get('history') or []),
                'error': job.get('error'),
                'cancel_requested': bool(job.get('cancel_requested')),
            }

    if snapshot:
        _persist_job(snapshot)

    with _listeners_lock:
        listeners = list(_listeners.get(job_id, []))
    for listener in listeners:
        try:
            listener.put_nowait(event)
        except queue.Full:
            # Терминальные события нельзя терять — освободим слот и повторим
            if etype in ('done', 'error', 'cancelled'):
                try:
                    listener.get_nowait()
                except queue.Empty:
                    pass
                try:
                    listener.put_nowait(event)
                except queue.Full:
                    pass


def sync_job_from_db(job_id: str) -> Optional[Dict[str, Any]]:
    """Публичная обёртка для worker-процесса."""
    return _sync_job_from_db(job_id)


def update_job_meta(job_id: str, patch: Dict[str, Any]) -> None:
    """Обновить meta (например result размера бакета) и персистить в PG."""
    snapshot = None
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        meta = dict(job.get('meta') or {})
        meta.update(patch or {})
        job['meta'] = meta
        snapshot = {
            'id': job['id'],
            'username': job.get('username'),
            'op': job.get('op'),
            'meta': meta,
            'status': job.get('status'),
            'created_at': job.get('created_at'),
            'started_at': job.get('started_at'),
            'finished_at': job.get('finished_at'),
            'history': list(job.get('history') or []),
            'error': job.get('error'),
            'cancel_requested': bool(job.get('cancel_requested')),
        }
    if snapshot:
        _persist_job(snapshot)


def mark_running(job_id: str) -> None:
    snapshot = None
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and job.get('status') == 'pending':
            job['status'] = 'running'
            job['started_at'] = _now()
            job['updated_at'] = job['started_at']
            snapshot = {
                'id': job['id'],
                'username': job.get('username'),
                'op': job.get('op'),
                'meta': dict(job.get('meta') or {}),
                'status': job.get('status'),
                'created_at': job.get('created_at'),
                'started_at': job.get('started_at'),
                'finished_at': job.get('finished_at'),
                'history': list(job.get('history') or []),
                'error': job.get('error'),
                'cancel_requested': bool(job.get('cancel_requested')),
            }
    if snapshot:
        _persist_job(snapshot)


def start_worker(job_id: str, target: Callable[[], None]) -> None:
    mark_running(job_id)

    def wrapper() -> None:
        try:
            target()
        except Exception as exc:
            publish(job_id, {'type': 'error', 'error': str(exc)})
        finally:
            # Safety net: если worker вышел без terminal event — зафиксируем в БД+SSE
            with _jobs_lock:
                job = _jobs.get(job_id)
                still_running = bool(job and job.get('status') == 'running')
            if still_running:
                if is_cancel_requested(job_id):
                    publish(job_id, {'type': 'cancelled'})
                else:
                    publish(job_id, {'type': 'done'})

    threading.Thread(target=wrapper, daemon=True).start()


def _terminal_event_from_job(job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Собрать terminal-событие из статуса/истории job (для SSE catch-up)."""
    status = job.get('status')
    history = job.get('history') or []
    for evt in reversed(history):
        if evt and evt.get('type') in ('done', 'error', 'cancelled'):
            return evt
    if status == 'cancelled':
        return {'type': 'cancelled'}
    if status == 'error':
        return {'type': 'error', 'error': job.get('error') or 'error'}
    if status == 'done':
        return {'type': 'done'}
    return None


def _history_catchup_start(new_history: List[Any], last_sent: Optional[Dict[str, Any]], sent_len: int) -> int:
    """Индекс в new_history, с которого досылать события клиенту.

    При кольцевом буфере (_MAX_HISTORY) длина истории не растёт — ищем last_sent
    по содержимому; если событие вытеснено, досылаем только «хвост» после sent_len
    или последнее событие.
    """
    if not new_history:
        return 0
    if last_sent is not None:
        for i in range(len(new_history) - 1, -1, -1):
            if new_history[i] == last_sent:
                return i + 1
        # last_sent вытеснен из кольца — отдадим хотя бы свежий хвост
        return max(0, len(new_history) - 1)
    if len(new_history) > sent_len:
        return sent_len
    return len(new_history)


def iter_job_events(job_id: str) -> Iterator[Dict[str, Any]]:
    """SSE-поток событий job.

    Live-события идут через in-memory queue (тот же worker-процесс).
    При нескольких gunicorn workers клиент может попасть на другой процесс —
    тогда на heartbeat добираем новые события и терминальный статус из PostgreSQL.
    """
    listener: queue.Queue = queue.Queue(maxsize=256)
    with _listeners_lock:
        _listeners.setdefault(job_id, []).append(listener)
    sent_history_len = 0
    last_sent_event: Optional[Dict[str, Any]] = None
    terminal_sent = False
    try:
        job = get_job(job_id)
        if not job:
            yield {'type': 'error', 'error': 'job_not_found'}
            return

        history = job.get('history') or []
        yield {
            'type': 'snapshot',
            'job': {
                'id': job['id'],
                'op': job['op'],
                'status': job['status'],
                'meta': job.get('meta') or {},
            },
            'history': history,
        }
        sent_history_len = len(history)
        if history:
            last_sent_event = history[-1]
        if any(evt and evt.get('type') in ('done', 'error', 'cancelled') for evt in history):
            terminal_sent = True

        if job.get('status') in ('done', 'error', 'cancelled'):
            if not terminal_sent:
                term = _terminal_event_from_job(job)
                if term:
                    yield term
            return

        last_ping_at = _now()
        while True:
            try:
                event = listener.get(timeout=_SSE_DB_POLL_SEC)
            except queue.Empty:
                refreshed = _sync_job_from_db(job_id)
                if not refreshed:
                    # БД недоступна / job только in-memory — смотрим локальный снимок
                    refreshed = get_job(job_id)
                if refreshed:
                    new_history = refreshed.get('history') or []
                    start = _history_catchup_start(new_history, last_sent_event, sent_history_len)
                    for evt in new_history[start:]:
                        yield evt
                        last_sent_event = evt
                        sent_history_len = min(len(new_history), sent_history_len + 1)
                        if evt.get('type') in ('done', 'error', 'cancelled'):
                            return
                    if refreshed.get('status') in ('done', 'error', 'cancelled'):
                        # История могла обрезаться или terminal не дошёл по queue —
                        # всегда отдадим terminal, иначе тост зависает навсегда
                        if not terminal_sent:
                            term = _terminal_event_from_job(refreshed)
                            if term:
                                yield term
                        return
                elif not is_job_active(job_id):
                    if not terminal_sent:
                        yield {'type': 'error', 'error': 'job_not_found'}
                    return
                if (_now() - last_ping_at) >= _SSE_HEARTBEAT_SEC:
                    yield {'type': 'ping'}
                    last_ping_at = _now()
                continue
            yield event
            last_sent_event = event
            if event.get('type') in ('done', 'error', 'cancelled'):
                terminal_sent = True
                return
    finally:
        with _listeners_lock:
            try:
                _listeners.get(job_id, []).remove(listener)
            except ValueError:
                pass


def find_active_job_by_op(op: str) -> Optional[Dict[str, Any]]:
    """Первый pending/running job с данным op (глобально, для singleton-операций вроде reindex)."""
    op = (op or '').strip()
    if not op:
        return None

    # Иначе зомби pending/running в PG блокирует reindex, пока /active не вызовет purge.
    _purge_stale_jobs_maybe()

    def _is_active(job: Optional[Dict[str, Any]]) -> bool:
        return bool(job and job.get('status') in ('pending', 'running'))

    with _jobs_lock:
        candidates = [
            j for j in _jobs.values()
            if j.get('op') == op and j.get('status') in ('pending', 'running')
        ]
    if candidates:
        candidates.sort(key=lambda j: j.get('created_at') or 0)
        for job in candidates:
            loaded = _sync_job_from_db(job['id'])
            if _is_active(loaded):
                return loaded
            # In-memory ещё «active», в PG уже terminal — не считаем активным.

    try:
        from db import get_connection
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id
                    FROM operation_jobs
                    WHERE op = %s AND status IN ('pending', 'running')
                    ORDER BY created_at ASC
                    LIMIT 1
                    """,
                    (op,),
                )
                row = cur.fetchone()
            if not row:
                return None
            job_id = str(row['id'] if isinstance(row, dict) else row[0])
        finally:
            conn.close()
    except Exception:
        return None
    loaded = _sync_job_from_db(job_id)
    return loaded if _is_active(loaded) else None


def get_job_with_cancel(job_id: str) -> Optional[Dict[str, Any]]:
    """Как get_job, но с cancel_requested (нужно для статуса reindex)."""
    loaded = _sync_job_from_db(job_id)
    if loaded:
        return loaded
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return None
        return {
            'id': job['id'],
            'username': job.get('username') or '',
            'op': job.get('op') or '',
            'meta': dict(job.get('meta') or {}),
            'status': job.get('status') or 'pending',
            'created_at': job.get('created_at'),
            'started_at': job.get('started_at'),
            'finished_at': job.get('finished_at'),
            'history': list(job.get('history') or []),
            'error': job.get('error'),
            'cancel_requested': bool(job.get('cancel_requested')),
        }


def list_jobs_for_user(username: str, *, active_only: bool = True) -> List[Dict[str, Any]]:
    # Force purge: иначе зомби delete/copy всплывает тостом при логине / resume.
    _purge_stale_jobs_maybe(force=True)
    by_id: Dict[str, Dict[str, Any]] = {}

    def _add(job_id: str, op: str, status: str, meta: Dict[str, Any], created_at) -> None:
        if active_only and status not in ('pending', 'running'):
            return
        by_id[job_id] = {
            'job_id': job_id,
            'op': op,
            'status': status,
            'display_names': (meta or {}).get('display_names') or [],
            'created_at': created_at,
        }

    with _jobs_lock:
        for job in _jobs.values():
            if job.get('username') != username:
                continue
            _add(
                job['id'],
                job.get('op') or '',
                job.get('status') or 'pending',
                job.get('meta') or {},
                job.get('created_at'),
            )

    # Jobs, созданные на другом gunicorn worker / external worker
    try:
        from db import get_connection
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL lock_timeout = '2s'")
                cur.execute("SET LOCAL statement_timeout = '5s'")
                if active_only:
                    # meta нужна только для display_names — без тяжёлого history
                    cur.execute(
                        """
                        SELECT id, op, status,
                               COALESCE(meta - 'payload', '{}'::jsonb) AS meta,
                               created_at
                        FROM operation_jobs
                        WHERE username = %s AND status IN ('pending', 'running')
                        """,
                        (username,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, op, status,
                               COALESCE(meta - 'payload', '{}'::jsonb) AS meta,
                               created_at
                        FROM operation_jobs
                        WHERE username = %s
                        ORDER BY created_at DESC
                        LIMIT 200
                        """,
                        (username,),
                    )
                for row in cur.fetchall() or []:
                    meta = row.get('meta') or {}
                    if isinstance(meta, str):
                        meta = json.loads(meta) if meta else {}
                    if not isinstance(meta, dict):
                        meta = {}
                    _add(
                        str(row['id']),
                        row.get('op') or '',
                        row.get('status') or 'pending',
                        meta,
                        _dt_to_ts(row.get('created_at')),
                    )
        finally:
            conn.close()
    except Exception:
        pass

    out = list(by_id.values())
    out.sort(key=lambda x: x.get('created_at') or 0)
    return out


def get_upload_state(job_id: str) -> Optional[Dict[str, Any]]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job.get('op') != 'upload':
            return None
        state = job.setdefault('upload_state', {})
        return state


def init_upload_state(job_id: str, total: int, display_names: List[str]) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job['upload_state'] = {
            'total': total,
            'display_names': display_names,
            'received': set(),
            'processing': 0,
            'completed': 0,
            'successful': 0,
            'failed': 0,
            'sealed': False,
            'last_receive_at': _now(),
            'idle_timer': None,
        }


def _cancel_upload_idle_timer(state: Dict[str, Any]) -> None:
    timer = state.get('idle_timer')
    if timer:
        try:
            timer.cancel()
        except Exception:
            pass
        state['idle_timer'] = None


def _schedule_upload_idle_finish(job_id: str, finish_cb: Callable[[str], None]) -> None:
    state = get_upload_state(job_id)
    if not state or state.get('sealed'):
        return

    def on_idle() -> None:
        with _jobs_lock:
            st = _jobs.get(job_id, {}).get('upload_state')
            if not st or st.get('sealed'):
                return
            st['sealed'] = True
        finish_cb(job_id)

    _cancel_upload_idle_timer(state)
    state['idle_timer'] = threading.Timer(_UPLOAD_IDLE_FINISH_SEC, on_idle)
    state['idle_timer'].daemon = True
    state['idle_timer'].start()


def register_upload_file_received(
    job_id: str,
    file_index: int,
    finish_cb: Callable[[str], None],
) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job.get('op') != 'upload':
            return False
        state = job.setdefault('upload_state', {})
        received = state.setdefault('received', set())
        if file_index in received:
            return False
        received.add(file_index)
        state['last_receive_at'] = _now()
    _schedule_upload_idle_finish(job_id, finish_cb)
    return True


def seal_upload_job(job_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        state = job.get('upload_state')
        if state:
            state['sealed'] = True
            _cancel_upload_idle_timer(state)


def upload_processing_started(job_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and job.get('upload_state') is not None:
            job['upload_state']['processing'] = int(job['upload_state'].get('processing') or 0) + 1


def upload_processing_finished(job_id: str, success: bool, finish_cb: Callable[[str], None]) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or not job.get('upload_state'):
            return
        state = job['upload_state']
        state['processing'] = max(0, int(state.get('processing') or 0) - 1)
        state['completed'] = int(state.get('completed') or 0) + 1
        if success:
            state['successful'] = int(state.get('successful') or 0) + 1
        else:
            state['failed'] = int(state.get('failed') or 0) + 1
        sealed = bool(state.get('sealed'))
        total = int(state.get('total') or 0)
        completed = int(state.get('completed') or 0)
        processing = int(state.get('processing') or 0)
        received_count = len(state.get('received') or set())
        should_finish = (
            processing == 0
            and (
                (sealed and completed >= received_count)
                or (total > 0 and completed >= total)
            )
        )
    if should_finish:
        finish_cb(job_id)
