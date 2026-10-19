"""Sidebar bucket list / size API handlers."""

from __future__ import annotations

import os
import threading
import time
from operator import itemgetter

from botocore.exceptions import ClientError
from flask import jsonify, session

from bucket_access import (
    _build_session_accessible_buckets,
    check_bucket_access,
    find_bucket_config_by_bucket_id,
)
from bucket_metrics import fetch_ceph_bucket_metrics, prometheus_base_url
from logs import LOG_CONFIG, log_error, log_info, log_s3_exception, log_warning, trf_en
from s3_client import (
    _map_s3_client_error,
    _map_s3_runtime_error,
    _trf,
    get_s3_client,
)
from translations import _

_bucket_size_cache = {}
_bucket_size_cache_lock = threading.Lock()


def list_buckets_impl():
    """Список бакетов для интерфейса без секретов (все авторизованные роли)."""
    context = 'list_buckets'
    try:
        all_buckets = _build_session_accessible_buckets(include_secrets=False, context=context)
        log_info(f"Returned {len(all_buckets)} buckets", context)
        return jsonify({'buckets': all_buckets})
    except Exception as e:
        error_msg = f'Failed to list buckets: {str(e)}'
        log_error(error_msg, context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.get_buckets')}), 500


def list_buckets_config_impl():
    """Полный список доступных бакетов с полями ключей — только администратор."""
    if session.get('role') != 'admin':
        return jsonify({'error': _('error.access_denied')}), 403
    context = 'list_buckets_config'
    try:
        all_buckets = _build_session_accessible_buckets(include_secrets=True, context=context)
        log_info(f"Returned {len(all_buckets)} buckets (admin, with keys)", context)
        return jsonify({'buckets': all_buckets})
    except Exception as e:
        error_msg = f'Failed to list buckets: {str(e)}'
        log_error(error_msg, context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.get_buckets')}), 500


def store_bucket_size_cache(bucket_id: str, payload: dict) -> None:
    with _bucket_size_cache_lock:
        cache = _bucket_size_cache
        cache[bucket_id] = (payload, time.time())
        if len(cache) > 100:
            by_time = sorted(cache.items(), key=lambda x: x[1][1])
            for k, _ in by_time[: len(cache) - 80]:
                del cache[k]


def get_cached_bucket_size(bucket_id: str):
    BUCKET_SIZE_CACHE_TTL = int(os.environ.get('BUCKET_SIZE_CACHE_TTL', '300'))
    with _bucket_size_cache_lock:
        cached = _bucket_size_cache.get(bucket_id)
        if cached:
            payload, ts = cached
            if time.time() - ts < BUCKET_SIZE_CACHE_TTL and isinstance(payload, dict):
                return payload
    return None


def compute_bucket_size_via_s3(
    bucket_id,
    bucket_config,
    display_name,
    cancel_check=None,
    progress_callback=None,
):
    """Медленный fallback: list_objects_v2. Для worker-процесса.

    progress_callback(objects_count, total_size, page_index) — опционально,
    вызывается периодически, чтобы было видно, что процесс жив.

    Возвращает payload dict или None при cancel.
    """
    from worker_jobs import JobCancelled

    context = 'bucket_size'
    bucket_name = bucket_config.get('bucket_name')
    s3_client = get_s3_client(bucket_config)
    total_size = 0
    total_objects = 0

    BUCKET_MAX_OBJECTS = int(os.environ.get('BUCKET_MAX_OBJECTS', '500000'))
    BUCKET_MAX_SIZE = int(os.environ.get('BUCKET_MAX_SIZE', '107000000000'))
    try:
        progress_every = int(os.environ.get('BUCKET_SIZE_PROGRESS_EVERY', '5000'))
    except (TypeError, ValueError):
        progress_every = 5000
    progress_every = max(1000, progress_every)
    try:
        progress_sec = float(os.environ.get('BUCKET_SIZE_PROGRESS_SEC', '15'))
    except (TypeError, ValueError):
        progress_sec = 15.0
    progress_sec = max(5.0, progress_sec)

    PAGE_SIZE = 1000
    get_size = itemgetter('Size')
    paginator = s3_client.get_paginator('list_objects_v2')
    truncated = False
    page_index = 0
    last_progress_objects = 0
    last_progress_at = time.time()

    try:
        for page in paginator.paginate(
            Bucket=bucket_name,
            PaginationConfig={'PageSize': PAGE_SIZE},
        ):
            page_index += 1
            if cancel_check and cancel_check():
                raise JobCancelled()
            contents = page.get('Contents')
            if not contents:
                continue
            total_size += sum(map(get_size, contents))
            total_objects += len(contents)

            now = time.time()
            objects_since = total_objects - last_progress_objects
            if progress_callback and (
                page_index == 1
                or objects_since >= progress_every
                or (now - last_progress_at) >= progress_sec
            ):
                progress_callback(total_objects, total_size, page_index)
                last_progress_objects = total_objects
                last_progress_at = now

            if total_objects >= BUCKET_MAX_OBJECTS or total_size >= BUCKET_MAX_SIZE:
                truncated = True
                break
    except JobCancelled:
        return None
    except ClientError as e:
        error_code = e.response['Error']['Code']
        error_message = e.response['Error']['Message']
        if error_code in ['AccessDenied', 'InvalidAccessKeyId']:
            raise RuntimeError(_trf('error.bucket_read_denied_for', name=display_name)) from e
        raise RuntimeError(
            _trf('error.bucket_list_objects_failed_with', details=error_message)
        ) from e

    log_info(
        f"Bucket {display_name}: {total_size} bytes, {total_objects} objects"
        + (" (calculation truncated)" if truncated else ""),
        context,
    )
    return {
        'size': total_size,
        'size_max': None,
        'objects_count': total_objects,
        'objects_max': None,
        'bucket': bucket_name,
        'bucket_id': bucket_id,
        'display_name': display_name,
        'truncated': truncated,
        'source': 's3',
    }


def _job_payload_bucket_id(job) -> str:
    meta = (job or {}).get('meta') or {}
    payload = meta.get('payload') or {}
    return (payload.get('bucket_id') or '').strip()


def _find_bucket_size_job(username: str, bucket_id: str, *, active_only: bool):
    import operation_jobs

    for item in operation_jobs.list_jobs_for_user(username, active_only=active_only):
        if item.get('op') != 'bucket_size':
            continue
        job = operation_jobs.get_job(item['job_id'])
        if not job:
            continue
        if _job_payload_bucket_id(job) == bucket_id:
            return job
    return None


def _find_recent_bucket_size_result(username: str, bucket_id: str):
    """Результат S3-scan лежит в meta job (общий для API и worker через PG)."""
    import operation_jobs

    best = None
    best_ts = -1.0
    for item in operation_jobs.list_jobs_for_user(username, active_only=False):
        if item.get('op') != 'bucket_size':
            continue
        job = operation_jobs.get_job(item['job_id'])
        if not job or job.get('status') != 'done':
            continue
        if _job_payload_bucket_id(job) != bucket_id:
            continue
        result = (job.get('meta') or {}).get('result')
        if not isinstance(result, dict):
            continue
        ts = float(job.get('finished_at') or job.get('created_at') or 0)
        if ts >= best_ts:
            best_ts = ts
            best = result
    return best


def get_bucket_size_impl(bucket_id):
    """Получить размер конкретного бакета.

    1) кэш / Prometheus — синхронно
    2) иначе S3-listing через worker (202 pending) или embedded sync
    """
    context = 'bucket_size'
    try:
        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            error_msg = f'Bucket with ID {bucket_id} not found in configuration'
            log_error(error_msg, context)
            return jsonify({'error': _('error.bucket_not_found')}), 404

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        display_name = bucket_info['display_name']

        if not check_bucket_access(bucket_id):
            error_msg = f'Access to bucket {display_name} denied'
            log_warning(error_msg, context)
            return jsonify({'error': _('error.access_denied')}), 403

        cached = get_cached_bucket_size(bucket_id)
        if cached:
            return jsonify(cached)

        s3_client = get_s3_client(bucket_config)

        # Сначала подтверждаем S3-доступ — иначе Prometheus мог бы отдать чужие метрики.
        try:
            s3_client.head_bucket(Bucket=bucket_name)
        except ClientError as e:
            full_msg, status_code = _map_s3_client_error(e, display_name)
            log_s3_exception(context, e, display_name)
            return jsonify({'error': full_msg}), status_code
        except Exception as e:
            full_msg, status_code = _map_s3_runtime_error(e, display_name)
            log_s3_exception(context, e, display_name)
            return jsonify({'error': full_msg}), status_code

        metrics = fetch_ceph_bucket_metrics(bucket_name)
        if metrics:
            payload = {
                'size': metrics['size'],
                'size_max': metrics.get('size_max'),
                'objects_count': metrics['objects_count'],
                'objects_max': metrics.get('objects_max'),
                'bucket': bucket_name,
                'bucket_id': bucket_id,
                'display_name': display_name,
                'truncated': False,
                'source': 'prometheus',
            }
            log_info(
                f"Bucket {display_name}: {payload['size']} bytes, "
                f"{payload['objects_count']} objects (prometheus)",
                context,
            )
            store_bucket_size_cache(bucket_id, payload)
            return jsonify(payload)

        # S3 fallback — через worker (не блокируем gunicorn).
        # Кэш процесса не шарится с worker → результат читаем из meta job в PG.
        from worker_jobs import (
            enqueue_job,
            serialize_bucket_size_job,
            use_external_worker,
            worker_mode,
        )
        import operation_jobs

        username = session.get('username', 'unknown')

        done_result = _find_recent_bucket_size_result(username, bucket_id)
        if done_result:
            store_bucket_size_cache(bucket_id, done_result)
            return jsonify(done_result)

        active = _find_bucket_size_job(username, bucket_id, active_only=True)
        if active:
            return jsonify({
                'pending': True,
                'job_id': active['id'],
                'bucket_id': bucket_id,
                'source': 's3',
            }), 202

        job_id = enqueue_job(
            username,
            'bucket_size',
            [display_name],
            serialize_bucket_size_job(bucket_id, username),
        )

        # Embedded: thread мог уже закончить
        if not use_external_worker():
            time.sleep(0.05)
            job = operation_jobs.get_job(job_id)
            if job and job.get('status') == 'done':
                result = (job.get('meta') or {}).get('result')
                if result:
                    store_bucket_size_cache(bucket_id, result)
                    return jsonify(result)

        log_info(
            f'Bucket size S3 scan enqueued job_id={job_id} mode={worker_mode()} '
            f'prometheus={"on" if prometheus_base_url() else "off"}',
            context,
        )
        return jsonify({
            'pending': True,
            'job_id': job_id,
            'bucket_id': bucket_id,
            'source': 's3',
        }), 202

    except Exception as e:
        full_msg, status_code = _map_s3_runtime_error(e, display_name if 'display_name' in locals() else '')
        if full_msg == _trf('error.unexpected'):
            full_msg = _trf('error.bucket_size_calculation_failed')
        log_s3_exception(context, e, display_name if 'display_name' in locals() else '')
        return jsonify({'error': full_msg}), status_code
