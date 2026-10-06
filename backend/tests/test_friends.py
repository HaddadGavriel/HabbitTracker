import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from app.services.supabase import RelationshipConflict


class FriendDatabase:
    def __init__(self):
        self.profiles = {}
        self.relationships = {}
        self.lock = asyncio.Lock()

    def add(self, user_id, username):
        now = datetime.now(timezone.utc).isoformat()
        self.profiles[user_id] = {"user_id": user_id, "username": username, "display_name": username.title(), "timezone": "UTC", "created_at": now, "updated_at": now}

    async def get_profile(self, user_id):
        return deepcopy(self.profiles.get(user_id))

    async def update_profile(self, user_id, values):
        self.profiles[user_id].update(values)
        return deepcopy(self.profiles[user_id])

    def view(self, row, actor):
        other = row["recipient_id"] if row["requester_id"] == actor else row["requester_id"]
        return {k: row[k] for k in ("id", "state", "created_at", "updated_at", "accepted_at")} | {
            "direction": "outgoing" if row["requester_id"] == actor else "incoming",
            "profile": {k: self.profiles[other][k] for k in ("user_id", "username", "display_name")},
        }

    async def send_friend_request(self, requester, recipient):
        async with self.lock:
            if recipient not in self.profiles:
                raise RelationshipConflict("recipient_not_found")
            old = next((r for r in self.relationships.values() if {r["requester_id"], r["recipient_id"]} == {requester, recipient}), None)
            if old:
                code = "friendship_exists" if old["state"] == "accepted" else ("outgoing_request_exists" if old["requester_id"] == requester else "incoming_request_exists")
                raise RelationshipConflict(code)
            now = datetime.now(timezone.utc).isoformat()
            row = {"id": str(uuid4()), "requester_id": requester, "recipient_id": recipient, "state": "pending", "created_at": now, "updated_at": now, "accepted_at": None}
            self.relationships[row["id"]] = row
            return self.view(row, requester)

    async def list_friend_requests(self, actor):
        return [self.view(r, actor) for r in self.relationships.values() if r["state"] == "pending" and actor in (r["requester_id"], r["recipient_id"])]

    async def accept_friend_request(self, request_id, actor):
        async with self.lock:
            row = self.relationships.get(request_id)
            if not row or row["recipient_id"] != actor or row["state"] != "pending": return None
            row["state"] = "accepted"; row["accepted_at"] = row["updated_at"] = datetime.now(timezone.utc).isoformat()
            return self.view(row, actor)

    async def reject_friend_request(self, request_id, actor):
        async with self.lock:
            row = self.relationships.get(request_id)
            if not row or row["recipient_id"] != actor or row["state"] != "pending": return False
            del self.relationships[request_id]; return True

    async def list_friends(self, actor):
        return [self.view(r, actor) for r in self.relationships.values() if r["state"] == "accepted" and actor in (r["requester_id"], r["recipient_id"])]

    async def remove_friend(self, actor, friend):
        async with self.lock:
            found = next((r for r in self.relationships.values() if r["state"] == "accepted" and {r["requester_id"], r["recipient_id"]} == {actor, friend}), None)
            if not found: return False
            del self.relationships[found["id"]]; return True


USERS = [str(UUID(int=i)) for i in range(1, 5)]
ENDPOINTS = [
    ("POST", "/friend-requests", {"recipient_user_id": USERS[1]}),
    ("GET", "/friend-requests", None),
    ("POST", f"/friend-requests/{USERS[3]}/accept", None),
    ("POST", f"/friend-requests/{USERS[3]}/reject", None),
    ("GET", "/friends", None),
    ("DELETE", f"/friends/{USERS[1]}", None),
]


@pytest.fixture(autouse=True)
def reset_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.mark.parametrize("method,path,body", ENDPOINTS)
@pytest.mark.parametrize("token", [None, "expired-token"])
def test_every_endpoint_validates_authentication(monkeypatch, method, path, body, token):
    original = httpx.AsyncClient

    def reject(request):
        assert request.url.path == "/auth/v1/user"
        assert request.headers["authorization"] == "Bearer expired-token"
        assert request.headers["apikey"] == "sb_publishable_test"
        return httpx.Response(401, json={"message": "expired"})

    monkeypatch.setattr("app.auth.httpx.AsyncClient", lambda *a, **kw: original(transport=httpx.MockTransport(reject)))
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with TestClient(app) as c:
        assert c.request(method, path, json=body, headers=headers).status_code == 401


@pytest.mark.parametrize("method,path,body", ENDPOINTS)
def test_every_endpoint_requires_existing_profile(method, path, body):
    db = FriendDatabase()
    with client(db, USERS[0]) as c:
        response = c.request(method, path, json=body)
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "profile_not_found"
    assert db.relationships == {}


