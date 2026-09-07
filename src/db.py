# db.py — подключение к PostgreSQL и работа с таблицей users
import os
import json
import secrets
from datetime import datetime, timezone
import psycopg2
from psycopg2.extras import RealDictCursor

def get_database_url():
    return os.environ.get(
        'DATABASE_URL',
        'postgresql://postgres:postgres@localhost:5432/postgres'
    )

def get_connection(dsn=None):
    return psycopg2.connect(
        dsn or get_database_url(),
        cursor_factory=RealDictCursor,
        connect_timeout=int(os.environ.get('DB_CONNECT_TIMEOUT', '10')),
    )


def connection_status():
    """
    Статус PostgreSQL для админ-панели (SELECT 1).
    Пароль в DSN не возвращается.
    Подключение только через DATABASE_URL — отдельные PGHOST/PGUSER не используются;
    в vars показываем разобранные обязательные части URL.
    """
    from urllib.parse import urlparse

    dsn = (get_database_url() or '').strip()
    parsed = urlparse(dsn)
    has_url = bool(dsn)
    try:
        import psycopg2 as _psycopg2  # noqa: F401
        psycopg2_ok = True
    except ImportError:
        psycopg2_ok = False
    host = parsed.hostname or None
    port = parsed.port  # None → default 5432 in libpq
    database = (parsed.path or '').lstrip('/') or None
    user = parsed.username or None
    # password may be URL-encoded; empty string still counts as «set»
    has_password = parsed.password is not None
    vars_list = [
        {'name': 'psycopg2', 'ok': psycopg2_ok, 'required': True},
        {'name': 'DATABASE_URL', 'ok': has_url, 'required': True},
        {'name': 'DATABASE_HOST', 'ok': bool(host), 'required': True},
        {'name': 'DATABASE_PORT', 'ok': bool(host), 'required': False},  # default 5432
        {'name': 'DATABASE_USER', 'ok': bool(user), 'required': True},
        {'name': 'DATABASE_PASSWORD', 'ok': has_password, 'required': True},
        {'name': 'DATABASE_NAME', 'ok': bool(database), 'required': True},
    ]
    meta = {
        'host': host,
        'port': port or (5432 if host else None),
        'database': database,
        'user': user,
        'configured': has_url,
        'psycopg2_installed': psycopg2_ok,
    }
    base = {
        'id': 'database',
        'vars': vars_list,
        'meta': meta,
    }
    missing = []
    if not has_url:
        missing.append('DATABASE_URL')
    else:
        if not host:
            missing.append('DATABASE_HOST')
        if not user:
            missing.append('DATABASE_USER')
        if not has_password:
            missing.append('DATABASE_PASSWORD')
        if not database:
            missing.append('DATABASE_NAME')
    if not psycopg2_ok:
        missing.append('psycopg2')
    if missing:
        return {
            **base,
            'configured': False,
            'connected': False,
            'status': 'not_configured',
            'detail': '',
        }
    target = host or database or 'postgres'
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute('SELECT 1')
                row = cur.fetchone()
            if not row:
                return {
                    **base,
                    'configured': True,
                    'connected': False,
                    'status': 'error',
                    'detail': f'Empty response from {target}',
                }
            return {
                **base,
                'configured': True,
                'connected': True,
                'status': 'ok',
                'detail': f'Connected to {target}',
            }
        finally:
            conn.close()
    except Exception as exc:
        return {
            **base,
            'configured': True,
            'connected': False,
            'status': 'error',
            'detail': str(exc)[:240],
        }


def _jsonb_bucket_cloud_list(value):
    """Колонки users.buckets / users.clouds: JSONB или текст → list (для сессии и проверок доступа)."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return []
        return parsed if isinstance(parsed, list) else []
    if isinstance(value, (tuple, set)):
        return list(value)
    return []


def _migrate_legacy_builtin_role_names(cur):
    """
    Переименовать editor→storage_editor, viewer→storage_viewer.
    Порядок важен: user_roles.role_name REFERENCES roles(name) без ON UPDATE CASCADE.
    """
    from roles import LEGACY_ROLE_ALIASES, ROLE_PERMISSIONS, ROLE_STORAGE_ADMIN

    for old_name, new_name in LEGACY_ROLE_ALIASES.items():
        cur.execute("SELECT permissions FROM roles WHERE lower(name) = %s LIMIT 1", (old_name,))
        old_row = cur.fetchone()
        if not old_row:
            continue

        cur.execute("SELECT 1 FROM roles WHERE name = %s LIMIT 1", (new_name,))
        if not cur.fetchone():
            perms = old_row.get('permissions') if isinstance(old_row, dict) else old_row[0]
            if isinstance(perms, str):
                perms_json = perms
            else:
                perms_json = json.dumps(perms if perms is not None else [])
            # Сначала новая роль — иначе UPDATE user_roles упирается в FK
            cur.execute(
                """
                INSERT INTO roles (name, permissions)
                VALUES (%s, %s::jsonb)
                ON CONFLICT (name) DO NOTHING
                """,
                (new_name, perms_json),
            )

        cur.execute(
            "UPDATE users SET role = %s WHERE lower(role) = %s",
            (new_name, old_name),
        )
        cur.execute(
            """
            UPDATE user_roles SET role_name = %s
            WHERE lower(role_name) = %s
            """,
            (new_name, old_name),
        )
        cur.execute("DELETE FROM roles WHERE lower(name) = %s", (old_name,))

    # Новая роль без legacy-имени
    if ROLE_STORAGE_ADMIN in ROLE_PERMISSIONS:
        cur.execute(
            """
            INSERT INTO roles (name, permissions)
            VALUES (%s, %s::jsonb)
            ON CONFLICT (name) DO NOTHING
            """,
            (ROLE_STORAGE_ADMIN, json.dumps(ROLE_PERMISSIONS[ROLE_STORAGE_ADMIN])),
        )


def _seed_builtin_roles(cur, *, overwrite=False):
    """Вставить встроенные роли. По умолчанию не трогать уже существующие (кастомизация в UI)."""
    from roles import ROLE_PERMISSIONS

    if overwrite:
        conflict_sql = """
            ON CONFLICT (name) DO UPDATE SET
                permissions = EXCLUDED.permissions
        """
    else:
        conflict_sql = "ON CONFLICT (name) DO NOTHING"

    for role_name, perms in ROLE_PERMISSIONS.items():
        cur.execute(
            f"""
            INSERT INTO roles (name, permissions)
            VALUES (%s, %s::jsonb)
            {conflict_sql}
            """,
            (role_name, json.dumps(perms)),
        )


def _seed_meilisearch_settings(cur):
    """Дефолтные параметры Meilisearch (не перезаписывает уже заданные ключи)."""
    from meilisearch import MEILI_SETTING_DEFAULTS

    cur.execute("DELETE FROM meilisearch WHERE key = 'MEILI_DISABLED'")
    for key, value in MEILI_SETTING_DEFAULTS.items():
        cur.execute(
            """
            INSERT INTO meilisearch (key, value)
            VALUES (%s, %s)
            ON CONFLICT (key) DO NOTHING
            """,
            (key, value),
        )


def get_meilisearch_settings() -> dict:
    """Все ключи/значения из public.meilisearch."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT key, value FROM meilisearch')
            return {row['key']: (row['value'] if row['value'] is not None else '') for row in cur.fetchall()}
    finally:
        conn.close()


def get_meilisearch_setting(key: str, default: str = '') -> str:
    """Одно значение из public.meilisearch."""
    key = (key or '').strip()
    if not key:
        return default
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT value FROM meilisearch WHERE key = %s', (key,))
            row = cur.fetchone()
            if not row:
                return default
            return row['value'] if row['value'] is not None else default
    finally:
        conn.close()


