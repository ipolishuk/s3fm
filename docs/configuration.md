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
- `WEB_CONCURRENCY` / `GUNICORN_WORKERS`, `WEB_THREADS` / `GUNICORN_THREADS`, `GUNICORN_TIMEOUT` — параметры gunicorn в Docker. По умолчанию `gthread` + `timeout=3600`: sync-worker иначе рвёт proxy-download больших файлов (~после 2 мин / ~300MB).
- `GUNICORN_WORKER_CLASS` — класс worker (по умолчанию `gthread`). Для длинных stream не ставьте `sync`.
- `OPERATION_WORKER_MODE` — `embedded` (по умолчанию: job в thread web-процесса) или `external` (только enqueue в PG, выполняет `python worker.py`). В режиме `external` Meili reindex (ручной и `MEILI_PERIODIC_SYNC` / `MEILI_REINDEX_ON_STARTUP`), ZIP-архивы (`download_archive`) и прочие ops ставит в очередь и выполняет worker; web только создаёт job и отдаёт status/SSE.
- `DOWNLOAD_PRESIGN_EXPIRES_SEC` — TTL presigned URL для одиночного файла (по умолчанию `3600`). Redirect на S3 только если у облака `public_url_enabled=true`; иначе proxy через web. `0` — всегда proxy.
- `DOWNLOAD_S3_READ_TIMEOUT` — пауза между чанками S3 при proxy-download (по умолчанию `900`).
- `DOWNLOAD_STAGING_PREFIX` — префикс временных ZIP в бакете (по умолчанию `.s3fm-downloads/`).
- Ingress/nginx перед приложением: `proxy-read-timeout` / `proxy_read_timeout` должен быть ≥ длительности скачивания (иначе обрыв снаружи gunicorn).
- `OPERATION_WORKER_POLL_SEC` — интервал опроса очереди в worker (по умолчанию `1`).
- `OPERATION_CANCEL_CHECK_EVERY` — проверять cancel каждые N ключей при copy папки (по умолчанию `10`).
- `OPERATION_DELETE_BATCH_SIZE` — размер батча `delete_objects` с проверкой cancel между батчами (по умолчанию `100`, макс. `1000`).
- `ACL_BATCH_MAX_OBJECTS` — максимум объектов в одном bulk ACL job (по умолчанию `10000`). При превышении API и UI отклоняют операцию.
- `OPERATION_PROGRESS_PERSIST_SEC` — как часто писать progress job в PostgreSQL для обычных ops (по умолчанию `5`; `0` — каждый progress). Снижает WAL и блокировки `/files/operation-jobs/active`.
- `OPERATION_PROGRESS_PERSIST_BULK_SEC` — то же для bulk ops `acl` / `copy` / `move` / `delete` / `upload` (по умолчанию `10`).
- `OPERATION_JOB_MAX_HISTORY` — кольцевой буфер history in-memory/SSE (по умолчанию `100`).
- `OPERATION_JOB_DB_PROGRESS_EVENTS` — сколько последних `progress` оставлять в jsonb `history` при UPSERT в PG (по умолчанию `1`; счётчики ещё в `meta.progress`).
- `OPERATION_PURGE_MIN_INTERVAL_SEC` — минимальный интервал purge старых job (по умолчанию `60`).
- `OPERATION_STALE_PENDING_SEC` — `pending` дольше N секунд (worker не забрал) → `error` (по умолчанию `120`).
- `OPERATION_STALE_RUNNING_SEC` — interactive `running` (copy/move/delete/acl/…) без `updated_at` дольше N секунд → `error` (по умолчанию `60`). Worker после рестарта не reclaim'ит `running` — idle = мёртвый исполнитель; progress в PG ~каждые `OPERATION_PROGRESS_PERSIST_*`. При старте worker — force-purge.
- `OPERATION_STALE_LONG_RUNNING_SEC` — то же для длинных ops `reindex` / `bucket_size` / `download_archive` (по умолчанию `3600`). Листинг S3 / Meili может минутами не слать progress; worker шлёт heartbeat `updated_at` ~каждые 30с и прерывается, если job уже помечен terminal в PG.

### Загрузка и логирование
- `MAX_UPLOAD_MB` — лимит загрузки (по умолчанию `100`).
- `LOG_LEVEL` — уровень логирования (`INFO|WARN|ERROR`, по умолчанию `INFO`).
- `SHOW_TRACEBACK` — показывать traceback в логах (`true|false`, по умолчанию `false`).
- `WERKZEUG_ACCESS_LOG` — `true` включает стандартный access-log Werkzeug (по умолчанию выключен).

### S3-клиент и TLS
- `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` / `AWS_CA_BUNDLE` — путь к CA bundle на хосте, если `ca_bundle_path` из конфига бакета недоступен.
- `BUCKET_SIZE_CACHE_TTL` — TTL кэша размера бакета в секундах (по умолчанию `300`). Кнопка refresh в UI шлёт `?refresh=1` и обходит кэш; без refresh повторно используется и недавний `bucket_size` job result не старше этого TTL.
- `BUCKET_MAX_OBJECTS` — лимит объектов при полном обходе для подсчёта размера (по умолчанию `500000`).
- `BUCKET_MAX_SIZE` — лимит суммарного размера в байтах при том же обходе (по умолчанию `107000000000`).
- `BUCKET_SIZE_PROGRESS_EVERY` — писать `bucket_size processing` каждые N объектов (по умолчанию `5000`).
- `BUCKET_SIZE_PROGRESS_SEC` — или не реже раза в N секунд (по умолчанию `15`, минимум `5`).
- `BUCKET_METRICS_PROMETHEUS_URL` — base URL VictoriaMetrics/Prometheus select API, например `https://vmselect.example.com/select/0/prometheus`. Если задан, размер и число объектов бакета читаются из метрик `ceph_s3_bucket_*` (label `bucket` = `bucket_name`); при ошибке или отсутствии серии — fallback на ListObjects.
- `BUCKET_METRICS_TIMEOUT` — таймаут запроса к Prometheus в секундах (по умолчанию `5`).
- `BUCKET_METRICS_TLS_VERIFY` — проверять TLS-сертификат VictoriaMetrics (`true` по умолчанию; `false` если корпоративный CA не в trust store).
- `BUCKET_METRICS_CA_BUNDLE` — путь к CA bundle для VictoriaMetrics (иначе `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE`).

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
- `MEILI_PERIODIC_SYNC` — ежедневный sync всех бакетов (`true|false`, по умолчанию `true` при включённом Meilisearch). Таймер и выполнение job живут на worker (`OPERATION_WORKER_MODE=external`) или в web-thread при `embedded`.
- `MEILI_SYNC_AT` — время суток для sync в формате `HH:MM` (24 часа, по умолчанию `03:00`; `off` / пусто отключает таймер при `MEILI_PERIODIC_SYNC=true`).
- `MEILI_REINDEX_WORKERS` — число бакетов, индексируемых параллельно (по умолчанию `2`, максимум `32`).
- `MEILI_REINDEX_ON_STARTUP` — синхронизация индекса при старте worker/app (`true|false`): если индекс бакета в Meilisearch **пустой** — полная переиндексация (как по кнопке в UI), если в индексе уже есть документы — **sync** (без wipe: upsert изменений, удаление устаревших). Ручная переиндексация в настройках всегда полная и тоже идёт через worker.
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
