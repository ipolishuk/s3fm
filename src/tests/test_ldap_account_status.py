"""Сверка статуса УЗ s3fm с флагом блокировки Active Directory."""

import os
import sys
from pathlib import Path
from unittest import mock

os.environ.setdefault('ALLOW_INSECURE_DEV_SECRET', 'true')
os.environ.setdefault('APP_SECRET_KEY', 'test-secret-key-for-pytest')

_SRC = Path(__file__).resolve().parents[1]
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

import ldap_client


class _Attr:
    def __init__(self, values):
        self.values = values


class _Entry:
    def __init__(self, **attrs):
        self._attrs = attrs

    def __contains__(self, name):
        return name in self._attrs

    def __getattr__(self, name):
        if name in self._attrs:
            return _Attr(self._attrs[name])
        raise AttributeError(name)


class _Conn:
    def __init__(self, entries, ok=True, description='success'):
        self.entries = entries
        self.ok = ok
        self.result = {'description': description}
        self.last_error = ''
        self.unbound = False

    def search(self, *args, **kwargs):
        return self.ok

    def unbind(self):
        self.unbound = True

    def close(self):
        return None


class TestAccountDisableFlag:
    def test_disabled_bit(self):
        assert ldap_client.ldap_account_disabled(514)
        assert ldap_client.ldap_account_disabled('66050')
        assert ldap_client.ldap_account_disabled(2)

    def test_enabled_account(self):
        assert not ldap_client.ldap_account_disabled(512)
        assert not ldap_client.ldap_account_disabled(66048)
        assert not ldap_client.ldap_account_disabled('')
        assert not ldap_client.ldap_account_disabled(None)


class TestDisabledLookup:
    def test_marks_only_disabled_directory_users(self):
        conn = _Conn([
            _Entry(sAMAccountName=['Bob'], userAccountControl=['514']),
            _Entry(sAMAccountName=['local'], userAccountControl=['512']),
        ])
        with mock.patch.object(ldap_client, 'is_ldap_configured', return_value=True), mock.patch.object(
            ldap_client, '_create_service_connection', return_value=conn
        ):
            disabled = ldap_client.disabled_usernames_in_ldap(['bob', 'local', 'admin', 'missing'])
        assert disabled == {'bob'}
        assert conn.unbound is True

    def test_search_failure_disables_nobody(self):
        conn = _Conn([], ok=False, description='operationsError')
        with mock.patch.object(ldap_client, 'is_ldap_configured', return_value=True), mock.patch.object(
            ldap_client, '_create_service_connection', return_value=conn
        ):
            assert ldap_client.disabled_usernames_in_ldap(['bob']) is None

    def test_admin_is_not_queried(self):
        with mock.patch.object(ldap_client, '_create_service_connection') as connect:
            assert ldap_client.disabled_usernames_in_ldap(['admin', ' Admin ']) == set()
        connect.assert_not_called()


class TestSync:
    def _run(self, disabled, usernames=None):
        updated = []

        def disable(names):
            updated.extend(names)
            return len(names)

        with mock.patch.object(ldap_client, 'is_ldap_configured', return_value=True), mock.patch.object(
            ldap_client, 'status_sync_interval_sec', return_value=86400
        ), mock.patch.object(ldap_client, '_advisory_try_lock', return_value=True), mock.patch.object(
            ldap_client, '_advisory_unlock'
        ), mock.patch.object(
            ldap_client, '_seconds_until_status_sync', return_value=0
        ), mock.patch(
            'db.get_connection', return_value=_Conn([])
        ), mock.patch(
            'db.list_active_usernames', return_value=['bob', 'local'] if usernames is None else usernames
        ), mock.patch.object(
            ldap_client, 'disabled_usernames_in_ldap', return_value=disabled
        ), mock.patch('db.disable_users', side_effect=disable) as disable_mock, mock.patch(
            'db.set_app_state'
        ) as save_state:
            result = ldap_client.sync_ldap_account_status()
        return result, updated, disable_mock, save_state

    def test_disables_blocked_account_and_records_time(self):
        result, updated, _disable, save_state = self._run({'bob'})
        assert result == 1
        assert updated == ['bob']
        save_state.assert_called_once()

    def test_directory_failure_does_not_disable_or_stamp(self):
        result, updated, disable_mock, save_state = self._run(None)
        assert result is None
        assert updated == []
        disable_mock.assert_not_called()
        save_state.assert_not_called()