def set_meilisearch_settings(updates: dict) -> dict:
    """Upsert ключей в public.meilisearch. Возвращает актуальный словарь настроек."""
    if not updates:
        return get_meilisearch_settings()
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            for key, value in updates.items():
                key = (key or '').strip()
                if not key:
                    continue
                cur.execute(
                    """
                    INSERT INTO meilisearch (key, value, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (key) DO UPDATE SET
                        value = EXCLUDED.value,
                        updated_at = NOW()
                    """,
                    (key, '' if value is None else str(value)),
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return get_meilisearch_settings()


def _ensure_preview_permission(cur):
    """Одноразовая миграция: добавить preview ролям с download_file.

    Не перезапускается при каждом init_schema — иначе снятие preview в UI
    откатывалось бы после рестарта приложения.
    """
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
            id VARCHAR(128) PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    cur.execute(
        """
        INSERT INTO public.schema_migrations (id)
        VALUES ('preview_permission_v1')
        ON CONFLICT (id) DO NOTHING
        RETURNING id
        """
    )
    if not cur.fetchone():
        return

    # Уже есть у какой-то роли (seed или прошлый ensure) — не дописываем снятые права.
    cur.execute(
        """
        SELECT 1
        FROM public.roles
        WHERE permissions @> %s::jsonb
        LIMIT 1
        """,
        (json.dumps(['preview']),),
    )
    if cur.fetchone():
        return

    cur.execute("SELECT name, permissions FROM public.roles")
    for row in cur.fetchall() or []:
        name = row.get('name') if isinstance(row, dict) else row[0]
        perms = row.get('permissions') if isinstance(row, dict) else row[1]
        if isinstance(perms, str):
            try:
                perms = json.loads(perms) if perms else []
            except Exception:
                perms = []
        if not isinstance(perms, list):
            continue
        if 'preview' in perms or 'download_file' not in perms:
            continue
        new_perms = list(perms) + ['preview']
        cur.execute(
            """
            UPDATE public.roles
            SET permissions = %s::jsonb
            WHERE name = %s
            """,
            (json.dumps(new_perms), name),
        )


# Схема public в новых БД уже есть; IF NOT EXISTS — если схему удалили или БД пустая.
# Явная схема public.* для совместимости с пустыми/нестандартными search_path.
_INIT_SCHEMA_SQL = """
CREATE SCHEMA IF NOT EXISTS public;
SET search_path TO public;

CREATE TABLE IF NOT EXISTS public.users (
    username VARCHAR(255) PRIMARY KEY,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(64) NOT NULL,
    buckets JSONB NOT NULL DEFAULT '[]',
    clouds JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS public.roles (
    name VARCHAR(64) PRIMARY KEY,
    permissions JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    username VARCHAR(255) NOT NULL REFERENCES public.users(username) ON DELETE CASCADE,
    bucket_id VARCHAR(255) NOT NULL,
    role_name VARCHAR(64) NOT NULL REFERENCES public.roles(name),
    PRIMARY KEY (username, bucket_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_bucket_id
    ON public.user_roles (bucket_id);

CREATE TABLE IF NOT EXISTS public.buckets (
    cloud_id VARCHAR(128) NOT NULL,
    cloud_name VARCHAR(255),
    cloud_icon VARCHAR(64),
    endpoint_url VARCHAR(512),
    display_name VARCHAR(255) NOT NULL,
    bucket_name VARCHAR(255) NOT NULL,
    bucket_id VARCHAR(255),
    aws_access_key_id VARCHAR(512),
    aws_secret_access_key VARCHAR(512),
    ca_bundle_path VARCHAR(512),
    region_name VARCHAR(64),
    skip_tls_verify BOOLEAN DEFAULT false,
    PRIMARY KEY (cloud_id, display_name)
);

CREATE TABLE IF NOT EXISTS public.clouds (
    cloud_id VARCHAR(128) NOT NULL,
    name VARCHAR(255),
    display_name VARCHAR(255),
    endpoint_url VARCHAR(512)
);

ALTER TABLE public.buckets DROP COLUMN IF EXISTS cloud_display_name;
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS cloud_name VARCHAR(255);
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS cloud_icon VARCHAR(64);
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS endpoint_url VARCHAR(512);
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS bucket_id VARCHAR(255);
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS aws_access_key_id VARCHAR(512);
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS aws_secret_access_key VARCHAR(512);
ALTER TABLE public.buckets ALTER COLUMN aws_secret_access_key TYPE TEXT;
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS ca_bundle_path VARCHAR(512);
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS region_name VARCHAR(64);
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS skip_tls_verify BOOLEAN DEFAULT false;
ALTER TABLE public.buckets ALTER COLUMN skip_tls_verify SET DEFAULT false;
UPDATE public.buckets SET skip_tls_verify = false WHERE skip_tls_verify IS NULL;
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS search_reindexed_at TIMESTAMPTZ;
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS search_index_enabled BOOLEAN DEFAULT true;
UPDATE public.buckets SET search_index_enabled = true WHERE search_index_enabled IS NULL;
ALTER TABLE public.buckets ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
ALTER TABLE public.clouds DROP COLUMN IF EXISTS icon;
ALTER TABLE public.clouds ADD COLUMN IF NOT EXISTS endpoint_url VARCHAR(512);
ALTER TABLE public.clouds ADD COLUMN IF NOT EXISTS public_url_enabled BOOLEAN DEFAULT false;
UPDATE public.clouds SET public_url_enabled = false WHERE public_url_enabled IS NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS given_name VARCHAR(255);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS family_name VARCHAR(255);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS middle_name VARCHAR(255);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
UPDATE public.users SET created_at = NOW() WHERE created_at IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'clouds'
          AND constraint_name = 'clouds_pkey'
    ) THEN
        ALTER TABLE public.clouds DROP CONSTRAINT clouds_pkey;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clouds_cloud_id_endpoint_url
    ON public.clouds (
        cloud_id,
        COALESCE(NULLIF(BTRIM(endpoint_url), ''), '')
    );

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    id VARCHAR(128) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.meilisearch (
    key VARCHAR(128) PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.operation_jobs (
    id UUID PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    op VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    history JSONB NOT NULL DEFAULT '[]'::jsonb,
    error TEXT,
    cancel_requested BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_operation_jobs_username_status
    ON public.operation_jobs (username, status);
CREATE INDEX IF NOT EXISTS idx_operation_jobs_finished_at
    ON public.operation_jobs (finished_at);
"""


def init_schema(conn=None):
    """
    Создаёт схему public и таблицы users, roles, buckets, clouds, meilisearch;
    приводит устаревшие колонки/значения skip_tls_verify.
    Если conn не передан — открывается своё подключение, выполняется commit.
    Если conn передан (внешняя транзакция) — commit/rollback не вызываются.
    """
    close = False
    if conn is None:
        conn = get_connection()
        close = True
    try:
        with conn.cursor() as cur:
            # Несколько gunicorn worker'ов зовут init_schema параллельно
            cur.execute("SELECT pg_advisory_lock(%s)", (87201401,))
            try:
                cur.execute(
                    """
                    DO $$
                    BEGIN
                      IF to_regclass('public.user_bucket_roles') IS NOT NULL
                         AND to_regclass('public.user_roles') IS NULL THEN
                        ALTER TABLE public.user_bucket_roles RENAME TO user_roles;
                      END IF;
                    END $$;
                    """
                )
                cur.execute(
                    """
                    DO $$
                    BEGIN
                      IF to_regclass('public.idx_user_bucket_roles_bucket_id') IS NOT NULL
                         AND to_regclass('public.idx_user_roles_bucket_id') IS NULL THEN
                        ALTER INDEX public.idx_user_bucket_roles_bucket_id
                          RENAME TO idx_user_roles_bucket_id;
                      END IF;
                    END $$;
                    """
                )
                cur.execute(_INIT_SCHEMA_SQL)
                # Переименование legacy-колонки (имя собрано конкатенацией, чтобы не дублировать старый идентификатор в коде).
                cur.execute(
                    """
                    DO $$
                    BEGIN
                      IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'buckets'
                          AND column_name = 'cloud' || '_endpoint' || '_url'
                      ) AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'buckets'
                          AND column_name = 'endpoint' || '_url'
                      ) THEN
                        EXECUTE 'ALTER TABLE public.buckets RENAME COLUMN '
                          || quote_ident('cloud' || '_endpoint' || '_url') || ' TO ' || quote_ident('endpoint' || '_url');
                      END IF;
                    END $$;
                    """
                )
                _migrate_legacy_builtin_role_names(cur)
                _seed_builtin_roles(cur, overwrite=False)
                _seed_meilisearch_settings(cur)
                _ensure_preview_permission(cur)
                _backfill_user_bucket_roles(cur)
                _encrypt_plaintext_bucket_secrets(cur)
            finally:
                cur.execute("SELECT pg_advisory_unlock(%s)", (87201401,))
        if close:
            conn.commit()
    except Exception:
        if close:
            conn.rollback()
        raise
    finally:
        if close:
            conn.close()

def _encrypt_plaintext_bucket_secrets(cur):
    """Однократно зашифровать legacy plaintext aws_secret_access_key в buckets."""
    from secrets_crypto import ENC_PREFIX, encrypt_secret, is_encrypted

    cur.execute(
        """
        SELECT cloud_id, display_name, aws_secret_access_key
        FROM buckets
        WHERE aws_secret_access_key IS NOT NULL
          AND BTRIM(aws_secret_access_key) <> ''
          AND aws_secret_access_key NOT LIKE %s
        """,
        (ENC_PREFIX + '%',),
    )
    rows = cur.fetchall() or []
    for row in rows:
        plain = row.get('aws_secret_access_key')
        if is_encrypted(plain):
            continue
        encrypted = encrypt_secret(plain)
        if encrypted == plain:
            continue
        cur.execute(
            """
            UPDATE buckets
            SET aws_secret_access_key = %s
            WHERE cloud_id = %s AND display_name = %s
            """,
            (encrypted, row['cloud_id'], row['display_name']),
        )


def _decrypt_bucket_secret_fields(row):
    """Расшифровать aws_secret_access_key в dict-строке бакета (in-place)."""
    if not row or not isinstance(row, dict):
        return row
    if 'aws_secret_access_key' not in row:
        return row
    from secrets_crypto import decrypt_secret
    try:
        row['aws_secret_access_key'] = decrypt_secret(row.get('aws_secret_access_key'))
    except Exception:
        # Оставляем как есть — S3 вызов упадёт явно; не маскируем ошибку ключа.
        pass
    return row


def _normalize_bucket_roles_input(bucket_roles):
    """Список {bucket_id, role} или dict bucket_id→role → list[{bucket_id, role}]."""
    if not bucket_roles:
        return []
    if isinstance(bucket_roles, dict):
        out = []
        for bucket_id, role_name in bucket_roles.items():
            bid = (bucket_id or '').strip()
            role = (role_name or '').strip()
            if bid and role:
                out.append({'bucket_id': bid, 'role': role})
        return out
    if not isinstance(bucket_roles, list):
        return []
    out = []
    for item in bucket_roles:
        if not isinstance(item, dict):
            continue
        bid = (item.get('bucket_id') or item.get('bucket') or '').strip()
        role = (item.get('role') or item.get('role_name') or '').strip()
        if bid and role:
            out.append({'bucket_id': bid, 'role': role})
    return out


def _backfill_user_bucket_roles(cur):
    """Миграция: для существующих users.buckets создать grants с users.role."""
    cur.execute(
        """
        INSERT INTO user_roles (username, bucket_id, role_name)
        SELECT u.username, b.elem, u.role
        FROM users u
        CROSS JOIN LATERAL jsonb_array_elements_text(u.buckets) AS b(elem)
        WHERE b.elem IS NOT NULL
          AND b.elem <> '*'
          AND BTRIM(b.elem) <> ''
        ON CONFLICT (username, bucket_id) DO NOTHING
        """
    )


def _normalize_user_email(raw):
    """Пустая строка → None; иначе trimmed email."""
    if raw is None:
        return None
    s = str(raw).strip()
    return s or None


def _normalize_user_text(raw):
    """Пустая строка → None; иначе trimmed текст."""
    if raw is None:
        return None
    s = str(raw).strip()
    return s or None


def _bucket_roles_rows_from_cursor(cur, username):
    cur.execute(
        """
        SELECT bucket_id, role_name
        FROM user_roles
        WHERE username = %s
        ORDER BY bucket_id
        """,
        (username,),
    )
    return [
        {'bucket_id': r['bucket_id'], 'role': r['role_name']}
        for r in cur.fetchall()
    ]


def get_user_bucket_roles(username):
    """Список назначений ролей по бакетам: [{bucket_id, role}, ...]."""
    if not username:
        return []
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                return _bucket_roles_rows_from_cursor(cur, username)
        finally:
            conn.close()
    except Exception:
        return []


def get_user_bucket_roles_map(username):
    """Словарь bucket_id → role_name."""
    return {
        item['bucket_id']: item['role']
        for item in get_user_bucket_roles(username)
    }


def _fetch_all_user_bucket_roles(cur):
    """Все grants: {username: [{bucket_id, role}, ...]}. Один запрос вместо N+1."""
    cur.execute(
        """
        SELECT username, bucket_id, role_name
        FROM user_roles
        ORDER BY username, bucket_id
        """
    )
    by_user = {}
    for row in cur.fetchall():
        by_user.setdefault(row['username'], []).append({
            'bucket_id': row['bucket_id'],
            'role': row['role_name'],
        })
    return by_user


def set_user_bucket_roles(username, bucket_roles, conn=None):
    """Заменить все назначения ролей пользователя по бакетам."""
    grants = _normalize_bucket_roles_input(bucket_roles)
    own = conn is None
    if own:
        conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM user_roles WHERE username = %s",
                (username,),
            )
            for grant in grants:
                cur.execute(
                    """
                    INSERT INTO user_roles (username, bucket_id, role_name)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (username, bucket_id) DO UPDATE SET
                        role_name = EXCLUDED.role_name
                    """,
                    (username, grant['bucket_id'], grant['role']),
                )
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def bucket_roles_to_allowed_buckets(bucket_roles, fallback_buckets=None):
    """Ключи grants + legacy buckets (без дубликатов)."""
    grants = _normalize_bucket_roles_input(bucket_roles)
    ids = [g['bucket_id'] for g in grants]
    if fallback_buckets:
        for tok in _jsonb_bucket_cloud_list(fallback_buckets):
            if tok and tok not in ids:
                ids.append(tok)
    return ids


