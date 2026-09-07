"""Search and Meilisearch reindex HTTP handlers."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from flask import Response, current_app, jsonify, request, session, stream_with_context

from bucket_access import (
    check_bucket_access,
    find_bucket_config_by_bucket_id,
)
from buckets import get_buckets_config
from db import (
    get_search_index_disabled_bucket_ids,
    is_bucket_search_index_enabled,
    set_bucket_search_reindexed_at,
)
from logs import LOG_CONFIG, log_error, log_info, log_s3_exception, log_warning, trf_en
import meilisearch
from roles import ROLE_ADMIN
from s3_client import (
    _map_s3_runtime_error,
    _trf,
    get_s3_client,
    get_s3_client_for_reindex,
)
from translations import _


def _search_files_via_s3(s3_client, bucket_name, bucket_id, display_name, query, context):
    """Линейный поиск по всему бакету через list_objects_v2 (fallback без Meilisearch)."""
    all_folders = []
    all_files = []
    query_lower = query.lower()
    seen_folders = set()
    seen_files = set()

    paginator = s3_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket_name):
        if 'Contents' in page:
            for obj in page['Contents']:
                key = obj['Key']
                if key.endswith('/'):
                    clean_key = key.rstrip('/')
                    object_name = clean_key.split('/')[-1] if clean_key else ''
                else:
                    object_name = key.split('/')[-1]

                if query_lower in object_name.lower():
                    if key.endswith('/'):
                        if key not in seen_folders:
                            folder_name = object_name or key.rstrip('/').split('/')[-1]
                            all_folders.append({
                                'name': folder_name,
                                'path': key,
                                'size': obj['Size'],
                                'last_modified': obj['LastModified'].isoformat()
                            })
                            seen_folders.add(key)
                    else:
                        if key not in seen_files:
                            all_files.append({
                                'name': object_name,
                                'path': key,
                                'size': obj['Size'],
                                'last_modified': obj['LastModified'].isoformat()
                            })
                            seen_files.add(key)

    try:
        paginator_with_delimiter = s3_client.get_paginator('list_objects_v2')
        for page in paginator_with_delimiter.paginate(Bucket=bucket_name, Delimiter='/'):
            if 'CommonPrefixes' in page:
                for prefix_obj in page['CommonPrefixes']:
                    folder_path = prefix_obj['Prefix']
                    folder_name = folder_path.rstrip('/').split('/')[-1]
                    if query_lower in folder_name.lower() and folder_path not in seen_folders:
                        all_folders.append({
                            'name': folder_name,
                            'path': folder_path,
                            'size': 0,
                            'last_modified': datetime.now().isoformat()
                        })
                        seen_folders.add(folder_path)
    except Exception as e:
        log_warning(f'CommonPrefixes folder search failed: {str(e)}', context)

    return all_folders, all_files


def _search_response_payload(bucket_name, bucket_id, display_name, query, all_folders, all_files, *, engine='s3'):
    return jsonify({
        'bucket': bucket_name,
        'bucket_id': bucket_id,
        'display_name': display_name,
        'query': query,
        'folders': all_folders,
        'files': all_files,
        'total_folders': len(all_folders),
        'total_files': len(all_files),
        'is_truncated': False,
        'next_continuation_token': '',
        'search_engine': engine,
    })


def search_files_impl():
    """Поиск файлов и папок по всему бакету (Meilisearch или fallback через S3)."""
    context = 'search_files'
    try:
        bucket_id = request.args.get('bucket', '')
        query = request.args.get('q', '').strip()

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

        if not query:
            log_error('Search query is required', context)
            return jsonify({'error': _('error.search_query_required')}), 400

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

        if meilisearch.is_enabled():
            meili_result = meilisearch.search_bucket(bucket_id, query)
            if meili_result is not None:
                all_folders, all_files = meili_result
                log_info(
                    f"Search (Meilisearch) in bucket {display_name} query '{query}': "
                    f"{len(all_folders)} folders, {len(all_files)} files",
                    context,
                )
                return _search_response_payload(
                    bucket_name, bucket_id, display_name, query, all_folders, all_files, engine='meilisearch',
                )

        s3_client = get_s3_client(bucket_config)
        all_folders, all_files = _search_files_via_s3(
            s3_client, bucket_name, bucket_id, display_name, query, context,
        )
        log_info(
            f"Search (S3) in bucket {display_name} query '{query}': "
            f"{len(all_folders)} folders, {len(all_files)} files",
            context,
        )
        return _search_response_payload(
            bucket_name, bucket_id, display_name, query, all_folders, all_files, engine='s3',
        )

    except Exception as e:
        log_name = display_name if 'display_name' in locals() else bucket_id
        full_msg, status_code = _map_s3_runtime_error(e, log_name)
        if full_msg == _trf('error.unexpected'):
            full_msg = _trf('error.search_failed')
        log_s3_exception(context, e, log_name)
        return jsonify({'error': full_msg}), status_code


def search_status_impl():
    """Статус Meilisearch для панели настроек (только admin)."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    resp = jsonify(meilisearch.connection_status())
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    return resp


