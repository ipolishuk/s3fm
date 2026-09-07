# S3 File Manager

Веб-сервис для работы с S3-совместимыми хранилищами:
- просмотр и поиск файлов/папок в бакетах;
- загрузка и создание (кнопка **+** в тулбаре и drag-and-drop), предпросмотр (изображения, PDF, JSON/TXT/MD/HTML/CSS), скачивание, удаление объектов;
- массовые операции (в рамках прав роли);
- админ-панель для управления бакетами, облаками, пользователями и ролями;
- разграничение доступа по облакам и конкретным бакетам.

Сервис хранит конфигурацию и ACL в PostgreSQL и отдаёт единый веб-интерфейс на Flask.

## Технологии

- Backend: `Flask`
- S3-клиент: `boto3`
- База данных: `PostgreSQL` (`psycopg2-binary`)
- Полнотекстовый поиск: `Meilisearch` (опционально; без него — линейный обход S3)
- Frontend: серверный HTML + JS/CSS из `src/html`, `src/js`, `src/css`
- Локализация: `ru/en` (через `translations.py`)

## Структура проекта

- `src/app.py` — основной Flask-приложение и API.
- `src/db.py` — схема БД и доступ к данным (`users`, `roles`, `clouds`, `buckets`, `schema_migrations`).
- `src/config.py` — операционный CLI: схема БД, смена пароля, экспорт/импорт JSON.
- `src/roles.py` — permissions-модель, вычисление прав текущей роли (включая `edit_file_acl` для S3 ACL объектов).
- `src/users.py` — работа с пользователем, per-bucket grants и синхронизация сессии из БД (`sync_logged_in_session_from_db`).
- `src/sso.py` — OIDC/SSO (Keycloak).
- `src/logs.py` — единая точка логирования (формат, уровни, `trf_en`, `log_s3_exception`).
- `src/translations.py` — строки UI `ru/en` и шаблоны для серверных логов.
- `src/buckets.py` — адаптер конфигурации бакетов из БД.
- `src/meilisearch.py` — индекс и поиск через Meilisearch.
- `src/html/index.html` — основной UI (файловый менеджер + settings).
- `src/js/*.js` — клиентская логика.
- `src/css/*.css` — стили интерфейса.
- `src/config.md` — внутренние правила разработки (логирование).
- `docker/web/Dockerfile` — образ web (`python:3.11.9-bookworm` + `pip install` + `COPY src/`);
- `docker/meilisearch/Dockerfile` — образ Meilisearch с `aws-cli`;

## Модель данных

Сервис использует таблицы:
- `users` — учётные записи, роль, списки доступных `buckets` и `clouds` (JSONB);
- `user_roles` — per-bucket grants (`username`, `bucket_id`, `role_name`);
- `roles` — роли и наборы permissions;
- `clouds` — облака (ID, отображаемое имя, endpoint), допускаются несколько строк на один `cloud_id` с разными `endpoint_url`;
- `buckets` — бакеты и их S3-параметры (включая креды, CA bundle, TLS-флаг, флаг `search_index_enabled` для Meilisearch).

Схема и миграционные правки применяются автоматически при старте (`db.init_schema()`).

## Авторизация и ACL

### SSO (Keycloak / OIDC)

При включённом SSO вход выполняется через Authorization Code flow (OpenID Connect). IdP — Keycloak или любой совместимый OIDC-провайдер.

Эндпоинты:
- `GET /api/auth/sso/login` — редиреект на страницу входа IdP;
- `GET /api/auth/sso/callback` — callback после аутентификации (настраивается в Keycloak как Valid redirect URI).

