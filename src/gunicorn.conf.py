"""Gunicorn config for s3-file-manager (Docker / prod)."""

import os


bind = os.environ.get('GUNICORN_BIND', '0.0.0.0:3000')
workers = int(os.environ.get('WEB_CONCURRENCY', os.environ.get('GUNICORN_WORKERS', '2')))
threads = int(os.environ.get('WEB_THREADS', os.environ.get('GUNICORN_THREADS', '4')))
timeout = int(os.environ.get('GUNICORN_TIMEOUT', '120'))
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
