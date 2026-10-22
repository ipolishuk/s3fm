"""Сборка ZIP-архива для скачивания (выполняется на operation worker)."""

from __future__ import annotations

import os
import tempfile
import threading
import time
import zipfile
from typing import Any, Callable, Dict, Iterator, List, Optional

from botocore.exceptions import ClientError

from bucket_access import normalize_s3_object_key
from logs import log_error, log_info, log_user_action
from s3_client import _content_disposition, get_s3_client
from translations import _


class ZipLimitExceeded(Exception):
    def __init__(self, key: str):
        self.key = key


def _zip_limits():
    zip_max_bytes = int(os.environ.get('ZIP_MAX_BYTES', str(512 * 1024 * 1024)))
    zip_max_files = int(os.environ.get('ZIP_MAX_FILES', '5000'))
    return zip_max_bytes, zip_max_files


def _presign_expires_sec() -> int:
    try:
        return max(0, int(os.environ.get('DOWNLOAD_PRESIGN_EXPIRES_SEC', '3600')))
    except (TypeError, ValueError):
        return 3600


def _staging_prefix() -> str:
    raw = (os.environ.get('DOWNLOAD_STAGING_PREFIX') or '.s3fm-downloads/').strip()
    if not raw:
        raw = '.s3fm-downloads/'
    return raw if raw.endswith('/') else raw + '/'


def generate_object_presigned_url(
    s3_client,
    bucket_name: str,
    key: str,
    *,
    filename: str,
    disposition: str = 'attachment',
    expires_in: Optional[int] = None,
) -> str:
    """Подписанный GET URL объекта (браузер качает напрямую с S3)."""
    ttl = _presign_expires_sec() if expires_in is None else int(expires_in)
    if ttl <= 0:
        raise ValueError('presign_disabled')
    params = {
        'Bucket': bucket_name,
        'Key': key,
        'ResponseContentDisposition': _content_disposition(filename, disposition),
    }
    return s3_client.generate_presigned_url('get_object', Params=params, ExpiresIn=ttl)


def _schedule_staging_delete(s3_client, bucket_name: str, key: str, delay_sec: int) -> None:
    delay = max(60, int(delay_sec))

    def _run():
        time.sleep(delay)
        try:
            s3_client.delete_object(Bucket=bucket_name, Key=key)
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name='s3fm-download-staging-cleanup').start()


def build_download_archive_to_temp(
    *,
    s3_client,
    bucket_name: str,
    paths: List[str],
    folders: List[str],
    parent_folder: str,
    base_path: str,
    cancel_check: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, Any]:
    """Собрать ZIP во временный файл. Возвращает {tmp, file_count, total_bytes}."""
    zip_max_bytes, zip_max_files = _zip_limits()
    seen_names: set = set()
    total_bytes = [0]
    file_count = [0]
    parent = (parent_folder or 'archive').strip().rstrip('/') or 'archive'
    base = (base_path or '').strip().rstrip('/')
    last_progress_at = [0.0]

    def _account_bytes(n: int) -> None:
        total_bytes[0] += n
        if zip_max_bytes > 0 and total_bytes[0] > zip_max_bytes:
            raise ZipLimitExceeded('error.zip_too_large')

    def _emit_progress() -> None:
        if not on_progress:
            return
        now = time.time()
        if last_progress_at[0] and (now - last_progress_at[0]) < 1.0:
            return
        last_progress_at[0] = now
        on_progress(file_count[0], total_bytes[0])

    def add_to_zip(zf, s3_key: str, name_in_zip: str) -> bool:
        if cancel_check and cancel_check():
            raise InterruptedError('cancelled')
        if name_in_zip in seen_names:
            name_in_zip = parent + '/' + s3_key.replace('/', '_')
        seen_names.add(name_in_zip)
        file_count[0] += 1
        if zip_max_files > 0 and file_count[0] > zip_max_files:
            raise ZipLimitExceeded('error.zip_too_many_files')
        try:
            resp = s3_client.get_object(Bucket=bucket_name, Key=s3_key)
            body = resp['Body']
            info = zipfile.ZipInfo(name_in_zip)
            info.compress_type = zipfile.ZIP_DEFLATED
            with zf.open(info, 'w') as dest:
                while True:
                    if cancel_check and cancel_check():
                        raise InterruptedError('cancelled')
                    chunk = body.read(256 * 1024)
                    if not chunk:
                        break
                    _account_bytes(len(chunk))
                    dest.write(chunk)
            _emit_progress()
            return True
        except ClientError:
            return False

    tmp = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for s3_key in paths or []:
                if not s3_key or not isinstance(s3_key, str):
                    continue
                s3_key = normalize_s3_object_key(s3_key)
                if not s3_key:
                    continue
                name_in_zip = s3_key.split('/')[-1] if '/' in s3_key else s3_key
                add_to_zip(zf, s3_key, parent + '/' + name_in_zip)
            for folder_path in list(folders or []):
                if not folder_path or not isinstance(folder_path, str):
                    continue
                folder_path = normalize_s3_object_key(folder_path)
                if not folder_path:
                    continue
                prefix = folder_path.rstrip('/') + '/'
                folder_stripped = folder_path.rstrip('/')
                if base and folder_stripped.startswith(base + '/'):
                    folder_rel = folder_stripped[len(base) + 1:]
                elif base and folder_stripped == base:
                    folder_rel = ''
                else:
                    folder_rel = folder_stripped
                paginator = s3_client.get_paginator('list_objects_v2')
                for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
                    for obj in page.get('Contents') or []:
                        key = obj['Key']
                        if key.endswith('/'):
                            continue
                        rel_name = key[len(prefix):]
                        if not rel_name:
                            continue
                        if folder_rel:
                            name_in_zip = parent + '/' + folder_rel + '/' + rel_name
                        else:
                            name_in_zip = parent + '/' + rel_name
                        add_to_zip(zf, key, name_in_zip)
        tmp.seek(0)
        return {
            'tmp': tmp,
            'file_count': file_count[0],
            'total_bytes': total_bytes[0],
        }
    except Exception:
        try:
            tmp.close()
        except Exception:
            pass
        raise


