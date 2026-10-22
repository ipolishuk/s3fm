"""Sidebar buckets API (list + size + properties)."""

from __future__ import annotations

from datetime import date, datetime

from flask import Blueprint, jsonify

from auth_session import login_required
from bucket_access import check_bucket_access
from bucket_ops import (
    get_bucket_size_impl,
    list_buckets_config_impl,
    list_buckets_impl,
)
from db import get_bucket_row, get_bucket_row_by_id
from logs import LOG_CONFIG, log_error
from translations import _

bp = Blueprint('buckets', __name__)


def _iso_ts(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _bucket_properties_payload(row):
    return {
        'cloud_id': row.get('cloud_id') or '',
        'display_name': row.get('display_name') or '',
        'bucket_name': row.get('bucket_name') or '',
        'bucket_id': row.get('bucket_id') or '',
        'created_by': (row.get('created_by') or '').strip() or None,
        'created_at': _iso_ts(row.get('created_at')),
        'updated_at': _iso_ts(row.get('updated_at')),
    }


@bp.route('/api/buckets')
@login_required
def list_buckets():
    return list_buckets_impl()


@bp.route('/api/buckets-config')
@login_required
def list_buckets_config():
    return list_buckets_config_impl()


@bp.route('/api/bucket-size/<bucket_id>')
@login_required
def get_bucket_size(bucket_id):
    return get_bucket_size_impl(bucket_id)


@bp.route('/api/buckets/<path:bucket_id>/properties')
@login_required
def bucket_properties(bucket_id):
    """Свойства бакета для ПКМ (имя, кто добавил, даты). Без секретов."""
    bid = (bucket_id or '').strip()
    if not bid:
        return jsonify({'error': _('error.bucket_not_found')}), 404
    if not check_bucket_access(bid):
        return jsonify({'error': _('error.access_denied')}), 403
    try:
        row = get_bucket_row_by_id(bid)
        if not row:
            return jsonify({'error': _('error.bucket_not_found')}), 404
        return jsonify(_bucket_properties_payload(row))
    except Exception as e:
        log_error('Failed to load bucket properties', 'bucket_properties', e, LOG_CONFIG['show_traceback'])
        return jsonify({'error': _('error.unexpected')}), 500


@bp.route('/api/buckets/properties-by-key')
@login_required
def bucket_properties_by_key():
    """Свойства по cloud_id + display_name (строка Settings → Buckets)."""
    from flask import request

    cloud_id = (request.args.get('cloud_id') or '').strip()
    display_name = (request.args.get('display_name') or '').strip()
    if not cloud_id or not display_name:
        return jsonify({'error': _('error.unexpected')}), 400
    try:
        row = get_bucket_row(cloud_id, display_name)
        if not row:
            return jsonify({'error': _('error.bucket_not_found')}), 404
        bid = (row.get('bucket_id') or '').strip()
        if bid and not check_bucket_access(bid):
            # Settings-manageable без ACL в session: admin / creator
            from settings_helpers import _can_manage_bucket_row
            if not _can_manage_bucket_row(row):
                return jsonify({'error': _('error.access_denied')}), 403
        elif not bid:
            from settings_helpers import _can_manage_bucket_row
            if not _can_manage_bucket_row(row):
                return jsonify({'error': _('error.access_denied')}), 403
        return jsonify(_bucket_properties_payload(row))
    except Exception as e:
        log_error(
            'Failed to load bucket properties by key',
            'bucket_properties',
            e,
            LOG_CONFIG['show_traceback'],
        )
        return jsonify({'error': _('error.unexpected')}), 500
