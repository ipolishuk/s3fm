"""Search / Meilisearch API routes."""

from __future__ import annotations

from flask import Blueprint

from auth_session import login_required
from search_ops import (
    reindex_search_cancel_impl,
    reindex_search_events_impl,
    reindex_search_impl,
    reindex_search_status_impl,
    search_files_impl,
    search_settings_impl,
    search_status_impl,
)

bp = Blueprint('search', __name__)


@bp.route('/api/search', methods=['GET'])
@login_required
def search_files():
    return search_files_impl()


@bp.route('/api/search/status', methods=['GET'])
@login_required
def search_status():
    return search_status_impl()


@bp.route('/api/search/settings', methods=['GET', 'PUT'])
@login_required
def search_settings():
    return search_settings_impl()


@bp.route('/api/search/reindex', methods=['POST'])
@login_required
def reindex_search():
    return reindex_search_impl()


@bp.route('/api/search/reindex/status', methods=['GET'])
@login_required
def reindex_search_status():
    return reindex_search_status_impl()


@bp.route('/api/search/reindex/events', methods=['GET'])
@login_required
def reindex_search_events():
    return reindex_search_events_impl()


@bp.route('/api/search/reindex/cancel', methods=['POST'])
@login_required
def reindex_search_cancel():
    return reindex_search_cancel_impl()
