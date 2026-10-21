"""Выполнение operation_jobs вне gunicorn: claim из PG + hydrate payload + run.

API только создаёт job (pending + serializable payload). Этот модуль крутит
отдельный процесс `worker.py` или embedded-thread при OPERATION_WORKER_MODE=embedded.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

from logs import LOG_CONFIG, log_error, log_info, log_user_action
from translations import _

WORKER_OPS = frozenset({'copy', 'move', 'delete', 'acl', 'bucket_size', 'reindex'})

# Singleton enqueue + Meili scheduler (несколько worker-реплик)
_REINDEX_ENQUEUE_LOCK_KEY = 87201411
_MEILI_SCHEDULER_LOCK_KEY = 87201412
_meili_scheduler_leader_conn = None

_OP_LOG_CONTEXT = {
    'copy': 'copy_objects',
    'move': 'move_objects',
    'delete': 'delete_objects',
    'acl': 'file_metadata_acl_batch',
    'bucket_size': 'bucket_size',
    'reindex': 'reindex_search',
}


def _op_log_context(op: str, payload: Optional[Dict[str, Any]] = None) -> str:
    if op == 'reindex' and isinstance(payload, dict):
        ctx = (payload.get('log_context') or '').strip()
        if ctx:
            return ctx
    return _OP_LOG_CONTEXT.get(op, 'worker')


def _job_log_suffix(op: str, job: Optional[Dict[str, Any]]) -> str:
    """Доп. поля для bucket_size: bucket='…' id=…"""
    if op != 'bucket_size' or not job:
        return ''
    bucket_id = job.get('bucket_id') or ''
    display = job.get('display_name') or bucket_id
    return f' bucket={display!r} id={bucket_id}'


def _progress_log_interval_sec() -> float:
    try:
        sec = float(os.environ.get('OPERATION_PROGRESS_LOG_SEC', '30'))
    except (TypeError, ValueError):
        sec = 30.0
    return max(5.0, sec)


def _make_progress_logger(job_id: str, context: str, username: str, suffix: str = ''):
    """Throttled Processing-логи, чтобы было видно что job жив.

    Первый лог не сразу после Start — только после OPERATION_PROGRESS_LOG_SEC
    (короткие job: Start → Finished без Processing).
    """
    started_at = time.time()
    last_log_at = [0.0]
    interval = _progress_log_interval_sec()

    def maybe_log(event: Dict[str, Any]) -> None:
        if not event or event.get('type') != 'progress':
            return
        now = time.time()
        # Не дублируем Start в ту же секунду
        if last_log_at[0] <= 0 and (now - started_at) < interval:
            return
        if last_log_at[0] > 0 and (now - last_log_at[0]) < interval:
            return
        current = event.get('current')
        total = event.get('total')
        extra = ''
        if current is not None and total not in (None, 0) and not event.get('total_pending'):
            extra = f' current={current}/{total}'
        elif current is not None:
            extra = f' current={current}'
        log_info(
            f'Processing job={job_id}{suffix}{extra}',
            context,
            username=username or 'SYSTEM',
        )
        last_log_at[0] = now

    return maybe_log


class JobCancelled(Exception):
    """Операция прервана по cancel_requested (между батчами/ключами)."""


def worker_mode() -> str:
    """external — только отдельный процесс; embedded — thread в web (dev/tests)."""
    raw = (os.environ.get('OPERATION_WORKER_MODE') or 'embedded').strip().lower()
    return 'external' if raw in ('external', 'worker', '1', 'true', 'yes') else 'embedded'


def use_external_worker() -> bool:
    return worker_mode() == 'external'


def cancel_check_every() -> int:
    try:
        n = int(os.environ.get('OPERATION_CANCEL_CHECK_EVERY', '10'))
    except (TypeError, ValueError):
        n = 10
    return max(1, n)


def serialize_transfer_job(job: Dict[str, Any]) -> Dict[str, Any]:
    """copy/move: убираем boto-клиентов."""
    return {
        'src_bucket_id': job['src_bucket_id'],
        'dst_bucket_id': job['dst_bucket_id'],
        'dst_path': job.get('dst_path') or '',
        'normalized_items': list(job.get('normalized_items') or []),
        'use_server_copy': bool(job.get('use_server_copy')),
        'src_display': job.get('src_display') or '',
        'dst_display': job.get('dst_display') or '',
        'src_bucket_name': job.get('src_bucket_name') or '',
        'dst_bucket_name': job.get('dst_bucket_name') or '',
        'username': job.get('username') or 'unknown',
    }


def serialize_delete_job(job: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'bucket_id': job['bucket_id'],
        'bucket_name': job.get('bucket_name') or '',
        'display_name': job.get('display_name') or '',
        'items': list(job.get('items') or []),
        'username': job.get('username') or 'unknown',
    }


def serialize_acl_job(job: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'bucket_id': job['bucket_id'],
        'bucket_name': job.get('bucket_name') or '',
        'display_name': job.get('display_name') or '',
        'paths': list(job.get('paths') or []),
        'grants': list(job.get('grants') or []),
        'username': job.get('username') or 'unknown',
    }


def serialize_bucket_size_job(bucket_id: str, username: str) -> Dict[str, Any]:
    return {
        'bucket_id': bucket_id,
        'username': username or 'unknown',
    }


def serialize_reindex_job(
    bucket_ids: List[str],
    *,
    index_mode: str = 'full',
    log_context: str = 'reindex_search',
    username: str = 'system',
) -> Dict[str, Any]:
    return {
        'bucket_ids': list(bucket_ids or []),
        'index_mode': index_mode or 'full',
        'log_context': log_context or 'reindex_search',
        'username': username or 'system',
    }


def _pg_try_advisory_lock(conn, key: int) -> bool:
    with conn.cursor() as cur:
        cur.execute('SELECT pg_try_advisory_lock(%s)', (key,))
        row = cur.fetchone()
    if not row:
        return False
    return bool(next(iter(row.values()))) if isinstance(row, dict) else bool(row[0])


def _pg_advisory_unlock(conn, key: int) -> None:
    with conn.cursor() as cur:
        cur.execute('SELECT pg_advisory_unlock(%s)', (key,))


def enqueue_reindex(
    bucket_ids: List[str],
    *,
    index_mode: str = 'full',
    log_context: str = 'reindex_search',
    username: str = 'system',
) -> Optional[str]:
    """Создать pending reindex job. None, если уже есть активный reindex или список пуст."""
    import meilisearch
    import operation_jobs
    from db import get_connection

    seen = set()
    ordered: List[str] = []
    for raw in bucket_ids or []:
        bid = (raw or '').strip()
        if bid and bid not in seen:
            seen.add(bid)
            ordered.append(bid)
    ordered = meilisearch.filter_search_index_enabled_bucket_ids(ordered)
    if not ordered:
        return None

    workers = meilisearch.reindex_workers()
    display_names = ordered[:5]
    if len(ordered) > 5:
        display_names = display_names + [f'+{len(ordered) - 5}']

    payload = serialize_reindex_job(
        ordered,
        index_mode=index_mode,
        log_context=log_context,
        username=username,
    )
    meta = {
        'display_names': display_names,
        'payload': payload,
        'total': len(ordered),
        'completed': 0,
        'workers': workers,
        'bucket_ids': list(ordered),
        'stats': {},
        'error': None,
        'last_bucket_id': None,
        'last_count': None,
        'index_mode': index_mode or 'full',
        'log_context': log_context or 'reindex_search',
    }

    conn = None
    locked = False
    job_id = None
    try:
        conn = get_connection()
        locked = _pg_try_advisory_lock(conn, _REINDEX_ENQUEUE_LOCK_KEY)
        if not locked:
            # Другой процесс как раз ставит reindex — не дублируем.
            return None
        if operation_jobs.find_active_job_by_op('reindex'):
            return None
        job_id = operation_jobs.create_job(username or 'system', 'reindex', meta)
    finally:
        if conn is not None:
            if locked:
                try:
                    _pg_advisory_unlock(conn, _REINDEX_ENQUEUE_LOCK_KEY)
                except Exception:
                    pass
            try:
                conn.close()
            except Exception:
                pass

    if not job_id:
        return None
    if not use_external_worker():
        operation_jobs.start_worker(job_id, lambda: execute_job(job_id))
    return job_id


def _hydrate_s3_clients(payload: Dict[str, Any], op: str) -> Dict[str, Any]:
    from bucket_access import find_bucket_config_by_bucket_id
    from s3_client import get_s3_client
    from file_ops import _s3_copy_configs_compatible

    job = dict(payload)
    if op in ('copy', 'move'):
        src_info = find_bucket_config_by_bucket_id(job['src_bucket_id'])
        dst_info = find_bucket_config_by_bucket_id(job['dst_bucket_id'])
        if not src_info or not dst_info:
            raise RuntimeError('bucket_not_found')
        src_cfg = src_info['bucket_config']
        dst_cfg = dst_info['bucket_config']
        src_client = get_s3_client(src_cfg)
        dst_client = get_s3_client(dst_cfg)
        use_server_copy = bool(job.get('use_server_copy')) or (
            src_client is dst_client or _s3_copy_configs_compatible(src_cfg, dst_cfg)
        )
        if use_server_copy and src_client is not dst_client:
            dst_client = src_client
        job['src_client'] = src_client
        job['dst_client'] = dst_client
        job['use_server_copy'] = use_server_copy
        job['src_bucket_name'] = job.get('src_bucket_name') or src_cfg.get('bucket_name')
        job['dst_bucket_name'] = job.get('dst_bucket_name') or dst_cfg.get('bucket_name')
        job['src_display'] = job.get('src_display') or src_info.get('display_name') or ''
        job['dst_display'] = job.get('dst_display') or dst_info.get('display_name') or ''
        return job

    if op in ('delete', 'acl', 'bucket_size'):
        bucket_id = job.get('bucket_id') or ''
        info = find_bucket_config_by_bucket_id(bucket_id)
        if not info:
            raise RuntimeError('bucket_not_found')
        cfg = info['bucket_config']
        job['bucket_name'] = job.get('bucket_name') or cfg.get('bucket_name')
        job['display_name'] = job.get('display_name') or info.get('display_name') or ''
        if op != 'bucket_size':
            job['s3_client'] = get_s3_client(cfg)
        else:
            job['bucket_config'] = cfg
        return job

    raise RuntimeError(f'unsupported_op:{op}')


def enqueue_job(
    username: str,
    op: str,
    display_names: Optional[List[str]],
    payload: Dict[str, Any],
) -> str:
    """Создать pending job; в embedded-режиме сразу стартовать thread."""
    import operation_jobs

    meta = {
        'display_names': list(display_names or []),
        'payload': payload,
    }
    job_id = operation_jobs.create_job(username, op, meta)
    if not use_external_worker():
        operation_jobs.start_worker(job_id, lambda: execute_job(job_id))
    return job_id


def claim_next_job() -> Optional[str]:
    """Забрать один pending job (SKIP LOCKED). Возвращает job_id или None."""
    import operation_jobs
    from db import get_connection

    ops = sorted(WORKER_OPS)
    conn = get_connection()
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id
                FROM operation_jobs
                WHERE status = 'pending' AND op = ANY(%s)
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
                """,
                (ops,),
            )
            row = cur.fetchone()
            if not row:
                conn.rollback()
                return None
            job_id = str(row['id'] if isinstance(row, dict) else row[0])
            cur.execute(
                """
                UPDATE operation_jobs
                SET status = 'running',
                    started_at = COALESCE(started_at, NOW()),
                    updated_at = NOW()
                WHERE id = %s
                """,
                (job_id,),
            )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()

    operation_jobs.sync_job_from_db(job_id)
    operation_jobs.mark_running(job_id)
    return job_id


