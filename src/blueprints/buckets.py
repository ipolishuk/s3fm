"""Sidebar buckets API (list + size)."""

from __future__ import annotations

from flask import Blueprint

from auth_session import login_required
from bucket_ops import (
    get_bucket_size_impl,
    list_buckets_config_impl,
    list_buckets_impl,
)

bp = Blueprint('buckets', __name__)


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
