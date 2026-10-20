"""API + real database adapter tests; never contact Expo."""
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from test_friend_database_adapter import db, transport

OWNER, OTHER, REGISTRATION = [str(uuid4()) for _ in range(3)]


@pytest.fixture(autouse=True)
def reset():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def authorize():
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = db


def test_unregister_requires_authentication():
    with TestClient(app) as client:
        assert client.post('/devices/unregister', json={'registration_id': REGISTRATION}).status_code == 401


@pytest.mark.parametrize('removed', [False, True])
def test_unregister_is_owner_derived_conditional_and_does_not_need_a_token(monkeypatch, removed):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.path == '/rest/v1/rpc/unregister_device'
        assert request.headers['apikey'] == 'sb_secret_test' and 'authorization' not in request.headers
        assert json.loads(request.content) == {'p_user': OWNER, 'p_registration': REGISTRATION}
        return httpx.Response(200, json=removed)
    transport(monkeypatch, handler)
    authorize()
    with TestClient(app) as client:
        result = client.post('/devices/unregister', json={'registration_id': REGISTRATION},
                             headers={'X-User-Id': OTHER}, params={'user_id': OTHER})
    assert result.status_code == 200 and result.json() == {'removed': removed}
    assert len(calls) == 1


@pytest.mark.parametrize('body', [{}, {'registration_id': 'bad'}, {'registration_id': REGISTRATION, 'user_id': OTHER},
                                  {'registration_id': REGISTRATION, 'expo_push_token': 'ExpoPushToken[private]'}])
def test_unregister_rejects_missing_identity_and_extra_fields(monkeypatch, body):
    transport(monkeypatch, lambda request: pytest.fail('Must not call DB'))
    authorize()
    with TestClient(app) as client:
        assert client.post('/devices/unregister', json=body).status_code == 422


@pytest.mark.parametrize('failure', ['timeout', 'http', 'malformed'])
def test_unregister_failure_never_claims_remote_removal_and_redacts_diagnostics(monkeypatch, failure):
    calls = []
    def handler(request):
        calls.append(request)
        if failure == 'timeout':
            raise httpx.ReadTimeout('ExpoPushToken[private] bearer-private', request=request)
        return httpx.Response(503 if failure == 'http' else 200, json={'private': 'ExpoPushToken[private]'})
    transport(monkeypatch, handler)
    authorize()
    with TestClient(app) as client:
        result = client.post('/devices/unregister', json={'registration_id': REGISTRATION})
    assert result.status_code == 503 and 'private' not in result.text
    assert 'removed' not in result.json() and len(calls) == 1


def test_delayed_cancelled_registration_is_conflict_without_token_disclosure(monkeypatch):
    transport(monkeypatch, lambda request: httpx.Response(200, text="null"))
    authorize()
    with TestClient(app) as client:
        result = client.post('/devices/register', json={'registration_id': REGISTRATION, 'platform': 'ios',
                                                       'expo_push_token': 'ExpoPushToken[private]'})
    assert result.status_code == 409
    assert result.json()['detail']['code'] == 'registration_superseded'
    assert 'private' not in result.text


@pytest.mark.parametrize('body', [{'private': 'ExpoPushToken[private]'}, 12, [], 'bad timestamp'])
def test_registration_malformed_database_result_is_safe_unavailable(monkeypatch, body):
    transport(monkeypatch, lambda request: httpx.Response(200, json=body))
    authorize()
    with TestClient(app) as client:
        result = client.post('/devices/register', json={'registration_id': REGISTRATION, 'platform': 'android',
                                                       'expo_push_token': 'ExpoPushToken[private]'})
    assert result.status_code == 503 and 'private' not in result.text