def execute_job(job_id: str) -> None:
    """Выполнить job по id (payload из meta). Идемпотентно к terminal-статусу."""
    import operation_jobs

    snap = operation_jobs.get_job(job_id)
    if not snap:
        log_error(f'execute_job: job not found {job_id}', 'worker')
        return
    if snap.get('status') in ('done', 'error', 'cancelled'):
        return

    op = snap.get('op') or ''
    meta = snap.get('meta') or {}
    payload = meta.get('payload')
    username = snap.get('username') or (payload.get('username') if isinstance(payload, dict) else None) or 'SYSTEM'
    context = _op_log_context(op, payload if isinstance(payload, dict) else None)
    suffix = ''
    started = False

    if not isinstance(payload, dict):
        operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})
        return

    # mark running if still pending (embedded path)
    if snap.get('status') == 'pending':
        operation_jobs.mark_running(job_id)

    cancel_check = lambda: operation_jobs.is_cancel_requested(job_id)

    try:
        if cancel_check():
            operation_jobs.publish(job_id, {'type': 'cancelled'})
            return

        if op == 'reindex':
            log_info(f'Start job={job_id}', context, username=username)
            started = True
            _run_reindex(job_id, payload, cancel_check)
            return

        job = _hydrate_s3_clients(payload, op)
        suffix = _job_log_suffix(op, job)
        log_info(f'Start job={job_id}{suffix}', context, username=username)
        started = True

        if op == 'copy':
            _run_copy(job_id, job, cancel_check)
        elif op == 'move':
            _run_move(job_id, job, cancel_check)
        elif op == 'delete':
            _run_delete(job_id, job, cancel_check)
        elif op == 'acl':
            _run_acl(job_id, job, cancel_check)
        elif op == 'bucket_size':
            _run_bucket_size(job_id, job, cancel_check)
        else:
            operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})
    except JobCancelled:
        operation_jobs.publish(job_id, {'type': 'cancelled'})
    except Exception as exc:
        log_error(
            f'Job failed job={job_id}{suffix}',
            context,
            exc,
            LOG_CONFIG['show_traceback'],
            username=username,
        )
        operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})
    finally:
        if started:
            log_info(f'Finished job={job_id}{suffix}', context, username=username)


