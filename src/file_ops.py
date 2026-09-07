"""Copy / move / delete-batch helpers and SSE job streaming."""

from __future__ import annotations

import json
import threading
from urllib.parse import unquote

from botocore.exceptions import ClientError
from flask import Response, session, stream_with_context

from bucket_access import (
    check_bucket_access as _check_bucket_access,
    find_bucket_config_by_bucket_id,
    normalize_s3_object_key as _normalize_s3_object_key,
)
from logs import LOG_CONFIG, log_error, log_s3_exception
import meilisearch
import operation_jobs
from roles import (
    role_copy_file,
    role_copy_files_multi,
    role_copy_folder,
    role_copy_folder_multi,
    role_create_folder,
    role_delete_file,
    role_delete_files_multi,
    role_delete_folder,
    role_delete_folder_multi,
    role_move_file,
    role_move_files_multi,
    role_move_folder,
    role_move_folder_multi,
    role_upload_files,
    role_upload_folder,
)
from s3_client import get_s3_client as _get_s3_client
from translations import _


def _trf(key, **kwargs):
    """Локализованная строка с подстановкой {placeholders}."""
    text = _(key)
    for k, v in kwargs.items():
        text = text.replace('{' + str(k) + '}', str(v))
    return text


def _s3_copy_configs_compatible(src_cfg, dst_cfg):
    keys = ('endpoint_url', 'aws_access_key_id', 'aws_secret_access_key', 'region_name')
    return all((src_cfg or {}).get(k) == (dst_cfg or {}).get(k) for k in keys)


def _copy_s3_object(src_client, dst_client, src_bucket_name, dst_bucket_name, src_key, dst_key, use_server_copy):
    if use_server_copy:
        src_client.copy_object(
            Bucket=dst_bucket_name,
            Key=dst_key,
            CopySource={'Bucket': src_bucket_name, 'Key': src_key},
        )
        return
    response = src_client.get_object(Bucket=src_bucket_name, Key=src_key)
    body = response['Body'].read()
    put_args = {'Bucket': dst_bucket_name, 'Key': dst_key, 'Body': body}
    if response.get('ContentType'):
        put_args['ContentType'] = response['ContentType']
    if response.get('Metadata'):
        put_args['Metadata'] = response['Metadata']
    dst_client.put_object(**put_args)


def _folder_name_from_prefix(folder_prefix):
    parts = [p for p in (folder_prefix or '').rstrip('/').split('/') if p]
    return parts[-1] if parts else ''


def _count_folder_objects(src_client, src_bucket_name, src_folder_prefix):
    if not src_folder_prefix.endswith('/'):
        src_folder_prefix += '/'
    count = 0
    seen_keys = set()
    paginator = src_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=src_bucket_name, Prefix=src_folder_prefix):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if key in seen_keys:
                continue
            seen_keys.add(key)
            count += 1
    if src_folder_prefix not in seen_keys:
        count += 1
    return count


def _list_files_under_prefix(s3_client, bucket_name, folder_prefix):
    """Рекурсивно перечислить файлы (не маркеры папок) под префиксом."""
    prefix = (folder_prefix or '').strip()
    if prefix and not prefix.endswith('/'):
        prefix += '/'
    files = []
    seen_keys = set()
    paginate_kwargs = {'Bucket': bucket_name}
    if prefix:
        paginate_kwargs['Prefix'] = prefix
    paginator = s3_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(**paginate_kwargs):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if key in seen_keys or key.endswith('/'):
                continue
            seen_keys.add(key)
            files.append(key)
    return files


