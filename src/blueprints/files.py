"""File operation routes (download/preview/archive + list/mutations)."""

from __future__ import annotations

from flask import Blueprint, jsonify, request, session

from auth_session import login_required
from bucket_access import (
    check_bucket_access,
    find_bucket_config_by_bucket_id,
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
    folder_metadata_impl,
    list_all_folders_impl,
    list_files_impl,
    list_folder_files_recursive_impl,
    list_selection_items_impl,
    move_objects_impl,
    seal_upload_job_impl,
    upload_file_impl,
)
from roles import (
    role_download_file,
    role_download_files_multi,
    role_download_folder,
)
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


@bp.route('/files/download-job/<job_id>')
@login_required
def download_job_result(job_id):
    """Отдать ZIP, собранный worker (staging object в том же бакете)."""
    import operation_jobs
    from botocore.exceptions import ClientError
    from flask import Response, stream_with_context
    from logs import log_error, log_info
    from s3_client import _content_disposition, get_s3_client

    username = session.get('username', '')
    if not operation_jobs.job_belongs_to_user(job_id, username):
        return jsonify({'error': _('error.access_denied')}), 403
    job = operation_jobs.get_job_with_cancel(job_id) or operation_jobs.get_job(job_id)
    if not job or (job.get('op') or '') != 'download_archive':
        return jsonify({'error': _('error.unexpected')}), 404
    if (job.get('status') or '') != 'done':
        return jsonify({'error': _('download.archive_not_ready')}), 409
    meta = job.get('meta') or {}
    staging_key = (meta.get('staging_key') or '').strip()
    bucket_id = ''
    payload = meta.get('payload') if isinstance(meta.get('payload'), dict) else {}
    bucket_id = (payload.get('bucket_id') or meta.get('bucket_id') or '').strip()
    staging_bucket = (meta.get('staging_bucket') or payload.get('bucket_name') or '').strip()
    filename = (meta.get('filename') or 'archive.zip').strip() or 'archive.zip'
    if not staging_key or not bucket_id:
        return jsonify({'error': _('error.unexpected')}), 404

    bucket_info = find_bucket_config_by_bucket_id(bucket_id)
    if not bucket_info:
        return jsonify({'error': _('error.bucket_not_found')}), 404
    if not check_bucket_access(bucket_id):
        return jsonify({'error': _('error.access_denied')}), 403

    bucket_config = bucket_info['bucket_config']
    bucket_name = staging_bucket or bucket_config.get('bucket_name')
    s3_client = get_s3_client(bucket_config)
    try:
        log_info(
            f'Delivering download-job archive job={job_id} key={staging_key}',
            'download_archive',
        )
        s3_response = s3_client.get_object(Bucket=bucket_name, Key=staging_key)
        body = s3_response['Body']
        content_length = s3_response.get('ContentLength')

        def stream():
            try:
                for chunk in body.iter_chunks(chunk_size=65536):
                    if chunk:
                        yield chunk
            finally:
                body.close()
                try:
                    s3_client.delete_object(Bucket=bucket_name, Key=staging_key)
                except Exception:
                    pass

        headers = {
            'Content-Disposition': _content_disposition(filename, 'attachment'),
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
        }
        if content_length is not None:
            headers['Content-Length'] = str(content_length)
        return Response(
            stream_with_context(stream()),
            status=200,
            mimetype='application/zip',
            headers=headers,
        )
    except ClientError as e:
        log_error(f'download-job get_object failed job={job_id}', 'download_archive', e)
        return jsonify({'error': _('download.error')}), 404


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
    """Поставить сборку ZIP в очередь worker (202 + job_id + SSE)."""
    username = session.get('username', 'Неизвестный пользователь')
    data = request.get_json(silent=True) or {}
    bucket_id = (data.get('bucket') or '').strip()
    paths = data.get('paths', []) or []
    folders_raw = data.get('folders', []) or []
    if not bucket_id:
        return jsonify({'error': _('error.bucket_id_required')}), 400
    if not isinstance(paths, list):
        paths = []
    if isinstance(folders_raw, str):
        folders = [folders_raw] if folders_raw.strip() else []
    elif isinstance(folders_raw, list):
        folders = [
            str(f).strip()
            for f in folders_raw
            if f and isinstance(f, str) and f.strip()
        ]
    else:
        folders = []
    if not paths and not folders:
        return jsonify({'error': _('download.no_files')}), 400

    parent_folder = (data.get('parent_folder') or 'archive').strip().rstrip('/') or 'archive'
    base_path = (data.get('base_path') or '').strip().rstrip('/')

    bucket_info = find_bucket_config_by_bucket_id(bucket_id)
    if not bucket_info:
        return jsonify({'error': _('error.bucket_not_found')}), 404
    bucket_config = bucket_info['bucket_config']
    display_name = bucket_info['display_name']
    if not check_bucket_access(bucket_id):
        return jsonify({'error': _('error.access_denied')}), 403

    if folders and not role_download_folder(bucket_id):
        return jsonify({'error': _('error.access_denied')}), 403
    if paths:
        if len(paths) > 1:
            if not role_download_files_multi(bucket_id):
                return jsonify({'error': _('error.access_denied')}), 403
        elif not (role_download_file(bucket_id) or role_download_files_multi(bucket_id)):
            return jsonify({'error': _('error.access_denied')}), 403

    from worker_jobs import enqueue_job, serialize_download_archive_job

    archive_job = {
        'bucket_id': bucket_id,
        'bucket_name': bucket_config.get('bucket_name') or '',
        'display_name': display_name,
        'paths': paths,
        'folders': folders,
        'parent_folder': parent_folder,
        'base_path': base_path,
        'username': username,
    }
    labels = []
    if folders:
        labels.extend([(f or '').rstrip('/').split('/')[-1] or f for f in folders[:5]])
    if paths:
        labels.extend([(p or '').split('/')[-1] or p for p in paths[:5]])
    if len(folders) + len(paths) > 5:
        labels = labels[:5] + [f'+{len(folders) + len(paths) - 5}']

    job_id = enqueue_job(
        username,
        'download_archive',
        labels or ['archive.zip'],
        serialize_download_archive_job(archive_job),
    )
    return jsonify({'job_id': job_id, 'op': 'download_archive'}), 202


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


@bp.route('/api/files/folder-metadata', methods=['GET'])
@login_required
def folder_metadata():
    return folder_metadata_impl()


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