def _run_copy(job_id: str, job: Dict[str, Any], cancel_check) -> None:
    import operation_jobs
    from file_ops import _iter_copy_events

    context = 'copy_objects'
    username = job.get('username') or 'SYSTEM'
    log_progress = _make_progress_logger(job_id, context, username)
    for event in _iter_copy_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        log_progress(event)
        if event.get('type') == 'done':
            log_user_action(
                username, context,
                f"Copy from {job.get('src_display')} to {job.get('dst_display')}, "
                f"dst_path=/{job.get('dst_path')}, objects={event.get('copied', 0)}",
            )
            break
        if event.get('type') in ('cancelled', 'error'):
            break


def _run_move(job_id: str, job: Dict[str, Any], cancel_check) -> None:
    import operation_jobs
    from file_ops import _iter_move_events

    context = 'move_objects'
    username = job.get('username') or 'SYSTEM'
    log_progress = _make_progress_logger(job_id, context, username)
    for event in _iter_move_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        log_progress(event)
        if event.get('type') == 'done':
            log_user_action(
                username, context,
                f"Move from {job.get('src_display')} to {job.get('dst_display')}, "
                f"dst_path=/{job.get('dst_path')}, objects={event.get('moved', 0)}",
            )
            break
        if event.get('type') in ('cancelled', 'error'):
            break