Переменные окружения:
- `SSO_ENABLED` — `true` включает SSO;
- `OIDC_ISSUER` — URL realm Keycloak, например `https://keycloak.example.com/realms/myrealm` (без завершающего `/`);
- `OIDC_CLIENT_ID` — client id в Keycloak;
- `OIDC_CLIENT_SECRET` — client secret;
- `OIDC_REDIRECT_URI` — полный callback URL (рекомендуется в prod), например `https://s3fm.example.com/api/auth/sso/callback`; если не задан — строится из `APP_EXTERNAL_URL` + `/api/auth/sso/callback`;
- `OIDC_SCOPES` — scopes (по умолчанию `openid profile email`);
- `OIDC_EXTERNAL_URL` / `APP_EXTERNAL_URL` — публичный URL приложения (для post-logout redirect, если нет `SSO_POST_LOGOUT_REDIRECT_URI`);
- `SSO_POST_LOGOUT_REDIRECT_URI` — URL для Keycloak end_session (только при `SSO_FEDERATED_LOGOUT=true`; по умолчанию `{APP_EXTERNAL_URL}/`);
- `SSO_FEDERATED_LOGOUT` — `true` отправляет браузер на logout Keycloak; **по умолчанию выключено** (выход только из S3 FM → `/login`, без IdP);
- `SSO_USERNAME_CLAIM` — claim для маппинга на `users.username` (по умолчанию `preferred_username`, затем `username`, `sub`, `email`);
- `SSO_STRIP_EMAIL_DOMAIN` — при claim `email` брать часть до `@` (`true` по умолчанию);
- `SSO_ONLY` — `true` скрывает форму логин/пароль, только SSO;
- `SSO_AUTO_PROVISION` — `true` создаёт пользователя в БД при первом входе;
- `SSO_DEFAULT_ROLE` — роль для автосоздания (`storage_viewer` по умолчанию);
- `OIDC_HTTP_TIMEOUT` — таймаут HTTP-запросов к Keycloak в секундах (по умолчанию `30`).

### LDAP lookup (добавление / копирование пользователя)

В **Настройки → Пользователи** при **добавлении** или **копировании** УЗ справа от поля логина есть кнопка поиска по Active Directory / LDAP.

Поведение UI:
- запрос — частичное совпадение по `sAMAccountName`, `displayName`, `cn`, `mail`;
- минимум **6** символов;
- **1** совпадение — сразу заполняются логин, ФИО и email;
- **несколько** — dropdown со счётчиком и списком (до 25 записей в ответе API); клик подставляет выбранного пользователя;
- при **копировании** права / бакеты / облака берутся у исходной УЗ; логин / ФИО / email задаются заново (в т.ч. через LDAP).

Если иконка поиска серая — LDAP не настроен или bind не проходит. Диагностика: **Настройки → Статус** (`/settings/status`).

Эндпоинт: `GET /api/settings/users/ldap-lookup?username=` (только **admin**, сессия обязательна). Ответ при успехе:

```json
{
  "query": "ivanov",
  "count": 2,
  "users": [
    { "username": "i.ivanov", "display_name": "Ivan Ivanov", "email": "i.ivanov@example.com" }
  ]
}
```

Переменные окружения (для включения поиска обязательны URI + BASE_DN + BIND_USER + BIND_PASSWORD):

| Переменная | Обязательно | Описание |
|---|---|---|
| `LDAP_URI` | да | URL каталога, предпочтительно **`ldaps://…`** (TLS). Пример: `ldaps://example.com` |
| `LDAP_BASE_DN` | да* | База поиска. Пример: `DC=example,DC=com` (*если не задан — в коде default `DC=example,DC=com`) |
| `LDAP_DOMAIN` | для короткого bind | UPN-суффикс, если `LDAP_BIND_USER` — короткий логин. Пример: `example.com` |
| `LDAP_BIND_USER` | да | Service account: короткий логин, `user@domain` или полный DN |
| `LDAP_BIND_PASSWORD` | да | Пароль service account (**секрет**, только в `.env`) |
| `LDAP_SEARCH_SIZE_LIMIT` | нет | Лимит AD search (по умолчанию `200`; UI всё равно отдаёт не больше 25) |
| `LDAP_SEARCH_TIME_LIMIT` | нет | Таймаут поиска в секундах (по умолчанию `5`) |

Безопасность и эксплуатация:
- пароль bind **не** храните в `docker-compose.yml` и не коммитьте — только в локальном `.env` (файл в `.gitignore`);
- шаблон для запуска Python на хосте: [`src/.env.example`](src/.env.example); в Docker Compose `.env` не обязателен — добавьте туда только LDAP/SSO-переменные, не копируйте файл целиком;
- учётка bind должна иметь минимальные права чтения в AD (поиск пользователей);
- используйте `ldaps://`; plain `ldap://` передаёт bind-пароль без шифрования.

Пользователь SSO сопоставляется с записью в таблице `users` по `username`. Без `SSO_AUTO_PROVISION` учётку нужно завести заранее в настройках (как для локального входа). Права (`role`, `allowed_buckets`, `allowed_clouds`, при необходимости `user_roles`) задаются в БД.