def client(db, user):
    app.dependency_overrides[get_database] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=user)
    return TestClient(app)


def test_authentication_missing_profile_and_validation():
    app.dependency_overrides.clear()
    assert TestClient(app).get("/friends").status_code == 401
    db = FriendDatabase()
    with client(db, USERS[0]) as c:
        assert c.get("/friend-requests").status_code == 404
        for body in [{"recipient_user_id": "bad"}, {"recipient_user_id": USERS[1], "user_id": USERS[0]}, {}]:
            assert c.post("/friend-requests", json=body).status_code == 422
    app.dependency_overrides.clear()


def test_complete_flow_visibility_names_and_re_request():
    db = FriendDatabase()
    for uid, name in zip(USERS[:3], ["alice", "bob", "eve"]): db.add(uid, name)
    with client(db, USERS[0]) as alice:
        sent = alice.post("/friend-requests", json={"recipient_user_id": USERS[1]})
        assert sent.status_code == 201 and sent.json()["direction"] == "outgoing"
        assert set(sent.json()["profile"]) == {"user_id", "username", "display_name"}
        request_id = sent.json()["id"]
        assert alice.get("/friends").json() == []
    with client(db, USERS[2]) as eve:
        assert eve.get("/friend-requests").json() == {"incoming": [], "outgoing": []}
        assert eve.post(f"/friend-requests/{request_id}/accept").status_code == 404
        assert eve.post(f"/friend-requests/{request_id}/reject").status_code == 404
        assert eve.delete(f"/friends/{USERS[1]}").status_code == 404
    with client(db, USERS[0]) as alice:
        assert alice.post(f"/friend-requests/{request_id}/accept").status_code == 404
        assert alice.post(f"/friend-requests/{request_id}/reject").status_code == 404
    with client(db, USERS[1]) as bob:
        pending = bob.get("/friend-requests").json()
        assert len(pending["incoming"]) == 1 and not pending["outgoing"]
        assert bob.post(f"/friend-requests/{request_id}/accept").status_code == 200
        assert bob.post(f"/friend-requests/{request_id}/accept").status_code == 404
        assert bob.post(f"/friend-requests/{request_id}/reject").status_code == 404
        assert bob.get("/friend-requests").json() == {"incoming": [], "outgoing": []}
        assert bob.get("/friends").json()[0]["profile"]["username"] == "alice"
        assert bob.patch("/profiles/me", json={"username": "robert", "display_name": "Robert"}).status_code == 200
    with client(db, USERS[2]) as eve:
        assert eve.get("/friends").json() == []
        assert eve.delete(f"/friends/{USERS[0]}").status_code == 404
    with client(db, USERS[0]) as alice:
        friends = alice.get("/friends").json()
        assert friends[0]["profile"]["username"] == "robert"
        assert friends[0]["profile"]["display_name"] == "Robert"
        assert set(friends[0]) == {"id", "direction", "state", "profile", "created_at", "updated_at", "accepted_at"}
        assert alice.post("/friend-requests", json={"recipient_user_id": USERS[1]}).json()["detail"]["code"] == "friendship_exists"
        assert alice.delete(f"/friends/{USERS[1]}").status_code == 204
        assert alice.delete(f"/friends/{USERS[1]}").status_code == 404
    with client(db, USERS[1]) as bob:
        assert bob.get("/friends").json() == []
    with client(db, USERS[0]) as alice:
        assert alice.post("/friend-requests", json={"recipient_user_id": USERS[1]}).status_code == 201
    app.dependency_overrides.clear()


def test_self_missing_duplicate_opposite_reject_and_request_again():
    db = FriendDatabase(); db.add(USERS[0], "alice"); db.add(USERS[1], "bob")
    with client(db, USERS[0]) as alice:
        assert alice.post("/friend-requests", json={"recipient_user_id": USERS[0]}).json()["detail"]["code"] == "self_request"
        assert alice.post("/friend-requests", json={"recipient_user_id": USERS[2]}).status_code == 404
        request_id = alice.post("/friend-requests", json={"recipient_user_id": USERS[1]}).json()["id"]
        duplicate = alice.post("/friend-requests", json={"recipient_user_id": USERS[1]})
        assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "outgoing_request_exists"
    with client(db, USERS[1]) as bob:
        opposite = bob.post("/friend-requests", json={"recipient_user_id": USERS[0]})
        assert opposite.status_code == 409 and opposite.json()["detail"]["code"] == "incoming_request_exists"
        assert bob.post(f"/friend-requests/{request_id}/reject").status_code == 204
        assert bob.post(f"/friend-requests/{request_id}/reject").status_code == 404
        assert bob.post(f"/friend-requests/{request_id}/accept").status_code == 404
        assert bob.post("/friend-requests", json={"recipient_user_id": USERS[0]}).status_code == 201
    app.dependency_overrides.clear()


