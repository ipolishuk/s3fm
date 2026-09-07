# Архитектура

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
- `src/config.md` — стандартизация проекта (логирование, API, i18n, security, …).
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
