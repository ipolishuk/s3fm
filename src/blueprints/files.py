"""File operation routes (download/preview/archive + list/mutations)."""

from __future__ import annotations

import os
import tempfile
import zipfile

from botocore.exceptions import ClientError
from flask import Blueprint, jsonify, request, send_file, session

from auth_session import login_required
from bucket_access import (
    check_bucket_access,
    find_bucket_config_by_bucket_id,
    normalize_s3_object_key,
)
from files_api import (
    copy_objects_impl,
    create_folder_impl,
    create_upload_job_impl,
    delete_object_impl,
    delete_objects_batch_impl,
    file_metadata_acl_batch_impl,
    file_metadata_acl_capability_impl,
    file_metadata_acl_read_impl,
    file_metadata_acl_update_impl,
    file_metadata_impl,
    list_all_folders_impl,
    list_files_impl,
    list_folder_files_recursive_impl,
    list_selection_items_impl,
    move_objects_impl,
    seal_upload_job_impl,
    upload_file_impl,
)
from logs import LOG_CONFIG, log_error, log_user_action
from roles import (
    role_download_file,
    role_download_files_multi,
    role_download_folder,
)
from s3_client import get_s3_client
from stream_ops import stream_s3_object_response as _stream_s3_object_response
from translations import _

bp = Blueprint('files', __name__)


@bp.route('/files/download/<bucket_id>/<path:file_path>')
@login_required
def download_file(bucket_id, file_path):
    """Скачать файл из S3."""
    return _stream_s3_object_response(
        bucket_id, file_path, disposition='attachment', context='download',
    )


@bp.route('/files/view/<bucket_id>/<path:file_path>')
@login_required
def view_file(bucket_id, file_path):
    """Inline-предпросмотр из S3."""
    return _stream_s3_object_response(
        bucket_id, file_path, disposition='inline', context='preview',
    )


