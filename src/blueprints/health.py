"""Health / readiness / metrics endpoints."""

import os

from flask import Blueprint, Response, jsonify, request
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from rate_limit import check_metrics_rate, client_ip_from_request

bp = Blueprint('health', __name__)


@bp.route('/healthz/live', methods=['GET'])
@bp.route('/health', methods=['GET'])
def healthz_live():
    return jsonify({'status': 'ok'}), 200


@bp.route('/healthz/ready', methods=['GET'])
def healthz_ready():
    """Readiness: PostgreSQL обязателен; Meilisearch — только если включён."""
    import meilisearch
    from db import get_connection

    checks = {}
    ready = True
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute('SELECT 1')
                cur.fetchone()
            checks['database'] = 'ok'
        finally:
            conn.close()
    except Exception as e:
        ready = False
        checks['database'] = f'error: {e}'

    meili_enabled = (os.environ.get('MEILI_ENABLED') or '').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )
    if meili_enabled:
        try:
            meili = meilisearch.connection_status()
            if meili.get('available'):
                checks['meilisearch'] = 'ok'
            else:
                ready = False
                checks['meilisearch'] = meili.get('config_error') or 'unavailable'
        except Exception as e:
            ready = False
            checks['meilisearch'] = f'error: {e}'

    status = 'ready' if ready else 'not_ready'
    return jsonify({'status': status, 'checks': checks}), (200 if ready else 503)


@bp.route('/metrics', methods=['GET'])
def metrics():
    from translations import _

    ip = client_ip_from_request(request)
    allowed, retry_after = check_metrics_rate(ip)
    if not allowed:
        resp = jsonify({
            'error': _('error.rate_limited'),
            'retry_after': max(1, int(retry_after or 1)),
        })
        resp.status_code = 429
        resp.headers['Retry-After'] = str(max(1, int(retry_after or 1)))
        return resp
    return Response(generate_latest(), mimetype=CONTENT_TYPE_LATEST)
