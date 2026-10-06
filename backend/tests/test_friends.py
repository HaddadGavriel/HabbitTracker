import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID, uuid4

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
        self.profiles[user_id] = {"user_id": user_id, "username": username, "display_name": username.title(), "timezone": "UTC"}

    async def get_profile(self, user_id):
        return deepcopy(self.profiles.get(user_id))

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
    with client(db, USERS[1]) as bob:
        pending = bob.get("/friend-requests").json()
        assert len(pending["incoming"]) == 1 and not pending["outgoing"]
        assert bob.post(f"/friend-requests/{request_id}/accept").status_code == 200
        assert bob.post(f"/friend-requests/{request_id}/reject").status_code == 404
        assert bob.get("/friend-requests").json() == {"incoming": [], "outgoing": []}
        assert bob.get("/friends").json()[0]["profile"]["username"] == "alice"
    db.profiles[USERS[1]]["username"] = "robert"
    with client(db, USERS[0]) as alice:
        friends = alice.get("/friends").json()
        assert friends[0]["profile"]["username"] == "robert"
        assert set(friends[0]) == {"id", "direction", "state", "profile", "created_at", "updated_at", "accepted_at"}
        assert alice.post("/friend-requests", json={"recipient_user_id": USERS[1]}).json()["detail"]["code"] == "friendship_exists"
        assert alice.delete(f"/friends/{USERS[1]}").status_code == 204
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
        assert bob.post(f"/friend-requests/{request_id}/accept").status_code == 404
        assert bob.post("/friend-requests", json={"recipient_user_id": USERS[0]}).status_code == 201
    app.dependency_overrides.clear()