def get_user(username):
    """
    Возвращает пользователя по username или None.
    Формат: {
        password_hash, role, allowed_buckets, allowed_clouds,
        bucket_roles: [{bucket_id, role}, ...]
    }
    """
    if not username:
        return None
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT u.username, u.password, u.role, u.buckets, u.clouds, u.email,
                           u.given_name, u.family_name, u.middle_name, u.full_name,
                           u.created_at, u.last_login_at,
                           EXISTS (
                               SELECT 1 FROM user_roles ubr
                               WHERE ubr.username = u.username
                                 AND ubr.role_name <> u.role
                           ) AS has_custom_roles
                    FROM users u
                    WHERE u.username = %s
                    """,
                    (username,),
                )
                row = cur.fetchone()
                if not row:
                    return None
                buckets = _jsonb_bucket_cloud_list(row['buckets'])
                clouds = _jsonb_bucket_cloud_list(row['clouds'])
                bucket_roles = _bucket_roles_rows_from_cursor(cur, username)
            if bucket_roles and '*' not in buckets:
                grant_ids = {g['bucket_id'] for g in bucket_roles}
                for bid in grant_ids:
                    if bid not in buckets:
                        buckets.append(bid)
            return {
                'password_hash': row['password'],
                'role': row['role'],
                'allowed_buckets': buckets,
                'allowed_clouds': clouds,
                'bucket_roles': bucket_roles,
                'email': _normalize_user_email(row.get('email')),
                'given_name': _normalize_user_text(row.get('given_name')),
                'family_name': _normalize_user_text(row.get('family_name')),
                'middle_name': _normalize_user_text(row.get('middle_name')),
                'full_name': _normalize_user_text(row.get('full_name')),
                'created_at': row.get('created_at'),
                'last_login_at': row.get('last_login_at'),
                'has_custom_roles': bool(row.get('has_custom_roles')),
            }
        finally:
            conn.close()
    except Exception:
        return None


def get_buckets_config():
    """
    Загружает конфигурацию бакетов из таблицы buckets.
    Возвращает структуру как BUCKETS_CONFIG: { cloud_id: { name, display_name (как name), icon, endpoint_url, cloud_id, buckets: { ... } } }
    """
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT cloud_id, cloud_name, cloud_icon, endpoint_url,
                           display_name, bucket_name, bucket_id,
                           aws_access_key_id, aws_secret_access_key, ca_bundle_path,
                           region_name, skip_tls_verify
                    FROM buckets
                    ORDER BY cloud_id, display_name
                """)
                rows = cur.fetchall()
            if not rows:
                return {}
            result = {}
            for r in rows:
                cid = r['cloud_id']
                if cid not in result:
                    cn = (r.get('cloud_name') or cid)
                    result[cid] = {
                        'name': cn,
                        'display_name': cn,
                        'icon': r['cloud_icon'] or 'fa-cloud',
                        'endpoint_url': r['endpoint_url'] or '',
                        'cloud_id': cid,
                        'buckets': {},
                    }
                bc = {
                    'bucket_name': r['bucket_name'],
                    'aws_access_key_id': r['aws_access_key_id'],
                    'aws_secret_access_key': r['aws_secret_access_key'],
                    'endpoint_url': (r.get('endpoint_url') or '').strip(),
                }
                _decrypt_bucket_secret_fields(bc)
                if r['bucket_id']:
                    bc['bucket_id'] = r['bucket_id']
                if r['ca_bundle_path']:
                    bc['ca_bundle_path'] = r['ca_bundle_path']
                if r['region_name']:
                    bc['region_name'] = r['region_name']
                if r['skip_tls_verify'] is not None:
                    bc['skip_tls_verify'] = r['skip_tls_verify']
                result[cid]['buckets'][r['display_name']] = bc
            # Пустые группы (без бакетов в БД), чтобы отображались в UI
            if 'other' not in result:
                result['other'] = {
                    'name': 'Другие бакеты',
                    'display_name': 'Другие облака',
                    'icon': 'fa-cloud',
                    'endpoint_url': 'https://s3.example.com',
                    'cloud_id': 'other',
                    'public_url_enabled': False,
                    'buckets': {},
                }
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT cloud_id, BOOL_OR(COALESCE(public_url_enabled, false)) AS public_url_enabled
                        FROM clouds
                        GROUP BY cloud_id
                    """)
                    for crow in cur.fetchall():
                        cid = crow['cloud_id']
                        if cid in result:
                            result[cid]['public_url_enabled'] = bool(crow['public_url_enabled'])
            except Exception:
                pass
            for cid in result:
                if 'public_url_enabled' not in result[cid]:
                    result[cid]['public_url_enabled'] = False
            return result
        finally:
            conn.close()
    except Exception:
        return {}


def list_buckets_rows():
    """Список всех строк из таблицы buckets (для настроек). Секреты не отдаём в открытом виде."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT cloud_id, cloud_name, cloud_icon, endpoint_url,
                           display_name, bucket_name, bucket_id,
                           aws_access_key_id IS NOT NULL AND aws_access_key_id != '' AS has_access_key,
                           aws_secret_access_key IS NOT NULL AND aws_secret_access_key != '' AS has_secret_key,
                           ca_bundle_path, region_name, skip_tls_verify,
                           search_reindexed_at,
                           COALESCE(search_index_enabled, true) AS search_index_enabled,
                           created_by
                    FROM buckets
                    ORDER BY cloud_id, display_name
                """)
                return cur.fetchall()
        finally:
            conn.close()
    except Exception:
        return []


def bucket_s3_target_exists(bucket_name, endpoint_url, exclude_cloud_id=None, exclude_display_name=None):
    """Есть ли в FM другая запись с тем же S3-бакетом (bucket_name + endpoint_url).

    exclude_* — не учитывать текущую строку при редактировании.
    """
    bn = (bucket_name or '').strip()
    ep = (endpoint_url or '').strip()
    if not bn or not ep:
        return False
    try:
        from security import normalize_endpoint_url
        target_ep = normalize_endpoint_url(ep)
        if not target_ep:
            return False
        excl_cid = (exclude_cloud_id or '').strip() or None
        excl_dn = (exclude_display_name or '').strip() or None
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT cloud_id, display_name, bucket_name, endpoint_url
                    FROM buckets
                    WHERE LOWER(BTRIM(bucket_name)) = LOWER(BTRIM(%s))
                      AND endpoint_url IS NOT NULL
                      AND BTRIM(endpoint_url) <> ''
                    """,
                    (bn,),
                )
                for row in cur.fetchall() or []:
                    if (
                        excl_cid is not None
                        and excl_dn is not None
                        and str(row.get('cloud_id') or '') == excl_cid
                        and str(row.get('display_name') or '') == excl_dn
                    ):
                        continue
                    existing_ep = normalize_endpoint_url(row.get('endpoint_url'))
                    if existing_ep and existing_ep == target_ep:
                        return True
        finally:
            conn.close()
    except Exception:
        return False
    return False


