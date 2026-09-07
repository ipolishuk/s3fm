#!/usr/bin/env python3
"""
Операционный CLI S3 File Manager: схема БД, пароли, экспорт/импорт конфигурации.

Команды:
  schema              — инициализация схемы PostgreSQL и bootstrap admin
  reset-password      — смена пароля пользователя
  export              — PostgreSQL → JSON (бакеты, облака, пользователи, роли)
  import              — JSON → PostgreSQL

Файлы по умолчанию: config_buckets.json, config_clouds.json, config_users.json,
config_roles.json. Combined JSON: import/export --all -f backup/full-config.json.

Подключение: DATABASE_URL или --database-url (приоритет над .env).

Примеры:
  export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
  s3 schema
  s3 reset-password admin
  s3 export --all
  s3 import --all
  s3 export --users -f backup/users.json
"""

import argparse
import json
import os
import sys
from pathlib import Path

import boto3
import urllib3
from botocore.config import Config

_SRC_DIR = Path(__file__).resolve().parent
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from dotenv import load_dotenv

from db import (
    config_database,
    get_buckets_config,
    get_connection,
    get_database_url,
    get_users_as_users_data,
    init_schema,
    insert_bucket,
    insert_user,
    list_cloud_rows,
    list_roles,
    reset_user_password,
)

DEFAULT_BUCKETS_FILE = "config_buckets.json"
DEFAULT_CLOUDS_FILE = "config_clouds.json"
DEFAULT_USERS_FILE = "config_users.json"
DEFAULT_ROLES_FILE = "config_roles.json"

_DEFAULT_FILE_BY_SCOPE = {
    "buckets": DEFAULT_BUCKETS_FILE,
    "clouds": DEFAULT_CLOUDS_FILE,
    "users": DEFAULT_USERS_FILE,
    "roles": DEFAULT_ROLES_FILE,
}

_ALL_DEFAULT_FILES = (
    DEFAULT_BUCKETS_FILE,
    DEFAULT_CLOUDS_FILE,
    DEFAULT_USERS_FILE,
    DEFAULT_ROLES_FILE,
)


def _scope_file(args):
    """Путь JSON для одиночной области или combined-файл при --all -f."""
    if args.file:
        return args.file
    if args.scope == "all":
        return None
    return _DEFAULT_FILE_BY_SCOPE[args.scope]


def _read_json_or_error(path):
    try:
        return _read_json(path), None
    except FileNotFoundError:
        return None, f"Input file not found: {path}"
    except json.JSONDecodeError as exc:
        return None, f"Invalid JSON in {path}: {exc}"

_HELP_EPILOG = """
Примеры:
  s3 schema
  s3 reset-password admin
  s3 export --buckets (--clouds, --roles, --users)
  s3 import --users -f users.json
  s3 export --all --dst bucket -f backups/config.json

Подключение к БД: переменная DATABASE_URL или --database-url (приоритет над .env).
Перед export/import выполняется проверка подключения (SELECT 1).
"""


class _ConfigHelpFormatter(argparse.RawDescriptionHelpFormatter):
    """Краткая форма опций и выравнивание help подкоманд."""

    def _format_action(self, action):
        if type(action).__name__ == '_ChoicesPseudoAction':
            indent = ' ' * self._current_indent
            name = self._format_action_invocation(action)
            if not action.help:
                return f'{indent}{name}\n'
            help_text = self._expand_help(action)
            gap = '  '
            first_width = self._width - self._current_indent - len(name) - len(gap)
            lines = self._split_lines(help_text, max(first_width, 1))
            cont = ' ' * (self._current_indent + len(name) + len(gap))
            out = f'{indent}{name}{gap}{lines[0]}\n'
            for line in lines[1:]:
                out += f'{cont}{line}\n'
            return out
        return super()._format_action(action)

    def _format_action_invocation(self, action):
        if action.option_strings and action.metavar and len(action.option_strings) == 2:
            short, long_opt = action.option_strings
            metavar = self._metavar_formatter(
                action, self._get_default_metavar_for_optional(action)
            )(1)[0]
            return f'{short}, {long_opt} {metavar}'
        return super()._format_action_invocation(action)


