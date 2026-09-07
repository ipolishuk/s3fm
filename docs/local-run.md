# Запуск локально

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
