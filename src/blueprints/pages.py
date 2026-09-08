"""Shell / SPA page routes and static CSS/JS."""

from __future__ import annotations

import os

from flask import Blueprint, g, jsonify, redirect, render_template, send_from_directory, session, url_for

from auth_session import login_required
from bucket_access import check_bucket_access, find_bucket_config_by_bucket_id
from docs import get_help_documentation, get_help_support
from settings_helpers import _can_open_settings, _settings_buckets_only

bp = Blueprint('pages', __name__)

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@bp.route('/css/<path:filename>')
def serve_css(filename):
    return send_from_directory(os.path.join(_APP_DIR, 'css'), filename)


@bp.route('/js/<path:filename>')
def serve_js(filename):
    return send_from_directory(os.path.join(_APP_DIR, 'js'), filename)


@bp.route('/img/<path:filename>')
def serve_img(filename):
    return send_from_directory(os.path.join(_APP_DIR, 'img'), filename)


@bp.route('/')
def index():
    """Главная страница с интерфейсом управления."""
    if not session.get('logged_in'):
        return redirect(url_for('auth.login_page'))
    return render_template('index.html')


@bp.route('/bucket/<bucket_id>/<path:subpath>')
@login_required
def bucket_view_with_path(bucket_id, subpath):
    if not check_bucket_access(bucket_id):
        return redirect(url_for('pages.index'))
    if not find_bucket_config_by_bucket_id(bucket_id):
        return redirect(url_for('pages.index'))
    return render_template('index.html')


@bp.route('/bucket/<bucket_id>')
@login_required
def bucket_view(bucket_id):
    if not check_bucket_access(bucket_id):
        return redirect(url_for('pages.index'))
    if not find_bucket_config_by_bucket_id(bucket_id):
        return redirect(url_for('pages.index'))
    return render_template('index.html')


@bp.route('/settings')
@bp.route('/settings/<tab>')
@login_required
def settings_view(tab='buckets'):
    if not _can_open_settings():
        return redirect(url_for('pages.index'))
    if tab not in ('buckets', 'clouds', 'users', 'roles', 'search', 'status'):
        return redirect('/settings/buckets')
    # Не-admin (storage_admin / add_bucket): только вкладка бакетов
    if _settings_buckets_only() and tab != 'buckets':
        return redirect('/settings/buckets')
    return render_template('index.html')


@bp.route('/api/help/documentation')
@login_required
def api_help_documentation():
    locale = getattr(g, 'locale', None) or session.get('locale', 'en')
    return jsonify({'sections': get_help_documentation(locale)})


@bp.route('/api/help/support')
@login_required
def api_help_support():
    locale = getattr(g, 'locale', None) or session.get('locale', 'en')
    return jsonify({'sections': get_help_support(locale)})


@bp.route('/help')
@bp.route('/help/<tab>')
@login_required
def help_view(tab='documentation'):
    if tab not in ('documentation', 'support'):
        return redirect('/help/documentation')
    return render_template('index.html')
