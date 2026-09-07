"""pytest suite for s3-file-manager (unit / light integration)."""

import base64
import hashlib
import ipaddress
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

# src/ на PYTHONPATH
_SRC = Path(__file__).resolve().parents[1]
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

os.environ.setdefault('ALLOW_INSECURE_DEV_SECRET', 'true')
os.environ.setdefault('APP_SECRET_KEY', 'test-secret-key-for-pytest')
os.environ.setdefault('ENDPOINT_ALLOW_PRIVATE_RESOLVE', 'true')


@pytest.fixture
def security():
    import security as sec
    return sec


class TestEndpointHost:
    def test_literal_private_forbidden(self, security):
        assert security.is_forbidden_endpoint_host('10.0.0.1')
        assert security.is_forbidden_endpoint_host('127.0.0.1')
        assert security.is_forbidden_endpoint_host('169.254.169.254')

    def test_public_ip_allowed(self, security):
        assert not security.is_forbidden_endpoint_host('8.8.8.8')

    def test_localhost_name_forbidden(self, security):
        assert security.is_forbidden_endpoint_host('localhost')
        assert security.is_forbidden_endpoint_host('foo.localhost')


class TestDnsRebinding:
    def test_dns_to_link_local_forbidden(self, security):
        with mock.patch.object(
            security,
            'resolve_hostname_addresses',
            return_value=[ipaddress.ip_address('169.254.169.254')],
        ):
            assert security.hostname_dns_forbidden('evil.example.com', allow_private=True)
            assert security.hostname_dns_forbidden('evil.example.com', allow_private=False)

    def test_dns_to_private_allowed_when_flag(self, security):
        with mock.patch.object(
            security,
            'resolve_hostname_addresses',
            return_value=[ipaddress.ip_address('10.1.2.3')],
        ):
            assert not security.hostname_dns_forbidden('s3.internal', allow_private=True)
            assert security.hostname_dns_forbidden('s3.internal', allow_private=False)

    def test_dns_to_public_ok(self, security):
        with mock.patch.object(
            security,
            'resolve_hostname_addresses',
            return_value=[ipaddress.ip_address('1.1.1.1')],
        ):
            assert not security.hostname_dns_forbidden('cdn.example.com', allow_private=False)

    def test_validate_blocks_dns_metadata(self, security):
        with mock.patch.object(security, 'get_cloud_row', return_value=None), mock.patch.object(
            security,
            'resolve_hostname_addresses',
            return_value=[ipaddress.ip_address('169.254.169.254')],
        ):
            ok, err = security.validate_endpoint_url(
                'https://looks-public.example.com',
                require_allowlist=False,
            )
            assert not ok
            assert err == 'error.endpoint_host_forbidden'


class TestSecretsCrypto:
    def test_roundtrip(self):
        from secrets_crypto import decrypt_secret, encrypt_secret, is_encrypted

        plain = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        enc = encrypt_secret(plain)
        assert is_encrypted(enc)
        assert enc.startswith('enc:v1:')
        assert decrypt_secret(enc) == plain
        assert decrypt_secret(plain) == plain  # legacy plaintext


class TestRateLimit:
    def test_login_limit(self):
        import importlib
        import rate_limit

        importlib.reload(rate_limit)
        rate_limit.LOGIN_RATE_LIMIT = 3
        rate_limit.LOGIN_RATE_WINDOW_SECONDS = 300
        rate_limit._limiter = rate_limit.SlidingWindowLimiter()

        ip = '203.0.113.9'
        user = 'bruteforce-user'
        for _ in range(3):
            rate_limit.record_login_failure(ip, user)
        allowed, retry = rate_limit.check_login_rate(ip, user)
        assert not allowed
        assert retry >= 1


class TestCsrf:
    def test_validate_csrf_ok(self, security):
        class Sess(dict):
            pass

        class Req:
            headers = {'X-CSRF-Token': 'abc123'}
            form = None
            is_json = False

        sess = Sess(csrf_token='abc123')
        assert security.validate_csrf(sess, Req())

    def test_validate_csrf_mismatch(self, security):
        class Sess(dict):
            pass

        class Req:
            headers = {'X-CSRF-Token': 'wrong'}
            form = None
            is_json = False

        sess = Sess(csrf_token='abc123')
        assert not security.validate_csrf(sess, Req())