def _run_delete(job_id: str, job: Dict[str, Any], cancel_check) -> None:
    import operation_jobs
    from file_ops import _iter_delete_batch_events

    context = 'delete_objects'
    username = job.get('username') or 'SYSTEM'
    log_progress = _make_progress_logger(job_id, context, username)
    for event in _iter_delete_batch_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        log_progress(event)
        if event.get('type') == 'done':
            log_user_action(
                username, context,
                f"Batch delete in {job.get('display_name')}, "
                f"items={len(job.get('items') or [])}, deleted={event.get('deleted', 0)}",
            )
            break
        if event.get('type') in ('cancelled', 'error'):
            break


def _run_acl(job_id: str, job: Dict[str, Any], cancel_check) -> None:
    import operation_jobs
    from acl_ops import _iter_acl_batch_events

    context = 'file_metadata_acl_batch'
    username = job.get('username') or 'SYSTEM'
    log_progress = _make_progress_logger(job_id, context, username)
    for event in _iter_acl_batch_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        log_progress(event)
        if event.get('type') == 'done':
            log_user_action(
                username, context,
                f"Batch ACL in {job.get('display_name')}, "
                f"files={len(job.get('paths') or [])}, applied={event.get('applied', 0)}",
            )
            break
        if event.get('type') in ('cancelled', 'error'):
            break


