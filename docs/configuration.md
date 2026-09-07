# Конфигурация

## Логирование

Вся логика логирования сосредоточена в [`src/logs.py`](../src/logs.py) (см. также [`src/config.md`](../src/config.md)):
- вызывать только функции из `logs.py` (`log_info`, `log_warning`, `log_error`, `log_user_action`, `log_s3_exception`, `trf_en`);
- **все сообщения в логах — на английском** (UI может оставаться локализованным через `translations.py`);
- формат строки: `[timestamp] [LEVEL] [context] [username] message`;
- до установки сессии в логах будет `[ANONYMOUS]` (нормально для `/api/login` и SSO callback);
- уровень и traceback: `LOG_LEVEL`, `SHOW_TRACEBACK`;
- access-log Werkzeug по умолчанию отключён (дублирует структурированные логи); включить: `WERKZEUG_ACCESS_LOG=true`.

## Переменные окружения

Ключевые переменные:

### База данных и сессия
- `DATABASE_URL` — DSN PostgreSQL (по умолчанию `postgresql://postgres:postgres@localhost:5432/postgres`).
- `DB_CONNECT_TIMEOUT` — таймаут подключения к PostgreSQL в секундах (по умолчанию `10`).
- `APP_SECRET_KEY` — **обязательный** secret Flask-сессии (длинная случайная строка). Без него приложение не стартует. Также используется для шифрования `aws_secret_access_key` в БД (Fernet), если не задан `APP_SECRETS_KEY`.
- `APP_SECRETS_KEY` — опциональный отдельный ключ шифрования секретов бакетов (если не задан — берётся `APP_SECRET_KEY`).
- `ALLOW_INSECURE_DEV_SECRET` — только для локальной разработки: `true` разрешает запуск без `APP_SECRET_KEY` и отключает `Secure` у cookie (не использовать в prod).
- `SESSION_COOKIE_SECURE` — `true`/`false` для session cookie; по умолчанию `true`, кроме `ALLOW_INSECURE_DEV_SECRET`.
- `SESSION_COOKIE_SAMESITE` — `Lax` (по умолчанию) / `Strict` / `None`.
- `APP_TRUST_PROXY` — `true` (по умолчанию) включает `ProxyFix` для `X-Forwarded-*` за TLS terminator.
- `LOGIN_RATE_LIMIT` / `LOGIN_RATE_WINDOW_SECONDS` — лимит неуспешных логинов (по умолчанию `5` / `300`).
- `METRICS_RATE_LIMIT` / `METRICS_RATE_WINDOW_SECONDS` — лимит запросов к `/metrics` (по умолчанию `60` / `60`).
- `ENDPOINT_ALLOW_PRIVATE_RESOLVE` — разрешить DNS→RFC1918 для endpoint без allowlist (по умолчанию `true`, внутренние S3). Loopback/link-local/metadata после DNS всегда запрещены.
- `ZIP_MAX_BYTES` / `ZIP_MAX_FILES` — лимиты ZIP-архива (по умолчанию `512MB` / `5000`).
- `FLASK_DEBUG` / `APP_DEBUG` — `true` включает debug и reloader при `python app.py` (по умолчанию `false`).
- `APP_SESSION_TIMEOUT_MINUTES` — таймаут сессии в минутах (по умолчанию `60`).
- `APP_ADMIN_PASSWORD` — пароль при **первом** создании `admin`; если учётка уже есть и ни разу не входила, на старте может быть выровнен под env (существующий пароль после смены через `config.py reset-password` не трогается).
- `WEB_CONCURRENCY` / `GUNICORN_WORKERS`, `WEB_THREADS` / `GUNICORN_THREADS`, `GUNICORN_TIMEOUT` — параметры gunicorn в Docker.

### Загрузка и логирование
- `MAX_UPLOAD_MB` — лимит загрузки (по умолчанию `100`).
- `LOG_LEVEL` — уровень логирования (`INFO|WARN|ERROR`, по умолчанию `INFO`).
- `SHOW_TRACEBACK` — показывать traceback в логах (`true|false`, по умолчанию `false`).
- `WERKZEUG_ACCESS_LOG` — `true` включает стандартный access-log Werkzeug (по умолчанию выключен).

### S3-клиент и TLS
- `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` / `AWS_CA_BUNDLE` — путь к CA bundle на хосте, если `ca_bundle_path` из конфига бакета недоступен.
- `BUCKET_SIZE_CACHE_TTL` — TTL кэша размера бакета в секундах (по умолчанию `300`).
- `BUCKET_MAX_OBJECTS` — лимит объектов при полном обходе для подсчёта размера (по умолчанию `500000`).
- `BUCKET_MAX_SIZE` — лимит суммарного размера в байтах при том же обходе (по умолчанию `107000000000`).