def search_settings_impl():
    """Чтение/запись настроек Meilisearch в БД (только admin)."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    if request.method == 'GET':
        return jsonify(meilisearch.editable_settings_payload())
    data = request.get_json(silent=True) or {}
    updates = data.get('settings') if isinstance(data.get('settings'), dict) else data
    try:
        payload = meilisearch.update_settings(updates or {})
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        log_error(f'Failed to update Meilisearch settings: {exc}', 'search_settings', exception=exc)
        return jsonify({'error': str(exc)}), 500
    return jsonify({'ok': True, **payload})

def reindex_search_impl():
    """Переиндексация бакета(ов) в Meilisearch (только admin)."""
    context = 'reindex_search'
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    if not meilisearch.is_enabled():
        return jsonify({'error': 'Meilisearch is not configured'}), 503

    data = request.get_json(silent=True) or {}
    bucket_id = (data.get('bucket') or '').strip()

    try:
        if bucket_id:
            bucket_info = find_bucket_config_by_bucket_id(bucket_id)
            if not bucket_info:
                return jsonify({'error': _('error.bucket_not_found')}), 404
            if not is_bucket_search_index_enabled(bucket_id):
                return jsonify({'error': _('error.search_index_disabled')}), 400

            def _on_one_bucket_complete(bid: str, count: int) -> None:
                if count is not None and count >= 0:
                    set_bucket_search_reindexed_at(bid, datetime.now(timezone.utc))

            log_info(f"Reindex request (background): bucket_id={bucket_id}", context)
            started = meilisearch.start_batch_reindex_background(
                [bucket_id],
                get_buckets_config,
                get_s3_client_for_reindex,
                app=current_app._get_current_object(),
                log_context=context,
                on_bucket_complete=_on_one_bucket_complete,
                index_mode='full',
            )
            if not started:
                return jsonify({
                    'error': _('error.reindex_already_running'),
                    'status': meilisearch.batch_reindex_status(),
                }), 409
            job = meilisearch.batch_reindex_status()
            return jsonify({
                'started': True,
                'bucket_id': bucket_id,
                'total': job['total'],
                'workers': job['workers'],
            }), 202

        if 'buckets' not in data:
            return jsonify({'error': _('error.reindex_buckets_required')}), 400
        raw_buckets = data.get('buckets')
        if not isinstance(raw_buckets, list):
            return jsonify({'error': _('error.reindex_buckets_invalid')}), 400
        bucket_ids = [str(b).strip() for b in raw_buckets if str(b).strip()]
        if not bucket_ids:
            return jsonify({'error': _('error.reindex_buckets_empty')}), 400
        disabled_index_buckets = get_search_index_disabled_bucket_ids()
        bucket_ids = [bid for bid in bucket_ids if bid not in disabled_index_buckets]
        if not bucket_ids:
            return jsonify({'error': _('error.search_index_all_disabled')}), 400

        run_background = data.get('background', True)
        if run_background is not False and str(run_background).lower() not in ('0', 'false', 'no', 'off'):
            def _on_bucket_complete(bid: str, count: int) -> None:
                if count is not None and count >= 0:
                    set_bucket_search_reindexed_at(bid, datetime.now(timezone.utc))

            log_info(f"Reindex batch request (background): buckets={len(bucket_ids)}", context)
            started = meilisearch.start_batch_reindex_background(
                bucket_ids,
                get_buckets_config,
                get_s3_client_for_reindex,
                app=current_app._get_current_object(),
                log_context=context,
                on_bucket_complete=_on_bucket_complete,
            )
            if not started:
                return jsonify({
                    'error': _('error.reindex_already_running'),
                    'status': meilisearch.batch_reindex_status(),
                }), 409
            job = meilisearch.batch_reindex_status()
            return jsonify({
                'started': True,
                'total': job['total'],
                'workers': job['workers'],
            }), 202

        log_info(f"Reindex batch request (sync): buckets={len(bucket_ids)}", context)
        meilisearch.set_reindex_log_context(context)
        try:
            stats = meilisearch.reindex_buckets_parallel(
                bucket_ids, get_buckets_config, get_s3_client_for_reindex, app=current_app._get_current_object(),
            )
        finally:
            meilisearch.reset_reindex_log_context()
        reindexed_at = datetime.now(timezone.utc)
        reindexed_at_by_bucket = {}
        for bid, n in stats.items():
            if n is not None and n >= 0:
                set_bucket_search_reindexed_at(bid, reindexed_at)
                reindexed_at_by_bucket[bid] = reindexed_at.isoformat()
        log_info(f"Reindex batch response: stats={stats}", context)
        return jsonify({
            'indexed_by_bucket': stats,
            'reindexed_at_by_bucket': reindexed_at_by_bucket,
        })
    except Exception as e:
        log_error('Reindex failed', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def reindex_search_status_impl():
    """Статус фоновой переиндексации (admin)."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    return jsonify(meilisearch.batch_reindex_status())


def reindex_search_events_impl():
    """SSE: прогресс фоновой переиндексации по мере завершения каждого бакета (admin)."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403

    def generate():
        for event in meilisearch.iter_batch_reindex_events():
            if event.get('type') == 'ping':
                yield ': ping\n\n'
                continue
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    )


def reindex_search_cancel_impl():
    """Остановить фоновую переиндексацию после текущих бакетов (admin)."""
    if session.get('role') != ROLE_ADMIN:
        return jsonify({'error': _('error.access_denied')}), 403
    if not meilisearch.request_batch_reindex_cancel():
        return jsonify({'error': _('error.reindex_not_running'), 'status': meilisearch.batch_reindex_status()}), 409
    return jsonify(meilisearch.batch_reindex_status())


