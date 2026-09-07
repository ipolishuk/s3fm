"""File browser HTTP handlers: list, metadata, ACL, upload, copy/move/delete."""

from __future__ import annotations

import os
import tempfile
import threading
from datetime import datetime, timezone

from botocore.exceptions import ClientError
from flask import current_app, jsonify, request, session

from acl_ops import (
    _apply_object_acl_from_grants,
    _build_acl_batch_job,
    _iter_acl_batch_events,
    _map_acl_put_client_error,
    _metadata_acl_capability_flags,
    _object_acl_payload_from_raw,
    _peek_cached_object_acl,
    _store_cached_object_acl,
)
from bucket_access import (
    check_bucket_access,
    find_bucket_config_by_bucket_id,
    normalize_s3_object_key as _normalize_s3_object_key,
)
from file_ops import (
    _build_copy_job,
    _build_delete_batch_job,
    _build_move_job,
    _delete_s3_path,
    _display_names_from_items,
    _iter_copy_events,
    _iter_delete_batch_events,
    _iter_move_events,
    _list_files_under_prefix,
    _operation_job_sse_response,
)
from list_ops import (
    _list_files_find_reveal_page,
    _s3_list_all_at_prefix,
    _s3_list_files_page,
)
from logs import LOG_CONFIG, log_error, log_info, log_s3_exception, log_user_action, log_warning, trf_en
import meilisearch
import operation_jobs
from roles import (
    role_create_folder,
    role_delete_file,
    role_delete_files_multi,
    role_delete_folder,
    role_delete_folder_multi,
    role_edit_file_acl,
    role_upload_files,
    role_upload_folder,
)
from s3_client import (
    _map_s3_client_error,
    _map_s3_runtime_error,
    _trf,
    get_s3_client,
)
from security import build_object_url
from translations import _
from upload_ops import (
    _finish_upload_job,
    _guess_upload_content_type,
    _run_upload_job_file,
    _s3fm_meta_from_head,
    _s3fm_upload_metadata,
)


def _max_upload_mb():
    return int(os.environ.get('MAX_UPLOAD_MB', '100'))


def list_files_impl():
    """Получить список файлов и папок с пагинацией"""
    context = 'list_objects'
    try:
        bucket_id = request.args.get('bucket', '')
        prefix = request.args.get('prefix', '')
        limit = int(request.args.get('limit', 50))
        continuation_token = request.args.get('continuation_token', '')
        reveal_key = request.args.get('reveal_key', '').strip()
        page_num = max(1, int(request.args.get('page', 1)))

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

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

        if reveal_key and prefix and not reveal_key.startswith(prefix):
            log_error(f'reveal_key must begin with prefix "{prefix}"', context)
            return jsonify({'error': _('error.object_path_required')}), 400

        s3_client = get_s3_client(bucket_config)

        page_start_tokens = None
        if reveal_key and not continuation_token:
            found_page, page_start_tokens, page_data = _list_files_find_reveal_page(
                s3_client, bucket_name, prefix, limit, reveal_key
            )
            page_num = found_page
            all_folders = page_data['folders']
            files_result = page_data['files']
            is_truncated = page_data['is_truncated']
            next_token = page_data['next_continuation_token']
        else:
            page_data = _s3_list_files_page(
                s3_client, bucket_name, prefix, limit, continuation_token or None
            )
            all_folders = page_data['folders']
            files_result = page_data['files']
            is_truncated = page_data['is_truncated']
            next_token = page_data['next_continuation_token']

        result = {
            'bucket': bucket_name,
            'bucket_id': bucket_id,
            'display_name': display_name,
            'prefix': prefix,
            'folders': all_folders,
            'files': files_result,
            'is_truncated': is_truncated,
            'next_continuation_token': next_token,
            'key_count': len(files_result),
            'page': page_num,
            'has_prev_page': page_num > 1,
            'has_next_page': bool(is_truncated),
        }
        if page_start_tokens is not None:
            result['page_start_tokens'] = page_start_tokens

        log_info(
            f"Bucket: {display_name}, prefix: '/{prefix}', page: {page_num}, "
            f"folders: {len(all_folders)}, files: {len(files_result)}",
            context,
        )

        return jsonify(result)

    except ClientError as e:
        error_msg, status_code = _map_s3_client_error(e, display_name)
        log_s3_exception(context, e, display_name)
        return jsonify({'error': error_msg}), status_code

    except Exception as e:
        full_msg, status_code = _map_s3_runtime_error(e, display_name)
        log_s3_exception(context, e, display_name)
        return jsonify({'error': full_msg}), status_code