def list_cloud_endpoints():
    """Endpoint URL только из таблицы clouds (без утечки из чужих бакетов)."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT cloud_id, ''::varchar(255) AS bucket_display_name,
                           BTRIM(endpoint_url) AS endpoint_url
                    FROM clouds
                    WHERE endpoint_url IS NOT NULL
                      AND BTRIM(endpoint_url) <> ''
                    ORDER BY cloud_id, endpoint_url
                    """
                )
                return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
    except Exception:
        return []


def is_bucket_search_index_enabled(bucket_id) -> bool:
    """Включена ли индексация Meilisearch для bucket_id (по умолчанию да)."""
    bucket_id = (bucket_id or '').strip()
    if not bucket_id:
        return False
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT COALESCE(search_index_enabled, true) AS search_index_enabled
                    FROM buckets WHERE bucket_id = %s
                    """,
                    (bucket_id,),
                )
                row = cur.fetchone()
            if not row:
                return True
            return bool(row.get('search_index_enabled'))
        finally:
            conn.close()
    except Exception:
        return True


def get_search_index_disabled_bucket_ids():
    """Множество bucket_id с отключённой индексацией."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT bucket_id FROM buckets
                    WHERE bucket_id IS NOT NULL AND bucket_id != ''
                      AND COALESCE(search_index_enabled, true) = false
                    """,
                )
                rows = cur.fetchall()
            return {str(r['bucket_id']).strip() for r in rows if r.get('bucket_id')}
        finally:
            conn.close()
    except Exception:
        return set()


def set_bucket_search_index_enabled(bucket_id, enabled):
    """Включить/отключить индексацию Meilisearch для bucket_id."""
    bucket_id = (bucket_id or '').strip()
    if not bucket_id:
        return False
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE buckets SET search_index_enabled = %s
                    WHERE bucket_id = %s
                    """,
                    (bool(enabled), bucket_id),
                )
                updated = cur.rowcount > 0
            conn.commit()
            return updated
        finally:
            conn.close()
    except Exception:
        return False


