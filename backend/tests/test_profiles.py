from copy import deepcopy
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from app.services.supabase import ProfileAlreadyExists, UsernameTaken


class ProfileDatabase:
    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.forced_create_error: Exception | None = None

    def row(self, user_id: str, username: str, display_name: str = "Person") -> dict:
        now = datetime.now(timezone.utc).isoformat()
        return {"user_id": user_id, "username": username, "display_name": display_name, "timezone": "UTC", "created_at": now, "updated_at": now}

    async def create_profile(self, user_id, values):
        if self.forced_create_error:
            raise self.forced_create_error
        if user_id in self.rows:
            raise ProfileAlreadyExists
        if any(row["username"] == values["username"] for row in self.rows.values()):
            raise UsernameTaken
        self.rows[user_id] = self.row(user_id, values["username"], values["display_name"])
        self.rows[user_id]["timezone"] = values["timezone"]
        return deepcopy(self.rows[user_id])

    async def get_profile(self, user_id):
        return deepcopy(self.rows.get(user_id))

    async def update_profile(self, user_id, values):
        if user_id not in self.rows:
            return None
        if "username" in values and any(key != user_id and row["username"] == values["username"] for key, row in self.rows.items()):
            raise UsernameTaken
        self.rows[user_id].update(values)
        self.rows[user_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
        return deepcopy(self.rows[user_id])

    async def search_profile(self, username):
        return deepcopy(next((row for row in self.rows.values() if row["username"] == username), None))


def client_for(user_id: str, database: ProfileDatabase) -> TestClient:
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=user_id)
    app.dependency_overrides[get_database] = lambda: database
    return TestClient(app)


def code(response) -> str:
    return response.json()["detail"]["code"]


def test_profile_endpoints_require_authentication():
    app.dependency_overrides.clear()
    client = TestClient(app)
    for method, path in [("post", "/profiles/me"), ("get", "/profiles/me"), ("patch", "/profiles/me"), ("get", "/profiles/search?username=someone")]:
        payload = {"username": "someone", "display_name": "Someone", "timezone": "UTC"} if method == "post" else {"display_name": "Someone"}
        response = getattr(client, method)(path, json=payload) if method in {"post", "patch"} else getattr(client, method)(path)
        assert response.status_code == 401


def test_invalid_supabase_token_is_rejected(monkeypatch):
    class RejectedResponse:
        status_code = 401

    class AuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, *args, **kwargs):
            return RejectedResponse()

    app.dependency_overrides.clear()
    monkeypatch.setattr("app.auth.httpx.AsyncClient", AuthClient)
    response = TestClient(app).get("/profiles/me", headers={"Authorization": "Bearer invalid"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid or expired Supabase access token"


def test_create_normalizes_and_get_returns_profile():
    database = ProfileDatabase()
    client = client_for("user-1", database)
    try:
        created = client.post("/profiles/me", json={"username": "  Alice_1 ", "display_name": "  Alice אבג  ", "timezone": "Asia/Jerusalem"})
        assert created.status_code == 201
        assert created.json()["username"] == "alice_1"
        assert created.json()["display_name"] == "Alice אבג"
        assert client.get("/profiles/me").json() == created.json()
        duplicate = client.post("/profiles/me", json={"username": "other", "display_name": "A", "timezone": "UTC"})
        assert duplicate.status_code == 409 and code(duplicate) == "profile_already_exists"
    finally:
        app.dependency_overrides.clear()


def test_missing_existing_auth_user_profile_is_normal():
    client = client_for("old-auth-user", ProfileDatabase())
    try:
        response = client.get("/profiles/me")
        assert response.status_code == 404 and code(response) == "profile_not_found"
        assert client.patch("/profiles/me", json={"display_name": "Name"}).status_code == 404
        assert client.get("/profiles/search?username=somebody").status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_validation_rejects_invalid_profile_fields_and_identity_fields():
    client = client_for("user-1", ProfileDatabase())
    try:
        base = {"username": "valid_name", "display_name": "Name", "timezone": "UTC"}
        for changes in [
            {"username": "ab"}, {"username": "has-dash"}, {"username": "éclair"},
            {"display_name": "   "}, {"display_name": "x" * 81}, {"timezone": "Mars/Olympus"},
            {"user_id": "other-user"}, {"created_at": "2020-01-01T00:00:00Z"},
        ]:
            assert client.post("/profiles/me", json={**base, **changes}).status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_case_insensitive_conflict_including_database_race():
    database = ProfileDatabase()
    database.rows["user-2"] = database.row("user-2", "taken")
    client = client_for("user-1", database)
    try:
        response = client.post("/profiles/me", json={"username": " TAKEN ", "display_name": "One", "timezone": "UTC"})
        assert response.status_code == 409 and code(response) == "username_taken"
        database.forced_create_error = UsernameTaken()  # conflict after any hypothetical pre-check
        response = client.post("/profiles/me", json={"username": "available", "display_name": "One", "timezone": "UTC"})
        assert response.status_code == 409 and code(response) == "username_taken"
    finally:
        app.dependency_overrides.clear()


def test_patch_semantics_conflict_and_atomicity():
    database = ProfileDatabase()
    database.rows["user-1"] = database.row("user-1", "first", "First")
    database.rows["user-2"] = database.row("user-2", "second", "Second")
    client = client_for("user-1", database)
    try:
        assert client.patch("/profiles/me", json={"username": " FIRST "}).status_code == 200
        updated = client.patch("/profiles/me", json={"display_name": " New Name "})
        assert updated.status_code == 200 and updated.json()["username"] == "first" and updated.json()["display_name"] == "New Name"
        before = deepcopy(database.rows["user-1"])
        conflict = client.patch("/profiles/me", json={"username": "SECOND", "display_name": "Should not stick"})
        assert conflict.status_code == 409 and code(conflict) == "username_taken"
        assert database.rows["user-1"] == before
        for payload in [{}, {"username": None}, {"bogus": "x"}, {"user_id": "user-2"}, {"created_at": "2020-01-01"}]:
            assert client.patch("/profiles/me", json=payload).status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_exact_search_self_search_and_restricted_fields():
    database = ProfileDatabase()
    database.rows["user-1"] = database.row("user-1", "alice")
    database.rows["user-2"] = database.row("user-2", "bob", "Bob")
    client = client_for("user-1", database)
    try:
        found = client.get("/profiles/search?username=%20BOB%20")
        assert found.status_code == 200
        assert found.json() == {"user_id": "user-2", "username": "bob", "display_name": "Bob"}
        for query in ["bo", "bobby", "alice"]:
            response = client.get(f"/profiles/search?username={query}")
            assert response.status_code in (404, 422)
        assert client.get("/profiles/search?username=has-dash").status_code == 422
    finally:
        app.dependency_overrides.clear()