def iter_download_archive_events(
    job: Dict[str, Any],
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Iterator[Dict[str, Any]]:
    """Собрать ZIP на worker, залить в staging-префикс, отдать presigned URL."""
    from worker_jobs import JobCancelled

    bucket_name = job.get('bucket_name') or ''
    display_name = job.get('display_name') or job.get('bucket_id') or ''
    username = job.get('username') or 'unknown'
    paths = list(job.get('paths') or [])
    folders = list(job.get('folders') or [])
    parent_folder = job.get('parent_folder') or 'archive'
    base_path = job.get('base_path') or ''
    job_id = job.get('job_id') or 'archive'
    s3_client = job.get('s3_client')
    if not s3_client:
        cfg = job.get('bucket_config')
        if not cfg:
            yield {'type': 'error', 'error': _('error.unexpected')}
            return
        s3_client = get_s3_client(cfg)

    yield {'type': 'start', 'total': 0, 'total_pending': True}

    def _progress(count: int, size_bytes: int) -> None:
        event = {
            'type': 'progress',
            'current': count,
            'total_pending': True,
            'size': size_bytes,
        }
        if on_progress:
            on_progress(event)

    tmp = None
    try:
        if cancel_check and cancel_check():
            raise JobCancelled()

        built = build_download_archive_to_temp(
            s3_client=s3_client,
            bucket_name=bucket_name,
            paths=paths,
            folders=folders,
            parent_folder=parent_folder,
            base_path=base_path,
            cancel_check=cancel_check,
            on_progress=_progress,
        )

        tmp = built['tmp']
        file_count = int(built['file_count'] or 0)
        total_bytes = int(built['total_bytes'] or 0)

        if file_count <= 0:
            yield {'type': 'error', 'error': _('download.no_files')}
            return

        if cancel_check and cancel_check():
            raise JobCancelled()

        staging_key = f'{_staging_prefix()}{job_id}/archive.zip'
        log_info(
            f'Uploading download archive to staging key={staging_key} '
            f'files={file_count} bytes={total_bytes}',
            'download_archive',
            username=username,
        )
        tmp.seek(0)
        s3_client.upload_fileobj(
            tmp,
            bucket_name,
            staging_key,
            ExtraArgs={'ContentType': 'application/zip'},
        )

        # Same-origin /files/download-job/<id> — работает и при private S3.
        # Presign в браузер — только если endpoint публичный (см. stream_ops).
        expires = _presign_expires_sec() or 3600
        _schedule_staging_delete(s3_client, bucket_name, staging_key, expires + 300)

        import operation_jobs
        operation_jobs.update_job_meta(job_id, {
            'staging_key': staging_key,
            'staging_bucket': bucket_name,
            'filename': 'archive.zip',
            'size': total_bytes,
            'file_count': file_count,
        })

        log_user_action(
            username,
            'download_archive',
            f"Bucket: {display_name}, archive: {file_count} files, "
            f"{len(folders)} folders, {total_bytes} bytes",
        )
        yield {
            'type': 'done',
            'total': file_count,
            'current': file_count,
            'downloaded': file_count,
            'download_url': f'/files/download-job/{job_id}',
            'filename': 'archive.zip',
            'size': total_bytes,
        }
    except JobCancelled:
        yield {'type': 'cancelled'}
    except InterruptedError:
        yield {'type': 'cancelled'}
    except ZipLimitExceeded as zle:
        yield {'type': 'error', 'error': _(zle.key)}
    except Exception as exc:
        log_error('Archive creation failed', 'download_archive', exc)
        yield {'type': 'error', 'error': _('error.unexpected')}
    finally:
        if tmp is not None:
            try:
                tmp.close()
            except Exception:
                pass
