import json
from copy import deepcopy

import httpx
import pytest
from fastapi.testclient import TestClient
from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from app.services.supabase import OccurrenceError
from test_friend_database_adapter import db, transport
from test_occurrences import OWNER

PLAN = {'version': 1, 'owner_id': OWNER, 'server_time': '2026-03-01T12:00:00Z',
        'timezone': 'UTC', 'local_date': '2026-03-01', 'effective': [], 'future': []}


@pytest.fixture(autouse=True)
def clear_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def test_auth_required():
    with TestClient(app) as client:
        assert client.get('/local-reminder-plan').status_code == 401


def test_identity_comes_only_from_auth_and_projection_is_minimal():
    class Database:
        async def get_local_reminder_plan(self, owner):
            assert owner == OWNER
            return deepcopy(PLAN) | {'private_cursor': 'must not escape'}
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = Database
    with TestClient(app) as client:
        response = client.get('/local-reminder-plan?owner_id=someone-else')
        assert response.status_code == 200
        assert response.json() == PLAN


def test_missing_profile():
    class Database:
        async def get_local_reminder_plan(self, owner):
            raise OccurrenceError('profile_not_found')
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = Database
    with TestClient(app) as client:
        assert client.get('/local-reminder-plan').json()['detail']['code'] == 'profile_not_found'


def test_legacy_profile_and_snapshot_zones_reach_native_unchanged_for_safe_pause():
    legacy = deepcopy(PLAN) | {'timezone': 'Factory', 'effective': [{
        'habit_id': OWNER, 'local_date': '2026-03-01', 'timezone': 'EST',
        'closes_at': '2026-03-02T05:00:00Z', 'reminder_times': ['08:00'],
    }]}
    class Database:
        async def get_local_reminder_plan(self, owner):
            assert owner == OWNER
            return legacy
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = Database
    with TestClient(app) as client:
        response = client.get('/local-reminder-plan')
        assert response.status_code == 200 and response.json() == legacy


async def test_adapter_owner_and_service_credentials(monkeypatch):
    def handler(request):
        assert request.url.path == '/rest/v1/rpc/get_local_reminder_plan'
        assert json.loads(request.content) == {'p_owner': OWNER}
        assert request.headers['apikey'] == 'sb_secret_test'
        assert 'authorization' not in request.headers
        return httpx.Response(200, json=PLAN)
    transport(monkeypatch, handler)
    assert await db().get_local_reminder_plan(OWNER) == PLAN


async def test_adapter_does_not_hide_database_failure(monkeypatch):
    transport(monkeypatch, lambda request: httpx.Response(500, json={'message': 'broken'}))
    with pytest.raises(httpx.HTTPStatusError):
        await db().get_local_reminder_plan(OWNER)