def set_bucket_search_reindexed_at(bucket_id, reindexed_at=None):
    """Записать время последней переиндексации Meilisearch для bucket_id."""
    bucket_id = (bucket_id or '').strip()
    if not bucket_id:
        return
    if reindexed_at is None:
        reindexed_at = datetime.now(timezone.utc)
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE buckets SET search_reindexed_at = %s WHERE bucket_id = %s",
                    (reindexed_at, bucket_id),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def get_bucket_row(cloud_id, display_name):
    """Один бакет по (cloud_id, display_name) со всеми полями (для редактирования)."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT cloud_id, cloud_name, cloud_icon, endpoint_url,
                           display_name, bucket_name, bucket_id,
                           aws_access_key_id, aws_secret_access_key, ca_bundle_path,
                           region_name, skip_tls_verify, created_by
                    FROM buckets
                    WHERE cloud_id = %s AND display_name = %s
                """, (cloud_id, display_name))
                row = cur.fetchone()
                return _decrypt_bucket_secret_fields(dict(row)) if row else None
        finally:
            conn.close()
    except Exception:
        return None


def update_bucket(cloud_id, display_name, bucket_name, bucket_id=None,
                  aws_access_key_id=None, aws_secret_access_key=None, cloud_name=None,
                  cloud_icon=None, endpoint_url=None,
                  ca_bundle_path=None, region_name=None, skip_tls_verify=None,
                  target_cloud_id=None, target_display_name=None):
    """Обновить бакет по (cloud_id, display_name). target_* — новый ключ строки (смена облака/отображаемого имени)."""
    row = get_bucket_row(cloud_id, display_name)
    if not row:
        return
    tcid = target_cloud_id if target_cloud_id is not None else cloud_id
    tdisp = target_display_name if target_display_name is not None else display_name
    row['bucket_name'] = bucket_name if bucket_name is not None else row['bucket_name']
    if bucket_id is not None:
        s = str(bucket_id).strip()
        row['bucket_id'] = s if s else row.get('bucket_id')
    else:
        row['bucket_id'] = row.get('bucket_id')
    row['aws_access_key_id'] = aws_access_key_id if aws_access_key_id is not None else row.get('aws_access_key_id')
    from secrets_crypto import encrypt_secret
    if aws_secret_access_key is not None:
        sk = aws_secret_access_key
    else:
        sk = row.get('aws_secret_access_key')
    row['aws_secret_access_key'] = encrypt_secret(sk) if sk else sk
    row['cloud_name'] = cloud_name if cloud_name is not None else row.get('cloud_name')
    row['cloud_icon'] = cloud_icon if cloud_icon is not None else row.get('cloud_icon')
    row['endpoint_url'] = endpoint_url if endpoint_url is not None else row.get('endpoint_url')
    row['ca_bundle_path'] = ca_bundle_path if ca_bundle_path is not None else row.get('ca_bundle_path')
    row['region_name'] = region_name if region_name is not None else row.get('region_name')
    row['skip_tls_verify'] = skip_tls_verify if skip_tls_verify is not None else row.get('skip_tls_verify')
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            b = row.get('bucket_id')
            if not b or not str(b).strip():
                row['bucket_id'] = allocate_bucket_id(
                    cur, cloud_id, display_name,
                )
            cur.execute("""
                UPDATE buckets SET
                    cloud_id = %s, display_name = %s,
                    bucket_name = %s, bucket_id = %s,
                    aws_access_key_id = %s, aws_secret_access_key = %s,
                    cloud_name = %s, cloud_icon = %s, endpoint_url = %s,
                    ca_bundle_path = %s, region_name = %s, skip_tls_verify = %s
                WHERE cloud_id = %s AND display_name = %s
            """, (
                tcid, tdisp,
                row['bucket_name'], row['bucket_id'],
                row['aws_access_key_id'], row['aws_secret_access_key'],
                row['cloud_name'], row['cloud_icon'], row['endpoint_url'],
                row['ca_bundle_path'], row['region_name'], row['skip_tls_verify'],
                cloud_id, display_name,
            ))
        conn.commit()
    finally:
        conn.close()


def delete_bucket(cloud_id, display_name):
    """Удалить бакет по (cloud_id, display_name)."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM buckets WHERE cloud_id = %s AND display_name = %s", (cloud_id, display_name))
        conn.commit()
    finally:
        conn.close()


def list_clouds():
    """Список облаков из таблицы clouds для выбора при добавлении пользователя/бакета."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO clouds (cloud_id, name, display_name, endpoint_url)
                    SELECT
                        b.cloud_id,
                        COALESCE(MAX(NULLIF(BTRIM(b.cloud_name), '')), b.cloud_id) AS cloud_name,
                        COALESCE(MAX(NULLIF(BTRIM(b.cloud_name), '')), b.cloud_id) AS cloud_display_name,
                        MIN(NULLIF(BTRIM(b.endpoint_url), '')) AS endpoint_url
                    FROM buckets b
                    GROUP BY b.cloud_id
                    HAVING NOT EXISTS (
                        SELECT 1 FROM clouds c WHERE c.cloud_id = b.cloud_id
                    )
                """)
                conn.commit()
                cur.execute("""
                    SELECT cloud_id, COALESCE(MAX(display_name), MAX(name), cloud_id) AS label
                    FROM clouds
                    GROUP BY cloud_id
                    ORDER BY cloud_id
                """)
                rows = cur.fetchall()
                return [{"id": r["cloud_id"], "label": r["label"] or r["cloud_id"]} for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def list_cloud_rows():
    """Список облаков из таблицы clouds для вкладки настроек."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO clouds (cloud_id, name, display_name, endpoint_url)
                    SELECT
                        b.cloud_id,
                        COALESCE(MAX(NULLIF(BTRIM(b.cloud_name), '')), b.cloud_id) AS cloud_name,
                        COALESCE(MAX(NULLIF(BTRIM(b.cloud_name), '')), b.cloud_id) AS cloud_display_name,
                        MIN(NULLIF(BTRIM(b.endpoint_url), '')) AS endpoint_url
                    FROM buckets b
                    GROUP BY b.cloud_id
                    HAVING NOT EXISTS (
                        SELECT 1 FROM clouds c WHERE c.cloud_id = b.cloud_id
                    )
                """)
                conn.commit()
                cur.execute("""
                    SELECT
                        cloud_id,
                        COALESCE(MAX(name), cloud_id) AS name,
                        COALESCE(MAX(display_name), MAX(name), cloud_id) AS display_name,
                        ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(BTRIM(endpoint_url), '')), NULL) AS endpoint_url,
                        BOOL_OR(COALESCE(public_url_enabled, false)) AS public_url_enabled
                    FROM clouds
                    GROUP BY cloud_id
                    ORDER BY cloud_id
                """)
                rows = cur.fetchall()
                return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def get_cloud_row(cloud_id):
    """Одно облако по cloud_id."""
    if not cloud_id:
        return None
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                        cloud_id,
                        COALESCE(MAX(name), cloud_id) AS name,
                        COALESCE(MAX(display_name), MAX(name), cloud_id) AS display_name,
                        ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(BTRIM(endpoint_url), '')), NULL) AS endpoint_url,
                        BOOL_OR(COALESCE(public_url_enabled, false)) AS public_url_enabled
                    FROM clouds
                    WHERE cloud_id = %s
                    GROUP BY cloud_id
                    """,
                    (cloud_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
        finally:
            conn.close()
    except Exception:
        return None


def insert_cloud(cloud_id, display_name=None, endpoint_url=None, public_url_enabled=False):
    """Добавить облако в таблицу clouds."""
    cid = (cloud_id or "").strip()
    disp = (display_name or "").strip() or cid
    pub_url = bool(public_url_enabled)
    endpoints = []
    seen = set()
    if isinstance(endpoint_url, (list, tuple, set)):
        for v in endpoint_url:
            s = str(v or '').strip()
            if not s or s in seen:
                continue
            seen.add(s)
            endpoints.append(s)
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            if not endpoints:
                cur.execute(
                    """
                    INSERT INTO clouds (cloud_id, name, display_name, endpoint_url, public_url_enabled)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (cloud_id, COALESCE(NULLIF(BTRIM(endpoint_url), ''), '')) DO NOTHING
                    """,
                    (cid, disp, disp, None, pub_url),
                )
            else:
                for ep in endpoints:
                    cur.execute(
                        """
                        INSERT INTO clouds (cloud_id, name, display_name, endpoint_url, public_url_enabled)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (cloud_id, COALESCE(NULLIF(BTRIM(endpoint_url), ''), '')) DO NOTHING
                        """,
                        (cid, disp, disp, ep, pub_url),
                    )
        conn.commit()
    finally:
        conn.close()


def update_cloud(cloud_id, display_name=None, endpoint_url=None, public_url_enabled=None):
    """Обновить display_name/endpoint_url облака и синхронизировать buckets по cloud_id."""
    cid = (cloud_id or "").strip()
    current = get_cloud_row(cid)
    if not current:
        return
    new_display = (display_name if display_name is not None else current.get("display_name") or current.get("name") or cid)
    new_public_url = (
        bool(public_url_enabled)
        if public_url_enabled is not None
        else bool(current.get('public_url_enabled'))
    )
    existing_raw = current.get("endpoint_url")
    existing_endpoints = [str(v).strip() for v in existing_raw] if isinstance(existing_raw, list) else []
    existing_endpoints = [v for v in existing_endpoints if v]
    new_endpoint = endpoint_url if endpoint_url is not None else existing_endpoints
    new_display = str(new_display).strip() or cid
    endpoints = []
    seen = set()
    if isinstance(new_endpoint, (list, tuple, set)):
        for v in new_endpoint:
            s = str(v or '').strip()
            if not s or s in seen:
                continue
            seen.add(s)
            endpoints.append(s)
    bucket_endpoint = endpoints[0] if endpoints else None
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM clouds WHERE cloud_id = %s", (cid,))
            if not endpoints:
                cur.execute(
                    """
                    INSERT INTO clouds (cloud_id, name, display_name, endpoint_url, public_url_enabled)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (cid, new_display, new_display, None, new_public_url),
                )
            else:
                for ep in endpoints:
                    cur.execute(
                        """
                        INSERT INTO clouds (cloud_id, name, display_name, endpoint_url, public_url_enabled)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (cid, new_display, new_display, ep, new_public_url),
                    )
            cur.execute(
                """
                UPDATE buckets
                SET cloud_name = %s, endpoint_url = %s
                WHERE cloud_id = %s
                """,
                (new_display, bucket_endpoint, cid),
            )
        conn.commit()
    finally:
        conn.close()


def count_buckets_with_cloud(cloud_id):
    """Количество бакетов, привязанных к cloud_id."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS c FROM buckets WHERE cloud_id = %s",
                    (cloud_id,),
                )
                row = cur.fetchone()
            return int(row["c"]) if row else 0
        finally:
            conn.close()
    except Exception:
        return 0


def delete_cloud(cloud_id):
    """Удалить облако по cloud_id."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM clouds WHERE cloud_id = %s", (cloud_id,))
        conn.commit()
    finally:
        conn.close()