class TestRoles:
    def test_viewer_permissions(self):
        from roles import ROLE_PERMISSIONS, ROLE_STORAGE_VIEWER, PERM_DOWNLOAD_FILE, PERM_DELETE_FILE

        perms = ROLE_PERMISSIONS[ROLE_STORAGE_VIEWER]
        assert PERM_DOWNLOAD_FILE in perms
        assert PERM_DELETE_FILE not in perms

    def test_storage_admin_has_full_storage_perms_not_settings_only(self):
        from roles import (
            ROLE_PERMISSIONS,
            ROLE_ADMIN,
            ROLE_STORAGE_ADMIN,
            is_settings_admin_role,
            is_full_storage_role,
            PERM_ADD_BUCKET,
        )

        assert set(ROLE_PERMISSIONS[ROLE_STORAGE_ADMIN]) == set(ROLE_PERMISSIONS[ROLE_ADMIN])
        assert PERM_ADD_BUCKET in ROLE_PERMISSIONS[ROLE_STORAGE_ADMIN]
        assert is_full_storage_role(ROLE_STORAGE_ADMIN)
        assert not is_settings_admin_role(ROLE_STORAGE_ADMIN)
        assert is_settings_admin_role(ROLE_ADMIN)

    def test_legacy_role_aliases(self):
        from roles import normalize_role_name, ROLE_STORAGE_EDITOR, ROLE_STORAGE_VIEWER

        assert normalize_role_name('editor') == ROLE_STORAGE_EDITOR
        assert normalize_role_name('viewer') == ROLE_STORAGE_VIEWER

    def test_admin_has_upload(self):
        from roles import ROLE_PERMISSIONS, ROLE_ADMIN, PERM_UPLOAD_FILES

        assert PERM_UPLOAD_FILES in ROLE_PERMISSIONS[ROLE_ADMIN]


class TestFernetKeyDerivation:
    def test_key_stable(self):
        raw = 'test-secret-key-for-pytest'
        digest = hashlib.sha256(raw.encode('utf-8')).digest()
        key = base64.urlsafe_b64encode(digest)
        assert len(key) == 44


class TestBucketAccessNormalize:
    def test_strips_leading_slash_and_decodes(self):
        from bucket_access import normalize_s3_object_key

        assert normalize_s3_object_key('/a/b%20c') == 'a/b c'
        assert normalize_s3_object_key(None) == ''
        assert normalize_s3_object_key('  x/y  ') == 'x/y'


class TestCsrfEnsureToken:
    def test_creates_and_reuses(self, security):
        sess = {}
        t1 = security.ensure_csrf_token(sess)
        t2 = security.ensure_csrf_token(sess)
        assert t1 and t1 == t2
        assert sess['csrf_token'] == t1

    def test_json_body_token(self, security):
        class Sess(dict):
            pass

        class Req:
            headers = {}
            form = None
            is_json = True

            def get_json(self, silent=True):
                return {'csrf_token': 'json-token'}

        sess = Sess(csrf_token='json-token')
        assert security.validate_csrf(sess, Req())


class TestDnsLoopbackAlwaysBlocked:
    def test_loopback_forbidden_even_with_private_allowed(self, security):
        with mock.patch.object(
            security,
            'resolve_hostname_addresses',
            return_value=[ipaddress.ip_address('127.0.0.1')],
        ):
            assert security.hostname_dns_forbidden('local.example', allow_private=True)


class TestFilesBlueprintRegistration:
    def test_mutation_routes_on_files_bp(self):
        os.environ.setdefault('ALLOW_INSECURE_DEV_SECRET', 'true')
        import app as app_module

        endpoints = {
            r.rule: r.endpoint
            for r in app_module.app.url_map.iter_rules()
            if r.rule.startswith('/files/') or r.rule == '/files'
        }
        assert endpoints['/files'] == 'files.list_files'
        assert endpoints['/files/upload'] == 'files.upload_file'
        assert endpoints['/files/create-folder'] == 'files.create_folder'
        assert endpoints['/files/delete'] == 'files.delete_object'
        assert endpoints['/files/download-archive'] == 'files.download_archive'


class TestFileOpsHelpers:
    def test_display_names_from_items(self):
        from file_ops import _display_names_from_items

        assert _display_names_from_items([{'path': 'dir/file.txt'}, {'path': 'alone'}]) == [
            'file.txt',
            'alone',
        ]

    def test_normalize_copy_into_self(self):
        from file_ops import _normalize_copy_items

        items = _normalize_copy_items(
            [{'path': 'folder/', 'type': 'folder'}],
            'bucket-a',
            'bucket-a',
            'folder/',
        )
        assert len(items) == 1
        assert items[0]['skip'] is True


