"""Unit tests for OIDC SSO callback helpers."""

import base64
import json
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

_SRC = Path(__file__).resolve().parents[1]
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

os.environ.setdefault('ALLOW_INSECURE_DEV_SECRET', 'true')
os.environ.setdefault('APP_SECRET_KEY', 'test-secret-key-for-pytest')


def _jwt(payload: dict) -> str:
    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')

    header = b64(json.dumps({'alg': 'none', 'typ': 'JWT'}).encode())
    body = b64(json.dumps(payload).encode())
    return f'{header}.{body}.sig'


@pytest.fixture
def sso():
    import sso as sso_module
    return sso_module


class TestClaimsFromIdToken:
    def test_reads_preferred_username(self, sso):
        token = _jwt({
            'preferred_username': 'i.ivanov',
            'email': 'i.ivanov@example.com',
            'name': 'Ivan Ivanov',
        })
        claims = sso._claims_from_id_token(token)
        assert claims['preferred_username'] == 'i.ivanov'
        assert claims['email'] == 'i.ivanov@example.com'

    def test_invalid_token_returns_empty(self, sso):
        assert sso._claims_from_id_token('') == {}
        assert sso._claims_from_id_token('not-a-jwt') == {}
        assert sso._claims_from_id_token('a.!!!.c') == {}


class TestUserinfoFromToken:
    def test_skips_userinfo_when_id_token_has_username(self, sso):
        token = _jwt({
            'preferred_username': 'i.ivanov',
            'given_name': 'Ivan',
            'family_name': 'Ivanov',
        })
        with mock.patch.object(sso, '_fetch_userinfo') as fetch:
            info = sso._userinfo_from_token({
                'id_token': token,
                'access_token': 'unused',
            })
        fetch.assert_not_called()
        assert info['preferred_username'] == 'i.ivanov'
        assert sso.resolve_username_from_userinfo(info) == 'i.ivanov'

    def test_fetches_userinfo_when_id_token_has_no_username(self, sso):
        token = _jwt({'iss': 'https://idp.example.com'})
        with mock.patch.object(
            sso,
            '_fetch_userinfo',
            return_value={'preferred_username': 'from-userinfo'},
        ) as fetch:
            info = sso._userinfo_from_token({
                'id_token': token,
                'access_token': 'atk',
            })
        fetch.assert_called_once_with('atk', http=None)
        assert info['preferred_username'] == 'from-userinfo'

    def test_embedded_userinfo_wins(self, sso):
        with mock.patch.object(sso, '_fetch_userinfo') as fetch:
            info = sso._userinfo_from_token({
                'userinfo': {'preferred_username': 'embedded'},
                'access_token': 'atk',
            })
        fetch.assert_not_called()
        assert info['preferred_username'] == 'embedded'


class TestOidcTimeout:
    def test_connect_capped(self, sso):
        connect, read = sso._oidc_timeout()
        assert read >= 1
        assert connect == min(sso._OIDC_CONNECT_TIMEOUT, read)
        assert connect <= read
