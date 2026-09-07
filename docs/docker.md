# Docker

## Docker Compose

Поднимает PostgreSQL, Meilisearch и web из корневого [`docker-compose.yml`](../docker-compose.yml).
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
Не копируйте [`src/.env.example`](../src/.env.example) целиком: там `DATABASE_URL=...localhost...`, это для запуска Python на хосте, не для контейнера.

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

## Образ web

Образ web ([`docker/web/Dockerfile`](../docker/web/Dockerfile)):
- `FROM python:3.11.9-bookworm`;
- `pip install -r requirements.txt`;
- `COPY src/` + shortcut `s3` → `python config.py`;
- `CMD gunicorn` на порту `3000`.
