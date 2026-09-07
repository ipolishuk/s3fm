# Авторизация и ACL

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
- шаблон для запуска Python на хосте: [`src/.env.example`](../src/.env.example); в Docker Compose `.env` не обязателен — добавьте туда только LDAP/SSO-переменные, не копируйте файл целиком;
- учётка bind должна иметь минимальные права чтения в AD (поиск пользователей);
- используйте `ldaps://`; plain `ldap://` передаёт bind-пароль без шифрования.

Пользователь SSO сопоставляется с записью в таблице `users` по `username`. Без `SSO_AUTO_PROVISION` учётку нужно завести заранее в настройках (как для локального входа). Права (`role`, `allowed_buckets`, `allowed_clouds`, при необходимости `user_roles`) задаются в БД.

В Keycloak (`idp.example.com`, realm `internal`) для клиента (например `s3fm`): Client authentication — confidential; **Valid redirect URIs** — `https://s3fm.example.com/api/auth/sso/callback`; **Web origins** — `https://s3fm.example.com`. **Valid post logout redirect URIs** нужны только если включён `SSO_FEDERATED_LOGOUT=true` (по умолчанию приложение шлёт `{APP_EXTERNAL_URL}/`, например `https://s3fm.example.com/`).

Шаблон переменных SSO/приложения и LDAP: [`src/.env.example`](../src/.env.example).

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
