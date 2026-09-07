# Стандартизация проекта S3 File Manager

Внутренние правила разработки. Операторская документация — в [`docs/`](../docs/).

---

## 1. Логирование

- Вся запись логов приложения — **только** через [`logs.py`](logs.py):
  - `log_info`, `log_warning`, `log_error`
  - `log_user_action`
  - `log_s3_exception`
  - `trf_en` — английский текст из `TRANSLATIONS['en']` для логов
- **Все сообщения в логах — на английском.** UI/API могут быть на `ru`/`en`; в лог не писать строки из `_()` / локали пользователя.
- Формат строки: `[timestamp] [LEVEL] [context] [username] message`
  - уровни: `INFO` | `WARN` | `ERROR` (не `WARNING`)
  - username: из сессии, иначе `ANONYMOUS`; без request context — `SYSTEM` (`set_log_username`)
- Traceback: только при `SHOW_TRACEBACK=true` или явном `show_traceback=True` / `exception=` у `log_error`.
- Access-log Werkzeug по умолчанию выключен; включать только `WERKZEUG_ACCESS_LOG=true`.
- Ошибки S3: в API — локализованный текст; в лог — `log_s3_exception` / английский `log_error`.
- **Исключение:** CLI [`config.py`](config.py) пишет в stdout/stderr через `print` (операционный вывод, не приложение).

Типичный catch:

```python
except Exception as e:
    log_error('…', 'context', e, LOG_CONFIG['show_traceback'])
    return jsonify({'error': _('error.unexpected')}), 500
```

---

## 2. Уведомления (UI)

- Информационные сообщения пользователю (успех, ошибка, предупреждение) — через **toast**:
  - `showSuccess` / `showError` / `showWarning` / `showInfo` ([`js/notifications.js`](js/notifications.js))
- Не дублировать тот же смысл отдельным `alert()` / произвольным DOM-блоком, если достаточно toast.
- Подтверждения деструктивных действий — через модалки ([`js/modal.js`](js/modal.js)); итог операции всё равно можно закрыть toast’ом.

---

## 3. Структура кода (Python / Flask)

- Плоский пакет `src/` (импорты без префикса пакета: `from logs import …`, `from db import …`).
- Точка входа: [`app.py`](app.py) → Flask `app`; в Docker — `gunicorn … app:app`.
- **Blueprints** ([`blueprints/`](blueprints/)) — тонкие маршруты; бизнес-логика в:
  - `*_api.py` — HTTP-обработчики (`files_api`, `settings_api`), функции `*_impl`
  - `*_ops.py` — операции с S3/доменом (`file_ops`, `upload_ops`, `list_ops`, …)
  - `*_helpers.py` — общие хелперы settings
- Доменные модули: `db`, `roles`, `users`, `buckets`, `security`, `sso`, `meilisearch`, …
- Приватные хелперы — с префиксом `_`.
- Шаблоны: `html/`; статика CSS: `css/` (+ маршруты `/css/`, `/js/` в pages blueprint).
- JSON: `ensure_ascii=False` (кириллица в ответах допустима).

---

## 4. Авторизация, сессия, CSRF

- После логина в сессии: `logged_in`, `username`, `role`, `allowed_buckets`, `allowed_clouds`, `bucket_roles`, `csrf_token`, `locale`, `last_activity`.
- Проверка сессии: `is_session_valid` / idle timeout `APP_SESSION_TIMEOUT_MINUTES`.
- Cookie: `HttpOnly`, `SameSite` (по умолчанию `Lax`), `Secure` по умолчанию on (локально — `SESSION_COOKIE_SECURE=false`).
- API без сессии → JSON `401` + `{'error': …}`; страницы UI → редирект `/login`.
- Права подтягиваются из БД на `GET /api/check-auth` (`sync_logged_in_session_from_db`) — **не** требовать повторный логин после смены ACL.
- CSRF ([`security.py`](security.py)):
  - заголовок `X-CSRF-Token` или поле `csrf_token`
  - обязателен для мутаций при активной сессии (кроме login / SSO)
  - отказ → `403` + `error.csrf_invalid`
  - фронт: [`js/csrf.js`](js/csrf.js) патчит `fetch`
- Ограничение попыток логина: `rate_limit` → `429` + `Retry-After`.

---

## 5. Локализация (i18n)

- Языки: `en`, `ru`; ключи в [`translations.py`](translations.py) (`TRANSLATIONS`).
- UI / JSON для пользователя: `_('dotted.key')` (локаль `g.locale`).
- Логи: `trf_en('dotted.key', …)` или литерал на английском.
- При добавлении строки — ключ **сразу в `en` и `ru`**.
- Плейсхолдеры: `{name}` через `.replace`, не через `str.format` с позиционными `{}`.
- Фронт: `window.I18N` из шаблона; fallback на английскую строку в JS, если ключа нет.
- Справка: `help/docs/{en,ru}/`, `help/support/{en,ru}/`.

---

## 6. API: ответы и ошибки

