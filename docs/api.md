# API

### Health checks (без авторизации)
- `GET /health` — alias для liveness;
- `GET /healthz/live` — liveness probe для Kubernetes;
- `GET /healthz/ready` — readiness probe (PostgreSQL; Meilisearch если `MEILI_ENABLED`).
- `GET /metrics` — Prometheus metrics (без auth, с rate limit).

### UI (deep links)
- `GET /` — файловый менеджер (требует сессию);
- `GET /login` — страница входа;
- `GET /settings` — настройки;
- `GET /settings/<tab>` — вкладка настроек (`users`, `buckets`, `clouds`, `roles`, `search`, …);
- `GET /bucket/<bucket_id>` — открыть бакет;
- `GET /bucket/<bucket_id>/<path:subpath>` — открыть путь внутри бакета.

### Auth и профиль
- `POST /api/login`
- `GET /api/auth/sso/login` — SSO (если `SSO_ENABLED=true`)
- `GET /api/auth/sso/callback`
- `POST /api/logout` (при SSO может вернуть `redirect` на end-session Keycloak)
- `GET /api/check-auth` — статус сессии; синхронизирует права пользователя из БД (см. [Авторизация](auth.md))
- `POST /api/set-locale`

### Файловые операции
- `GET /api/buckets` — список бакетов, доступных текущему пользователю;
- `GET /api/buckets-config` — конфигурация бакетов для UI;
- `GET /api/bucket-size/<bucket_id>`
- `GET /files`
- `GET /api/folders`
- `GET /api/search` — поиск по имени/пути (Meilisearch или fallback через S3; только бакеты с `search_index_enabled=true`)
- `GET /api/files/metadata` — метаданные объекта S3 (query: `bucket`, `path`);
- `GET /api/files/metadata/acl` — чтение S3 ACL объекта (permission `edit_file_acl`);
- `GET /api/files/metadata/acl-capability` — проверка, поддерживает ли бакет редактирование ACL;
- `PUT /api/files/metadata/acl` — обновление S3 ACL объекта (permission `edit_file_acl`);
- `POST /files/upload`
- `POST /files/create-folder`
- `DELETE /files/delete`
- `GET /files/download/<bucket_id>/<path:file_path>`
- `GET /files/view/<bucket_id>/<path:file_path>` — inline-предпросмотр изображений (JPEG/PNG/GIF/WebP/BMP), PDF, JSON, TXT, MD, HTML и CSS; требует право `preview` и доступ к бакету
- `POST /files/download-archive`

### Поиск и Meilisearch (admin)
- `GET /api/search/status` — статус подключения и переменные Meilisearch;
- `PUT /api/settings/buckets/search-index-enabled` — вкл/выкл индексации для бакета (`{"bucket_id": "...", "enabled": true|false}`);
- `POST /api/search/reindex` — переиндексация (см. ниже);
- `GET /api/search/reindex/status` — статус фоновой переиндексации;
- `GET /api/search/reindex/events` — SSE-прогресс фоновой переиндексации;
- `POST /api/search/reindex/cancel` — остановить фоновую переиндексацию после текущих бакетов;
- UI: **Настройки → Поиск** — статус, флаги индексации по бакетам, кнопки переиндексации (`/settings/search`).

Тело `POST /api/search/reindex`:
- один бакет: `{"bucket": "<bucket_id>"}` — фоновый запуск, ответ **HTTP 202** с `started`, `total`, `workers`;
- несколько бакетов: `{"buckets": ["id1", "id2"]}` — по умолчанию тоже в фоне (`background` не `false`);
- синхронный режим (блокирует до завершения): `{"buckets": ["id1"], "background": false}` — ответ **200** с `indexed_by_bucket`;
- поле `buckets` **обязательно**, если не задан `bucket`; пустое тело `{}` вернёт ошибку `reindex_buckets_required`.

Бакеты с `search_index_enabled=false` пропускаются; если таких осталось 0 — ошибка `search_index_all_disabled`. В UI кнопка «Переиндексировать все» сама собирает список `bucket_id` с включённой индексацией.
