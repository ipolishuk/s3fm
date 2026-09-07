"""Фоновые задачи upload/delete/copy/move/acl с SSE-прогрессом (переживают обрыв HTTP).

Состояние дублируется в PostgreSQL (operation_jobs), чтобы переживать рестарт воркера.
Live SSE listeners — in-memory; при нескольких gunicorn workers недостающие события
и терминальный статус добираются из БД на poll.
"""

from __future__ import annotations

import json
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
                           cancel_requested, created_at, started_at, finished_at
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
                'history': history if isinstance(history, list) else [],
                'error': row.get('error'),
                'cancel_requested': bool(row.get('cancel_requested')),
            }
        finally:
            conn.close()
    except Exception:
        return None


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
    try:
        from db import get_connection
        conn = get_connection()
        try:
            with conn.cursor() as cur:
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


def create_job(username: str, op: str, meta: Optional[Dict[str, Any]] = None) -> str:
    _purge_stale_jobs()
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
        'history': [],
        'error': None,
        'cancel_requested': False,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    _persist_job(job)
    return job_id


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
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
    loaded = _load_job_from_db(job_id)
    if not loaded:
        return None
    with _jobs_lock:
        # Не затираем более свежий in-memory job, если появился параллельно
        if job_id not in _jobs:
            _jobs[job_id] = dict(loaded)
            _jobs[job_id].setdefault('cancel_requested', False)
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


def job_belongs_to_user(job_id: str, username: str) -> bool:
    job = get_job(job_id)
    return bool(job and job.get('username') == username)


def is_job_active(job_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            return job.get('status') in ('pending', 'running')
    loaded = _load_job_from_db(job_id)
    return bool(loaded and loaded.get('status') in ('pending', 'running'))


def _sync_job_from_db(job_id: str) -> Optional[Dict[str, Any]]:
    """Подтянуть актуальный status/history/cancel из БД (несколько gunicorn workers)."""
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
            mem['history'] = list(loaded.get('history') or [])
            mem['error'] = loaded.get('error')
            mem['finished_at'] = loaded.get('finished_at')
            mem['started_at'] = loaded.get('started_at')
            if loaded.get('cancel_requested'):
                mem['cancel_requested'] = True
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
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job.get('status') not in ('pending', 'running'):
            return False
        job['cancel_requested'] = True
        if job.get('op') == 'upload':
            state = job.get('upload_state')
            if state:
                state['sealed'] = True
                _cancel_upload_idle_timer(state)
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
    return True


def publish(job_id: str, event: Dict[str, Any]) -> None:
    snapshot = None
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        history = job.setdefault('history', [])
        history.append(event)
        if len(history) > _MAX_HISTORY:
            job['history'] = history[-_MAX_HISTORY:]
        etype = event.get('type')
        if etype == 'error':
            job['status'] = 'error'
            job['error'] = event.get('error')
            job['finished_at'] = _now()
        elif etype == 'done':
            job['status'] = 'done'
            job['finished_at'] = _now()
        elif etype == 'cancelled':
            job['status'] = 'cancelled'
            job['finished_at'] = _now()
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
            pass


def mark_running(job_id: str) -> None:
    snapshot = None
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and job.get('status') == 'pending':
            job['status'] = 'running'
            job['started_at'] = _now()
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
            # Safety net: если worker вышел без terminal event — зафиксируем done в БД+SSE
            with _jobs_lock:
                job = _jobs.get(job_id)
                still_running = bool(job and job.get('status') == 'running')
            if still_running:
                publish(job_id, {'type': 'done'})

    threading.Thread(target=wrapper, daemon=True).start()


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

        if job.get('status') in ('done', 'error', 'cancelled'):
            return

        last_ping_at = _now()
        while True:
            try:
                event = listener.get(timeout=_SSE_DB_POLL_SEC)
            except queue.Empty:
                refreshed = _sync_job_from_db(job_id)
                if refreshed:
                    new_history = refreshed.get('history') or []
                    if len(new_history) > sent_history_len:
                        for evt in new_history[sent_history_len:]:
                            yield evt
                            sent_history_len += 1
                            if evt.get('type') in ('done', 'error', 'cancelled'):
                                return
                    if refreshed.get('status') in ('done', 'error', 'cancelled'):
                        # История могла обрезаться (_MAX_HISTORY) — отдадим terminal клиенту
                        last = (refreshed.get('history') or [])[-1:] or [None]
                        last_evt = last[0]
                        if not last_evt or last_evt.get('type') not in ('done', 'error', 'cancelled'):
                            status = refreshed.get('status')
                            if status == 'cancelled':
                                yield {'type': 'cancelled'}
                            elif status == 'error':
                                yield {
                                    'type': 'error',
                                    'error': refreshed.get('error') or 'error',
                                }
                            else:
                                yield {'type': 'done'}
                        return
                elif not is_job_active(job_id):
                    return
                if (_now() - last_ping_at) >= _SSE_HEARTBEAT_SEC:
                    yield {'type': 'ping'}
                    last_ping_at = _now()
                continue
            yield event
            with _jobs_lock:
                mem = _jobs.get(job_id)
                if mem:
                    sent_history_len = max(sent_history_len, len(mem.get('history') or []))
            if event.get('type') in ('done', 'error', 'cancelled'):
                return
    finally:
        with _listeners_lock:
            try:
                _listeners.get(job_id, []).remove(listener)
            except ValueError:
                pass


def list_jobs_for_user(username: str, *, active_only: bool = True) -> List[Dict[str, Any]]:
    _purge_stale_jobs()
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

    # Jobs, созданные на другом gunicorn worker
    try:
        from db import get_connection
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                if active_only:
                    cur.execute(
                        """
                        SELECT id, op, status, meta, created_at
                        FROM operation_jobs
                        WHERE username = %s AND status IN ('pending', 'running')
                        """,
                        (username,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, op, status, meta, created_at
                        FROM operation_jobs
                        WHERE username = %s
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
