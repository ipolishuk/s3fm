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
from bucket_metrics import fetch_ceph_bucket_metrics
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



def get_bucket_size_impl(bucket_id):
    """Получить размер конкретного бакета"""
    context = 'bucket_size'
    try:
        # Находим конфигурацию бакета по bucket_id
        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            error_msg = f'Bucket with ID {bucket_id} not found in configuration'
            log_error(error_msg, context)
            return jsonify({'error': _('error.bucket_not_found')}), 404

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        display_name = bucket_info['display_name']

        # Проверяем доступ к бакету по bucket_id
        if not check_bucket_access(bucket_id):
            error_msg = f'Access to bucket {display_name} denied'
            log_warning(error_msg, context)
            return jsonify({'error': _('error.access_denied')}), 403

        # Кэш: bucket_id -> (payload_dict, timestamp)
        BUCKET_SIZE_CACHE_TTL = int(os.environ.get('BUCKET_SIZE_CACHE_TTL', '300'))  # секунд, по умолчанию 5 мин
        with _bucket_size_cache_lock:
            cached = _bucket_size_cache.get(bucket_id)
            if cached:
                payload, ts = cached
                if time.time() - ts < BUCKET_SIZE_CACHE_TTL and isinstance(payload, dict):
                    return jsonify(payload)

        s3_client = get_s3_client(bucket_config)
        total_size = 0
        total_objects = 0

        # Сначала подтверждаем S3-доступ к bucket_name этими credentials —
        # иначе Prometheus мог бы отдать чужие метрики по одному лишь имени.
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
            with _bucket_size_cache_lock:
                cache = _bucket_size_cache
                cache[bucket_id] = (payload, time.time())
                if len(cache) > 100:
                    by_time = sorted(cache.items(), key=lambda x: x[1][1])
                    for k, _ in by_time[: len(cache) - 80]:
                        del cache[k]
            return jsonify(payload)

        # Лимит объектов для расчёта — меньший лимит по умолчанию снижает нагрузку на CPU (меньше страниц и итераций)
        BUCKET_MAX_OBJECTS = int(os.environ.get('BUCKET_MAX_OBJECTS', '500000'))
        BUCKET_MAX_SIZE = int(os.environ.get('BUCKET_MAX_SIZE', '107000000000'))
        PAGE_SIZE = 1000
        get_size = itemgetter('Size')  # быстрее, чем obj['Size'] в цикле

        paginator = s3_client.get_paginator('list_objects_v2')
        truncated = False

        try:
            for page in paginator.paginate(
                Bucket=bucket_name,
                PaginationConfig={'PageSize': PAGE_SIZE}
            ):
                contents = page.get('Contents')
                if not contents:
                    continue
                total_size += sum(map(get_size, contents))
                total_objects += len(contents)
                if total_objects >= BUCKET_MAX_OBJECTS or total_size >= BUCKET_MAX_SIZE:
                    truncated = True
                    break
        except ClientError as e:
            error_code = e.response['Error']['Code']
            error_message = e.response['Error']['Message']

            if error_code in ['AccessDenied', 'InvalidAccessKeyId']:
                full_msg = _trf('error.bucket_read_denied_for', name=display_name)
                log_error(trf_en('error.bucket_read_denied_for', name=display_name), context, e)
                return jsonify({'error': full_msg}), 500
            else:
                full_msg = _trf('error.bucket_list_objects_failed_with', details=error_message)
                log_error(trf_en('error.bucket_list_objects_failed_with', details=error_message), context, e)
                return jsonify({'error': full_msg}), 500

        log_info(
            f"Bucket {display_name}: {total_size} bytes, {total_objects} objects"
            + (" (calculation truncated)" if truncated else ""),
            context,
        )

        payload = {
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
        with _bucket_size_cache_lock:
            cache = _bucket_size_cache
            cache[bucket_id] = (payload, time.time())
            if len(cache) > 100:
                # Удаляем самые старые записи
                by_time = sorted(cache.items(), key=lambda x: x[1][1])
                for k, _ in by_time[: len(cache) - 80]:
                    del cache[k]

        return jsonify(payload)

    except Exception as e:
        full_msg, status_code = _map_s3_runtime_error(e, display_name)
        if full_msg == _trf('error.unexpected'):
            full_msg = _trf('error.bucket_size_calculation_failed')
        log_s3_exception(context, e, display_name)
        return jsonify({'error': full_msg}), status_code