@pytest.mark.parametrize("decision", ["accept", "reject", "remove"])
@pytest.mark.parametrize("body", [{"user_id": USERS[1]}, {"p_actor": USERS[1]}, {"state": "accepted"}, {"unexpected": True}, []])
def test_decisions_reject_unexpected_body_before_writing(decision, body):
    db = FriendDatabase()
    db.add(USERS[0], "alice")
    db.add(USERS[1], "bob")
    with client(db, USERS[0]) as c:
        request_id = c.post("/friend-requests", json={"recipient_user_id": USERS[1]}).json()["id"]
    with client(db, USERS[1]) as c:
        if decision == "remove":
            assert c.post(f"/friend-requests/{request_id}/accept", json={}).status_code == 200
            path, method = f"/friends/{USERS[0]}", "DELETE"
        else:
            path, method = f"/friend-requests/{request_id}/{decision}", "POST"
        before = deepcopy(db.relationships)
        assert c.request(method, path, json=body).status_code == 422
        assert db.relationships == before


@pytest.mark.parametrize("path,method", [
    ("/friend-requests/not-a-uuid/accept", "POST"),
    ("/friend-requests/not-a-uuid/reject", "POST"),
    ("/friends/not-a-uuid", "DELETE"),
])
def test_mutation_paths_require_uuids(path, method):
    db = FriendDatabase()
    db.add(USERS[0], "alice")
    with client(db, USERS[0]) as c:
        assert c.request(method, path).status_code == 422


def test_recipient_can_remove_and_pending_cannot_be_removed():
    db = FriendDatabase()
    db.add(USERS[0], "alice")
    db.add(USERS[1], "bob")
    with client(db, USERS[0]) as c:
        request_id = c.post("/friend-requests", json={"recipient_user_id": USERS[1]}).json()["id"]
        assert c.delete(f"/friends/{USERS[1]}").status_code == 404
    with client(db, USERS[1]) as c:
        assert c.delete(f"/friends/{USERS[0]}").status_code == 404
        assert c.post(f"/friend-requests/{request_id}/accept").status_code == 200
        assert c.request("DELETE", f"/friends/{USERS[0]}", json={}).status_code == 204
        assert c.post("/friend-requests", json={"recipient_user_id": USERS[0]}).status_code == 201


@pytest.mark.parametrize("code,status_code", [("profile_not_found", 404), ("self_request", 422)])
def test_send_maps_database_validation_errors(monkeypatch, code, status_code):
    db = FriendDatabase()
    db.add(USERS[0], "alice")

    async def failed_send(*args):
        raise RelationshipConflict(code)

    monkeypatch.setattr(db, "send_friend_request", failed_send)
    with client(db, USERS[0]) as c:
        response = c.post("/friend-requests", json={"recipient_user_id": USERS[1]})
        assert response.status_code == status_code
        assert response.json()["detail"]["code"] == code


def test_response_models_filter_private_adapter_fields(monkeypatch):
    db = FriendDatabase()
    db.add(USERS[0], "alice")
    db.add(USERS[1], "bob")
    original = db.view

    def extra_fields(row, actor):
        result = original(row, actor)
        result["requester_id"] = row["requester_id"]
        result["email"] = "private@example.com"
        result["profile"].update(timezone="UTC", email="private@example.com", auth_metadata={"private": True})
        return result

    monkeypatch.setattr(db, "view", extra_fields)

    def public_only(row):
        assert set(row) == {"id", "direction", "state", "profile", "created_at", "updated_at", "accepted_at"}
        assert set(row["profile"]) == {"user_id", "username", "display_name"}

    with client(db, USERS[0]) as c:
        sent = c.post("/friend-requests", json={"recipient_user_id": USERS[1]}).json()
        public_only(sent)
        public_only(c.get("/friend-requests").json()["outgoing"][0])
    with client(db, USERS[1]) as c:
        public_only(c.get("/friend-requests").json()["incoming"][0])
        public_only(c.post(f"/friend-requests/{sent['id']}/accept").json())
        public_only(c.get("/friends").json()[0])


@pytest.mark.parametrize("field", ["requester_id", "p_requester", "created_at", "accepted_at", "state"])
def test_send_rejects_client_identity_state_and_timestamps(field):
    db = FriendDatabase()
    db.add(USERS[0], "alice")
    with client(db, USERS[0]) as c:
        response = c.post("/friend-requests", json={"recipient_user_id": USERS[1], field: USERS[0]})
        assert response.status_code == 422
    assert db.relationships == {}
