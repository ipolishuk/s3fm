# Эксплуатация

## Экспорт/импорт конфигурации

Скрипт: [`src/config.py`](../src/config.py).

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