В Keycloak (`idp.example.com`, realm `internal`) для клиента (например `s3fm`): Client authentication — confidential; **Valid redirect URIs** — `https://s3fm.example.com/api/auth/sso/callback`; **Web origins** — `https://s3fm.example.com`. **Valid post logout redirect URIs** нужны только если включён `SSO_FEDERATED_LOGOUT=true` (по умолчанию приложение шлёт `{APP_EXTERNAL_URL}/`, например `https://s3fm.example.com/`).

Шаблон переменных SSO/приложения и LDAP: [`src/.env.example`](src/.env.example).

Локальный логин (`POST /api/login`) остаётся доступен, пока не включён `SSO_ONLY`.

После логина (локально или SSO) в сессии сохраняются:
- `role` — роль по умолчанию (fallback для бакетов без явного grant);
- `allowed_buckets`, `allowed_clouds`;
- `bucket_roles` — map `{ bucket_id: role_name }` для per-bucket grants.

Ответ `GET /api/check-auth` дополнительно отдаёт `permissions`, `bucket_permissions` и служебные поля сессии — они вычисляются из БД и актуальной сессии, а не кэшируются отдельно в cookie.

**Обновление прав без перелогина:** при каждом вызове `/api/check-auth` (перезагрузка страницы, старт приложения, фоновый пинг сессии раз в ~2 мин) сервер подтягивает из PostgreSQL актуальные `role`, `allowed_buckets`, `allowed_clouds` и `user_roles` в сессию (`sync_logged_in_session_from_db` в `users.py`). Это работает одинаково для локальных пользователей и SSO. Достаточно **обновить страницу (F5)** — повторный вход не нужен. Если учётная запись удалена из БД, сессия сбрасывается. Изменение **определения роли** (набор permissions в таблице `roles`) подхватывается сразу при следующем `check-auth`, т.к. permissions читаются из БД по имени роли.

Доступ к данным определяется ACL из `allowed_buckets`/`allowed_clouds` (или `*` внутри них) **и** явными grants в `user_roles`. Роль по умолчанию (`users.role`) применяется к бакетам, для которых grant не задан.

Семантика списков `allowed_buckets` / `allowed_clouds` в таблице `users`:
- `["*"]` или элемент `*` в списке — доступ ко **всем** бакетам или облакам соответственно;
- `[]` (пустой список) — **нет доступа** (это не означает «все выбраны»);
- конкретные ID — доступ только к перечисленным бакетам/облакам.

Отдельно от пользовательского ACL у каждого бакета в БД есть флаг `search_index_enabled` (по умолчанию `true`). Если он выключен, поиск и переиндексация Meilisearch для этого бакета не выполняются (фоновый sync/reindex тоже пропускает такие бакеты). Управление — в **Настройки → Поиск** или `PUT /api/settings/buckets/search-index-enabled`.

### Roles и permissions

Базовые роли: `admin`, `storage_admin`, `storage_editor`, `storage_viewer`.

**Per-bucket roles:** таблица `user_roles` хранит явную роль пользователя для конкретного бакета (`username`, `bucket_id`, `role_name`). Поле `users.role` — роль по умолчанию для всех выбранных бакетов без отдельного grant. В настройках пользователя (**Настройки → Пользователи → добавить/редактировать**) можно назначить, например, `storage_editor` в одном бакете и `storage_viewer` в другом. При первом запуске после обновления существующие записи мигрируются из `users.buckets` + `users.role`; имена `editor`/`viewer` переименовываются в `storage_editor`/`storage_viewer`.

`storage_admin` — те же права на объекты и `add_bucket`, что у `admin`. Открывает **Настройки → только Бакеты**: список своих созданных бакетов (`created_by`), просмотр/редактирование их настроек. Удаление бакетов и остальные вкладки Settings — только у `admin`. **Bucket ID** генерируется на сервере и неизменяем. После создания бакет автоматически выдаётся создателю (grant + ACL).

Пользователи с правом `add_bucket` (без полной роли admin) также видят Settings → Buckets для своих созданных записей.

UI custom roles (модалка пользователя):
- поле **Роль** — default role для всех бакетов из списка **Бакеты**;
- кнопка **Add custom roles** в футере модалки добавляет строку редактирования (как блок ACL у файла): dropdown бакета + dropdown роли, удаление строки;
- в блоке **Custom roles** отображаются только бакеты, у которых роль **отличается** от default; в БД (`user_roles`) сохраняются только такие исключения;
- без выбранных бакетов кнопка показывает подсказку в toast.