def _add_scope_arguments(parser):
    scope = parser.add_argument_group('Область (обязательно, один вариант)')
    scope_mx = scope.add_mutually_exclusive_group(required=True)
    scope_mx.add_argument(
        '--buckets',
        dest='scope',
        action='store_const',
        const='buckets',
        help=f'Только бакеты → {DEFAULT_BUCKETS_FILE}',
    )
    scope_mx.add_argument(
        '--users',
        dest='scope',
        action='store_const',
        const='users',
        help=f'Только пользователи → {DEFAULT_USERS_FILE}',
    )
    scope_mx.add_argument(
        '--roles',
        dest='scope',
        action='store_const',
        const='roles',
        help=f'Только роли → {DEFAULT_ROLES_FILE}',
    )
    scope_mx.add_argument(
        '--clouds',
        dest='scope',
        action='store_const',
        const='clouds',
        help=f'Только облака → {DEFAULT_CLOUDS_FILE}',
    )
    scope_mx.add_argument(
        '--all',
        dest='scope',
        action='store_const',
        const='all',
        help=(
            'Все секции: '
            f'{DEFAULT_BUCKETS_FILE}, {DEFAULT_CLOUDS_FILE}, '
            f'{DEFAULT_USERS_FILE}, {DEFAULT_ROLES_FILE}'
        ),
    )


def _build_parser():
    parser = argparse.ArgumentParser(
        prog='s3',
        formatter_class=_ConfigHelpFormatter,
        usage='%(prog)s [--database-url DSN] COMMAND ...',
        description=(
            'Операции с конфигурацией S3 File Manager: схема БД, пароли, '
            'экспорт и импорт JSON.'
        ),
        epilog=_HELP_EPILOG,
        add_help=False,
    )
    parser.add_argument(
        '--database-url',
        metavar='DSN',
        default=None,
        help='URL PostgreSQL для этого запуска (устанавливает DATABASE_URL)',
    )
    sub = parser.add_subparsers(dest='command', metavar='COMMAND')

    sub.add_parser(
        'schema',
        help='Схема БД, встроенные роли, bootstrap admin (buckets не очищаются)',
        description='Создать/обновить схему, встроенные роли admin/storage_* и учётку admin.',
    )

    p_reset = sub.add_parser(
        'reset-password',
        help='Сменить пароль пользователя (должен существовать в БД; admin создаётся при отсутствии)',
        description='Обновить пароль в таблице users (роль, buckets и clouds не меняются).',
    )
    p_reset.add_argument(
        'username',
        metavar='USERNAME',
        help='Логин пользователя (например admin)',
    )
    p_reset.add_argument(
        '-p',
        '--password',
        default=None,
        metavar='PASSWORD',
        help='Новый пароль (виден в history; иначе интерактивный ввод)',
    )

    p_export = sub.add_parser(
        'export',
        help='Экспорт из PostgreSQL в JSON',
        description='Экспорт бакетов, облаков, пользователей и/или ролей в JSON.',
    )
    _add_scope_arguments(p_export)
    p_export.add_argument(
        '-f',
        '--file',
        default=None,
        metavar='FILE',
        help='Путь к JSON; с --dst — также ключ объекта в S3 (для --all — один combined-файл)',
    )
    p_export.add_argument(
        '--stdout',
        action='store_true',
        help='Вывести JSON в stdout вместо записи в файл',
    )
    p_export.add_argument(
        '--dst',
        metavar='BUCKET',
        default=None,
        help='Загрузить JSON в S3 bucket_name из конфигурации БД',
    )

    p_import = sub.add_parser(
        'import',
        help='Импорт из JSON в PostgreSQL',
        description='Импорт бакетов, облаков, пользователей и/или ролей из JSON.',
    )
    _add_scope_arguments(p_import)
    p_import.add_argument(
        '-f',
        '--file',
        default=None,
        metavar='FILE',
        help='Путь к JSON (для --all без -f — четыре файла по умолчанию)',
    )

    parser.add_argument(
        '-h',
        '--help',
        action='help',
        help='Показать эту справку и выйти',
    )
    return parser