class TestListOps:
    def test_parse_page_skips_nested_and_markers(self):
        from datetime import datetime, timezone
        from list_ops import _parse_list_objects_page

        class Obj(dict):
            pass

        response = {
            'CommonPrefixes': [{'Prefix': 'docs/'}],
            'Contents': [
                {'Key': 'docs/', 'Size': 0, 'LastModified': datetime.now(timezone.utc)},
                {'Key': 'readme.txt', 'Size': 3, 'LastModified': datetime.now(timezone.utc)},
                {'Key': 'docs/nested.txt', 'Size': 1, 'LastModified': datetime.now(timezone.utc)},
            ],
        }
        folders, files = _parse_list_objects_page(response, '')
        assert folders == [{'name': 'docs', 'path': 'docs/'}]
        assert [f['name'] for f in files] == ['readme.txt']


class TestUploadOps:
    def test_guess_content_type_from_name(self):
        from upload_ops import _guess_upload_content_type

        class F:
            content_type = 'application/octet-stream'
            filename = 'note.json'

        assert _guess_upload_content_type(F()) == 'application/json'

    def test_guess_keeps_explicit_type(self):
        from upload_ops import _guess_upload_content_type

        class F:
            content_type = 'image/png'
            filename = 'x.bin'

        assert _guess_upload_content_type(F()) == 'image/png'


class TestAclOps:
    def test_detect_private_canned(self):
        from acl_ops import _detect_canned_acl

        policy = {
            'Owner': {'ID': 'abc'},
            'Grants': [
                {
                    'Grantee': {'Type': 'CanonicalUser', 'ID': 'abc'},
                    'Permission': 'FULL_CONTROL',
                }
            ],
        }
        assert _detect_canned_acl(policy) == 'private'

    def test_metadata_routes_on_files_bp(self):
        os.environ.setdefault('ALLOW_INSECURE_DEV_SECRET', 'true')
        import app as app_module

        endpoints = {
            (r.rule, tuple(sorted(r.methods - {'HEAD', 'OPTIONS'}))): r.endpoint
            for r in app_module.app.url_map.iter_rules()
            if r.rule.startswith('/api/files/')
        }
        assert endpoints[('/api/files/metadata', ('GET',))] == 'files.file_metadata'
        assert endpoints[('/api/files/metadata/acl', ('PUT',))] == 'files.file_metadata_acl_update'


class TestSettingsBlueprint:
    def test_settings_routes_registered(self):
        os.environ.setdefault('ALLOW_INSECURE_DEV_SECRET', 'true')
        import app as app_module

        endpoints = {
            r.rule: r.endpoint
            for r in app_module.app.url_map.iter_rules()
            if r.rule.startswith('/api/settings')
        }
        assert endpoints['/api/settings/users'] == 'settings.settings_list_users'
        assert endpoints['/api/settings/clouds'] == 'settings.settings_clouds'
        assert endpoints['/api/settings/status'] == 'settings.settings_services_status'
        assert len(endpoints) >= 17


class TestSettingsApiModule:
    def test_impls_exported(self):
        import settings_api
        assert callable(settings_api.settings_list_users_impl)
        assert callable(settings_api.settings_clouds_impl)
        assert callable(settings_api.settings_bucket_search_index_enabled_impl)


class TestSettingsHelpersModule:
    def test_helpers_exported(self):
        import settings_helpers as sh

        assert callable(sh._is_settings_admin)
        assert callable(sh._can_add_bucket)
        assert callable(sh._can_manage_bucket_row)
        assert callable(sh._can_open_settings)
        assert callable(sh._normalize_role_permissions)
        assert callable(sh._validate_bucket_update_s3_target)
        assert sh._normalize_role_permissions(['download_file', 'nope']) == ['download_file']

    def test_bucket_by_key_denies_without_existence_leak(self):
        """GET/PUT чужого бакета: 404, не 403 (анти-enumeration)."""
        src = (_SRC / 'settings_api.py').read_text(encoding='utf-8')
        start = src.index('def settings_bucket_by_key_impl')
        end = src.index('\ndef settings_options_clouds_impl', start)
        body = src[start:end]
        assert '_can_manage_bucket_row(row_probe)' in body
        assert "error.bucket_not_found" in body
        assert "settings_bucket_authz" in body
        # В ветке GET/PUT probe не должно быть access_denied (только DELETE)
        probe = body.split('if request.method == \'DELETE\':', 1)[0]
        assert 'error.access_denied' not in probe
        assert '403' not in probe