def list_bucket_options():
    """Список бакетов для выбора при добавлении пользователя: id (bucket_id или cloud_id:display_name), label."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT cloud_id, display_name, bucket_id, bucket_name
                    FROM buckets
                    ORDER BY cloud_id, display_name
                """)
                rows = cur.fetchall()
            out = []
            for r in rows:
                bid = r["bucket_id"] if r.get("bucket_id") else "{}:{}".format(r["cloud_id"], r["display_name"])
                label = "{} ({})".format(r["display_name"], r["cloud_id"])
                out.append({
                    "id": bid,
                    "label": label,
                    "cloud_id": r["cloud_id"],
                    "display_name": r["display_name"],
                    "bucket_name": r.get("bucket_name") or "",
                })
            return out
        finally:
            conn.close()
    except Exception:
        return []


def list_endpoints():
    """
    Варианты URL для настроек бакета: уникальные endpoint_url из clouds и buckets.
    """
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT cloud_id, bucket_display_name, endpoint_url
                    FROM (
                        SELECT cloud_id,
                               ''::varchar(255) AS bucket_display_name,
                               BTRIM(endpoint_url) AS endpoint_url
                        FROM clouds
                        WHERE endpoint_url IS NOT NULL
                          AND BTRIM(endpoint_url) <> ''
                        UNION ALL
                        SELECT cloud_id,
                               ''::varchar(255) AS bucket_display_name,
                               BTRIM(endpoint_url) AS endpoint_url
                        FROM buckets
                        WHERE endpoint_url IS NOT NULL
                          AND BTRIM(endpoint_url) <> ''
                    ) AS combined
                    ORDER BY cloud_id, bucket_display_name, endpoint_url
                    """
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def list_users():
    """Список пользователей из таблицы users (без паролей) для настроек."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT u.username, u.role, u.buckets, u.clouds, u.last_login_at,
                           EXISTS (
                               SELECT 1 FROM user_roles ubr
                               WHERE ubr.username = u.username
                                 AND ubr.role_name <> u.role
                           ) AS has_custom_roles
                    FROM users u
                    ORDER BY LOWER(u.username)
                    """
                )
                rows = cur.fetchall()
            out = []
            for r in rows:
                buckets = _jsonb_bucket_cloud_list(r.get('buckets'))
                clouds = _jsonb_bucket_cloud_list(r.get('clouds'))
                out.append({
                    'username': r['username'],
                    'role': r['role'],
                    'buckets': buckets,
                    'clouds': clouds,
                    'has_custom_roles': bool(r.get('has_custom_roles')),
                    'last_login_at': r.get('last_login_at'),
                })
            return out
        finally:
            conn.close()
    except Exception:
        return []


def get_users_as_users_data():
    """
    Словарь в формате USERS_DATA: {username: {password_hash, role, allowed_buckets, allowed_clouds}}.
    """
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT username, password, role, buckets, clouds, email FROM users ORDER BY username"
                )
                rows = cur.fetchall()
                roles_by_user = _fetch_all_user_bucket_roles(cur)
            out = {}
            for r in rows:
                buckets = _jsonb_bucket_cloud_list(r.get("buckets"))
                clouds = _jsonb_bucket_cloud_list(r.get("clouds"))
                out[r["username"]] = {
                    "password_hash": r["password"],
                    "role": r["role"],
                    "allowed_buckets": buckets,
                    "allowed_clouds": clouds,
                    "bucket_roles": roles_by_user.get(r["username"], []),
                    "email": _normalize_user_email(r.get("email")),
                }
            return out
        finally:
            conn.close()
    except Exception:
        return {}


def list_roles():
    """Список ролей из таблицы roles для настроек."""
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT name, permissions FROM roles ORDER BY name")
                rows = cur.fetchall()
            out = []
            for r in rows:
                perms = r.get("permissions")
                if isinstance(perms, str):
                    perms = json.loads(perms) if perms else []
                if not isinstance(perms, list):
                    perms = []
                out.append({"name": r["name"], "permissions": perms})
            return out
        finally:
            conn.close()
    except Exception:
        return []


def get_role(name):
    """Одна роль по имени или None."""
    if not name:
        return None
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT name, permissions FROM roles WHERE name = %s", (name,)
                )
                r = cur.fetchone()
            if not r:
                return None
            perms = r.get("permissions")
            if isinstance(perms, str):
                perms = json.loads(perms) if perms else []
            if not isinstance(perms, list):
                perms = []
            return {"name": r["name"], "permissions": perms}
        finally:
            conn.close()
    except Exception:
        return None


def insert_role(name, permissions):
    """Добавить роль (name, permissions — список строк)."""
    permissions = permissions if isinstance(permissions, list) else []
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO roles (name, permissions)
                VALUES (%s, %s::jsonb)
                """,
                (name, json.dumps(permissions)),
            )
        conn.commit()
    finally:
        conn.close()