Семантика:
- grant в `user_roles` → permissions этой роли для данного бакета;
- нет grant → используется `users.role`;
- доступ к бакету: legacy ACL (`allowed_buckets`/`allowed_clouds`) **или** наличие grant для `bucket_id`.

Поддерживаемые permissions:
- `add_bucket` — регистрация нового бакета (меню кнопки **+** и Настройки → Бакеты); создателю автоматически выдаётся доступ с его дефолтной ролью (`users.buckets` / `users.clouds` + grant в `user_roles`)
- `preview` — предпросмотр в новой вкладке (`/files/view/...`): изображения, PDF, JSON, TXT, MD, HTML, CSS; отдельно от `download_file` (можно разрешить скачивание без inline-просмотра и наоборот)
- `upload_files`
- `upload_folder`
- `create_folder`
- `delete_file`
- `delete_folder`
- `download_file`
- `download_folder`
- `download_files_multi`
- `delete_folder_multi`
- `delete_files_multi`
- `edit_file_acl` — просмотр и редактирование S3 ACL объекта (панель «Информация о файле»: кнопка **Add ACL** добавляет grant-строку с dropdown grantee/permission, как в bulk-редакторе; API `/api/files/metadata/acl*`)

Роли редактируются через settings и хранятся в БД.

## Основные API-эндпоинты

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
- `GET /api/check-auth` — статус сессии; синхронизирует права пользователя из БД (см. выше)
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

## Веб-интерфейс

### Загрузка и создание

- Кнопка **+** в тулбаре открывает меню:
  - **Добавить бакет** — при праве `add_bucket` (пункт скрыт, если права нет);
  - **Создать папку** — при праве `create_folder`;
  - **Загрузить файлы** / **Загрузить папку** — при правах `upload_files` / `upload_folder`.
- **Drag-and-drop**: перетащите файлы или папки на панель списка файлов (`content-panel` под breadcrumb). Подсвечивается только область списка, не навигация по пути.
- Права: для файлов — `upload_files`, для папок (в т.ч. при перетаскивании каталога) — `upload_folder`.
- Загрузка и создание папки не работают без выбранного бакета, в режиме множественного выбора и на экране настроек.
- Прогресс — всплывающая панель справа снизу: общий индикатор и список имён со статусами (ожидание / загрузка — анимированная иконка, успех — галочка, ошибка — текст).

### Предпросмотр

- Кнопка **Предпросмотр** в свойствах файла открывает документ в новой вкладке браузера.
- Нужны право `preview` и доступ к бакету (не только сессия; прямая ссылка `/files/view/...` для чужих бакетов/без права не сработает).
- Поддерживаются JPEG, PNG, GIF, WebP, BMP, PDF, JSON, TXT, MD, HTML и CSS.
- HTML отдаётся с `Content-Security-Policy: sandbox` (без скриптов и доступа к cookies приложения); MD показывается как текст.
- Право независимо от `download_file`. При обновлении с версии без `preview` оно один раз добавляется ролям с `download_file`; дальнейшее снятие в **Настройки → Роли** сохраняется после рестартов.

### Массовый выбор, скачивание и удаление

- Режим **Выбрать** в тулбаре: чекбоксы у файлов и папок, кнопки «Скачать» / «Удалить» для выделенного.
- Пути объектов хранятся в `data-path` строки списка; обработчики через делегирование событий — корректная работа с именами, содержащими апострофы (`'`), амперсанды (`&`), скобки и прочие спецсимволы.
- При массовом и одиночном удалении — та же панель прогресса: общий бар, в списке имён статусы «ожидание» / «удаление» (анимация), затем галочка или ошибка.

