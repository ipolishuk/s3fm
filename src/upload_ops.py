"""Upload metadata helpers and background upload job workers."""

from __future__ import annotations

import mimetypes
import os
from datetime import datetime, timezone

from botocore.exceptions import ClientError

from bucket_access import find_bucket_config_by_bucket_id
from logs import LOG_CONFIG, log_error
import meilisearch
import operation_jobs
from s3_client import get_s3_client as _get_s3_client


_S3FM_META_CREATED_AT = 's3fm-created-at'
_S3FM_META_CREATED_BY = 's3fm-created-by'
_S3FM_META_MODIFIED_BY = 's3fm-modified-by'


def _s3fm_meta_from_head(head: dict) -> dict:
    """Пользовательские метаданные объекта S3 (загрузка / изменение через s3-file-manager)."""
    md = head.get('Metadata') or {}
    created_at = (md.get(_S3FM_META_CREATED_AT) or '').strip() or None
    created_by = (md.get(_S3FM_META_CREATED_BY) or '').strip() or None
    modified_by = (md.get(_S3FM_META_MODIFIED_BY) or '').strip() or None
    actor = modified_by or created_by
    return {
        'created_at': created_at,
        'created_by': created_by,
        'modified_by': modified_by,
        'actor': actor,
    }


def _s3fm_upload_metadata(username, existing_head=None):
    username = (username or '').strip() or 'unknown'
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    existing = _s3fm_meta_from_head(existing_head) if existing_head else {}
    if existing.get('created_at'):
        return {
            _S3FM_META_CREATED_AT: existing['created_at'],
            _S3FM_META_CREATED_BY: existing.get('created_by') or username,
            _S3FM_META_MODIFIED_BY: username,
        }
    return {
        _S3FM_META_CREATED_AT: now,
        _S3FM_META_CREATED_BY: username,
        _S3FM_META_MODIFIED_BY: username,
    }


def _guess_upload_content_type(file_storage):
    """Content-Type для S3 PutObject: multipart Content-Type или mimetypes по имени файла."""
    raw = (getattr(file_storage, 'content_type', None) or '').strip()
    base = raw.split(';', 1)[0].strip().lower() if raw else ''
    if base and base not in ('application/octet-stream', 'binary/octet-stream'):
        return raw

    name = (getattr(file_storage, 'filename', None) or '').strip()
    guessed, encoding = mimetypes.guess_type(name, strict=False)
    if guessed:
        if encoding and encoding.lower() not in ('binary', '7bit', '8bit'):
            return f'{guessed}; charset={encoding}'
        return guessed
    return raw or 'application/octet-stream'


def _finish_upload_job(job_id):
    state = operation_jobs.get_upload_state(job_id)
    if not state:
        return
    if int(state.get('processing') or 0) > 0:
        return
    job = operation_jobs.get_job(job_id)
    if job and job.get('status') in ('done', 'error'):
        return
    successful = int(state.get('successful') or 0)
    failed = int(state.get('failed') or 0)
    total = int(state.get('total') or 0)
    operation_jobs.publish(job_id, {
        'type': 'done',
        'uploaded': successful,
        'failed': failed,
        'total': total,
    })


def _upload_bytes_to_s3(
    s3_client,
    bucket_name,
    bucket_id,
    s3_key,
    file_obj,
    username,
    content_type=None,
):
    existing_head = None
    try:
        existing_head = s3_client.head_object(Bucket=bucket_name, Key=s3_key)
    except ClientError as head_err:
        head_code = head_err.response.get('Error', {}).get('Code', '')
        if head_code not in ('404', 'NoSuchKey', 'NotFound'):
            raise

    extra = {
        'Metadata': _s3fm_upload_metadata(username, existing_head),
    }
    if content_type:
        extra['ContentType'] = content_type

    s3_client.upload_fileobj(file_obj, bucket_name, s3_key, ExtraArgs=extra)
    if meilisearch.is_enabled():
        meilisearch.upsert_document(bucket_id, s3_key)


def _run_upload_job_file(
    job_id,
    file_index,
    temp_path,
    filename,
    bucket_id,
    base_path,
    folder_upload,
    username,
    content_type=None,
):
    operation_jobs.upload_processing_started(job_id)
    if operation_jobs.is_cancel_requested(job_id):
        operation_jobs.publish(job_id, {'type': 'item_done', 'index': file_index, 'success': False})
        operation_jobs.upload_processing_finished(job_id, False, _finish_upload_job)
        return
    operation_jobs.publish(job_id, {'type': 'item_start', 'index': file_index})
    success = False
    try:
        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            raise RuntimeError('bucket_not_found')
        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        s3_client = _get_s3_client(bucket_config)

        path = base_path or ''
        if path and not path.endswith('/'):
            path += '/'
        s3_key = path + filename

        with open(temp_path, 'rb') as fh:
            _upload_bytes_to_s3(
                s3_client, bucket_name, bucket_id, s3_key, fh, username, content_type,
            )
        success = True
    except Exception as e:
        log_error(f'Upload job file failed: {filename}', 'upload_objects', e, LOG_CONFIG['show_traceback'])
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        operation_jobs.publish(job_id, {
            'type': 'item_done',
            'index': file_index,
            'success': success,
        })
        state = operation_jobs.get_upload_state(job_id)
        if state:
            completed = int(state.get('completed') or 0) + 1
            total = int(state.get('total') or 0)
            operation_jobs.publish(job_id, {
                'type': 'progress',
                'current': completed,
                'total': total,
            })
        operation_jobs.upload_processing_finished(job_id, success, _finish_upload_job)