def _run_bucket_size(job_id: str, job: Dict[str, Any], cancel_check) -> None:
    """S3 listing fallback для размера бакета (не Prometheus)."""
    import operation_jobs
    from bucket_ops import compute_bucket_size_via_s3, store_bucket_size_cache

    bucket_id = job.get('bucket_id') or ''
    display = job.get('display_name') or bucket_id
    username = job.get('username') or 'SYSTEM'
    context = 'bucket_size'
    suffix = f' bucket={display!r} id={bucket_id}'
    log_progress = _make_progress_logger(job_id, context, username, suffix)

    if cancel_check():
        operation_jobs.publish(job_id, {'type': 'cancelled'})
        return

    def on_progress(objects_count, size_bytes, pages):
        event = {
            'type': 'progress',
            'current': objects_count,
            'size': size_bytes,
            'pages': pages,
        }
        log_progress(event)
        operation_jobs.publish(job_id, event)

    payload = compute_bucket_size_via_s3(
        bucket_id,
        job.get('bucket_config'),
        display,
        cancel_check=cancel_check,
        progress_callback=on_progress,
        username=username,
    )
    if payload is None:
        operation_jobs.publish(job_id, {'type': 'cancelled'})
        return

    store_bucket_size_cache(bucket_id, payload)
    operation_jobs.update_job_meta(job_id, {'result': payload})
    operation_jobs.publish(job_id, {
        'type': 'done',
        'size': payload.get('size'),
        'objects_count': payload.get('objects_count'),
    })


