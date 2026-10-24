from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from fastapi.security import HTTPAuthorizationCredentials

from app.auth import get_authenticated_user, get_current_user, AuthenticatedUser
from app.config import Settings
from app.dependencies import get_database
from app.main import app


@pytest.mark.parametrize('mode', ['timeout', 'upstream', 'malformed', 'wrong_id', 'wrong_type', 'expired', 'ok'])
async def test_auth_service_failures_are_safe_and_distinguishable(monkeypatch, mode):
    user_id = str(uuid4())
    real_client = httpx.AsyncClient

    def handler(request):
        if mode == 'timeout':
            raise httpx.ConnectError('private provider information', request=request)
        return httpx.Response(401 if mode == 'expired' else 503 if mode == 'upstream' else 200,
                              json={} if mode == 'malformed' else {'id': 'bad' if mode == 'wrong_id' else 42 if mode == 'wrong_type' else user_id})

    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler)))
    credentials = HTTPAuthorizationCredentials(scheme='Bearer', credentials='private-token')
    if mode == 'ok':
        assert (await get_authenticated_user(credentials, Settings())).id == user_id
    else:
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as error:
            await get_authenticated_user(credentials, Settings())
        assert error.value.status_code == (401 if mode == 'expired' else 503)
        assert 'private' not in str(error.value.detail)


def test_database_transport_failure_is_safe_and_does_not_claim_rollback():
    class OfflineDatabase:
        async def get_profile(self, *_):
            raise httpx.ConnectError('sb_secret_hidden /private/provider/url')
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=str(uuid4()))
    app.dependency_overrides[get_database] = OfflineDatabase
    try:
        response = TestClient(app).get('/profiles/me')
        assert response.status_code == 503
        assert response.json()['detail']['code'] == 'service_unavailable'
        assert 'refresh before retrying' in response.text
        assert 'sb_secret' not in response.text and 'private' not in response.text
    finally:
        app.dependency_overrides.clear()
