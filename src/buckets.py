# buckets.py — загрузка конфигурации бакетов из PostgreSQL
from db import get_buckets_config as _get_buckets_config_from_db


def get_buckets_config():
    """Конфигурация бакетов только из таблицы buckets (без файлов и без кэша в памяти)."""
    return _get_buckets_config_from_db()


def reset_buckets_config_cache():
    """Зарезервировано для совместимости (раньше сбрасывали кэш); данные всегда читаются из БД заново."""
    pass


def _resolve_canonical_bucket_id_with_config(token, config):
    """Приводит bucket_id / composite / display_name / bucket_name к canonical bucket_id."""
    raw = (token or '').strip()
    if not raw:
        return ''
    for group_id, group_data in (config or {}).items():
        for display_name, bucket_config in (group_data.get('buckets') or {}).items():
            canonical = (bucket_config.get('bucket_id') or display_name or '').strip()
            bucket_name = (bucket_config.get('bucket_name') or '').strip()
            composite = "{}:{}".format(group_id, display_name)
            candidates = {canonical, display_name, bucket_name, composite}
            if raw in candidates:
                return canonical or raw
    return raw


def resolve_canonical_bucket_id(token):
    """Приводит bucket_id / composite / display_name / bucket_name к canonical bucket_id из конфига."""
    return _resolve_canonical_bucket_id_with_config(token, get_buckets_config())


def canonicalize_bucket_roles_map(grants_map):
    """Нормализует ключи grants к canonical bucket_id."""
    if not isinstance(grants_map, dict):
        return {}
    if not grants_map:
        return {}
    config = get_buckets_config()
    out = {}
    for grant_bid, role in grants_map.items():
        bid = _resolve_canonical_bucket_id_with_config(grant_bid, config)
        role_name = (role or '').strip()
        if bid and role_name:
            out[bid] = role_name
    return out
