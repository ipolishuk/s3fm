"""S3 object download / inline preview streaming."""

from __future__ import annotations

from botocore.exceptions import ClientError
from flask import Response, jsonify, stream_with_context

from bucket_access import (
    check_bucket_access,
    find_bucket_config_by_bucket_id,
    normalize_s3_object_key as _normalize_s3_object_key,
)
from logs import LOG_CONFIG, log_error, log_info, log_s3_exception, log_user_action, log_warning, trf_en
from roles import (
    role_download_file,
    role_download_files_multi,
    role_download_folder,
    role_preview,
)
from s3_client import (
    _PREVIEW_HTML_MIMETYPES,
    _content_disposition,
    _map_s3_client_error,
    _resolve_preview_mimetype,
    _trf,
    get_s3_client,
)
from translations import _


def _stream_s3_object_response(bucket_id, file_path, *, disposition='attachment', context='download'):
    """Стримит объект S3 с Content-Disposition attachment|inline. Для inline — только previewable типы."""
    allowed = (
        role_preview(bucket_id)
        if disposition == 'inline'
        else (role_download_file(bucket_id) or role_download_files_multi(bucket_id))
    )
    if not allowed:
        return jsonify({'error': _('error.access_denied')}), 403

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

        file_path = _normalize_s3_object_key(file_path)
        if not file_path:
            return jsonify({'error': _('error.object_path_required')}), 400

        s3_client = get_s3_client(bucket_config)
        action = 'Previewing' if disposition == 'inline' else 'Downloading'
        log_info(f'{action} file {file_path} from bucket {display_name}', context)

        s3_response = s3_client.get_object(Bucket=bucket_name, Key=file_path)
        body = s3_response['Body']
        content_type = s3_response.get('ContentType', 'application/octet-stream')
        disp_filename = file_path.split('/')[-1] if '/' in file_path else file_path
        content_length = s3_response.get('ContentLength')

        response_mimetype = content_type
        if disposition == 'inline':
            preview_type = _resolve_preview_mimetype(content_type, file_path)
            if not preview_type:
                body.close()
                return jsonify({'error': _('files.preview_unsupported')}), 415
            response_mimetype = preview_type

        def stream():
            try:
                for chunk in body.iter_chunks(chunk_size=65536):
                    if chunk:
                        yield chunk
            finally:
                body.close()

        headers = {
            'Content-Disposition': _content_disposition(disp_filename, disposition),
            'Cache-Control': 'no-store',
            # Не буферировать ответ целиком в nginx/ingress — иначе браузер ждёт до конца файла.
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
        }
        if content_length is not None:
            headers['Content-Length'] = str(content_length)
        # HTML в той же origin — XSS-риск; sandbox отрезает скрипты и cookie app-origin.
        if disposition == 'inline' and response_mimetype in _PREVIEW_HTML_MIMETYPES:
            headers['Content-Security-Policy'] = 'sandbox'

        return Response(
            stream_with_context(stream()),
            status=200,
            mimetype=response_mimetype,
            headers=headers,
        )

    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        log_name = display_name if 'display_name' in locals() else bucket_id
        if error_code == 'NoSuchKey':
            key_for_msg = _normalize_s3_object_key(file_path) if file_path else ''
            error_msg = _trf('error.s3_object_not_found', path=key_for_msg)
            log_error(trf_en('error.s3_object_not_found', path=key_for_msg), context, e)
            return jsonify({'error': error_msg}), 404
        error_msg, status_code = _map_s3_client_error(e, log_name)
        log_s3_exception(context, e, log_name)
        return jsonify({'error': error_msg}), status_code
    except Exception as e:
        log_error('Unexpected error', context, e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500





stream_s3_object_response = _stream_s3_object_response