### S3 object ACL (file ACL в UI)
- `ACL_PUT_PROBE` — `true` включает живую пробу `PutObjectAcl` при проверке capability (по умолчанию выключено).
- `ACL_PUT_PROBE_CACHE_TTL` — TTL кэша результата пробы в секундах (по умолчанию `300`).
- `ACL_READ_CACHE_TTL` — TTL кэша чтения ACL в секундах (по умолчанию `90`, минимум `10`).

### LDAP / AD lookup
- `LDAP_URI` — URL каталога (`ldaps://…` рекомендуется).
- `LDAP_BASE_DN` — база поиска (если не задан — `DC=example,DC=com`).
- `LDAP_DOMAIN` — UPN-суффикс для короткого `LDAP_BIND_USER`.
- `LDAP_BIND_USER` / `LDAP_BIND_PASSWORD` — учётка bind (обязательны для включения поиска; пароль только в `.env`).
- `LDAP_SEARCH_SIZE_LIMIT` — лимит AD search (по умолчанию `200`).
- `LDAP_SEARCH_TIME_LIMIT` — таймаут поиска в секундах (по умолчанию `5`).

Подробности UI и API — в [Авторизация и ACL → LDAP](auth.md#ldap-lookup-добавление--копирование-пользователя).

### Meilisearch
- `MEILI_ENABLED` — включить Meilisearch (`true|false`, по умолчанию выключен). При `true` обязателен `MEILI_HOST`.
- `MEILI_HOST` — URL Meilisearch (например `http://meilisearch:7700`).
- `MEILI_API_KEY` — master key Meilisearch (если включена аутентификация).
- `MEILI_PERIODIC_SYNC` — ежедневный sync всех бакетов в фоне (`true|false`, по умолчанию `true` при включённом Meilisearch).
- `MEILI_SYNC_AT` — время суток для sync в формате `HH:MM` (24 часа, по умолчанию `03:00`; `off` / пусто отключает таймер при `MEILI_PERIODIC_SYNC=true`).
- `MEILI_REINDEX_WORKERS` — число бакетов, индексируемых параллельно (по умолчанию `2`, максимум `32`).
- `MEILI_REINDEX_ON_STARTUP` — фоновая синхронизация индекса при старте (`true|false`): если индекс бакета в Meilisearch **пустой** — полная переиндексация (как по кнопке в UI), если в индексе уже есть документы — **sync** (без wipe: upsert изменений, удаление устаревших). Ручная переиндексация в настройках всегда полная.
- `MEILI_SYNC_TIMEZONE` — часовой пояс для `MEILI_SYNC_AT` (IANA, например `Europe/Moscow`; по умолчанию `UTC`).
- `MEILI_HTTP_TIMEOUT` — таймаут обычных HTTP-запросов к Meilisearch в секундах (по умолчанию `30`).
- `MEILI_REINDEX_HTTP_TIMEOUT` — таймаут HTTP при переиндексации (по умолчанию `600`, fallback на `MEILI_HTTP_TIMEOUT`).
- `MEILI_REINDEX_S3_READ_TIMEOUT` — таймаут чтения объектов из S3 при переиндексации в секундах (по умолчанию `900`).
- `MEILI_LARGE_BUCKET_THRESHOLD` — порог «большого» бакета (по умолчанию `500000` документов в индексе или объектов S3): включается потоковый sync без загрузки всего индекса в память и удаление устаревших записей по частям.
- `MEILI_INDEX_PART_SIZE` — размер части при индексации (по умолчанию `500000`): после каждых N объектов в лог пишется завершение части (`Reindex part 1`, `Sync part 2`, …), документы отправляются в Meilisearch батчами по 1000.
- `MEILI_INDEX_EXCLUDE_PREFIXES` — правила исключения путей S3 из индекса (через запятую):
  - **префикс** — `wals` или `backup/wals/` (как раньше);
  - **glob** — `*/wals/*` исключит, например, `my-service/wals/file.bin` (сегмент `wals` в пути; `*` — любая подстрока);
  - **regex** — `regex:^[^/]+/wals/.*` или `re:.*/wals/.*` — явное регулярное выражение по полному ключу.

Дефолты всех параметров также хранятся в таблице PostgreSQL `meilisearch` (key/value) и подставляются, если переменная окружения не задана. Приоритет: **env → БД → встроенный default**. При `MEILI_ENABLED=true` без `MEILI_HOST` приложение пишет ошибку конфигурации и не включает поиск.

Каждый бакет индексируется в **отдельный** индекс Meilisearch: `<bucket_name>_<bucket_id>` (спецсимволы заменяются на `_`).