def _iter_copy_folder_tree(
    src_client,
    dst_client,
    src_bucket_name,
    dst_bucket_name,
    src_folder_prefix,
    dst_folder_prefix,
    use_server_copy,
    dst_bucket_id,
):
    if not src_folder_prefix.endswith('/'):
        src_folder_prefix += '/'
    if not dst_folder_prefix.endswith('/'):
        dst_folder_prefix += '/'

    seen_keys = set()
    paginator = src_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=src_bucket_name, Prefix=src_folder_prefix):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if key in seen_keys:
                continue
            seen_keys.add(key)
            rel = key[len(src_folder_prefix):] if key.startswith(src_folder_prefix) else key
            dst_key = dst_folder_prefix + rel
            _copy_s3_object(
                src_client, dst_client, src_bucket_name, dst_bucket_name,
                key, dst_key, use_server_copy,
            )
            if meilisearch.is_enabled():
                meilisearch.upsert_document(dst_bucket_id, dst_key)
            yield dst_key

    if src_folder_prefix not in seen_keys:
        try:
            src_client.head_object(Bucket=src_bucket_name, Key=src_folder_prefix)
            _copy_s3_object(
                src_client, dst_client, src_bucket_name, dst_bucket_name,
                src_folder_prefix, dst_folder_prefix, use_server_copy,
            )
        except ClientError as head_err:
            code = head_err.response.get('Error', {}).get('Code', '')
            if code in ('404', 'NoSuchKey', 'NotFound'):
                dst_client.put_object(Bucket=dst_bucket_name, Key=dst_folder_prefix, Body=b'')
            else:
                raise
        if meilisearch.is_enabled():
            meilisearch.upsert_document(dst_bucket_id, dst_folder_prefix)
        yield dst_folder_prefix


def _normalize_copy_items(items, src_bucket_id, dst_bucket_id, dst_path, into_self_error_key='error.copy_into_self'):
    normalized = []
    for raw_item in items:
        path = _normalize_s3_object_key((raw_item or {}).get('path', ''))
        item_type = (raw_item or {}).get('type', 'file')
        if not path:
            continue
        is_folder = item_type == 'folder' or path.endswith('/')
        if is_folder and not path.endswith('/'):
            path += '/'

        folder_name = _folder_name_from_prefix(path) if is_folder else ''
        if is_folder:
            dst_target_prefix = dst_path + folder_name + '/' if folder_name else dst_path
        else:
            dst_target_prefix = dst_path

        skip = False
        skip_error = None
        if src_bucket_id == dst_bucket_id:
            if is_folder and (dst_target_prefix.startswith(path) or path.startswith(dst_target_prefix)):
                skip = True
                skip_error = _trf(into_self_error_key, path=path)
            elif not is_folder:
                dst_key = dst_path + path.rsplit('/', 1)[-1]
                if dst_key == path:
                    skip = True
                    skip_error = _trf(into_self_error_key, path=path)

        normalized.append({
            'path': path,
            'is_folder': is_folder,
            'dst_target_prefix': dst_target_prefix,
            'skip': skip,
            'skip_error': skip_error,
        })
    return normalized