def update_role(name, permissions):
    """Обновить permissions у существующей роли."""
    permissions = permissions if isinstance(permissions, list) else []
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE roles SET permissions = %s::jsonb WHERE name = %s
                """,
                (json.dumps(permissions), name),
            )
        conn.commit()
    finally:
        conn.close()


def delete_role(name):
    """Удалить роль по имени."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM roles WHERE name = %s", (name,))
        conn.commit()
    finally:
        conn.close()


def count_users_with_role(role_name):
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS c FROM users WHERE role = %s", (role_name,)
                )
                row = cur.fetchone()
            return int(row["c"]) if row else 0
        finally:
            conn.close()
    except Exception:
        return 0


def update_user_email(username, email, conn=None):
    """Обновить email пользователя (NULL если пусто)."""
    if not username:
        return False
    normalized = _normalize_user_email(email)
    own = conn is None
    if own:
        conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET email = %s WHERE username = %s",
                (normalized, username),
            )
            updated = cur.rowcount > 0
        if own:
            conn.commit()
        return updated
    finally:
        if own:
            conn.close()


def update_user_sso_profile(username, email=None, given_name=None, family_name=None, full_name=None, middle_name=None, conn=None):
    """Синхронизировать профиль из SSO."""
    if not username:
        return False
    own = conn is None
    if own:
        conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                SET email = %s, given_name = %s, family_name = %s,
                    full_name = %s, middle_name = %s
                WHERE username = %s
                """,
                (
                    _normalize_user_email(email),
                    _normalize_user_text(given_name),
                    _normalize_user_text(family_name),
                    _normalize_user_text(full_name),
                    _normalize_user_text(middle_name),
                    username,
                ),
            )
            updated = cur.rowcount > 0
        if own:
            conn.commit()
        return updated
    finally:
        if own:
            conn.close()


def touch_user_last_login(username, conn=None):
    """Обновить время последнего входа."""
    if not username:
        return False
    own = conn is None
    if own:
        conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET last_login_at = NOW() WHERE username = %s",
                (username,),
            )
            updated = cur.rowcount > 0
        if own:
            conn.commit()
        return updated
    finally:
        if own:
            conn.close()


def insert_user(username, password_hash, role, buckets=None, clouds=None, bucket_roles=None, email=None, full_name=None, conn=None):
    """Добавить или обновить пользователя. buckets/clouds — списки, сохраняются как JSONB."""
    buckets = buckets if buckets is not None else []
    clouds = clouds if clouds is not None else []
    grants = _normalize_bucket_roles_input(bucket_roles)
    if grants and '*' not in buckets:
        buckets = bucket_roles_to_allowed_buckets(grants, buckets)
    own = conn is None
    if own:
        conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (username, password, role, buckets, clouds, email, full_name)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (username) DO UPDATE SET
                    password = EXCLUDED.password,
                    role = EXCLUDED.role,
                    buckets = EXCLUDED.buckets,
                    clouds = EXCLUDED.clouds,
                    email = EXCLUDED.email,
                    full_name = EXCLUDED.full_name
                """,
                (
                    username,
                    password_hash,
                    role,
                    json.dumps(buckets),
                    json.dumps(clouds),
                    _normalize_user_email(email),
                    _normalize_user_text(full_name),
                ),
            )
        set_user_bucket_roles(username, grants, conn=conn)
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def update_user(username, role, buckets=None, clouds=None, password_hash=None, bucket_roles=None, email=None, full_name=None):
    """Обновить пользователя. password_hash=None — пароль не менять. bucket_roles=None — grants не менять."""
    buckets = buckets if buckets is not None else []
    clouds = clouds if clouds is not None else []
    grants = None
    if bucket_roles is not None:
        grants = _normalize_bucket_roles_input(bucket_roles)
        if '*' not in buckets:
            buckets = bucket_roles_to_allowed_buckets(grants, buckets)
    normalized_email = _normalize_user_email(email)
    normalized_full_name = _normalize_user_text(full_name)
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            if password_hash is not None:
                cur.execute(
                    """
                    UPDATE users
                    SET password = %s, role = %s, buckets = %s, clouds = %s, email = %s, full_name = %s
                    WHERE username = %s
                    """,
                    (
                        password_hash, role, json.dumps(buckets), json.dumps(clouds),
                        normalized_email, normalized_full_name, username,
                    ),
                )
            else:
                cur.execute(
                    """
                    UPDATE users SET role = %s, buckets = %s, clouds = %s, email = %s, full_name = %s
                    WHERE username = %s
                    """,
                    (
                        role, json.dumps(buckets), json.dumps(clouds),
                        normalized_email, normalized_full_name, username,
                    ),
                )
            updated = cur.rowcount > 0
        if updated and grants is not None:
            set_user_bucket_roles(username, grants, conn=conn)
        conn.commit()
        return updated
    finally:
        conn.close()


def _admin_password_from_env():
    """Пароль bootstrap-admin из APP_ADMIN_PASSWORD."""
    val = (os.environ.get('APP_ADMIN_PASSWORD') or '').strip()
    return val or None


def ensure_startup_admin():
    """
    Учётная запись admin, полные права (buckets/clouds ['*']).

    - admin нет — создаём (APP_ADMIN_PASSWORD или «admin»).
    - APP_ADMIN_PASSWORD задан, admin есть, ещё не входил и хэш не совпадает — обновляем
      (первый запуск после config.py schema с дефолтным паролем).
    - admin уже есть — пароль не меняем (в т.ч. без APP_ADMIN_PASSWORD).
    """
    import roles as roles_module
    from users import hash_password, verify_password

    env_pw = _admin_password_from_env()
    row = get_user('admin')
    role = roles_module.ROLE_ADMIN
    full_access = (['*'], ['*'])

    if not row:
        insert_user('admin', hash_password(env_pw or 'admin'), role, *full_access)
        return

    if env_pw and row.get('last_login_at') is None and not verify_password(row['password_hash'], env_pw):
        insert_user('admin', hash_password(env_pw), role, *full_access)


def delete_user(username):
    """Удалить пользователя по username."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE username = %s", (username,))
        conn.commit()
    finally:
        conn.close()


def ensure_cloud(cloud_id, cloud_name=None, endpoint_url=None, conn=None):
    """Добавить облако в таблицу clouds, если ещё нет (при добавлении бакета). name и display_name в clouds совпадают с cloud_name."""
    own = conn is None
    if own:
        conn = get_connection()
    nm = (cloud_name or "").strip() or cloud_id
    ep = None
    if isinstance(endpoint_url, (list, tuple, set)):
        for v in endpoint_url:
            s = str(v or '').strip()
            if s:
                ep = s
                break
    else:
        s = str(endpoint_url or '').strip()
        if s:
            ep = s
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO clouds (cloud_id, name, display_name, endpoint_url)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (cloud_id, COALESCE(NULLIF(BTRIM(endpoint_url), ''), '')) DO NOTHING
                """,
                (cloud_id, nm, nm, ep),
            )
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def is_bucket_id_taken(bucket_id, exclude_cloud_id=None, exclude_display_name=None):
    """True, если bucket_id уже занят другой строкой (не exclude cloud_id/display_name)."""
    bid = (bucket_id or '').strip()
    if not bid:
        return False
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                if exclude_cloud_id is not None and exclude_display_name is not None:
                    cur.execute(
                        """
                        SELECT 1 FROM buckets
                        WHERE bucket_id = %s
                          AND NOT (cloud_id = %s AND display_name = %s)
                        """,
                        (bid, exclude_cloud_id, exclude_display_name),
                    )
                else:
                    cur.execute("SELECT 1 FROM buckets WHERE bucket_id = %s", (bid,))
                return cur.fetchone() is not None
        finally:
            conn.close()
    except Exception:
        return False


