"""Поиск конфигурации бакетов, нормализация S3-ключей и проверка доступа сессии."""

from __future__ import annotations

from urllib.parse import unquote

from flask import session

from auth_session import (
    session_allowed_list as _session_allowed_list,
    bucket_roles_from_session as _bucket_roles_from_session,
)
from buckets import get_buckets_config
from logs import log_warning


def normalize_s3_object_key(key: str) -> str:
    """Нормализует ключ объекта из URL/формы (без ведущего /)."""
    if key is None:
        return ''
    return unquote(str(key).strip()).lstrip('/')


def _inherit_bucket_config(group_data, bucket_config):
    """Копия конфига бакета с наследованием endpoint_url / region_name из облака."""
    cfg = bucket_config.copy()
    if not (cfg.get('endpoint_url') or '').strip():
        cfg['endpoint_url'] = (group_data.get('endpoint_url') or '').strip()
    if 'region_name' not in cfg:
        cfg['region_name'] = group_data.get('region_name', 'us-east-1')
    return cfg


def find_bucket_config(bucket_name):
    """Находит конфигурацию бакета по его реальному имени (bucket_name)."""
    for group_id, group_data in get_buckets_config().items():
        for display_name, bucket_config in group_data['buckets'].items():
            if bucket_config.get('bucket_name') == bucket_name:
                bucket_id = bucket_config.get('bucket_id', display_name)
                cfg = _inherit_bucket_config(group_data, bucket_config)
                return {
                    'group_id': group_id,
                    'group_data': group_data,
                    'display_name': display_name,
                    'bucket_config': cfg,
                    'bucket_id': bucket_id,
                }
    return None


def find_bucket_config_by_bucket_id(bucket_id):
    """Находит конфигурацию бакета по bucket_id или cloud_id:display_name."""
    for group_id, group_data in get_buckets_config().items():
        for display_name, bucket_config in group_data['buckets'].items():
            current_bucket_id = bucket_config.get('bucket_id', display_name)
            composite_key = "{}:{}".format(group_id, display_name)
            if current_bucket_id == bucket_id or composite_key == bucket_id:
                cfg = _inherit_bucket_config(group_data, bucket_config)
                return {
                    'group_id': group_id,
                    'group_data': group_data,
                    'display_name': display_name,
                    'bucket_config': cfg,
                    'bucket_id': current_bucket_id,
                    'bucket_name': cfg.get('bucket_name'),
                    'aws_access_key_id': cfg.get('aws_access_key_id'),
                    'aws_secret_access_key': cfg.get('aws_secret_access_key'),
                    'endpoint_url': cfg.get('endpoint_url'),
                    'region_name': cfg.get('region_name', 'us-east-1'),
                    'ca_bundle_path': cfg.get('ca_bundle_path'),
                    'skip_tls_verify': cfg.get('skip_tls_verify'),
                }
    return None

def _session_has_bucket_grant(bucket_id):
    if not bucket_id:
        return False
    grants = _bucket_roles_from_session()
    if bucket_id in grants:
        return True
    bucket_info = find_bucket_config_by_bucket_id(bucket_id)
    if not bucket_info:
        return False
    cfg = bucket_info.get('bucket_config') or {}
    candidates = {
        bucket_id,
        bucket_info.get('display_name') or '',
        cfg.get('bucket_name') or '',
        cfg.get('bucket_id') or '',
        "{}:{}".format(bucket_info.get('group_id', ''), bucket_info.get('display_name', '')),
    }
    for grant_bid in grants:
        if grant_bid in candidates:
            return True
    return False



def check_cloud_access(cloud_id):
    """Проверяет доступ пользователя к облаку (группе бакетов)"""
    if not session.get('logged_in'):
        return False

    user_clouds = _session_allowed_list(session.get('allowed_clouds', []))

    # Если в allowed_clouds есть '*', разрешаем доступ ко всем облакам
    if '*' in user_clouds:
        return True

    return cloud_id in user_clouds