class TestFrontendExtracts:
    def test_selection_mode_script_present(self):
        js = _SRC / 'js' / 'selection-mode.js'
        html = (_SRC / 'html' / 'index.html').read_text(encoding='utf-8')
        assert js.is_file()
        assert '/js/selection-mode.js' in html
        text = js.read_text(encoding='utf-8')
        assert 'function toggleSelectionMode' in text
        assert 'function clearSelection' in text
        assert 'async function toggleSelectionMode' not in html
        assert 'function clearSelection()' not in html

    def test_files_script_present(self):
        js = _SRC / 'js' / 'files.js'
        html = (_SRC / 'html' / 'index.html').read_text(encoding='utf-8')
        assert js.is_file()
        assert '/js/files.js' in html
        text = js.read_text(encoding='utf-8')
        assert 'async function loadFiles' in text
        assert 'function displayFiles' in text
        assert 'function formatDate' in text
        assert 'function formatFileSize' in text
        assert 'async function deleteObject' in text
        assert 'function openFilePreview' in text
        assert 'async function loadFiles' not in html
        assert 'function displayFiles' not in html

    def test_app_modules_extracted_from_index(self):
        html = (_SRC / 'html' / 'index.html').read_text(encoding='utf-8')
        assert 'let currentPath' not in html
        assert 'function setupSettingsPanel' not in html
        assert 'function goToHome' not in html
        required = [
            'app-state.js',
            'auth-ui.js',
            'permissions-ui.js',
            'list-row-utils.js',
            'toolbar.js',
            'home-navigation.js',
            'routing.js',
            'settings-panel.js',
            'app-init.js',
            'files.js',
            'selection-mode.js',
        ]
        for name in required:
            assert (_SRC / 'js' / name).is_file(), name
            assert f'/js/{name}' in html, name


class TestContextMenuWiring:
    def test_list_row_path_bridge_not_typo(self):
        text = (_SRC / 'js' / 'context-menus.js').read_text(encoding='utf-8')
        assert 'global.getListRowPath(row)' in text
        assert 'return global.listRowPath(row)' not in text

    def test_onclick_handlers_exported(self):
        import re
        html = (_SRC / 'html' / 'index.html').read_text(encoding='utf-8')
        all_js = '\n'.join(p.read_text(encoding='utf-8') for p in (_SRC / 'js').glob('*.js'))
        names = set()
        for oc in re.findall(r'onclick="([^"]+)"', html):
            m = re.match(r'(?:window\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(', oc.strip())
            if m:
                names.add(m.group(1))
        missing = []
        for name in sorted(names):
            if not any(
                pat in all_js
                for pat in (
                    f'window.{name} =',
                    f'global.{name} =',
                    f'function {name}(',
                    f'async function {name}(',
                )
            ):
                missing.append(name)
        assert missing == [], missing


class TestRemainingBlueprints:
    def test_search_buckets_pages_registered(self):
        os.environ.setdefault('ALLOW_INSECURE_DEV_SECRET', 'true')
        import app as app_module

        endpoints = {r.endpoint: r.rule for r in app_module.app.url_map.iter_rules()}
        assert endpoints.get('search.search_files') == '/api/search'
        assert endpoints.get('search.reindex_search') == '/api/search/reindex'
        assert endpoints.get('buckets.list_buckets') == '/api/buckets'
        assert endpoints.get('buckets.get_bucket_size') == '/api/bucket-size/<bucket_id>'
        assert endpoints.get('pages.index') == '/'
        assert endpoints.get('pages.serve_js') == '/js/<path:filename>'
        assert any(r.endpoint == 'pages.settings_view' for r in app_module.app.url_map.iter_rules())
        assert any(r.endpoint == 'pages.help_view' for r in app_module.app.url_map.iter_rules())
        # no bare app views left
        bare = [ep for ep in endpoints if '.' not in ep and ep != 'static']
        assert bare == [], bare

    def test_domain_impls_callable(self):
        from search_ops import search_files_impl
        from bucket_ops import get_bucket_size_impl, list_buckets_impl

        assert callable(search_files_impl)
        assert callable(list_buckets_impl)
        assert callable(get_bucket_size_impl)
