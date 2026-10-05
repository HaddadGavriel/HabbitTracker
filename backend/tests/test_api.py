from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database, get_push_service
from app.main import app
from app.config import Settings
from app.services.supabase import SupabaseDatabase


class FakeDatabase:
    def __init__(self):
        self.user_id = None
        self.marked = False

    async def register_device(self, user_id, token, platform):
        self.user_id = user_id
        return datetime.now(timezone.utc)

    async def create_test(self, request_id, user_id, client_started_at, received_at):
        self.user_id = user_id

    async def verify_and_mark_test(self, request_id, user_id):
        return True

    async def latest_token(self, user_id):
        return "ExponentPushToken[test-token]"

    async def mark_push(self, request_id, ticket_id, status):
        self.marked = status == "push_accepted"


class FakePush:
    async def send(self, token, request_id, server_timestamp):
        return "ticket-123"


def test_secret_api_key_is_not_used_as_a_bearer_jwt():
    database = SupabaseDatabase(Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="sb_publishable_test",
        supabase_secret_key="sb_secret_test",
    ))
    assert database.headers["apikey"] == "sb_secret_test"
    assert "Authorization" not in database.headers


def test_protected_endpoints_reject_unauthenticated_requests():
    client = TestClient(app)
    assert client.post("/devices/register", json={"expo_push_token": "ExponentPushToken[test]", "platform": "android"}).status_code == 401
    assert client.post("/infrastructure-test", json={"request_id": "request-123", "client_started_at": datetime.now(timezone.utc).isoformat()}).status_code == 401


def test_infrastructure_orchestration_and_validation():
    database = FakeDatabase()
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id="user-123")
    app.dependency_overrides[get_database] = lambda: database
    app.dependency_overrides[get_push_service] = lambda: FakePush()
    try:
        client = TestClient(app)
        response = client.post("/infrastructure-test", json={"request_id": "request-123", "client_started_at": datetime.now(timezone.utc).isoformat()})
        assert response.status_code == 200
        assert response.json()["database_verified"] is True
        assert response.json()["push_requested"] is True
        assert response.json()["expo_ticket_id"] == "ticket-123"
        assert database.user_id == "user-123"
        assert database.marked
        assert client.post("/infrastructure-test", json={"request_id": "bad id!", "client_started_at": "not-a-date"}).status_code == 422
    finally:
        app.dependency_overrides.clear()