def list_selection_items_impl():
    """Все объекты на уровне prefix (без пагинации UI) для «выбрать все в бакете/папке»."""
    context = 'list_selection_items'
    bucket_id = ''
    try:
        bucket_id = request.args.get('bucket', '')
        prefix = request.args.get('prefix', '')

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            error_msg = f'Bucket with ID {bucket_id} not found in configuration'
            log_error(error_msg, context)
            return jsonify({'error': _('error.bucket_not_found')}), 404

        display_name = bucket_info['display_name']
        if not check_bucket_access(bucket_id):
            log_warning(f'Access to bucket {display_name} denied', context)
            return jsonify({'error': _('error.access_denied')}), 403

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        s3_client = get_s3_client(bucket_config)
        all_folders, all_files = _s3_list_all_at_prefix(s3_client, bucket_name, prefix)

        folder_items = [{'path': f['path'], 'type': 'folder'} for f in all_folders]
        file_items = [{'path': f['path'], 'type': 'file'} for f in all_files]
        total = len(folder_items) + len(file_items)

        log_info(
            f"Bucket: {display_name}, prefix: '/{prefix}', selection items: {total}",
            context,
        )
        return jsonify({
            'bucket_id': bucket_id,
            'prefix': prefix,
            'folders': folder_items,
            'files': file_items,
            'total': total,
        })

    except ClientError as e:
        display_name = ''
        if bucket_id:
            bucket_info = find_bucket_config_by_bucket_id(bucket_id)
            if bucket_info:
                display_name = bucket_info.get('display_name', '')
        error_msg, status_code = _map_s3_client_error(e, display_name)
        log_s3_exception(context, e, display_name)
        return jsonify({'error': error_msg}), status_code

    except Exception as e:
        full_msg, status_code = _map_s3_runtime_error(e, bucket_id)
        if full_msg == _trf('error.unexpected'):
            full_msg = _trf('error.folders_list_failed')
        log_s3_exception(context, e, bucket_id)
        return jsonify({'error': full_msg}), status_code