def print_help():
    _build_parser().print_help()


def parse_args(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.error('укажите COMMAND (schema, reset-password, export, import)')
    return args


def _masked_database_url():
    dsn = (os.environ.get("DATABASE_URL") or "").strip()
    if not dsn:
        return "(not set)"
    if "@" not in dsn:
        return dsn
    try:
        scheme, rest = dsn.split("://", 1)
        _userinfo, hostpart = rest.rsplit("@", 1)
        return f"{scheme}://***@{hostpart}"
    except (ValueError, IndexError):
        return "(invalid DSN format)"


def check_database_connection():
    """
    Проверяет доступность PostgreSQL по текущему DATABASE_URL.
    Возвращает 0 при успехе, 1 при ошибке.
    """
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                if cur.fetchone() is None:
                    print("Database check failed: empty response.", file=sys.stderr)
                    return 1
            return 0
        finally:
            conn.close()
    except Exception as exc:
        print(f"Database connection failed: {exc}", file=sys.stderr)
        print(f"DSN (password hidden): {_masked_database_url()}", file=sys.stderr)
        return 1


def _write_json(path, obj):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, indent=2, ensure_ascii=False))
        f.write("\n")


def _json_payload_bytes(obj):
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _inherit_bucket_config(bucket_config, group_data):
    cfg = dict(bucket_config or {})
    if not (cfg.get("endpoint_url") or "").strip():
        cfg["endpoint_url"] = (group_data.get("endpoint_url") or "").strip()
    if "region_name" not in cfg:
        cfg["region_name"] = group_data.get("region_name", "us-east-1")
    return cfg


def _find_bucket_by_dst(dst):
    """Найти бакет в конфиге БД только по S3 bucket_name."""
    token = (dst or "").strip()
    if not token:
        return None
    config = get_buckets_config()
    matches = []
    for group_id, group_data in (config or {}).items():
        for display_name, bucket_config in (group_data.get("buckets") or {}).items():
            if not isinstance(bucket_config, dict):
                continue
            bucket_name = (bucket_config.get("bucket_name") or "").strip()
            if bucket_name != token:
                continue
            inherited = _inherit_bucket_config(bucket_config, group_data)
            matches.append(
                {
                    "group_id": group_id,
                    "display_name": display_name,
                    "bucket_name": bucket_name,
                    "bucket_config": inherited,
                }
            )
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    labels = [
        f"{m['bucket_name']} ({m['group_id']}:{m['display_name']})"
        for m in matches
    ]
    print(
        f"Ambiguous bucket name {token!r}, matches: {', '.join(labels)}",
        file=sys.stderr,
    )
    return None


def _skip_tls_verify_enabled(bucket_config):
    value = (bucket_config or {}).get("skip_tls_verify")
    if value is True:
        return True
    if isinstance(value, str):
        return value.lower() in ("true", "1", "yes")
    return bool(value)