def _build_copy_job(data):
    src_bucket_id = (data.get('src_bucket') or '').strip()
    dst_bucket_id = (data.get('dst_bucket') or '').strip()
    dst_path = _normalize_s3_object_key(data.get('dst_path', ''))
    items = data.get('items') or []

    if dst_path and not dst_path.endswith('/'):
        dst_path += '/'

    if not src_bucket_id or not dst_bucket_id:
        return None, (_('error.bucket_id_required'), 400, {})
    if not items:
        return None, (_('error.copy_items_required'), 400, {})

    file_items = [i for i in items if (i or {}).get('type') == 'file']
    folder_items = [i for i in items if (i or {}).get('type') == 'folder']
    if len(file_items) > 1 and not role_copy_files_multi(src_bucket_id):
        return None, (_('error.access_denied'), 403, {})
    if len(folder_items) > 1 and not role_copy_folder_multi(src_bucket_id):
        return None, (_('error.access_denied'), 403, {})

    src_info = find_bucket_config_by_bucket_id(src_bucket_id)
    dst_info = find_bucket_config_by_bucket_id(dst_bucket_id)
    if not src_info or not dst_info:
        return None, (_('error.bucket_not_found'), 404, {})
    if not _check_bucket_access(src_bucket_id) or not _check_bucket_access(dst_bucket_id):
        return None, (_('error.access_denied'), 403, {})

    src_cfg = src_info['bucket_config']
    dst_cfg = dst_info['bucket_config']
    src_bucket_name = src_cfg.get('bucket_name')
    dst_bucket_name = dst_cfg.get('bucket_name')

    if not role_upload_files(dst_bucket_id):
        return None, (_('error.access_denied'), 403, {})

    normalized_items = _normalize_copy_items(items, src_bucket_id, dst_bucket_id, dst_path)
    if not normalized_items:
        return None, (_('error.copy_items_required'), 400, {})

    for item in normalized_items:
        if item['skip']:
            continue
        if item['is_folder']:
            if not (role_copy_folder(src_bucket_id) or role_copy_folder_multi(src_bucket_id)):
                return None, (_('error.access_denied'), 403, {})
            if not (role_upload_folder(dst_bucket_id) or role_create_folder(dst_bucket_id)):
                return None, (_('error.access_denied'), 403, {})
        elif not (role_copy_file(src_bucket_id) or role_copy_files_multi(src_bucket_id)):
            return None, (_('error.access_denied'), 403, {})

    src_client = _get_s3_client(src_cfg)
    dst_client = _get_s3_client(dst_cfg)
    use_server_copy = (
        src_client is dst_client
        or _s3_copy_configs_compatible(src_cfg, dst_cfg)
    )
    if use_server_copy and src_client is not dst_client:
        dst_client = src_client

    return {
        'src_bucket_id': src_bucket_id,
        'dst_bucket_id': dst_bucket_id,
        'dst_path': dst_path,
        'normalized_items': normalized_items,
        'src_client': src_client,
        'dst_client': dst_client,
        'src_bucket_name': src_bucket_name,
        'dst_bucket_name': dst_bucket_name,
        'use_server_copy': use_server_copy,
        'src_display': src_info['display_name'],
        'dst_display': dst_info['display_name'],
        'username': session.get('username', 'unknown'),
    }, None


def _count_copy_objects_total(job):
    total = 0
    for item in job['normalized_items']:
        if item['skip']:
            continue
        if item['is_folder']:
            total += _count_folder_objects(
                job['src_client'], job['src_bucket_name'], item['path'],
            )
        else:
            total += 1
    return total


def _start_parallel_copy_object_count(job):
    holder = {'total': None, 'error': None}
    lock = threading.Lock()

    def worker():
        try:
            total = _count_copy_objects_total(job)
            with lock:
                holder['total'] = total
        except Exception as exc:
            with lock:
                holder['error'] = exc

    thread = threading.Thread(target=worker, name='transfer-object-count', daemon=True)
    thread.start()
    return holder, lock, thread


def _poll_parallel_copy_object_count(holder, lock):
    with lock:
        if holder['error'] is not None:
            return 'error', holder['error']
        if holder['total'] is not None:
            return 'ready', holder['total']
        return 'pending', None


def _emit_transfer_total_if_ready(holder, lock, count_state, context='transfer_count'):
    if count_state['announced']:
        return None
    status, value = _poll_parallel_copy_object_count(holder, lock)
    if status == 'error':
        log_error('Transfer object count failed', context, value, LOG_CONFIG['show_traceback'])
        return {'type': 'error', 'error': _('error.unexpected')}
    if status != 'ready':
        return None
    count_state['announced'] = True
    count_state['total'] = value
    return {'type': 'total', 'total': value}


def _yield_transfer_total_or_stop(holder, lock, count_state, context):
    """Return (stop, event). stop=True when count failed."""
    total_evt = _emit_transfer_total_if_ready(holder, lock, count_state, context=context)
    if not total_evt:
        return False, None
    if total_evt.get('type') == 'error':
        return True, total_evt
    return False, total_evt


def _transfer_progress_event(current, total, total_pending, **extra):
    event = {'type': 'progress', 'current': current, **extra}
    if total_pending:
        event['total_pending'] = True
        event['total'] = 0
    else:
        event['total'] = total
    return event


def _job_cancelled_event(**kwargs):
    event = {'type': 'cancelled'}
    event.update(kwargs)
    return event


