"""Gunicorn config for s3-file-manager (Docker / prod).

Скачивание больших файлов идёт proxy-stream через web. У sync-worker
GUNICORN_TIMEOUT считает wall-clock всего запроса (даже при активной
передаче) → обрыв ~после N секунд (~300MB при типичной скорости).
gthread держит heartbeat в отдельном потоке — длинный download не
убивает worker.
"""

import os


bind = os.environ.get('GUNICORN_BIND', '0.0.0.0:3000')
workers = int(os.environ.get('WEB_CONCURRENCY', os.environ.get('GUNICORN_WORKERS', '2')))
threads = int(os.environ.get('WEB_THREADS', os.environ.get('GUNICORN_THREADS', '4')))
# gthread: timeout не рвёт активный stream (sync — рвёт).
worker_class = os.environ.get('GUNICORN_WORKER_CLASS', 'gthread')
# Запас на multi-GB dump через медленный канал; при gthread это в основном
# защита от зависших запросов, не лимит размера файла.
timeout = int(os.environ.get('GUNICORN_TIMEOUT', '3600'))
graceful_timeout = int(os.environ.get('GUNICORN_GRACEFUL_TIMEOUT', '30'))
keepalive = int(os.environ.get('GUNICORN_KEEPALIVE', '5'))
accesslog = os.environ.get('GUNICORN_ACCESSLOG', '-')
errorlog = os.environ.get('GUNICORN_ERRORLOG', '-')
loglevel = os.environ.get('GUNICORN_LOGLEVEL', 'info')
preload_app = False


def post_fork(server, worker):
    """Инициализация схемы/Meili в каждом worker-процессе."""
    try:
        from app import start_background_init
        start_background_init()
    except Exception as exc:
        server.log.warning('post_fork startup failed: %s', exc)