### Settings
- Users / Roles / Clouds / Status / Search / search-index — **только admin**
- Buckets API (`GET/POST /api/settings/buckets`, `GET/PUT …/buckets/<cloud>/<name>`, options, test) — **admin**, `storage_admin` или право `add_bucket`
- `PUT/DELETE` конкретного бакета: GET/PUT — admin или **создатель** (`created_by`); DELETE — только admin
- `GET/POST /api/settings/users`
- `GET /api/settings/users/ldap-lookup?username=` — частичный поиск в LDAP/AD (только admin; ≥6 символов; ответ `{ query, count, users[] }`, не больше 25 записей)
- `GET /api/settings/status` — статус Database / LDAP / Meilisearch (только admin)
- `GET/PUT/DELETE /api/settings/users/<username>`
- `GET/POST /api/settings/roles`
- `GET/PUT/DELETE /api/settings/roles/<role_name>`
- `GET/POST /api/settings/buckets`
- `GET/PUT/DELETE /api/settings/buckets/<cloud_id>/<display_name>`
- `POST /api/settings/buckets/test` — проверка подключения к бакету из формы (без сохранения в БД);
- `GET/POST /api/settings/clouds`
- `GET/PUT/DELETE /api/settings/clouds/<cloud_id>`
- `GET /api/settings/options/roles`
- `GET /api/settings/options/role-permissions`
- `GET /api/settings/options/clouds`
- `GET /api/settings/options/buckets`
- `GET /api/settings/options/endpoints`

Особенности:
- учётную запись `admin` нельзя удалить (ограничение на backend);
- для облаков в API settings поле `endpoint_url` передаётся как массив URL;
- `PUT /api/settings/users/<username>` принимает `bucket_roles` — список `[{ "bucket_id", "role" }]` (только исключения от default role); при редактировании **своей** учётки сессия обновляется сразу (`session_updated: true` в ответе).

Тело пользователя (фрагмент):

```json
{
  "username": "alice",
  "role": "storage_viewer",
  "buckets": ["bucket-a", "bucket-b"],
  "clouds": ["openstack"],
  "bucket_roles": [
    { "bucket_id": "bucket-a", "role": "storage_editor" }
  ]
}
```

## Логирование

Вся логика логирования сосредоточена в `src/logs.py` (см. также `src/config.md`):
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

