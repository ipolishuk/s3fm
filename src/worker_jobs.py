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

WORKER_OPS = frozenset({'copy', 'move', 'delete', 'acl', 'bucket_size'})


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

        job = _hydrate_s3_clients(payload, op)

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
        log_error(f'Worker job failed op={op}', 'worker', exc, LOG_CONFIG['show_traceback'])
        operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})


def _run_copy(job_id: str, job: Dict[str, Any], cancel_check) -> None:
    import operation_jobs
    from file_ops import _iter_copy_events

    context = 'copy_objects'
    for event in _iter_copy_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        if event.get('type') == 'done':
            log_user_action(
                job.get('username', 'unknown'), context,
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
    for event in _iter_move_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        if event.get('type') == 'done':
            log_user_action(
                job.get('username', 'unknown'), context,
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
    for event in _iter_delete_batch_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        if event.get('type') == 'done':
            log_user_action(
                job.get('username', 'unknown'), context,
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
    for event in _iter_acl_batch_events(job, context, cancel_check=cancel_check):
        operation_jobs.publish(job_id, event)
        if event.get('type') == 'done':
            log_user_action(
                job.get('username', 'unknown'), context,
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
    log_info(f'bucket_size start job_id={job_id} bucket={display!r} id={bucket_id}', 'worker')

    if cancel_check():
        operation_jobs.publish(job_id, {'type': 'cancelled'})
        return

    def on_progress(objects_count, size_bytes, pages):
        log_info(
            f'bucket_size processing job_id={job_id} bucket={display!r} '
            f'objects={objects_count} size={size_bytes} pages={pages}',
            'worker',
        )
        operation_jobs.publish(job_id, {
            'type': 'progress',
            'current': objects_count,
            'size': size_bytes,
            'pages': pages,
        })

    payload = compute_bucket_size_via_s3(
        bucket_id,
        job.get('bucket_config'),
        display,
        cancel_check=cancel_check,
        progress_callback=on_progress,
    )
    if payload is None:
        log_info(f'bucket_size cancelled job_id={job_id} bucket={display!r}', 'worker')
        operation_jobs.publish(job_id, {'type': 'cancelled'})
        return

    store_bucket_size_cache(bucket_id, payload)
    operation_jobs.update_job_meta(job_id, {'result': payload})
    operation_jobs.publish(job_id, {
        'type': 'done',
        'size': payload.get('size'),
        'objects_count': payload.get('objects_count'),
    })
    log_info(
        f'bucket_size done job_id={job_id} bucket={display!r} '
        f'size={payload.get("size")} objects={payload.get("objects_count")} '
        f'truncated={payload.get("truncated")}',
        'worker',
    )


def worker_loop(poll_sec: float = 1.0) -> None:
    """Бесконечный цикл claim → execute (для `python worker.py`)."""
    log_info(f'Operation worker started mode={worker_mode()} ops={sorted(WORKER_OPS)}', 'worker')
    while True:
        try:
            job_id = claim_next_job()
            if job_id:
                import operation_jobs
                snap = operation_jobs.get_job(job_id) or {}
                log_info(
                    f'Claimed job {job_id} op={snap.get("op")} user={snap.get("username")}',
                    'worker',
                )
                execute_job(job_id)
                log_info(f'Finished job {job_id} op={snap.get("op")}', 'worker')
                continue
        except Exception as exc:
            log_error('Worker loop error', 'worker', exc, LOG_CONFIG['show_traceback'])
        time.sleep(poll_sec)
