"""Settings API routes (thin wrappers around app.py impls)."""

from __future__ import annotations

from flask import Blueprint

from auth_session import login_required

bp = Blueprint('settings', __name__)


def _settings_api():
    import settings_api
    return settings_api

@bp.route('/api/settings/users', methods=['GET', 'POST'])
@login_required
def settings_list_users():
    return _settings_api().settings_list_users_impl()

@bp.route('/api/settings/status', methods=['GET'])
@login_required
def settings_services_status():
    return _settings_api().settings_services_status_impl()

@bp.route('/api/settings/users/ldap-lookup', methods=['GET'])
@login_required
def settings_users_ldap_lookup():
    return _settings_api().settings_users_ldap_lookup_impl()

@bp.route('/api/settings/users/<path:username>', methods=['GET', 'PUT', 'DELETE'])
@login_required
def settings_user_by_name(username):
    return _settings_api().settings_user_by_name_impl(username)

@bp.route('/api/settings/roles', methods=['GET', 'POST'])
@login_required
def settings_roles():
    return _settings_api().settings_roles_impl()

@bp.route('/api/settings/roles/<role_name>', methods=['GET', 'PUT', 'DELETE'])
@login_required
def settings_role_by_name(role_name):
    return _settings_api().settings_role_by_name_impl(role_name)

@bp.route('/api/settings/options/roles')
@login_required
def settings_options_roles():
    return _settings_api().settings_options_roles_impl()

@bp.route('/api/settings/options/role-permissions')
@login_required
def settings_options_role_permissions():
    return _settings_api().settings_options_role_permissions_impl()

@bp.route('/api/settings/buckets', methods=['GET', 'POST'])
@login_required
def settings_buckets():
    return _settings_api().settings_buckets_impl()

@bp.route('/api/settings/bucket-access/<path:bucket_id>', methods=['GET', 'POST', 'PUT', 'DELETE'])
@login_required
def settings_bucket_access(bucket_id):
    return _settings_api().settings_bucket_access_impl(bucket_id)

@bp.route('/api/settings/buckets/<cloud_id>/<path:display_name>', methods=['GET', 'PUT', 'DELETE'])
@login_required
def settings_bucket_by_key(cloud_id, display_name):
    return _settings_api().settings_bucket_by_key_impl(cloud_id, display_name)

@bp.route('/api/settings/options/clouds')
@login_required
def settings_options_clouds():
    return _settings_api().settings_options_clouds_impl()

@bp.route('/api/settings/buckets/test', methods=['POST'])
@login_required
def settings_test_bucket_connection():
    return _settings_api().settings_test_bucket_connection_impl()

@bp.route('/api/settings/options/buckets')
@login_required
def settings_options_buckets():
    return _settings_api().settings_options_buckets_impl()

@bp.route('/api/settings/options/endpoints')
@login_required
def settings_options_endpoints():
    return _settings_api().settings_options_endpoints_impl()

@bp.route('/api/settings/clouds', methods=['GET', 'POST'])
@login_required
def settings_clouds():
    return _settings_api().settings_clouds_impl()

@bp.route('/api/settings/clouds/<cloud_id>', methods=['GET', 'PUT', 'DELETE'])
@login_required
def settings_cloud_by_id(cloud_id):
    return _settings_api().settings_cloud_by_id_impl(cloud_id)

@bp.route('/api/settings/buckets/search-index-enabled', methods=['PUT'])
@login_required
def settings_bucket_search_index_enabled():
    return _settings_api().settings_bucket_search_index_enabled_impl()