def _build_session_accessible_buckets(include_secrets, context='accessible_buckets'):
    """Список бакетов для текущей сессии по allowed_buckets / allowed_clouds или user_roles grant."""
    user_buckets = _session_allowed_list(session.get('allowed_buckets', []))
    user_clouds = _session_allowed_list(session.get('allowed_clouds', []))
    grants = _bucket_roles_from_session()
    all_buckets = []
    has_all_buckets_access = '*' in user_buckets
    has_all_clouds_access = '*' in user_clouds

    for group_id, group_data in get_buckets_config().items():
        cloud_id = group_data.get('cloud_id', group_id)
        cloud_allowed = has_all_clouds_access or cloud_id in user_clouds

        for display_name, bucket_config in group_data['buckets'].items():
            bucket_name = bucket_config.get('bucket_name')
            if not bucket_name:
                log_warning(f'Bucket missing bucket_name in configuration: {display_name}', context)
                continue

            bucket_id = bucket_config.get('bucket_id', display_name)
            composite_bucket_key = "{}:{}".format(cloud_id, display_name)
            has_grant = bool(
                (bucket_id and bucket_id in grants)
                or (composite_bucket_key in grants)
                or (bucket_name and bucket_name in grants)
                or (display_name and display_name in grants)
            )
            has_bucket_access = (
                has_all_buckets_access
                or has_grant
                or bucket_id in user_buckets
                or composite_bucket_key in user_buckets
                or (bucket_name and bucket_name in user_buckets)
                or (display_name and display_name in user_buckets)
            )
            # Grant на бакет даёт доступ к нему даже без cloud в ACL
            if not has_bucket_access:
                continue
            if not cloud_allowed and not has_grant:
                continue

            has_access_key = bool(bucket_config.get('aws_access_key_id'))
            has_secret_key = bool(bucket_config.get('aws_secret_access_key'))
            has_credentials = has_access_key and has_secret_key

            bucket_config_with_inheritance = bucket_config.copy()
            if not (bucket_config_with_inheritance.get('endpoint_url') or '').strip():
                bucket_config_with_inheritance['endpoint_url'] = (group_data.get('endpoint_url') or '').strip()
            if 'region_name' not in bucket_config_with_inheritance:
                bucket_config_with_inheritance['region_name'] = group_data.get('region_name', 'us-east-1')

            if include_secrets:
                ak = bucket_config.get('aws_access_key_id')
                sk = bucket_config.get('aws_secret_access_key')
            else:
                ak = None
                sk = None

            all_buckets.append({
                'name': bucket_name,
                'display_name': display_name,
                'bucket_id': bucket_id,
                'bucket_name': bucket_name,
                'has_custom_credentials': has_credentials,
                'credentials_status': 'missing' if not has_credentials else 'present',
                'group': group_id,
                'group_name': group_data['display_name'],
                'group_icon': group_data['icon'],
                'cloud_id': cloud_id,
                'cloud_name': group_data['name'],
                'aws_access_key_id': ak,
                'aws_secret_access_key': sk,
                'endpoint_url': bucket_config_with_inheritance.get('endpoint_url'),
                'region_name': bucket_config_with_inheritance.get('region_name', 'us-east-1'),
                'ca_bundle_path': bucket_config.get('ca_bundle_path'),
                'skip_tls_verify': bucket_config.get('skip_tls_verify'),
                'public_url_enabled': bool(group_data.get('public_url_enabled')),
            })

    return all_buckets



def check_bucket_access(bucket_id):
    if not session.get('logged_in'):
        return False

    if _session_has_bucket_grant(bucket_id):
        return True

    user_buckets = _session_allowed_list(session.get('allowed_buckets', []))

    if '*' in user_buckets:
        return True
    if bucket_id in user_buckets:
        return True
    # В настройках бакеты сохраняются как cloud_id:display_name; проверяем по найденному бакету
    bucket_info = find_bucket_config_by_bucket_id(bucket_id)
    if bucket_info:
        composite = "{}:{}".format(bucket_info['group_id'], bucket_info['display_name'])
        if composite in user_buckets:
            return True
        cfg = bucket_info.get('bucket_config') or {}
        bn = cfg.get('bucket_name')
        if bn and bn in user_buckets:
            return True
        dn = bucket_info.get('display_name')
        if dn and dn in user_buckets:
            return True
    return False