def allocate_bucket_id(cur, exclude_cloud_id=None, exclude_display_name=None):
    """
    Уникальный идентификатор бакета: 12 шестнадцатеричных символов (6 байт), например 5a36dff838fc.
    exclude_* — строка (cloud_id, display_name), для которой коллизия допустима (текущая запись при UPDATE).
    """
    for _ in range(64):
        bid = secrets.token_hex(6)
        if exclude_cloud_id is not None and exclude_display_name is not None:
            cur.execute(
                """
                SELECT 1 FROM buckets
                WHERE bucket_id = %s
                  AND NOT (cloud_id = %s AND display_name = %s)
                """,
                (bid, exclude_cloud_id, exclude_display_name),
            )
        else:
            cur.execute("SELECT 1 FROM buckets WHERE bucket_id = %s", (bid,))
        if cur.fetchone() is None:
            return bid
    raise RuntimeError("Не удалось подобрать уникальный bucket_id")


def insert_bucket(
    cloud_id, display_name, bucket_name,
    bucket_id=None, aws_access_key_id=None, aws_secret_access_key=None,
    cloud_name=None, cloud_icon=None, endpoint_url=None,
    ca_bundle_path=None, region_name=None, skip_tls_verify=None,
    created_by=None,
    conn=None,
):
    """Добавить или обновить бакет в таблице buckets. Возвращает итоговый bucket_id."""
    own = conn is None
    if own:
        conn = get_connection()
    bid = None
    cn = (cloud_name or "").strip() or cloud_id
    creator = (created_by or "").strip() or None
    if skip_tls_verify is None:
        stv = False
    elif isinstance(skip_tls_verify, bool):
        stv = skip_tls_verify
    elif isinstance(skip_tls_verify, str):
        stv = skip_tls_verify.lower() in ("true", "1", "yes")
    else:
        stv = bool(skip_tls_verify)
    try:
        ensure_cloud(cloud_id, cn, endpoint_url=endpoint_url, conn=conn)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT bucket_id FROM buckets WHERE cloud_id = %s AND display_name = %s",
                (cloud_id, display_name),
            )
            prev = cur.fetchone()
            prev_bid = ""
            if prev and prev.get("bucket_id"):
                prev_bid = str(prev["bucket_id"]).strip()
            raw = ""
            if bucket_id is not None:
                raw = str(bucket_id).strip()
            if raw:
                bid = raw
            elif prev_bid:
                bid = prev_bid
            elif prev:
                bid = allocate_bucket_id(cur, cloud_id, display_name)
            else:
                bid = allocate_bucket_id(cur)
            from secrets_crypto import encrypt_secret
            stored_secret = encrypt_secret(aws_secret_access_key) if aws_secret_access_key else aws_secret_access_key
            cur.execute(
                """
                INSERT INTO buckets (
                    cloud_id, cloud_name, cloud_icon, endpoint_url,
                    display_name, bucket_name, bucket_id,
                    aws_access_key_id, aws_secret_access_key, ca_bundle_path,
                    region_name, skip_tls_verify, created_by
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (cloud_id, display_name) DO UPDATE SET
                    cloud_name = COALESCE(EXCLUDED.cloud_name, buckets.cloud_name),
                    cloud_icon = COALESCE(EXCLUDED.cloud_icon, buckets.cloud_icon),
                    endpoint_url = COALESCE(EXCLUDED.endpoint_url, buckets.endpoint_url),
                    bucket_name = EXCLUDED.bucket_name,
                    bucket_id = COALESCE(EXCLUDED.bucket_id, buckets.bucket_id),
                    aws_access_key_id = COALESCE(EXCLUDED.aws_access_key_id, buckets.aws_access_key_id),
                    aws_secret_access_key = COALESCE(EXCLUDED.aws_secret_access_key, buckets.aws_secret_access_key),
                    ca_bundle_path = COALESCE(EXCLUDED.ca_bundle_path, buckets.ca_bundle_path),
                    region_name = COALESCE(EXCLUDED.region_name, buckets.region_name),
                    skip_tls_verify = COALESCE(EXCLUDED.skip_tls_verify, buckets.skip_tls_verify),
                    created_by = COALESCE(buckets.created_by, EXCLUDED.created_by)
                """,
                (
                    cloud_id,
                    cn,
                    cloud_icon or 'fa-cloud',
                    endpoint_url or '',
                    display_name,
                    bucket_name,
                    bid,
                    aws_access_key_id,
                    stored_secret,
                    ca_bundle_path,
                    region_name,
                    stv,
                    creator,
                ),
            )
        if own:
            conn.commit()
        return bid
    finally:
        if own:
            conn.close()


def reset_user_password(username, dsn=None, password=None):
    """
    Устанавливает пароль пользователя (werkzeug hash, users.hash_password).
    Пароль: аргумент password или интерактивный ввод через getpass.
    Если admin отсутствует — создаётся с ролью admin и полным доступом.
    Для остальных пользователей запись должна уже существовать в БД.
    """
    import getpass

    username = (username or '').strip()
    if not username:
        raise SystemExit('Username is required')

    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    from users import hash_password

    if not password:
        password = getpass.getpass('Password: ')
        confirm = getpass.getpass('Repeat password: ')
        if password != confirm:
            raise SystemExit('Passwords do not match')
    if not password.strip():
        raise SystemExit('Refusing empty password')

    import roles as roles_module

    pwd_hash = hash_password(password)
    conn = get_connection(dsn)
    try:
        init_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE users SET password = %s WHERE username = %s',
                (pwd_hash, username),
            )
            if cur.rowcount == 0:
                if username.lower() != 'admin':
                    raise SystemExit(f'User not found: {username}')
                cur.execute(
                    """
                    INSERT INTO users (username, password, role, buckets, clouds)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        'admin',
                        pwd_hash,
                        roles_module.ROLE_ADMIN,
                        json.dumps(['*']),
                        json.dumps(['*']),
                    ),
                )
        conn.commit()
    finally:
        conn.close()
    print(f'{username}: password updated')


def config_database(dsn=None):
    """
    Создаёт схему и гарантирует встроенные роли admin/storage_* (данные buckets/clouds не трогаются).

    Кастомные роли из таблицы roles не удаляются. Встроенные роли перезаписываются значениями
    из roles.ROLE_PERMISSIONS (явный сброс к дефолтам при ручном `config.py schema`).

    Таблица buckets — единственный источник списка бакетов для приложения; заполнение — UI, импорт или
    скрипт src/config/config_buckets.py. Пользователь admin (APP_ADMIN_PASSWORD, по умолчанию admin)
    с полным доступом.
    """
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    import buckets as buckets_module
    import roles as roles_module
    from users import hash_password

    admin_password = _admin_password_from_env() or 'admin'
    conn = get_connection(dsn)
    try:
        init_schema(conn)
        pwd_hash = hash_password(admin_password)
        with conn.cursor() as cur:
            _migrate_legacy_builtin_role_names(cur)
            _seed_builtin_roles(cur, overwrite=True)
            cur.execute(
                """
                INSERT INTO users (username, password, role, buckets, clouds)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (username) DO UPDATE SET
                    password = EXCLUDED.password,
                    role = EXCLUDED.role,
                    buckets = EXCLUDED.buckets,
                    clouds = EXCLUDED.clouds
                """,
                (
                    'admin',
                    pwd_hash,
                    roles_module.ROLE_ADMIN,
                    json.dumps(['*']),
                    json.dumps(['*']),
                ),
            )
        conn.commit()
    finally:
        conn.close()

    try:
        buckets_module.reset_buckets_config_cache()
    except Exception:
        pass
