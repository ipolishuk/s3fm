# Веб-интерфейс

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