def file_metadata_impl():
    """Быстрые метаданные: размер и дата (head_object). ACL — GET /metadata/acl."""
    context = 'file_metadata'
    try:
        bucket_id = (request.args.get('bucket') or '').strip()
        file_path = (request.args.get('path') or '').strip()
        if not bucket_id:
            return jsonify({'error': _('error.bucket_id_required')}), 400
        if not file_path or file_path.endswith('/'):
            return jsonify({'error': _('error.object_path_required')}), 400

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            return jsonify({'error': _('error.bucket_not_found')}), 404

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        display_name = bucket_info['display_name']
        endpoint_url = (bucket_config.get('endpoint_url') or '').strip()

        if not check_bucket_access(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403

        group_data = bucket_info.get('group_data') or {}
        public_url_enabled = bool(group_data.get('public_url_enabled'))
        object_url = (
            build_object_url(bucket_name, endpoint_url, file_path)
            if public_url_enabled
            else ''
        )

        s3_client = get_s3_client(bucket_config)
        head = s3_client.head_object(Bucket=bucket_name, Key=file_path)

        last_modified = head.get('LastModified')
        if last_modified is not None and hasattr(last_modified, 'isoformat'):
            last_modified = last_modified.isoformat()

        filename = file_path.split('/')[-1] if '/' in file_path else file_path
        s3fm = _s3fm_meta_from_head(head)

        return jsonify({
            'bucket_id': bucket_id,
            'display_name': display_name,
            'path': file_path,
            'name': filename,
            'size': int(head.get('ContentLength') or 0),
            'last_modified': last_modified,
            'created_at': s3fm['created_at'],
            'modified_by': s3fm['actor'],
            'content_type': head.get('ContentType') or '',
            'object_url': object_url,
        })

    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        if error_code == 'NoSuchKey':
            return jsonify({'error': _trf('error.s3_object_not_found', path=file_path)}), 404
        log_name = display_name if 'display_name' in locals() else bucket_id
        error_msg, status_code = _map_s3_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code
    except Exception as e:
        log_error('File metadata failed', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def file_metadata_acl_read_impl():
    """Список грантов ACL объекта (отдельно от head и проверки кнопки)."""
    context = 'file_metadata_acl_read'
    try:
        bucket_id = (request.args.get('bucket') or '').strip()
        file_path = (request.args.get('path') or '').strip()
        if not bucket_id:
            return jsonify({'error': _('error.bucket_id_required')}), 400
        if not file_path or file_path.endswith('/'):
            return jsonify({'error': _('error.object_path_required')}), 400

        if not role_edit_file_acl(bucket_id):
            return jsonify({'error': _('error.acl_access_denied')}), 403

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            return jsonify({'error': _('error.bucket_not_found')}), 404

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        display_name = bucket_info['display_name']

        if not check_bucket_access(bucket_id):
            return jsonify({'error': _('error.acl_access_denied')}), 403

        cached_payload = _peek_cached_object_acl(bucket_id, file_path)
        if cached_payload is not None:
            return jsonify(cached_payload)

        s3_client = get_s3_client(bucket_config)
        raw_acl = None
        acl_data, acl_error = None, None
        try:
            raw_acl = s3_client.get_object_acl(Bucket=bucket_name, Key=file_path)
            acl_data, acl_error = _object_acl_payload_from_raw(
                s3_client, bucket_name, raw_acl, resolve_bucket_owner=False,
            )
        except ClientError as e:
            code = e.response.get('Error', {}).get('Code', '')
            if code == 'NoSuchKey':
                return jsonify({'error': _trf('error.s3_object_not_found', path=file_path)}), 404
            if code in ('AccessDenied', 'AllAccessDisabled'):
                acl_error = _trf('files.info_acl_denied')
            else:
                raise

        payload = {
            'acl': acl_data,
            'acl_error': acl_error,
            'acl_readable': bool(acl_data and not acl_error),
        }
        _store_cached_object_acl(bucket_id, file_path, payload)
        return jsonify(payload)

    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        if error_code == 'NoSuchKey':
            return jsonify({'error': _trf('error.s3_object_not_found', path=file_path)}), 404
        log_name = display_name if 'display_name' in locals() else bucket_id
        error_msg, status_code = _map_s3_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code
    except Exception as e:
        log_error('File ACL read failed', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def file_metadata_acl_capability_impl():
    """Быстрая проверка s3:PutObjectAcl для кнопки «Редактировать» (без get_object_acl)."""
    context = 'file_metadata_acl_capability'
    try:
        bucket_id = (request.args.get('bucket') or '').strip()
        file_path = (request.args.get('path') or '').strip()
        if not bucket_id:
            return jsonify({'error': _('error.bucket_id_required')}), 400
        if not file_path or file_path.endswith('/'):
            return jsonify({'error': _('error.object_path_required')}), 400

        if not role_edit_file_acl(bucket_id):
            return jsonify({'error': _('error.acl_access_denied')}), 403

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            return jsonify({'error': _('error.bucket_not_found')}), 404

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')

        if not check_bucket_access(bucket_id):
            return jsonify({'error': _('error.acl_access_denied')}), 403

        s3_client = get_s3_client(bucket_config)
        can_edit_acl, can_put_object_acl = _metadata_acl_capability_flags(
            s3_client, bucket_name, bucket_id,
        )
        return jsonify({
            'can_edit_acl': can_edit_acl,
            'can_put_object_acl': can_put_object_acl,
        })

    except ClientError as e:
        log_name = display_name if 'display_name' in locals() else bucket_id
        error_msg, status_code = _map_acl_put_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code
    except Exception as e:
        log_error('File ACL capability check failed', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def file_metadata_acl_update_impl():
    """Обновить ACL объекта S3."""
    context = 'file_metadata_acl_update'
    username = session.get('username', 'Неизвестный пользователь')
    file_path = ''

    try:
        data = request.get_json(silent=True) or {}
        bucket_id = (data.get('bucket') or data.get('bucket_id') or '').strip()
        file_path = (data.get('path') or '').strip()
        if not bucket_id:
            return jsonify({'error': _('error.bucket_id_required')}), 400
        if not file_path or file_path.endswith('/'):
            return jsonify({'error': _('error.object_path_required')}), 400

        if not role_edit_file_acl(bucket_id):
            return jsonify({'error': _('error.acl_access_denied')}), 403

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            return jsonify({'error': _('error.bucket_not_found')}), 404

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        display_name = bucket_info['display_name']

        if not check_bucket_access(bucket_id):
            return jsonify({'error': _('error.acl_access_denied')}), 403

        grants_raw = data.get('grants')
        if not isinstance(grants_raw, list):
            return jsonify({'error': _('files.info_acl_grants_invalid')}), 400

        s3_client = get_s3_client(bucket_config)

        try:
            acl_data, acl_error = _apply_object_acl_from_grants(
                s3_client, bucket_name, bucket_id, file_path, grants_raw,
            )
        except ClientError as e:
            code = e.response.get('Error', {}).get('Code', '')
            if code == 'NoSuchKey':
                return jsonify({'error': _trf('error.s3_object_not_found', path=file_path)}), 404
            error_msg, status_code = _map_acl_put_client_error(e, display_name)
            log_s3_exception(context, e, display_name)
            return jsonify({'error': error_msg}), status_code
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400

        log_user_action(
            username,
            context,
            f"Bucket: {display_name}, ACL updated: /{file_path}",
        )

        return jsonify({
            'ok': True,
            'acl': acl_data,
            'acl_error': acl_error,
            'message': _trf('files.info_acl_saved'),
        })

    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        if error_code == 'NoSuchKey':
            return jsonify({'error': _trf('error.s3_object_not_found', path=file_path)}), 404
        log_name = display_name if 'display_name' in locals() else bucket_id
        error_msg, status_code = _map_acl_put_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code
    except Exception as e:
        log_error('File ACL update failed', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def file_metadata_acl_batch_impl():
    """Пакетное применение ACL в фоне (прогресс через SSE)."""
    context = 'file_metadata_acl_batch'
    try:
        data = request.get_json(silent=True) or {}
        batch_job, err = _build_acl_batch_job(data)
        if err:
            body = {'error': err[0]}
            if len(err) > 2 and err[2]:
                body.update(err[2])
            return jsonify(body), err[1]

        raw_names = data.get('display_names')
        if not isinstance(raw_names, list):
            raw_names = _display_names_from_items(
                [{'path': p} for p in batch_job['paths']],
            )
        display_names = [str(n) for n in raw_names]

        job_id = operation_jobs.create_job(
            batch_job['username'], 'acl', {'display_names': display_names},
        )

        def worker():
            try:
                cancel_check = lambda: operation_jobs.is_cancel_requested(job_id)
                for event in _iter_acl_batch_events(batch_job, context, cancel_check=cancel_check):
                    operation_jobs.publish(job_id, event)
                    if event.get('type') == 'done':
                        log_user_action(
                            batch_job['username'], context,
                            f"Batch ACL in {batch_job['display_name']}, "
                            f"files={len(batch_job['paths'])}, applied={event.get('applied', 0)}",
                        )
                        break
                    if event.get('type') == 'cancelled':
                        break
            except Exception as e:
                log_error('Unexpected ACL batch job error', context, e, LOG_CONFIG['show_traceback'])
                operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})

        operation_jobs.start_worker(job_id, worker)
        return jsonify({'job_id': job_id, 'op': 'acl'}), 202
    except Exception as e:
        log_error('Unexpected ACL batch error', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def list_all_folders_impl():
    """Получить список всех папок в бакете рекурсивно"""
    context = 'list_all_folders'
    try:
        bucket_id = request.args.get('bucket', '')
        prefix = request.args.get('prefix', '')

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

        # Находим конфигурацию бакета по bucket_id
        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            error_msg = f'Bucket with ID {bucket_id} not found in configuration'
            log_error(error_msg, context)
            return jsonify({'error': _('error.bucket_not_found')}), 404

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')

        # Проверяем доступ к бакету по bucket_id
        if not check_bucket_access(bucket_id):
            log_warning('Access to bucket denied', context)
            return jsonify({'error': _('error.access_denied')}), 403

        s3_client = get_s3_client(bucket_config)

        all_folders = []
        seen_folders = set()

        # Рекурсивно получаем все объекты БЕЗ разделителя
        paginator = s3_client.get_paginator('list_objects_v2')

        for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
            if 'Contents' in page:
                for obj in page['Contents']:
                    key = obj['Key']

                    # Находим все папки в пути
                    parts = key.split('/')
                    current_path = ''

                    # Для каждой части пути (кроме последней для файлов)
                    for i in range(len(parts)):
                        if i < len(parts) - 1 or key.endswith('/'):
                            current_path = '/'.join(parts[:i+1])
                            if not current_path.endswith('/'):
                                current_path += '/'

                            # Добавляем папку если она еще не добавлена
                            if current_path not in seen_folders:
                                folder_name = parts[i] if parts[i] else ''
                                all_folders.append({
                                    'name': folder_name,
                                    'path': current_path,
                                    'full_path': current_path
                                })
                                seen_folders.add(current_path)

        log_info(f"Bucket: {bucket_id}, prefix: '/{prefix}', found {len(all_folders)} folders", context)

        return jsonify({
            'bucket': bucket_name,
            'bucket_id': bucket_id,
            'prefix': prefix,
            'folders': all_folders,
            'total_folders': len(all_folders)
        })

    except Exception as e:
        full_msg, status_code = _map_s3_runtime_error(e, bucket_id)
        if full_msg == _trf('error.unexpected'):
            full_msg = _trf('error.folders_list_failed')
        log_s3_exception(context, e, bucket_id)
        return jsonify({'error': full_msg}), status_code


def list_folder_files_recursive_impl():
    """Рекурсивно перечислить файлы внутри одной или нескольких папок (для bulk ACL)."""
    context = 'list_folder_files_recursive'
    try:
        data = request.get_json(silent=True) or {}
        bucket_id = (data.get('bucket') or '').strip()
        raw_prefixes = data.get('prefixes') or []

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

        if not isinstance(raw_prefixes, list) or not raw_prefixes:
            log_error('Folder prefixes are required', context)
            return jsonify({'error': _('error.object_path_required')}), 400

        if not role_edit_file_acl(bucket_id):
            log_warning('ACL folder files list denied', context)
            return jsonify({'error': _('error.acl_access_denied')}), 403

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            error_msg = f'Bucket with ID {bucket_id} not found in configuration'
            log_error(error_msg, context)
            return jsonify({'error': _('error.bucket_not_found')}), 404

        if not check_bucket_access(bucket_id):
            log_warning('Access to bucket denied', context)
            return jsonify({'error': _('error.access_denied')}), 403

        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        s3_client = get_s3_client(bucket_config)

        all_files = []
        seen_files = set()
        for raw_prefix in raw_prefixes:
            prefix = _normalize_s3_object_key(str(raw_prefix or '').strip())
            if not prefix:
                continue
            for file_path in _list_files_under_prefix(s3_client, bucket_name, prefix):
                if file_path not in seen_files:
                    seen_files.add(file_path)
                    all_files.append(file_path)

        log_info(
            f"Bucket: {bucket_id}, prefixes: {len(raw_prefixes)}, files: {len(all_files)}",
            context,
        )
        return jsonify({
            'bucket_id': bucket_id,
            'files': all_files,
            'total_files': len(all_files),
        })

    except Exception as e:
        full_msg, status_code = _map_s3_runtime_error(e, bucket_id if 'bucket_id' in locals() else '')
        if full_msg == _trf('error.unexpected'):
            full_msg = _trf('error.folders_list_failed')
        log_s3_exception(context, e, bucket_id if 'bucket_id' in locals() else '')
        return jsonify({'error': full_msg}), status_code



def upload_file_impl():
    """Загрузить файл(ы) в S3"""
    context = 'upload_objects'

    # Явная проверка размера тела запроса — гарантирует 413 вместо 500 при превышении лимита
    max_bytes = current_app.config.get('MAX_CONTENT_LENGTH')
    if max_bytes and request.content_length and request.content_length > max_bytes:
        return jsonify({'error': _('error.upload_too_large').replace('{max_mb}', str(_max_upload_mb())), 'max_mb': _max_upload_mb()}), 413

    try:
        job_id = (request.form.get('job_id') or '').strip()
        if job_id:
            if not operation_jobs.job_belongs_to_user(job_id, session.get('username', '')):
                return jsonify({'error': _('error.access_denied')}), 403
            job = operation_jobs.get_job(job_id)
            if not job or job.get('op') != 'upload':
                return jsonify({'error': _('error.unexpected')}), 404
            if 'file' not in request.files:
                return jsonify({'error': _('error.no_file_provided')}), 400
            file = request.files.get('file')
            if not file or file.filename == '':
                return jsonify({'error': _('error.no_file_provided')}), 400
            try:
                file_index = int(request.form.get('file_index', '-1'))
            except (TypeError, ValueError):
                return jsonify({'error': _('error.no_file_provided')}), 400
            if file_index < 0:
                return jsonify({'error': _('error.no_file_provided')}), 400

            meta = job.get('meta') or {}
            bucket_id = meta.get('bucket_id') or ''
            base_path = meta.get('path') or ''
            folder_upload = bool(meta.get('folder_upload'))
            username = session.get('username', 'unknown')

            if not bucket_id or not check_bucket_access(bucket_id):
                return jsonify({'error': _('error.access_denied')}), 403
            if folder_upload:
                if not role_upload_folder(bucket_id):
                    return jsonify({'error': _('error.access_denied')}), 403
            elif not role_upload_files(bucket_id):
                return jsonify({'error': _('error.access_denied')}), 403

            fd, temp_path = tempfile.mkstemp(prefix='s3fm-upload-')
            os.close(fd)
            try:
                file.save(temp_path)
            except Exception:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
                raise

            if not operation_jobs.register_upload_file_received(job_id, file_index, _finish_upload_job):
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
                return jsonify({'accepted': True, 'duplicate': True}), 202

            content_type = _guess_upload_content_type(file)
            threading.Thread(
                target=_run_upload_job_file,
                args=(
                    job_id,
                    file_index,
                    temp_path,
                    file.filename,
                    bucket_id,
                    base_path,
                    folder_upload,
                    username,
                    content_type,
                ),
                daemon=True,
            ).start()
            return jsonify({'accepted': True}), 202

        bucket_id = request.form.get('bucket', '')

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

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

        is_folder_upload = request.form.get('folder_upload') == '1'
        if is_folder_upload:
            if not role_upload_folder(bucket_id):
                return jsonify({'error': _('error.access_denied')}), 403
        elif not role_upload_files(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403

        if 'file' not in request.files:
            log_error('No file provided', context)
            return jsonify({'error': _('error.no_file_provided')}), 400

        files = request.files.getlist('file')
        path = request.form.get('path', '')

        if not files or all(file.filename == '' for file in files):
            log_error('No files selected', context)
            return jsonify({'error': _('error.no_files_selected')}), 400

        s3_client = get_s3_client(bucket_config)
        uploaded_files = []
        errors = []
        username = session.get('username', 'unknown')

        # log_info(f"Uploading {len(files)} file(s) to bucket {display_name}, path: '/{path}'", context)

        for file in files:
            if file.filename == '':
                continue

            try:
                # Формируем полный путь в S3
                if path and not path.endswith('/'):
                    path += '/'
                s3_key = path + file.filename

                log_info(f"Uploading file '{file.filename}' to {display_name}/{s3_key}", context)

                existing_head = None
                try:
                    existing_head = s3_client.head_object(Bucket=bucket_name, Key=s3_key)
                except ClientError as head_err:
                    head_code = head_err.response.get('Error', {}).get('Code', '')
                    if head_code not in ('404', 'NoSuchKey', 'NotFound'):
                        raise

                s3_client.upload_fileobj(
                    file,
                    bucket_name,
                    s3_key,
                    ExtraArgs={
                        'Metadata': _s3fm_upload_metadata(username, existing_head),
                        'ContentType': _guess_upload_content_type(file),
                    },
                )
                uploaded_files.append(file.filename)
                if meilisearch.is_enabled():
                    meilisearch.upsert_document(bucket_id, s3_key)

                log_info(f"File '{file.filename}' uploaded successfully", context)

            except ClientError as e:
                error_code = e.response['Error']['Code']
                error_message = e.response['Error']['Message']
                error_detail = f"{file.filename}: {error_code}"
                errors.append(error_detail)
                log_error(f"Failed to upload file '{file.filename}': {error_code} - {error_message}", context, e)
            except Exception as e:
                error_detail = f"{file.filename}: {str(e)[:100]}"
                errors.append(error_detail)
                log_error(f"Failed to upload file '{file.filename}'", context, e)

        if errors:
            if uploaded_files:
                result_msg = _trf('upload.partial', ok=len(uploaded_files), fail=len(errors))
                return jsonify({
                    'message': result_msg,
                    'uploaded_files': uploaded_files,
                    'errors': errors
                }), 207
            else:
                log_error('Failed to upload files', context)
                return jsonify({'error': _('error.upload_failed'), 'errors': errors}), 500
        else:
            result_msg = _trf('upload.success_count', count=len(uploaded_files))

            return jsonify({
                'message': result_msg,
                'uploaded_files': uploaded_files
            })

    except ClientError as e:
        log_name = display_name if 'display_name' in locals() else bucket_id
        error_msg, status_code = _map_s3_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code
    except Exception as e:
        log_error('Unexpected error', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500

def create_folder_impl():
    """Создать папку в S3"""
    context = 'create_folder'
    username = session.get('username', 'Неизвестный пользователь')

    try:
        data = request.get_json()
        bucket_id = data.get('bucket', '')
        folder_path = data.get('path', '')

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

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

        if not role_create_folder(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403

        if not folder_path:
            log_error('Folder path is required', context)
            return jsonify({'error': _('error.folder_path_required')}), 400

        # В S3 папки создаются путем добавления объекта с "/" в конце
        if not folder_path.endswith('/'):
            folder_path += '/'

        s3_client = get_s3_client(bucket_config)
        # Извлекаем имя папки из пути
        folder_path_clean = folder_path.rstrip('/')
        folder_name = folder_path_clean.split('/')[-1] if folder_path_clean else ''

        log_info(f"Creating folder '{folder_name}' in bucket {display_name}", context)

        # Проверяем, существует ли уже такая папка
        try:
            response = s3_client.list_objects_v2(
                Bucket=bucket_name,
                Prefix=folder_path,
                MaxKeys=1
            )

            if 'Contents' in response and len(response['Contents']) > 0:
                for obj in response['Contents']:
                    if obj['Key'] == folder_path:
                        error_msg = _trf('error.folder_exists_named', name=folder_name)
                        log_warning(trf_en('error.folder_exists_named', name=folder_name), context)
                        return jsonify({'error': error_msg}), 400

                error_msg = _trf('error.folder_not_empty_named', name=folder_name)
                log_warning(trf_en('error.folder_not_empty_named', name=folder_name), context)
                return jsonify({'error': error_msg}), 400

            response_with_delimiter = s3_client.list_objects_v2(
                Bucket=bucket_name,
                Prefix=folder_path.rstrip('/') + '/',
                Delimiter='/',
                MaxKeys=1
            )

            if 'CommonPrefixes' in response_with_delimiter and len(response_with_delimiter['CommonPrefixes']) > 0:
                error_msg = _trf('error.folder_exists_named', name=folder_name)
                log_warning(trf_en('error.folder_exists_named', name=folder_name), context)
                return jsonify({'error': error_msg}), 400

        except ClientError as e:
            log_warning('Error checking if folder exists', context)
            pass

        # Создаем папку
        s3_client.put_object(
            Bucket=bucket_name,
            Key=folder_path
        )

        log_info(f"Folder '{folder_name}' created successfully", context)
        if meilisearch.is_enabled():
            meilisearch.upsert_document(bucket_id, folder_path)

        log_user_action(username, context, f"Bucket: {display_name}, folder: {folder_name}, path: /{folder_path}")

        return jsonify({'message': _trf('msg.folder_created_named', name=folder_name)})

    except ClientError as e:
        log_name = display_name if 'display_name' in locals() else bucket_id
        error_msg, status_code = _map_s3_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code
    except Exception as e:
        log_error(trf_en('error.unexpected'), context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _trf('error.unexpected')}), 500


def copy_objects_impl():
    """Копировать файлы и папки (рекурсивно) в другой бакет или путь."""
    context = 'copy_objects'
    try:
        data = request.get_json() or {}
        job, err = _build_copy_job(data)
        if err:
            body = {'error': err[0]}
            if len(err) > 2 and err[2]:
                body.update(err[2])
            return jsonify(body), err[1]

        stream = bool(data.get('stream'))

        if stream:
            raw_names = data.get('display_names')
            if not isinstance(raw_names, list):
                raw_names = _display_names_from_items(data.get('items'))
            display_names = [str(n) for n in raw_names]
            job_id = operation_jobs.create_job(
                job['username'], 'copy', {'display_names': display_names},
            )

            def worker():
                try:
                    cancel_check = lambda: operation_jobs.is_cancel_requested(job_id)
                    for event in _iter_copy_events(job, context, cancel_check=cancel_check):
                        operation_jobs.publish(job_id, event)
                        if event.get('type') == 'done':
                            copied_total = event.get('copied', 0)
                            log_user_action(
                                job['username'], context,
                                f"Copy from {job['src_display']} to {job['dst_display']}, "
                                f"dst_path=/{job['dst_path']}, objects={copied_total}",
                            )
                            break
                        if event.get('type') == 'cancelled':
                            break
                except Exception as e:
                    log_error('Unexpected copy job error', context, e, LOG_CONFIG['show_traceback'])
                    operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})

            operation_jobs.start_worker(job_id, worker)
            return jsonify({'job_id': job_id, 'op': 'copy'}), 202

        copied_total = 0
        errors = []
        done_message = ''
        for event in _iter_copy_events(job, context):
            if event.get('type') == 'done':
                copied_total = event.get('copied', 0)
                errors = event.get('errors', [])
                done_message = event.get('message', '')

        if copied_total == 0 and errors:
            return jsonify({'error': errors[0], 'errors': errors}), 400

        log_user_action(
            job['username'], context,
            f"Copy from {job['src_display']} to {job['dst_display']}, "
            f"dst_path=/{job['dst_path']}, objects={copied_total}",
        )
        return jsonify({
            'message': done_message or _trf('msg.copy_completed', count=copied_total),
            'copied': copied_total,
            'errors': errors,
        })
    except Exception as e:
        log_error('Unexpected copy error', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def move_objects_impl():
    """Переместить файлы и папки (копирование + удаление источника)."""
    context = 'move_objects'
    try:
        data = request.get_json() or {}
        job, err = _build_move_job(data)
        if err:
            body = {'error': err[0]}
            if len(err) > 2 and err[2]:
                body.update(err[2])
            return jsonify(body), err[1]

        stream = bool(data.get('stream'))

        if stream:
            raw_names = data.get('display_names')
            if not isinstance(raw_names, list):
                raw_names = _display_names_from_items(data.get('items'))
            display_names = [str(n) for n in raw_names]
            job_id = operation_jobs.create_job(
                job['username'], 'move', {'display_names': display_names},
            )

            def worker():
                try:
                    cancel_check = lambda: operation_jobs.is_cancel_requested(job_id)
                    for event in _iter_move_events(job, context, cancel_check=cancel_check):
                        operation_jobs.publish(job_id, event)
                        if event.get('type') == 'done':
                            moved_total = event.get('moved', 0)
                            log_user_action(
                                job['username'], context,
                                f"Move from {job['src_display']} to {job['dst_display']}, "
                                f"dst_path=/{job['dst_path']}, objects={moved_total}",
                            )
                            break
                        if event.get('type') == 'cancelled':
                            break
                except Exception as e:
                    log_error('Unexpected move job error', context, e, LOG_CONFIG['show_traceback'])
                    operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})

            operation_jobs.start_worker(job_id, worker)
            return jsonify({'job_id': job_id, 'op': 'move'}), 202

        moved_total = 0
        errors = []
        done_message = ''
        for event in _iter_move_events(job, context):
            if event.get('type') == 'done':
                moved_total = event.get('moved', 0)
                errors = event.get('errors', [])
                done_message = event.get('message', '')

        if moved_total == 0 and errors:
            return jsonify({'error': errors[0], 'errors': errors}), 400

        log_user_action(
            job['username'], context,
            f"Move from {job['src_display']} to {job['dst_display']}, "
            f"dst_path=/{job['dst_path']}, objects={moved_total}",
        )
        return jsonify({
            'message': done_message or _trf('msg.move_completed', count=moved_total),
            'moved': moved_total,
            'errors': errors,
        })
    except Exception as e:
        log_error('Unexpected move error', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def delete_objects_batch_impl():
    """Пакетное удаление в фоне (прогресс через SSE)."""
    context = 'delete_objects'
    try:
        data = request.get_json() or {}
        batch_job, err = _build_delete_batch_job(data)
        if err:
            body = {'error': err[0]}
            if len(err) > 2 and err[2]:
                body.update(err[2])
            return jsonify(body), err[1]

        raw_names = data.get('display_names')
        if not isinstance(raw_names, list):
            raw_names = _display_names_from_items(batch_job['items'])
        display_names = [str(n) for n in raw_names]
        job_id = operation_jobs.create_job(
            batch_job['username'], 'delete', {'display_names': display_names},
        )

        def worker():
            try:
                cancel_check = lambda: operation_jobs.is_cancel_requested(job_id)
                for event in _iter_delete_batch_events(batch_job, context, cancel_check=cancel_check):
                    operation_jobs.publish(job_id, event)
                    if event.get('type') == 'done':
                        log_user_action(
                            batch_job['username'], context,
                            f"Batch delete in {batch_job['display_name']}, "
                            f"items={len(batch_job['items'])}, deleted={event.get('deleted', 0)}",
                        )
                        break
                    if event.get('type') == 'cancelled':
                        break
            except Exception as e:
                log_error('Unexpected delete job error', context, e, LOG_CONFIG['show_traceback'])
                operation_jobs.publish(job_id, {'type': 'error', 'error': _('error.unexpected')})

        operation_jobs.start_worker(job_id, worker)
        return jsonify({'job_id': job_id, 'op': 'delete'}), 202
    except Exception as e:
        log_error('Unexpected delete batch error', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def create_upload_job_impl():
    """Создать фоновую задачу пакетной загрузки."""
    try:
        data = request.get_json() or {}
        bucket_id = (data.get('bucket') or '').strip()
        path = data.get('path') if data.get('path') is not None else ''
        folder_upload = bool(data.get('folder_upload'))
        display_names = data.get('display_names') or []
        if not isinstance(display_names, list):
            display_names = []
        display_names = [str(n) for n in display_names]
        total = int(data.get('total') or len(display_names) or 0)

        if not bucket_id:
            return jsonify({'error': _('error.bucket_id_required')}), 400
        if total <= 0:
            return jsonify({'error': _('error.no_files_selected')}), 400

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            return jsonify({'error': _('error.bucket_not_found')}), 404
        if not check_bucket_access(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403
        if folder_upload:
            if not role_upload_folder(bucket_id):
                return jsonify({'error': _('error.access_denied')}), 403
        elif not role_upload_files(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403

        job_id = operation_jobs.create_job(
            session.get('username', 'unknown'),
            'upload',
            {
                'display_names': display_names,
                'bucket_id': bucket_id,
                'path': path,
                'folder_upload': folder_upload,
            },
        )
        operation_jobs.init_upload_state(job_id, total, display_names)
        operation_jobs.mark_running(job_id)
        operation_jobs.publish(job_id, {
            'type': 'start',
            'total': total,
            'item_count': total,
        })
        return jsonify({'job_id': job_id, 'op': 'upload'}), 202
    except Exception as e:
        log_error('Create upload job failed', 'upload_objects', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


def seal_upload_job_impl(job_id):
    """Сообщить серверу, что клиент закончил отправку файлов."""
    if not operation_jobs.job_belongs_to_user(job_id, session.get('username', '')):
        return jsonify({'error': _('error.access_denied')}), 403
    operation_jobs.seal_upload_job(job_id)
    _finish_upload_job(job_id)
    return jsonify({'ok': True})


def delete_object_impl():
    """Удалить файл или папку"""
    context = 'delete_objects'

    try:
        data = request.get_json()
        bucket_id = data.get('bucket', '')
        object_path = data.get('path', '')

        if not bucket_id:
            log_error('Bucket ID is required', context)
            return jsonify({'error': _('error.bucket_id_required')}), 400

        if not object_path:
            log_error('Object path is required', context)
            return jsonify({'error': _('error.object_path_required')}), 400

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

        is_folder = object_path.endswith('/')
        if is_folder and not role_delete_folder(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403
        if not is_folder and not role_delete_file(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403

        # log_info(f"Deleting object from bucket {display_name}: {object_path}", context)

        s3_client = get_s3_client(bucket_config)

        # Если это папка, нужно удалить все объекты внутри
        if is_folder:
            objects_to_delete = []
            paginator = s3_client.get_paginator('list_objects_v2')

            for page in paginator.paginate(Bucket=bucket_name, Prefix=object_path):
                if 'Contents' in page:
                    for obj in page['Contents']:
                        objects_to_delete.append({'Key': obj['Key']})

            log_info(f"Folder contains {len(objects_to_delete)} objects to delete", context)

            if objects_to_delete:
                max_batch_size = 1000
                deleted_count = 0

                for i in range(0, len(objects_to_delete), max_batch_size):
                    batch = objects_to_delete[i:i + max_batch_size]
                    log_info(f"Deleting batch {i//max_batch_size + 1}, size: {len(batch)}", context)

                    try:
                        response = s3_client.delete_objects(
                            Bucket=bucket_name,
                            Delete={'Objects': batch}
                        )
                        deleted_count += len(batch)

                        if 'Errors' in response and response['Errors']:
                            for error in response['Errors']:
                                log_error(f"Failed to delete object: {error.get('Key')}", context)

                    except ClientError as e:
                        log_error("Failed to delete batch", context, e)
                        continue

                log_info(f"Successfully deleted {deleted_count} objects", context)
                if meilisearch.is_enabled():
                    meilisearch.remove_by_path_prefix(bucket_id, object_path)

                return jsonify({'message': _trf('msg.folder_deleted_with_count', path=object_path, count=deleted_count)})
            else:
                log_info("No objects in folder, deleting folder marker", context)
                s3_client.delete_object(
                    Bucket=bucket_name,
                    Key=object_path
                )
                log_info("Folder marker deleted successfully", context)
                if meilisearch.is_enabled():
                    meilisearch.remove_document(bucket_id, object_path)

                return jsonify({'message': _trf('msg.folder_deleted', path=object_path)})
        else:
            log_info(f"Deleting file: {display_name}/{object_path}", context)
            s3_client.delete_object(
                Bucket=bucket_name,
                Key=object_path
            )
            log_info("File deleted successfully", context)
            if meilisearch.is_enabled():
                meilisearch.remove_document(bucket_id, object_path)

        return jsonify({'message': _trf('msg.object_deleted_from', path=object_path, name=display_name)})

    except ClientError as e:
        error_code = e.response['Error']['Code']
        log_name = display_name if 'display_name' in locals() else bucket_id
        if error_code == 'MalformedXML':
            error_msg = _trf('error.s3_malformed_xml')
            log_error(trf_en('error.s3_malformed_xml'), context, e)
            return jsonify({'error': error_msg}), 500
        if error_code == 'NoSuchKey':
            error_msg = _trf('error.s3_object_not_found', path=object_path)
            log_error(trf_en('error.s3_object_not_found', path=object_path), context, e)
            return jsonify({'error': error_msg}), 404
        error_msg, status_code = _map_s3_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code

    except Exception as e:
        log_error("Unexpected error", context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500

