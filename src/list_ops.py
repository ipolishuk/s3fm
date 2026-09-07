"""S3 list_objects helpers (pagination, reveal, select-all)."""

from __future__ import annotations


def _parse_list_objects_page(response, prefix):
    """Разобрать одну страницу list_objects_v2 (Delimiter=/)."""
    all_folders = []
    if 'CommonPrefixes' in response:
        for prefix_obj in response['CommonPrefixes']:
            folder_path = prefix_obj['Prefix']
            folder_name = folder_path.rstrip('/').split('/')[-1]
            all_folders.append({'name': folder_name, 'path': folder_path})

    files_result = []
    if 'Contents' in response:
        for obj in response['Contents']:
            key = obj['Key']
            if key == prefix or key == prefix.rstrip('/'):
                continue
            if key.endswith('/'):
                continue
            relative_key = key[len(prefix):] if key.startswith(prefix) else key
            if '/' not in relative_key:
                file_name = key.split('/')[-1]
                files_result.append({
                    'name': file_name,
                    'path': key,
                    'size': obj['Size'],
                    'last_modified': obj['LastModified'].isoformat(),
                })

    return all_folders, files_result


def _s3_list_files_page(s3_client, bucket_name, prefix, limit, continuation_token=None):
    list_params = {
        'Bucket': bucket_name,
        'Prefix': prefix,
        'Delimiter': '/',
        'MaxKeys': limit,
    }
    if continuation_token:
        list_params['ContinuationToken'] = continuation_token
    response = s3_client.list_objects_v2(**list_params)
    folders, files = _parse_list_objects_page(response, prefix)
    return {
        'folders': folders,
        'files': files,
        'is_truncated': response.get('IsTruncated', False),
        'next_continuation_token': response.get('NextContinuationToken') or '',
    }


def _reveal_key_on_page(reveal_key, folders, files):
    if not reveal_key:
        return False
    target = reveal_key.rstrip('/')
    for folder in folders:
        fp = folder['path'].rstrip('/')
        if folder['path'] == reveal_key or fp == target:
            return True
    for file_obj in files:
        if file_obj['path'] == reveal_key or file_obj['path'].rstrip('/') == target:
            return True
    return False


def _list_files_find_reveal_page(s3_client, bucket_name, prefix, limit, reveal_key, max_pages=5000):
    """Найти страницу списка, на которой отображается объект reveal_key."""
    page_start_tokens = ['']
    continuation_token = None
    page = 1
    last_page_data = None

    while page <= max_pages:
        page_data = _s3_list_files_page(
            s3_client, bucket_name, prefix, limit, continuation_token
        )
        last_page_data = page_data
        if _reveal_key_on_page(reveal_key, page_data['folders'], page_data['files']):
            return page, page_start_tokens, page_data
        if not page_data['is_truncated']:
            break
        continuation_token = page_data['next_continuation_token']
        page_start_tokens.append(continuation_token)
        page += 1

    return 1, [''], last_page_data or _s3_list_files_page(
        s3_client, bucket_name, prefix, limit, None
    )


def _s3_list_all_at_prefix(s3_client, bucket_name, prefix):
    """Все файлы и папки на одном уровне префикса (Delimiter=/), для select-all."""
    norm_prefix = prefix or ''
    all_folders = []
    all_files = []
    seen_folder_paths = set()
    seen_file_paths = set()
    paginator = s3_client.get_paginator('list_objects_v2')
    paginate_kwargs = {
        'Bucket': bucket_name,
        'Prefix': norm_prefix,
        'Delimiter': '/',
    }
    for page in paginator.paginate(**paginate_kwargs):
        folders, files = _parse_list_objects_page(page, norm_prefix)
        for folder in folders:
            fp = folder['path']
            if fp not in seen_folder_paths:
                seen_folder_paths.add(fp)
                all_folders.append(folder)
        for file_obj in files:
            fp = file_obj['path']
            if fp not in seen_file_paths:
                seen_file_paths.add(fp)
                all_files.append(file_obj)
    return all_folders, all_files