- Ошибка: `jsonify({'error': _('error.…')}), <status>`.
- Успех мутации: часто `{'ok': True}` (+ поля по необходимости: `bucket_id`, `session_updated`, …).
- Коды:
  - `400` — валидация
  - `401` — нет/просрочена сессия
  - `403` — доступ / CSRF / ACL
  - `404` — не найдено
  - `413` — слишком большой upload (`max_mb` в теле)
  - `429` — rate limit (`retry_after`)
  - `500` — неожиданная / несмапленная ошибка
- Маппинг S3 → статус + локализованный текст: централизованно в `s3_client` (`_map_s3_*`); параллельно писать английский лог.
- Не отдавать traceback клиенту.

---

## 7. База данных

- PostgreSQL, DSN: `DATABASE_URL`.
- Схема: `db.init_schema()` при старте (и CLI `s3 schema`); идемпотентный DDL в [`db.py`](db.py).
- Одноразовые data-migrations — таблица `schema_migrations` (не Alembic).
- Параллельный старт gunicorn: advisory lock вокруг init.
- Секреты бакетов в БД: `enc:v1:…` ([`secrets_crypto.py`](secrets_crypto.py)); plaintext при чтении — legacy.
- Списки ACL: JSONB; семантика `["*"]` = все, `[]` = ничего.
- Публичные функции доступа: `get_*` / `list_*` / `insert_*` / `update_*` / `delete_*`.

---

## 8. Роли и права

- Builtin: `admin`, `storage_admin`, `storage_editor`, `storage_viewer`.
- Permissions — snake_case (`upload_files`, `edit_file_acl`, …); см. [`roles.py`](roles.py).
- Per-bucket grants: таблица `user_roles`; `users.role` — default.
- Зарезервировано: нельзя удалить пользователя/`role` `admin`; править admin-учётку/роль — только admin.
- Проверки доступа к бакету — через `bucket_access` / `roles`, не размазывать ad-hoc по handlers.

---

## 9. Frontend

- Без бандлера: серверный HTML + модули `js/*.js` (порядок подключения в `html/index.html`).
- CSS по зонам: `root.css`, `main.css`, `modal.css`, …
- Общие хелперы: `window.S3FM` (`escapeHtml`, `escapeAttr`, CSRF).
- Пути объектов в DOM — атрибут `data-path`; обработчики через делегирование (спецсимволы в именах).
- Тема: `data-theme` + `localStorage` (`s3fm-theme`).
- Deep links: `/`, `/bucket/<id>/…`, `/settings/<tab>` — сервер + [`js/routing.js`](js/routing.js).
- Не вставлять неэкранированный пользовательский/S3-текст в HTML.

---

## 10. Безопасность

- Не коммитить секреты (`.env`, реальные ключи, пароли). Шаблон: [`src/.env.example`](.env.example).
- `APP_SECRET_KEY` обязателен в prod; `ALLOW_INSECURE_DEV_SECRET` — только локально.
- Endpoint URL: только `http`/`https`; запрет loopback/metadata; DNS-проверки в `security.py`.
- LDAP: предпочтительно `ldaps://`; bind-пароль только из env / `.env`.
- Preview HTML — с CSP sandbox.
- Лимиты: `MAX_UPLOAD_MB`, `ZIP_MAX_*`, rate limit login/metrics.

---

## 11. Docker и окружение

- Compose: корневой [`docker-compose.yml`](../docker-compose.yml) — postgres + meilisearch + web.
- Образ: [`docker/web/Dockerfile`](../docker/web/Dockerfile) — `COPY src/`, shortcut `s3` → `python config.py`.
- В compose тестовые значения для локального запуска; корневой `.env` опционален (LDAP/SSO).
- Не копировать `.env.example` целиком в compose: там `DATABASE_URL=…localhost…` для запуска Python на хосте.
- Apple Silicon: у `web` задан `platform: linux/amd64`.

---

## 12. CLI (`config.py` / `s3`)

- Команды: `schema`, `reset-password`, `export`, `import`.
- Области: `--buckets` | `--clouds` | `--users` | `--roles` | `--all` (взаимоисключающие).
- DSN: `DATABASE_URL` или `--database-url`.
- Сообщения CLI — на английском в stdout/stderr.

---

## 13. Тесты

- Каталог: [`tests/`](tests/), конфиг [`pytest.ini`](pytest.ini) (`pythonpath = .`).
- Запуск из `src/`: `pytest -q`.
- Фокус: unit / light integration (security, CSRF, roles, crypto) — не обязательный полный E2E с живым S3.
- Для тестов допустимы `ALLOW_INSECURE_DEV_SECRET` / тестовый `APP_SECRET_KEY`.

---

## 14. Документация

- Правила разработки (этот файл): `src/config.md`.
- Операторские гайды: [`docs/`](../docs/) (ссылки из корневого `README.md`).
- Пользовательская справка в UI: `src/help/…`.
- При смене поведения API/ACL/env — обновлять соответствующий файл в `docs/`.

---

## Чеклист перед PR

1. Новые логи — через `logs.py`, текст на английском.
2. Новые UI-сообщения — toast + ключи в `translations.py` (`en` и `ru`).
3. Мутации API — CSRF учтён; ответ в формате `{'error'|…}` / `{'ok': True}`.
4. Секреты не в git и не в захардкоженном compose для prod.
5. Права — через существующую модель roles / `user_roles`, без обходов.
6. При необходимости — тест в `tests/` и правка `docs/`.