def _iter_copy_events(job, context, cancel_check=None):
    yield {'type': 'counting'}
    if cancel_check and cancel_check():
        yield _job_cancelled_event()
        return

    item_count = len(job['normalized_items'])
    count_holder, count_lock, count_thread = _start_parallel_copy_object_count(job)
    count_state = {'announced': False, 'total': None}

    yield {
        'type': 'start',
        'total': 0,
        'total_pending': True,
        'item_count': item_count,
    }

    def emit_total():
        stop, total_evt = _yield_transfer_total_or_stop(
            count_holder, count_lock, count_state, context,
        )
        return stop, total_evt

    current = 0
    copied_total = 0
    errors = []

    for item_index, item in enumerate(job['normalized_items']):
        stop, total_evt = emit_total()
        if total_evt:
            yield total_evt
        if stop:
            return
        if cancel_check and cancel_check():
            total = count_state['total']
            yield _job_cancelled_event(
                current=current,
                total=total if total is not None else current,
                copied=copied_total,
            )
            return
        yield {'type': 'item_start', 'index': item_index}

        if item['skip']:
            errors.append(item['skip_error'])
            yield {'type': 'item_done', 'index': item_index, 'success': False}
            continue

        path = item['path']
        try:
            if item['is_folder']:
                for dst_key in _iter_copy_folder_tree(
                    job['src_client'], job['dst_client'],
                    job['src_bucket_name'], job['dst_bucket_name'],
                    path, item['dst_target_prefix'],
                    job['use_server_copy'], job['dst_bucket_id'],
                ):
                    stop, total_evt = emit_total()
                    if total_evt:
                        yield total_evt
                    if stop:
                        return
                    if cancel_check and cancel_check():
                        total = count_state['total']
                        yield _job_cancelled_event(
                            current=current,
                            total=total if total is not None else current,
                            copied=copied_total,
                        )
                        return
                    current += 1
                    copied_total += 1
                    total = count_state['total']
                    yield _transfer_progress_event(
                        current,
                        total,
                        total is None,
                        item_index=item_index,
                        key=dst_key,
                    )
            else:
                dst_key = job['dst_path'] + path.rsplit('/', 1)[-1]
                _copy_s3_object(
                    job['src_client'], job['dst_client'],
                    job['src_bucket_name'], job['dst_bucket_name'],
                    path, dst_key, job['use_server_copy'],
                )
                if meilisearch.is_enabled():
                    meilisearch.upsert_document(job['dst_bucket_id'], dst_key)
                current += 1
                copied_total += 1
                total = count_state['total']
                yield _transfer_progress_event(
                    current,
                    total,
                    total is None,
                    item_index=item_index,
                    key=dst_key,
                )
            yield {'type': 'item_done', 'index': item_index, 'success': True}
        except ClientError as e:
            log_s3_exception(context, e, job['src_display'])
            errors.append(f"{path}: {e.response.get('Error', {}).get('Code', 'Error')}")
            yield {'type': 'item_done', 'index': item_index, 'success': False}
        except Exception as e:
            log_error('Copy failed', context, e, LOG_CONFIG['show_traceback'])
            errors.append(f"{path}: {str(e)}")
            yield {'type': 'item_done', 'index': item_index, 'success': False}

    if not count_state['announced']:
        count_thread.join()
        stop, total_evt = emit_total()
        if total_evt:
            yield total_evt
        if stop:
            return

    final_total = count_state['total'] if count_state['total'] is not None else copied_total
    yield {
        'type': 'done',
        'copied': copied_total,
        'total': final_total,
        'errors': errors,
        'message': _trf('msg.copy_completed', count=copied_total),
    }