def _reindex_status_from_job(job: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Форма статуса для /api/search/reindex/status и SSE (совместима с UI)."""
    if not job:
        return {
            'active': False,
            'cancel_requested': False,
            'total': 0,
            'completed': 0,
            'workers': 0,
            'bucket_ids': [],
            'stats': {},
            'error': None,
        }
    meta = job.get('meta') or {}
    status = job.get('status') or ''
    return {
        'active': status in ('pending', 'running'),
        'cancel_requested': bool(job.get('cancel_requested')),
        'total': int(meta.get('total') or 0),
        'completed': int(meta.get('completed') or 0),
        'workers': int(meta.get('workers') or 0),
        'bucket_ids': list(meta.get('bucket_ids') or []),
        'stats': dict(meta.get('stats') or {}),
        'error': job.get('error') or meta.get('error'),
        'job_id': job.get('id'),
    }


def batch_reindex_status() -> Dict[str, Any]:
    import operation_jobs
    return _reindex_status_from_job(operation_jobs.find_active_job_by_op('reindex'))


def request_batch_reindex_cancel() -> bool:
    import operation_jobs
    job = operation_jobs.find_active_job_by_op('reindex')
    if not job:
        return False
    return operation_jobs.request_cancel(job['id'])


def iter_batch_reindex_events():
    """SSE-события reindex в формате UI (snapshot → progress → done).

    Poll meta в PG — web и worker в разных процессах, in-memory queue недоступна.
    """
    import operation_jobs

    job = operation_jobs.find_active_job_by_op('reindex')
    if not job:
        yield {'type': 'snapshot', 'job': _reindex_status_from_job(None)}
        return

    job_id = job['id']
    status = _reindex_status_from_job(job)
    yield {'type': 'snapshot', 'job': status}
    last_completed = int(status.get('completed') or 0)
    last_stats_keys = set((status.get('stats') or {}).keys())
    last_ping_at = time.monotonic()
    poll_sec = 1.0
    heartbeat_sec = 25.0

    while True:
        time.sleep(poll_sec)
        refreshed = operation_jobs.get_job_with_cancel(job_id)
        if not refreshed:
            yield {'type': 'done', 'job': _reindex_status_from_job(None)}
            return
        st = _reindex_status_from_job(refreshed)
        completed = int(st.get('completed') or 0)
        stats_keys = set((st.get('stats') or {}).keys())
        if completed != last_completed or stats_keys != last_stats_keys:
            meta = refreshed.get('meta') or {}
            yield {
                'type': 'progress',
                'bucket_id': meta.get('last_bucket_id'),
                'count': meta.get('last_count'),
                'job': st,
            }
            last_completed = completed
            last_stats_keys = stats_keys
        if refreshed.get('status') in ('done', 'error', 'cancelled') or not st.get('active'):
            yield {'type': 'done', 'job': st}
            return
        if (time.monotonic() - last_ping_at) >= heartbeat_sec:
            yield {'type': 'ping'}
            last_ping_at = time.monotonic()


def _run_reindex(job_id: str, payload: Dict[str, Any], cancel_check) -> None:
    import meilisearch
    import operation_jobs
    from buckets import get_buckets_config
    from db import set_bucket_search_reindexed_at
    from s3_client import get_s3_client_for_reindex
    from datetime import datetime, timezone

    bucket_ids = list(payload.get('bucket_ids') or [])
    index_mode = payload.get('index_mode') or 'full'
    log_context = payload.get('log_context') or 'reindex_search'
    username = payload.get('username') or 'system'

    if not bucket_ids:
        operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.reindex_buckets_empty')})
        return
    if cancel_check():
        operation_jobs.publish(job_id, {
            'type': 'done',
            'job': _reindex_status_from_job(operation_jobs.get_job_with_cancel(job_id)),
        })
        return

    context = log_context or 'reindex_search'
    meilisearch.set_reindex_log_context(log_context)

    def _on_bucket_complete(bucket_id: str, count: int) -> None:
        snap = operation_jobs.get_job_with_cancel(job_id) or {}
        meta = dict(snap.get('meta') or {})
        stats = dict(meta.get('stats') or {})
        stats[bucket_id] = count
        completed = int(meta.get('completed') or 0) + 1
        meta.update({
            'stats': stats,
            'completed': completed,
            'last_bucket_id': bucket_id,
            'last_count': count,
        })
        operation_jobs.update_job_meta(job_id, meta)
        if count is not None and count >= 0:
            try:
                set_bucket_search_reindexed_at(bucket_id, datetime.now(timezone.utc))
            except Exception as exc:
                log_error(
                    f'Failed to update search_reindexed_at for {bucket_id}',
                    context,
                    exc,
                    LOG_CONFIG['show_traceback'],
                    username=username,
                )
        log_info(
            f'Processing job={job_id} bucket_id={bucket_id} count={count} '
            f'completed={completed}/{meta.get("total") or "?"}',
            context,
            username=username,
        )
        st = _reindex_status_from_job(operation_jobs.get_job_with_cancel(job_id))
        operation_jobs.publish(job_id, {
            'type': 'progress',
            'bucket_id': bucket_id,
            'count': count,
            'job': st,
        })

    try:
        meilisearch.reindex_buckets_parallel(
            bucket_ids,
            get_buckets_config,
            get_s3_client_for_reindex,
            app=None,
            cancel_check=cancel_check,
            on_bucket_complete=_on_bucket_complete,
            index_mode=index_mode,
        )
    except Exception as exc:
        log_error(
            f'Job failed job={job_id}',
            context,
            exc,
            LOG_CONFIG['show_traceback'],
            username=username,
        )
        try:
            operation_jobs.update_job_meta(job_id, {'error': str(exc)})
        except Exception:
            pass
        operation_jobs.publish(job_id, {
            'type': 'error',
            'error': _('error.unexpected'),
            'job': _reindex_status_from_job(operation_jobs.get_job_with_cancel(job_id)),
        })
        return
    finally:
        meilisearch.reset_reindex_log_context()

    st = _reindex_status_from_job(operation_jobs.get_job_with_cancel(job_id))
    operation_jobs.publish(job_id, {'type': 'done', 'job': st})


def start_meili_schedulers() -> None:
    """Startup + nightly Meili sync: ставить в очередь worker (вызывать из worker.py / embedded app).

    При нескольких репликах worker только лидер (pg advisory lock) поднимает таймеры.
    """
    global _meili_scheduler_leader_conn
    try:
        import meilisearch
        from buckets import get_buckets_config
        from db import get_connection
        from s3_client import get_s3_client_for_reindex

        if not meilisearch.is_configured():
            return

        if _meili_scheduler_leader_conn is None:
            conn = get_connection()
            if not _pg_try_advisory_lock(conn, _MEILI_SCHEDULER_LOCK_KEY):
                conn.close()
                log_info('Meilisearch schedulers skipped: another worker is leader', 'worker')
                return
            # Держим соединение — session-level lock живёт, пока процесс жив.
            _meili_scheduler_leader_conn = conn

        meilisearch.schedule_startup_reindex(
            get_buckets_config, get_s3_client_for_reindex, app=None,
        )
        meilisearch.schedule_periodic_sync(
            get_buckets_config, get_s3_client_for_reindex, app=None,
        )
    except Exception as exc:
        log_error('Failed to start Meilisearch schedulers', 'worker', exc, LOG_CONFIG['show_traceback'])


def worker_loop(poll_sec: float = 1.0) -> None:
    """Бесконечный цикл claim → execute (для `python worker.py`)."""
    log_info(f'Operation worker started mode={worker_mode()} ops={sorted(WORKER_OPS)}', 'worker')
    start_meili_schedulers()
    while True:
        try:
            job_id = claim_next_job()
            if job_id:
                execute_job(job_id)
                continue
        except Exception as exc:
            log_error('Worker loop error', 'worker', exc, LOG_CONFIG['show_traceback'])
        time.sleep(poll_sec)