def _resolve_s3_ca_verify_path(bucket_config):
    configured = ((bucket_config or {}).get("ca_bundle_path") or "").strip()
    if configured and os.path.isfile(configured):
        return configured
    for env_key in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "AWS_CA_BUNDLE"):
        env_path = (os.environ.get(env_key) or "").strip()
        if env_path and os.path.isfile(env_path):
            return env_path
    for candidate in (
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def _create_s3_client(bucket_config):
    access_key = bucket_config.get("aws_access_key_id")
    secret_key = bucket_config.get("aws_secret_access_key")
    endpoint_url = (bucket_config.get("endpoint_url") or "").strip()
    if not access_key or not secret_key:
        raise ValueError("bucket credentials are missing in database config")
    if not endpoint_url:
        raise ValueError("bucket endpoint_url is missing in database config")
    region_name = bucket_config.get("region_name", "us-east-1")
    ca_verify_path = _resolve_s3_ca_verify_path(bucket_config)
    skip_tls_verify = _skip_tls_verify_enabled(bucket_config)
    read_timeout = 60
    if ca_verify_path:
        config = Config(
            signature_version="s3v4",
            connect_timeout=10,
            read_timeout=read_timeout,
            retries={"max_attempts": 2, "mode": "standard"},
            max_pool_connections=10,
        )
        return boto3.client(
            "s3",
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            endpoint_url=endpoint_url,
            region_name=region_name,
            config=config,
            verify=ca_verify_path,
        )
    verify_ssl = not skip_tls_verify
    if skip_tls_verify:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    return boto3.client(
        "s3",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        endpoint_url=endpoint_url,
        region_name=region_name,
        config=Config(
            signature_version="s3v4",
            connect_timeout=30,
            read_timeout=read_timeout,
            retries={"max_attempts": 3},
        ),
        verify=verify_ssl,
    )


def _count_buckets_by_name(token):
    name = (token or "").strip()
    if not name:
        return 0
    count = 0
    for group_data in (get_buckets_config() or {}).values():
        for bucket_config in (group_data.get("buckets") or {}).values():
            if not isinstance(bucket_config, dict):
                continue
            if (bucket_config.get("bucket_name") or "").strip() == name:
                count += 1
    return count


def _resolve_dst_bucket(dst):
    """Найти бакет по S3 bucket_name или None (неоднозначность — сообщение в stderr)."""
    return _find_bucket_by_dst(dst)


def _upload_json_to_dst(bucket_info, key, obj):
    if not bucket_info:
        return 1
    s3_key = (key or "").strip().lstrip("/")
    if not s3_key:
        print("S3 object key is empty.", file=sys.stderr)
        return 1
    bucket_name = bucket_info["bucket_name"]
    try:
        client = _create_s3_client(bucket_info["bucket_config"])
        client.put_object(
            Bucket=bucket_name,
            Key=s3_key,
            Body=_json_payload_bytes(obj),
            ContentType="application/json; charset=utf-8",
        )
    except Exception as exc:
        print(
            f"Failed to upload to s3://{bucket_name}/{s3_key}: {exc}",
            file=sys.stderr,
        )
        return 1
    print(f"Uploaded JSON to s3://{bucket_name}/{s3_key}")
    return 0


def _deliver_json_export(args, path, obj, dst_bucket=None):
    if args.stdout:
        print(json.dumps(obj, indent=2, ensure_ascii=False))
    else:
        _write_json(path, obj)
        print(f"Exported config to {path}")
    if args.dst:
        key = args.file or os.path.basename(path)
        return _upload_json_to_dst(dst_bucket, key, obj)
    return 0


def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _looks_like_buckets_top_level(data):
    if not isinstance(data, dict) or not data:
        return True
    sample = next(iter(data.values()), None)
    return isinstance(sample, dict) and isinstance(sample.get("buckets"), dict)


def _users_dict_from_parsed(data):
    if not isinstance(data, dict):
        return None
    u = data.get("users")
    if isinstance(u, dict):
        return u
    if "roles" not in data and "buckets" not in data and _is_plain_users_data(data):
        return data
    return None


def _is_plain_users_data(d):
    if not isinstance(d, dict) or not d:
        return False
    for v in d.values():
        if not isinstance(v, dict) or "role" not in v:
            return False
    return True


def _roles_list_from_parsed(data):
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return None
    r = data.get("roles")
    if isinstance(r, list):
        return r
    return None


def _clouds_list_from_parsed(data):
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return None
    c = data.get("clouds")
    if isinstance(c, list):
        return c
    return None


def _buckets_dict_from_parsed(data, scope):
    if not isinstance(data, dict):
        return None
    inner = data.get("buckets")
    if isinstance(inner, dict) and (
        scope == "all" or "users" in data or "roles" in data
    ):
        return inner
    if isinstance(inner, dict) and set(data.keys()) == {"buckets"}:
        return inner
    if scope in ("buckets", "all") and _looks_like_buckets_top_level(data):
        return data
    if scope == "all" and isinstance(inner, dict):
        return inner
    return None


def export_buckets_stdout_or_file(args, data, dst_bucket=None):
    if not isinstance(data, dict):
        print("Failed to read buckets config from database.", file=sys.stderr)
        return 1
    return _deliver_json_export(args, _scope_file(args), data, dst_bucket)


def export_users_stdout_or_file(args, users_obj, dst_bucket=None):
    if not isinstance(users_obj, dict):
        print("Failed to read users from database.", file=sys.stderr)
        return 1
    return _deliver_json_export(args, _scope_file(args), users_obj, dst_bucket)


def export_roles_stdout_or_file(args, roles_list, dst_bucket=None):
    if not isinstance(roles_list, list):
        print("Failed to read roles from database.", file=sys.stderr)
        return 1
    return _deliver_json_export(args, _scope_file(args), roles_list, dst_bucket)


def export_clouds_stdout_or_file(args, clouds_list, dst_bucket=None):
    if not isinstance(clouds_list, list):
        print("Failed to read clouds from database.", file=sys.stderr)
        return 1
    return _deliver_json_export(args, _scope_file(args), clouds_list, dst_bucket)


def export_to_json(args):
    dst_bucket = None
    if args.dst:
        dst_bucket = _resolve_dst_bucket(args.dst)
        if not dst_bucket:
            if _count_buckets_by_name(args.dst) == 0:
                print(f"Bucket not found in database: {args.dst!r}", file=sys.stderr)
            return 1

    if args.scope == "buckets":
        return export_buckets_stdout_or_file(args, get_buckets_config(), dst_bucket)
    if args.scope == "users":
        return export_users_stdout_or_file(args, get_users_as_users_data(), dst_bucket)
    if args.scope == "roles":
        return export_roles_stdout_or_file(args, list_roles(), dst_bucket)
    if args.scope == "clouds":
        return export_clouds_stdout_or_file(args, list_cloud_rows(), dst_bucket)
    # all
    b = get_buckets_config()
    c = list_cloud_rows()
    u = get_users_as_users_data()
    r = list_roles()
    if not isinstance(b, dict):
        print("Failed to read buckets from database.", file=sys.stderr)
        return 1
    if not isinstance(u, dict):
        print("Failed to read users from database.", file=sys.stderr)
        return 1
    if not isinstance(c, list):
        print("Failed to read clouds from database.", file=sys.stderr)
        return 1
    if not isinstance(r, list):
        print("Failed to read roles from database.", file=sys.stderr)
        return 1
    combined = {"buckets": b, "clouds": c, "users": u, "roles": r}
    if args.stdout:
        print(json.dumps(combined, indent=2, ensure_ascii=False))
    if args.file:
        return _deliver_json_export(args, args.file, combined, dst_bucket)
    if args.stdout and not args.dst:
        return 0
    rc = 0
    for path, obj in zip(_ALL_DEFAULT_FILES, (b, c, u, r)):
        err = _deliver_json_export(args, path, obj, dst_bucket)
        if err:
            rc = err
    return rc


def _print_import_section(scope, path, items):
    print(f"Imported {scope} from: {path}")
    for item in items:
        print(item)


def _import_buckets(conn, cfg):
    if not isinstance(cfg, dict):
        print("Buckets config root must be an object.", file=sys.stderr)
        return 1, []
    imported = []
    for group_id, group_data in cfg.items():
        if not isinstance(group_data, dict):
            continue
        buckets = group_data.get("buckets") or {}
        if not isinstance(buckets, dict):
            continue

        group_endpoint = (group_data.get("endpoint_url") or "").strip()
        merged_cloud = (
            group_data.get("display_name")
            or group_data.get("name")
            or group_id
        )

        for display_name, bucket_config in buckets.items():
            if not isinstance(bucket_config, dict):
                continue
            bucket_name = bucket_config.get("bucket_name")
            if not bucket_name:
                print(
                    f"Skip {group_id}/{display_name}: no bucket_name",
                    file=sys.stderr,
                )
                continue

            bucket_id = bucket_config.get("bucket_id")
            row_endpoint = (
                bucket_config.get("endpoint_url") or group_endpoint or ""
            ).strip()
            aws_access_key_id = bucket_config.get("aws_access_key_id")
            aws_secret_access_key = bucket_config.get("aws_secret_access_key")
            ca_bundle_path = bucket_config.get("ca_bundle_path")
            region_name = bucket_config.get("region_name")
            skip_tls_verify = bucket_config.get("skip_tls_verify")
            if skip_tls_verify is None:
                skip_tls_verify = group_data.get("skip_tls_verify")
            if skip_tls_verify is None:
                skip_tls_verify = False
            elif isinstance(skip_tls_verify, str):
                skip_tls_verify = skip_tls_verify.lower() in (
                    "true",
                    "1",
                    "yes",
                )
            else:
                skip_tls_verify = bool(skip_tls_verify)

            insert_bucket(
                cloud_id=group_id,
                display_name=display_name,
                bucket_name=bucket_name,
                bucket_id=bucket_id,
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
                cloud_name=merged_cloud,
                cloud_icon=group_data.get("icon"),
                endpoint_url=row_endpoint or None,
                ca_bundle_path=ca_bundle_path,
                region_name=region_name,
                skip_tls_verify=skip_tls_verify,
                conn=conn,
            )
            imported.append(f"{group_id} / {display_name}")
    return 0, imported


def _import_users(conn, users_dict):
    if not isinstance(users_dict, dict):
        print("Users section must be an object.", file=sys.stderr)
        return 1, []
    imported = []
    for username, entry in users_dict.items():
        if not isinstance(entry, dict):
            continue
        password_hash = entry.get("password_hash")
        role = entry.get("role")
        if not password_hash or not role:
            print(
                f"Skip user {username}: need password_hash and role",
                file=sys.stderr,
            )
            continue
        buckets = entry.get("allowed_buckets")
        clouds = entry.get("allowed_clouds")
        if buckets is None:
            buckets = []
        if clouds is None:
            clouds = []
        if not isinstance(buckets, list):
            buckets = list(buckets) if buckets else []
        if not isinstance(clouds, list):
            clouds = list(clouds) if clouds else []
        bucket_roles = entry.get("bucket_roles")
        email = entry.get("email")
        insert_user(
            username,
            password_hash,
            role,
            buckets=buckets,
            clouds=clouds,
            bucket_roles=bucket_roles,
            email=email,
            conn=conn,
        )
        imported.append(username)
    return 0, imported


def _import_roles(conn, roles_list):
    if not isinstance(roles_list, list):
        print("Roles section must be an array.", file=sys.stderr)
        return 1, []
    imported = []
    with conn.cursor() as cur:
        for item in roles_list:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not name:
                print("Skip role entry without name", file=sys.stderr)
                continue
            try:
                from roles import is_reserved_role_name
                if is_reserved_role_name(name):
                    print(f"Skip reserved role name: {name}", file=sys.stderr)
                    continue
            except Exception:
                pass
            perms = item.get("permissions")
            if perms is None:
                perms = []
            if not isinstance(perms, list):
                perms = []
            cur.execute(
                """
                INSERT INTO roles (name, permissions)
                VALUES (%s, %s::jsonb)
                ON CONFLICT (name) DO UPDATE SET
                    permissions = EXCLUDED.permissions
                """,
                (name, json.dumps(perms)),
            )
            imported.append(name)
    return 0, imported


def _import_clouds(conn, clouds_list):
    if not isinstance(clouds_list, list):
        print("Clouds section must be an array.", file=sys.stderr)
        return 1, []
    imported = []
    grouped = {}
    for item in clouds_list:
        if not isinstance(item, dict):
            continue
        cloud_id = (item.get("cloud_id") or "").strip()
        if not cloud_id:
            print("Skip cloud entry without cloud_id", file=sys.stderr)
            continue
        display_name = (item.get("display_name") or item.get("name") or cloud_id).strip()
        entry = grouped.setdefault(cloud_id, {"display_name": display_name, "endpoints": []})
        if display_name:
            entry["display_name"] = display_name
        endpoint_raw = item.get("endpoint_url")
        if endpoint_raw is None:
            raw_parts = []
        elif isinstance(endpoint_raw, list):
            raw_parts = [str(v).strip() for v in endpoint_raw]
        else:
            print(f"Skip cloud entry with invalid endpoint_url type (must be array): {cloud_id}", file=sys.stderr)
            continue
        for ep in raw_parts:
            s = ep.strip()
            if not s:
                continue
            if s not in entry["endpoints"]:
                entry["endpoints"].append(s)

    with conn.cursor() as cur:
        for cloud_id, payload in grouped.items():
            display_name = payload["display_name"] or cloud_id
            normalized = payload["endpoints"] or [None]
            cur.execute("DELETE FROM clouds WHERE cloud_id = %s", (cloud_id,))
            for endpoint_url in normalized:
                cur.execute(
                    """
                    INSERT INTO clouds (cloud_id, name, display_name, endpoint_url)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (cloud_id, COALESCE(NULLIF(BTRIM(endpoint_url), ''), '')) DO UPDATE SET
                        name = EXCLUDED.name,
                        display_name = EXCLUDED.display_name
                    """,
                    (cloud_id, display_name, display_name, endpoint_url),
                )
            imported.append(cloud_id)
    return 0, imported


def import_from_db(args):
    init_schema()
    conn = get_connection()
    try:
        if args.scope == "buckets":
            path = _scope_file(args)
            data, err_msg = _read_json_or_error(path)
            if err_msg:
                print(err_msg, file=sys.stderr)
                return 1
            cfg = _buckets_dict_from_parsed(data, "buckets")
            if cfg is None:
                print("Could not parse buckets config from file.", file=sys.stderr)
                return 1
            err, bucket_items = _import_buckets(conn, cfg)
            if err:
                return err
            conn.commit()
            _print_import_section("buckets", path, bucket_items)
            return 0

        if args.scope == "users":
            path = _scope_file(args)
            data, err_msg = _read_json_or_error(path)
            if err_msg:
                print(err_msg, file=sys.stderr)
                return 1
            users_dict = _users_dict_from_parsed(data)
            if not users_dict:
                print("No users object found in file.", file=sys.stderr)
                return 1
            err, user_items = _import_users(conn, users_dict)
            if err:
                return err
            conn.commit()
            _print_import_section("users", path, user_items)
            return 0

        if args.scope == "roles":
            path = _scope_file(args)
            data, err_msg = _read_json_or_error(path)
            if err_msg:
                print(err_msg, file=sys.stderr)
                return 1
            roles_list = _roles_list_from_parsed(data)
            if roles_list is None:
                print("No roles array found in file.", file=sys.stderr)
                return 1
            err, role_items = _import_roles(conn, roles_list)
            if err:
                return err
            conn.commit()
            _print_import_section("roles", path, role_items)
            return 0
        if args.scope == "clouds":
            path = _scope_file(args)
            data, err_msg = _read_json_or_error(path)
            if err_msg:
                print(err_msg, file=sys.stderr)
                return 1
            clouds_list = _clouds_list_from_parsed(data)
            if clouds_list is None:
                print("No clouds array found in file.", file=sys.stderr)
                return 1
            err, cloud_items = _import_clouds(conn, clouds_list)
            if err:
                return err
            conn.commit()
            _print_import_section("clouds", path, cloud_items)
            return 0

        # all
        if args.file:
            data, err_msg = _read_json_or_error(args.file)
            if err_msg:
                print(err_msg, file=sys.stderr)
                return 1
            bdata = data
            udata = data
            rdata = data
            cdata = data
            imported_from = args.file
        else:
            bdata, err_msg = _read_json_or_error(DEFAULT_BUCKETS_FILE)
            if err_msg:
                print(err_msg.replace("Input file", "Buckets file"), file=sys.stderr)
                return 1
            udata, err_msg = _read_json_or_error(DEFAULT_USERS_FILE)
            if err_msg:
                print(err_msg.replace("Input file", "Users file"), file=sys.stderr)
                return 1
            rdata, err_msg = _read_json_or_error(DEFAULT_ROLES_FILE)
            if err_msg:
                print(err_msg.replace("Input file", "Roles file"), file=sys.stderr)
                return 1
            cdata, err_msg = _read_json_or_error(DEFAULT_CLOUDS_FILE)
            if err_msg:
                print(err_msg.replace("Input file", "Clouds file"), file=sys.stderr)
                return 1
            imported_from = None

        cfg = _buckets_dict_from_parsed(bdata, "all")
        if cfg is None and isinstance(bdata, dict) and isinstance(
            bdata.get("buckets"), dict
        ):
            cfg = bdata["buckets"]
        elif cfg is None and isinstance(bdata, dict) and _looks_like_buckets_top_level(
            bdata
        ):
            cfg = bdata
        elif cfg is None:
            cfg = {}
        bucket_items = []
        if isinstance(cfg, dict) and cfg:
            err, bucket_items = _import_buckets(conn, cfg)
            if err:
                return err

        user_items = []
        users_dict = _users_dict_from_parsed(udata)
        if users_dict:
            err, user_items = _import_users(conn, users_dict)
            if err:
                return err

        role_items = []
        roles_list = _roles_list_from_parsed(rdata)
        if roles_list:
            err, role_items = _import_roles(conn, roles_list)
            if err:
                return err

        cloud_items = []
        clouds_list = _clouds_list_from_parsed(cdata)
        if clouds_list:
            err, cloud_items = _import_clouds(conn, clouds_list)
            if err:
                return err

        conn.commit()
        if imported_from:
            print(f"Imported all sections from: {imported_from}")
            print()
            if bucket_items:
                print("Buckets:")
                for item in bucket_items:
                    print(item)
            if cloud_items:
                if bucket_items:
                    print()
                print("Clouds:")
                for item in cloud_items:
                    print(item)
            if user_items:
                if bucket_items or cloud_items:
                    print()
                print("Users:")
                for item in user_items:
                    print(item)
            if role_items:
                if bucket_items or cloud_items or user_items:
                    print()
                print("Roles:")
                for item in role_items:
                    print(item)
        else:
            sections = (
                ("buckets", DEFAULT_BUCKETS_FILE, bucket_items),
                ("clouds", DEFAULT_CLOUDS_FILE, cloud_items),
                ("users", DEFAULT_USERS_FILE, user_items),
                ("roles", DEFAULT_ROLES_FILE, role_items),
            )
            for idx, (scope, path, items) in enumerate(sections):
                if idx:
                    print()
                _print_import_section(scope, path, items)
        return 0
    finally:
        conn.close()


def main():
    load_dotenv()
    if len(sys.argv) == 1:
        print_help()
        return 0
    args = parse_args()
    if args.database_url and str(args.database_url).strip():
        os.environ['DATABASE_URL'] = str(args.database_url).strip()

    if args.command == 'schema':
        config_database()
        print(f'Database: {get_database_url()}')
        print('Config Status: OK')
        return 0

    if args.command == 'reset-password':
        reset_user_password(args.username, password=args.password)
        return 0

    rc = check_database_connection()
    if rc:
        return rc
    if args.command == 'import':
        return import_from_db(args)
    if args.command == 'export':
        return export_to_json(args)
    print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