def _delete_s3_path(s3_client, bucket_name, bucket_id, object_path):
    """Удалить файл или папку (рекурсивно). Возвращает число удалённых ключей."""
    if not object_path:
        return 0
    is_folder = object_path.endswith('/')
    deleted_count = 0

    if is_folder:
        objects_to_delete = []
        paginator = s3_client.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=bucket_name, Prefix=object_path):
            for obj in page.get('Contents', []):
                objects_to_delete.append({'Key': obj['Key']})

        if objects_to_delete:
            max_batch_size = 1000
            for i in range(0, len(objects_to_delete), max_batch_size):
                batch = objects_to_delete[i:i + max_batch_size]
                s3_client.delete_objects(
                    Bucket=bucket_name,
                    Delete={'Objects': batch},
                )
                deleted_count += len(batch)
            if meilisearch.is_enabled():
                meilisearch.remove_by_path_prefix(bucket_id, object_path)
        else:
            s3_client.delete_object(Bucket=bucket_name, Key=object_path)
            deleted_count = 1
            if meilisearch.is_enabled():
                meilisearch.remove_document(bucket_id, object_path)
    else:
        s3_client.delete_object(Bucket=bucket_name, Key=object_path)
        deleted_count = 1
        if meilisearch.is_enabled():
            meilisearch.remove_document(bucket_id, object_path)

    return deleted_count


def _build_move_job(data):
    src_bucket_id = (data.get('src_bucket') or '').strip()
    dst_bucket_id = (data.get('dst_bucket') or '').strip()
    dst_path = _normalize_s3_object_key(data.get('dst_path', ''))
    items = data.get('items') or []

    if dst_path and not dst_path.endswith('/'):
        dst_path += '/'

    if not src_bucket_id or not dst_bucket_id:
        return None, (_('error.bucket_id_required'), 400, {})
    if not items:
        return None, (_('error.move_items_required'), 400, {})

    file_items = [i for i in items if (i or {}).get('type') == 'file']
    folder_items = [i for i in items if (i or {}).get('type') == 'folder']
    if len(file_items) > 1 and not role_move_files_multi(src_bucket_id):
        return None, (_('error.access_denied'), 403, {})
    if len(folder_items) > 1 and not role_move_folder_multi(src_bucket_id):
        return None, (_('error.access_denied'), 403, {})

    src_info = find_bucket_config_by_bucket_id(src_bucket_id)
    dst_info = find_bucket_config_by_bucket_id(dst_bucket_id)
    if not src_info or not dst_info:
        return None, (_('error.bucket_not_found'), 404, {})
    if not _check_bucket_access(src_bucket_id) or not _check_bucket_access(dst_bucket_id):
        return None, (_('error.access_denied'), 403, {})

    src_cfg = src_info['bucket_config']
    dst_cfg = dst_info['bucket_config']
    src_bucket_name = src_cfg.get('bucket_name')
    dst_bucket_name = dst_cfg.get('bucket_name')

    if not role_upload_files(dst_bucket_id):
        return None, (_('error.access_denied'), 403, {})

    normalized_items = _normalize_copy_items(
        items, src_bucket_id, dst_bucket_id, dst_path, 'error.move_into_self',
    )
    if not normalized_items:
        return None, (_('error.move_items_required'), 400, {})

    for item in normalized_items:
        if item['skip']:
            continue
        if item['is_folder']:
            if not (
                (role_move_folder(src_bucket_id) or role_move_folder_multi(src_bucket_id))
                and (role_delete_folder(src_bucket_id) or role_delete_folder_multi(src_bucket_id))
            ):
                return None, (_('error.access_denied'), 403, {})
            if not (role_upload_folder(dst_bucket_id) or role_create_folder(dst_bucket_id)):
                return None, (_('error.access_denied'), 403, {})
        else:
            if not (
                (role_move_file(src_bucket_id) or role_move_files_multi(src_bucket_id))
                and (role_delete_file(src_bucket_id) or role_delete_files_multi(src_bucket_id))
            ):
                return None, (_('error.access_denied'), 403, {})

    src_client = _get_s3_client(src_cfg)
    dst_client = _get_s3_client(dst_cfg)
    use_server_copy = (
        src_client is dst_client
        or _s3_copy_configs_compatible(src_cfg, dst_cfg)
    )
    if use_server_copy and src_client is not dst_client:
        dst_client = src_client

    return {
        'src_bucket_id': src_bucket_id,
        'dst_bucket_id': dst_bucket_id,
        'dst_path': dst_path,
        'normalized_items': normalized_items,
        'src_client': src_client,
        'dst_client': dst_client,
        'src_bucket_name': src_bucket_name,
        'dst_bucket_name': dst_bucket_name,
        'use_server_copy': use_server_copy,
        'src_display': src_info['display_name'],
        'dst_display': dst_info['display_name'],
        'username': session.get('username', 'unknown'),
    }, None


