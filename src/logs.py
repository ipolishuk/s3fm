# logs.py — structured application logging (English messages only)
import logging
import os
import sys
import traceback as tb_module
from datetime import datetime

from botocore.exceptions import ClientError
from translations import TRANSLATIONS

LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO').upper()
SHOW_TRACEBACK = os.environ.get('SHOW_TRACEBACK', 'false').lower() == 'true'

LOG_CONFIG = {
    'level': LOG_LEVEL,
    'show_traceback': SHOW_TRACEBACK,
}


def configure_werkzeug_access_log():
    """Werkzeug access log duplicates our structured request logs; disable unless enabled."""
    if os.environ.get('WERKZEUG_ACCESS_LOG', '').lower() in ('true', '1', 'yes'):
        return
    logging.getLogger('werkzeug').setLevel(logging.ERROR)


def get_log_timestamp():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def get_current_username():
    try:
        from flask import has_app_context, g
        if has_app_context():
            return getattr(g, 'log_username', 'SYSTEM')
    except RuntimeError:
        pass
    return 'SYSTEM'


def set_log_username(username):
    try:
        from flask import has_app_context, g
        if has_app_context():
            g.log_username = username
    except RuntimeError:
        pass


def log_message(level, context, message, exception=None, show_traceback=False):
    level_order = {'INFO': 1, 'WARN': 2, 'ERROR': 3}
    config_level = LOG_CONFIG.get('level', 'INFO')
    if level_order.get(level, 0) < level_order.get(config_level, 1):
        return

    timestamp = get_log_timestamp()
    username = get_current_username()
    log_msg = f'[{timestamp}] [{level}] [{context}] [{username}] {message}'

    if exception:
        log_msg += f'\n[{timestamp}] [{level}] [{context}] [{username}] Exception: {str(exception)}'

    if show_traceback and exception:
        for line in tb_module.format_exc().strip().split('\n'):
            log_msg += f'\n[{timestamp}] [{level}] [{context}] [{username}] Traceback: {line}'

    sys.stdout.write(log_msg + '\n')
    sys.stdout.flush()


def log_info(message, context=None):
    log_message('INFO', context or 'GENERAL', message)


def log_warning(message, context=None):
    log_message('WARN', context or 'GENERAL', message)


def log_error(message, context=None, exception=None, show_traceback=False):
    log_message(
        'ERROR',
        context or 'GENERAL',
        message,
        exception,
        show_traceback or LOG_CONFIG['show_traceback'],
    )


def log_user_action(username, action, details=''):
    log_message('INFO', action, details)


def trf_en(key, **kwargs):
    """English translation string for server logs (ignores user locale)."""
    text = TRANSLATIONS['en'].get(key, key)
    for k, v in kwargs.items():
        text = text.replace('{' + str(k) + '}', str(v))
    return text


def log_s3_exception(context, exc, bucket_display=''):
    """Log S3/boto errors in English (API responses may stay localized)."""
    name = bucket_display or 'bucket'
    if isinstance(exc, ClientError):
        err = (exc.response or {}).get('Error', {}) or {}
        code = err.get('Code') or 'Error'
        message = err.get('Message') or str(exc)
        log_error(f'S3 {code} for {name}: {message}', context, exc)
    else:
        log_error(f'S3 operation failed for {name}: {exc}', context, exc)