Подробности UI и API — в разделе [LDAP lookup](#ldap-lookup-добавление--копирование-пользователя).

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

## Запуск локально

### 1) Подготовка

```bash
cd src
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2) База данных

Поднимите PostgreSQL и укажите `DATABASE_URL`.

Пример:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

### 3) Старт приложения

```bash
export APP_SECRET_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')"
# локальный HTTP без Secure-cookie:
export SESSION_COOKIE_SECURE=false
# или для быстрого локального запуска без секрета:
# export ALLOW_INSECURE_DEV_SECRET=true
python app.py
# prod-like:
# gunicorn -c gunicorn.conf.py app:app
```

Сервис стартует на `http://0.0.0.0:3000`. В Docker-образе по умолчанию запускается **gunicorn**. Пароли в БД — werkzeug hash; `aws_secret_access_key` бакетов шифруются at-rest (`enc:v1:…`). CSRF: заголовок `X-CSRF-Token` (токен из `/api/check-auth` / meta).

Тесты (из `src/`):

```bash
pip install -r requirements.txt
pytest -q
```

### 4) Meilisearch (опционально)

Для быстрого поиска по файлам и папкам поднимите Meilisearch и включите интеграцию:

```bash
# образ из репозитория
docker build -f docker/meilisearch/Dockerfile -t s3-file-manager-meilisearch .

docker run -d --name meilisearch -p 7700:7700 \
  -e MEILI_MASTER_KEY=dev-master-key-change-me \
  -v meili_data:/meili_data \
  s3-file-manager-meilisearch

# или официальный образ без сборки
docker run -d --name meilisearch -p 7700:7700 \
  -e MEILI_MASTER_KEY=dev-master-key-change-me \
  -v meili_data:/meili_data \
  getmeili/meilisearch:v1.11

export MEILI_ENABLED=true
export MEILI_HOST=http://127.0.0.1:7700
# в Docker Compose — имя сервиса: http://meilisearch:7700 (не 0.0.0.0)
export MEILI_API_KEY=dev-master-key-change-me
```

После первого включения проиндексируйте бакеты. Эндпоинт требует **сессию** (как в браузере) и роль **admin**:

```bash
# 1) Вход — cookie сохраняется в файл
curl -c /tmp/s3fm.cookies -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<APP_ADMIN_PASSWORD или пароль из БД>"}'

# 2) Список bucket_id (из настроек)
curl -b /tmp/s3fm.cookies http://localhost:3000/api/settings/buckets

# 3) Переиндексация нескольких бакетов (фон, HTTP 202)
curl -b /tmp/s3fm.cookies -X POST http://localhost:3000/api/search/reindex \
  -H 'Content-Type: application/json' \
  -d '{"buckets": ["<bucket_id_1>", "<bucket_id_2>"], "background": true}'
```

Для одного бакета (фон, HTTP 202): `{"bucket": "<bucket_id>"}`.

Для нескольких бакетов: `{"buckets": ["id1", "id2"], "background": true}` (как в UI).

Без cookie после логина ответ будет `{"error": "Authentication required"}` (HTTP 401).

Индекс обновляется при загрузке, создании папки и удалении объектов. При недоступности Meilisearch `/api/search` автоматически использует прежний обход S3.

## Docker Compose

Поднимает PostgreSQL, Meilisearch и web из корневого `docker-compose.yml`.
Файл `.env` **не нужен**: тестовые значения уже в compose.

```bash
docker compose up --build
```

После старта (2–5 секунд на инициализацию Postgres и схему):
- UI: [http://localhost:3000](http://localhost:3000)
- логин: `admin` / `admin` (`APP_ADMIN_PASSWORD` в compose)
- PostgreSQL: `localhost:5432`, пользователь / пароль / БД — `postgres`
- Meilisearch: [http://localhost:7700](http://localhost:7700)

Опциональные секреты (LDAP и т.п.) — переменные в корневом `.env` (файл в `.gitignore`).
Не копируйте [`src/.env.example`](src/.env.example) целиком: там `DATABASE_URL=...localhost...`, это для запуска Python на хосте, не для контейнера.

Полный сброс томов (как с нуля):

```bash
docker compose down -v
docker compose up --build
```

Остановка с сохранением БД и индекса:

```bash
docker compose down
```

На **Apple Silicon** для сервиса `web` задано `platform: linux/amd64`.

## Docker

Образ web (`docker/web/Dockerfile`):
- `FROM python:3.11.9-bookworm`;
- `pip install -r requirements.txt`;
- `COPY src/` + shortcut `s3` → `python config.py`;
- `CMD gunicorn` на порту `3000`.

## Экспорт/импорт конфигурации

Скрипт: `src/config.py`.

В web-контейнере доступен shortcut: `s3` → `python config.py` (например `s3 export --all`).

Команды:
- `schema` — инициализация схемы PostgreSQL;
- `reset-password USERNAME` — смена пароля;
- `export` — PostgreSQL → JSON;
- `import` — JSON → PostgreSQL.

Поддерживает:
- области: `--buckets`, `--clouds`, `--users`, `--roles`, `--all`;
- переопределение DSN через `--database-url`;
- загрузку экспорта в S3-бакет из БД: `--dst`, ключ объекта через `-f` (только `export`).

Формат clouds в JSON:

```json
[
  {
    "cloud_id": "openstack",
    "display_name": "OpenStack",
    "endpoint_url": [
      "https://web.example.com",
      "https://web2.example.com"
    ]
  }
]
```

При импорте `--clouds/--all` для одного `cloud_id` создаются отдельные строки в таблице `clouds` по каждому endpoint.

Экспорт/импорт пользователей включает `bucket_roles` (массив grants или пустой список). Поле опционально: без него при импорте grants для пользователя не меняются.

Пример:

```bash
s3 schema
s3 reset-password admin
s3 export --all
s3 import --all
s3 export --users -f backup/users.json
s3 import --all -f backup/full-config.json
```

Флаг `--file` / `-f` задаёт путь JSON для текущей области; без `-f` используются имена `config_*.json` по умолчанию. Для `--all` без `-f` — четыре отдельных файла; с `-f` — один combined JSON.

## Ограничение размера загрузки (413)

Лимит в приложении задаётся `MAX_UPLOAD_MB`.

Если сервис стоит за nginx, проверьте:

```nginx
client_max_body_size 100M;
```

Значение в nginx должно быть не меньше `MAX_UPLOAD_MB`.

## Примечания по эксплуатации

- Загрузка через drag-and-drop использует тот же API `POST /files/upload`, что и пункты меню кнопки **+** в тулбаре; при перетаскивании папки сохраняется структура каталогов (`folder_upload=1`).
- После изменений в settings UI принудительно обновляет список бакетов без ручного рефреша страницы.
- Если админ меняет права **другого** пользователя, тому достаточно обновить страницу (F5), чтобы увидеть новые бакеты и permissions; перелогин не требуется (local и SSO).
- Если админ меняет **свою** учётку через settings, UI вызывает `check-auth` и обновляет клиентское состояние без F5 (`session_updated` в ответе API).
- Для production рекомендуется запуск через WSGI-сервер и внешний reverse-proxy (вместо dev-режима Flask).