def _iter_move_events(job, context, cancel_check=None):
    yield {'type': 'counting'}
    if cancel_check and cancel_check():
        yield _job_cancelled_event()
        return

    item_count = len(job['normalized_items'])
    count_holder, count_lock, count_thread = _start_parallel_copy_object_count(job)
    count_state = {'announced': False, 'total': None}

    yield {
        'type': 'start',
        'total': 0,
        'total_pending': True,
        'item_count': item_count,
    }

    def emit_total():
        stop, total_evt = _yield_transfer_total_or_stop(
            count_holder, count_lock, count_state, context,
        )
        return stop, total_evt

    current = 0
    moved_total = 0
    errors = []

    for item_index, item in enumerate(job['normalized_items']):
        stop, total_evt = emit_total()
        if total_evt:
            yield total_evt
        if stop:
            return
        if cancel_check and cancel_check():
            total = count_state['total']
            yield _job_cancelled_event(
                current=current,
                total=total if total is not None else current,
                moved=moved_total,
            )
            return
        yield {'type': 'item_start', 'index': item_index}

        if item['skip']:
            errors.append(item['skip_error'])
            yield {'type': 'item_done', 'index': item_index, 'success': False}
            continue

        path = item['path']
        try:
            if item['is_folder']:
                for dst_key in _iter_copy_folder_tree(
                    job['src_client'], job['dst_client'],
                    job['src_bucket_name'], job['dst_bucket_name'],
                    path, item['dst_target_prefix'],
                    job['use_server_copy'], job['dst_bucket_id'],
                ):
                    stop, total_evt = emit_total()
                    if total_evt:
                        yield total_evt
                    if stop:
                        return
                    if cancel_check and cancel_check():
                        total = count_state['total']
                        yield _job_cancelled_event(
                            current=current,
                            total=total if total is not None else current,
                            moved=moved_total,
                        )
                        return
                    current += 1
                    moved_total += 1
                    total = count_state['total']
                    yield _transfer_progress_event(
                        current,
                        total,
                        total is None,
                        item_index=item_index,
                        key=dst_key,
                    )
            else:
                dst_key = job['dst_path'] + path.rsplit('/', 1)[-1]
                _copy_s3_object(
                    job['src_client'], job['dst_client'],
                    job['src_bucket_name'], job['dst_bucket_name'],
                    path, dst_key, job['use_server_copy'],
                )
                if meilisearch.is_enabled():
                    meilisearch.upsert_document(job['dst_bucket_id'], dst_key)
                current += 1
                moved_total += 1
                total = count_state['total']
                yield _transfer_progress_event(
                    current,
                    total,
                    total is None,
                    item_index=item_index,
                    key=dst_key,
                )

            _delete_s3_path(
                job['src_client'], job['src_bucket_name'], job['src_bucket_id'], path,
            )
            yield {'type': 'item_done', 'index': item_index, 'success': True}
        except ClientError as e:
            log_s3_exception(context, e, job['src_display'])
            errors.append(f"{path}: {e.response.get('Error', {}).get('Code', 'Error')}")
            yield {'type': 'item_done', 'index': item_index, 'success': False}
        except Exception as e:
            log_error('Move failed', context, e, LOG_CONFIG['show_traceback'])
            errors.append(f"{path}: {str(e)}")
            yield {'type': 'item_done', 'index': item_index, 'success': False}

    if not count_state['announced']:
        count_thread.join()
        stop, total_evt = emit_total()
        if total_evt:
            yield total_evt
        if stop:
            return

    final_total = count_state['total'] if count_state['total'] is not None else moved_total
    yield {
        'type': 'done',
        'moved': moved_total,
        'total': final_total,
        'errors': errors,
        'message': _trf('msg.move_completed', count=moved_total),
    }