@bp.route('/files/download-archive', methods=['POST'])
@login_required
def download_archive():
    """Скачать несколько файлов из S3 одним ZIP (stream + лимиты размера)."""
    context = 'download_archive'
    username = session.get('username', 'Неизвестный пользователь')
    zip_max_bytes = int(os.environ.get('ZIP_MAX_BYTES', str(512 * 1024 * 1024)))
    zip_max_files = int(os.environ.get('ZIP_MAX_FILES', '5000'))

    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': _('error.bucket_id_required')}), 400
        bucket_id = data.get('bucket', '')
        paths = data.get('paths', []) or []
        folders_raw = data.get('folders', []) or []
        if not bucket_id:
            return jsonify({'error': _('error.bucket_id_required')}), 400
        if not isinstance(paths, list):
            paths = []
        if isinstance(folders_raw, str):
            folders = [folders_raw] if folders_raw.strip() else []
        elif isinstance(folders_raw, list):
            folders = [str(f).strip() for f in folders_raw if f and (isinstance(f, str) and f.strip())]
        else:
            folders = []
        if not paths and not folders:
            return jsonify({'error': _('download.no_files')}), 400

        parent_folder = (data.get('parent_folder') or 'archive').strip().rstrip('/')
        if not parent_folder:
            parent_folder = 'archive'
        base_path = (data.get('base_path') or '').strip().rstrip('/')

        bucket_info = find_bucket_config_by_bucket_id(bucket_id)
        if not bucket_info:
            return jsonify({'error': _('error.bucket_not_found')}), 404
        bucket_config = bucket_info['bucket_config']
        bucket_name = bucket_config.get('bucket_name')
        display_name = bucket_info['display_name']
        if not check_bucket_access(bucket_id):
            return jsonify({'error': _('error.access_denied')}), 403

        if folders:
            if not role_download_folder(bucket_id):
                return jsonify({'error': _('error.access_denied')}), 403

        if paths:
            if len(paths) > 1:
                if not role_download_files_multi(bucket_id):
                    return jsonify({'error': _('error.access_denied')}), 403
            elif not (role_download_file(bucket_id) or role_download_files_multi(bucket_id)):
                return jsonify({'error': _('error.access_denied')}), 403

        s3_client = get_s3_client(bucket_config)
        seen_names = set()
        total_bytes = [0]
        file_count = [0]

        class ZipLimitExceeded(Exception):
            def __init__(self, key):
                self.key = key

        def _account_bytes(n):
            total_bytes[0] += n
            if zip_max_bytes > 0 and total_bytes[0] > zip_max_bytes:
                raise ZipLimitExceeded('error.zip_too_large')

        def add_to_zip(zf, s3_key, name_in_zip, root=parent_folder):
            if name_in_zip in seen_names:
                name_in_zip = root + '/' + s3_key.replace('/', '_')
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
                        chunk = body.read(256 * 1024)
                        if not chunk:
                            break
                        _account_bytes(len(chunk))
                        dest.write(chunk)
                return True
            except ClientError:
                return False

        tmp = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        try:
            with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                for s3_key in paths:
                    if not s3_key or not isinstance(s3_key, str):
                        continue
                    s3_key = normalize_s3_object_key(s3_key)
                    if not s3_key:
                        continue
                    name_in_zip = s3_key.split('/')[-1] if '/' in s3_key else s3_key
                    add_to_zip(zf, s3_key, parent_folder + '/' + name_in_zip)
                for folder_path in list(folders):
                    if not folder_path or not isinstance(folder_path, str):
                        continue
                    folder_path = normalize_s3_object_key(folder_path)
                    if not folder_path:
                        continue
                    prefix = folder_path.rstrip('/') + '/'
                    folder_stripped = folder_path.rstrip('/')
                    if base_path and folder_stripped.startswith(base_path + '/'):
                        folder_rel = folder_stripped[len(base_path) + 1:]
                    elif base_path and folder_stripped == base_path:
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
                                name_in_zip = parent_folder + '/' + folder_rel + '/' + rel_name
                            else:
                                name_in_zip = parent_folder + '/' + rel_name
                            add_to_zip(zf, key, name_in_zip)

            tmp.seek(0)
            log_user_action(
                username,
                context,
                f"Bucket: {display_name}, archive: {file_count[0]} files, "
                f"{len(folders)} folders, {total_bytes[0]} bytes",
            )
            return send_file(
                tmp,
                mimetype='application/zip',
                as_attachment=True,
                download_name='archive.zip',
            )
        except ZipLimitExceeded as zle:
            try:
                tmp.close()
            except Exception:
                pass
            return jsonify({'error': _(zle.key)}), 413
    except Exception as e:
        log_error('Archive creation failed', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


@bp.route('/files/operation-jobs/active', methods=['GET'])
@login_required
def operation_jobs_active():
    """Активные фоновые задачи текущего пользователя (reconnect после refresh)."""
    import operation_jobs
    username = session.get('username', '')
    items = operation_jobs.list_jobs_for_user(username, active_only=True)
    return jsonify({'items': items})


@bp.route('/files/operation-jobs/<job_id>/cancel', methods=['POST'])
@login_required
def operation_jobs_cancel(job_id):
    """Запросить отмену фоновой задачи."""
    import operation_jobs
    if not operation_jobs.job_belongs_to_user(job_id, session.get('username', '')):
        return jsonify({'error': _('error.access_denied')}), 403
    if not operation_jobs.get_job(job_id):
        return jsonify({'error': _('error.unexpected')}), 404
    if not operation_jobs.request_cancel(job_id):
        return jsonify({'error': _('progress.cancel_not_available')}), 400
    return jsonify({'ok': True, 'cancel_requested': True})


@bp.route('/files/operation-jobs/<job_id>/events', methods=['GET'])
@login_required
def operation_jobs_events(job_id):
    """SSE: прогресс фоновой задачи upload/delete/copy/move."""
    import operation_jobs
    from file_ops import _operation_job_sse_response
    if not operation_jobs.job_belongs_to_user(job_id, session.get('username', '')):
        return jsonify({'error': _('error.access_denied')}), 403
    if not operation_jobs.get_job(job_id):
        return jsonify({'error': _('error.unexpected')}), 404
    return _operation_job_sse_response(job_id)


# --- Mutation / list / metadata routes ---

@bp.route('/files/upload', methods=['POST'])
@login_required
def upload_file():
    return upload_file_impl()


@bp.route('/files/create-folder', methods=['POST'])
@login_required
def create_folder():
    return create_folder_impl()


@bp.route('/files/copy', methods=['POST'])
@login_required
def copy_objects():
    return copy_objects_impl()


@bp.route('/files/move', methods=['POST'])
@login_required
def move_objects():
    return move_objects_impl()


@bp.route('/files/delete-batch', methods=['POST'])
@login_required
def delete_objects_batch():
    return delete_objects_batch_impl()


@bp.route('/files/upload-jobs', methods=['POST'])
@login_required
def create_upload_job():
    return create_upload_job_impl()


@bp.route('/files/upload-jobs/<job_id>/seal', methods=['POST'])
@login_required
def seal_upload_job(job_id):
    return seal_upload_job_impl(job_id)


@bp.route('/files/delete', methods=['DELETE'])
@login_required
def delete_object():
    return delete_object_impl()


@bp.route('/files', methods=['GET'])
@login_required
def list_files():
    return list_files_impl()


@bp.route('/api/files/selection-items', methods=['GET'])
@login_required
def list_selection_items():
    return list_selection_items_impl()


@bp.route('/api/files/metadata', methods=['GET'])
@login_required
def file_metadata():
    return file_metadata_impl()


@bp.route('/api/files/metadata/acl', methods=['GET'])
@login_required
def file_metadata_acl_read():
    return file_metadata_acl_read_impl()


@bp.route('/api/files/metadata/acl-capability', methods=['GET'])
@login_required
def file_metadata_acl_capability():
    return file_metadata_acl_capability_impl()


@bp.route('/api/files/metadata/acl', methods=['PUT'])
@login_required
def file_metadata_acl_update():
    return file_metadata_acl_update_impl()


@bp.route('/api/files/metadata/acl-batch', methods=['POST'])
@login_required
def file_metadata_acl_batch():
    return file_metadata_acl_batch_impl()


@bp.route('/api/folders', methods=['GET'])
@login_required
def list_all_folders():
    return list_all_folders_impl()


@bp.route('/api/folders/files', methods=['POST'])
@login_required
def list_folder_files_recursive():
    return list_folder_files_recursive_impl()