def _normalize_delete_item_path(path):
    raw = (path or '').strip()
    if not raw:
        return ''
    try:
        decoded = unquote(raw)
        if decoded != raw:
            raw = decoded
    except Exception:
        pass
    return raw.strip()


def _build_delete_batch_job(data):
    bucket_id = (data.get('bucket') or '').strip()
    items = data.get('items') or []
    if not bucket_id:
        return None, (_('error.bucket_id_required'), 400, {})
    if not isinstance(items, list) or not items:
        return None, (_('error.object_path_required'), 400, {})

    bucket_info = find_bucket_config_by_bucket_id(bucket_id)
    if not bucket_info:
        return None, (_('error.bucket_not_found'), 404, {})
    if not _check_bucket_access(bucket_id):
        return None, (_('error.access_denied'), 403, {})

    file_items = [i for i in items if (i or {}).get('type') == 'file']
    folder_items = [i for i in items if (i or {}).get('type') == 'folder']
    if len(file_items) > 1 and not role_delete_files_multi(bucket_id):
        return None, (_('error.access_denied'), 403, {})
    if len(folder_items) > 1 and not role_delete_folder_multi(bucket_id):
        return None, (_('error.access_denied'), 403, {})

    normalized = []
    for item in items:
        if not isinstance(item, dict):
            continue
        path = _normalize_delete_item_path(item.get('path'))
        if not path:
            continue
        is_folder = path.endswith('/') or item.get('type') == 'folder'
        if is_folder and not path.endswith('/'):
            path += '/'
        if is_folder and not role_delete_folder(bucket_id):
            return None, (_('error.access_denied'), 403, {})
        if not is_folder and not role_delete_file(bucket_id):
            return None, (_('error.access_denied'), 403, {})
        normalized.append({'path': path, 'type': 'folder' if is_folder else 'file'})

    if not normalized:
        return None, (_('error.object_path_required'), 400, {})

    bucket_config = bucket_info['bucket_config']
    return {
        'bucket_id': bucket_id,
        'bucket_name': bucket_config.get('bucket_name'),
        'display_name': bucket_info['display_name'],
        's3_client': _get_s3_client(bucket_config),
        'items': normalized,
        'username': session.get('username', 'unknown'),
    }, None


def _iter_delete_batch_events(batch_job, context, cancel_check=None):
    items = batch_job['items']
    total = len(items)
    yield {'type': 'start', 'total': total, 'item_count': total}

    deleted_count = 0
    errors = []
    for index, item in enumerate(items):
        if cancel_check and cancel_check():
            yield _job_cancelled_event(current=deleted_count, total=total, deleted=deleted_count)
            return
        path = item['path']
        yield {'type': 'item_start', 'index': index}
        try:
            _delete_s3_path(
                batch_job['s3_client'],
                batch_job['bucket_name'],
                batch_job['bucket_id'],
                path,
            )
            deleted_count += 1
            yield {'type': 'progress', 'current': index + 1, 'total': total, 'item_index': index}
            yield {'type': 'item_done', 'index': index, 'success': True}
        except ClientError as e:
            log_s3_exception(context, e, batch_job['display_name'])
            errors.append(f"{path}: {e.response.get('Error', {}).get('Code', 'Error')}")
            yield {'type': 'item_done', 'index': index, 'success': False}
        except Exception as e:
            log_error('Delete batch item failed', context, e, LOG_CONFIG['show_traceback'])
            errors.append(f"{path}: {str(e)}")
            yield {'type': 'item_done', 'index': index, 'success': False}

    yield {
        'type': 'done',
        'deleted': deleted_count,
        'errors': errors,
        'message': _trf('msg.deleted_count', count=deleted_count),
    }


def _operation_job_sse_response(job_id):
    def generate():
        for event in operation_jobs.iter_job_events(job_id):
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


def _display_names_from_items(items):
    names = []
    for item in items or []:
        path = (item or {}).get('path') or ''
        parts = [p for p in str(path).split('/') if p]
        names.append(parts[-1] if parts else path)
    return names


