from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.habit_schemas import HabitCreate
from app.main import app
from app.services.supabase import SharingError
from test_friends import USERS, client
from test_habits import BASE, HabitDatabase


ENDPOINTS = [
    ("PUT", f"/habits/{USERS[3]}/shares/{USERS[1]}"),
    ("DELETE", f"/habits/{USERS[3]}/shares/{USERS[1]}"),
    ("GET", f"/habits/{USERS[3]}/shares"),
    ("GET", "/shared-habits"),
    ("GET", f"/shared-habits/{USERS[3]}"),
]
NOT_FOUND = {"detail": {"code": "habit_not_found", "message": "Habit not found"}}
PUBLIC_FIELDS = {"user_id", "username", "display_name"}


class SharingDatabase(HabitDatabase):
    """API isolation double; transaction and reconciliation tests use real RPCs."""
    def __init__(self):
        super().__init__()
        self.shares = {}
        self.occurrences = {}
        self.calls = []

    def public(self, user):
        return {key: self.profiles[user][key] for key in PUBLIC_FIELDS}

    def friendship(self, owner, recipient):
        return next((r for r in self.relationships.values() if r["state"] == "accepted"
                     and {r["requester_id"], r["recipient_id"]} == {owner, recipient}), None)

    async def grant_habit_share(self, actor, habit, recipient):
        self.calls.append(("grant", actor, habit, recipient))
        if await self.get_habit(actor, habit) is None: return None
        if actor == recipient: raise SharingError("self_share")
        friendship = self.friendship(actor, recipient)
        if friendship is None: raise SharingError("friendship_required")
        self.shares[(habit, recipient)] = friendship["id"]
        return self.public(recipient)

    async def revoke_habit_share(self, actor, habit, recipient):
        self.calls.append(("revoke", actor, habit, recipient))
        if await self.get_habit(actor, habit) is None: return None
        self.shares.pop((habit, recipient), None)
        return True

    async def list_habit_shares(self, actor, habit):
        self.calls.append(("shares", actor, habit))
        if await self.get_habit(actor, habit) is None: return None
        return [self.public(recipient) for (identifier, recipient), relation in self.shares.items()
                if identifier == habit and relation in self.relationships and recipient in self.profiles]

    def shared_view(self, recipient, habit):
        row = self.habits.get(habit)
        relationship = self.shares.get((habit, recipient))
        if not row or row["archived_at"] or relationship not in self.relationships: return None
        if row["owner_id"] not in self.profiles or recipient not in self.profiles: return None
        if not self.friendship(row["owner_id"], recipient): return None
        return {"id": habit, "owner": self.public(row["owner_id"]),
                "configuration": {key: row[key] for key in HabitCreate.model_fields},
                "local_date": "2026-03-02", "timezone": "Pacific/Kiritimati", "server_time": "2026-03-01T12:00:00Z",
                "current_streak": 2, "provisional": True, "calculated_at": "2026-03-01T12:00:00Z",
                "due_today": habit in self.occurrences, "occurrence": deepcopy(self.occurrences.get(habit))}

    async def list_shared_habits(self, actor):
        self.calls.append(("shared", actor))
        return [view for habit in self.habits if (view := self.shared_view(actor, habit)) is not None]

    async def get_shared_habit(self, actor, habit):
        self.calls.append(("detail", actor, habit))
        return self.shared_view(actor, habit)

    async def mutate_occurrence(self, actor, occurrence, operation, value, key=None):
        self.calls.append(("occurrence", actor, occurrence, operation, value, key))
        # These tests call the existing owner-only endpoint as a shared recipient.
        return None


@pytest.fixture(autouse=True)
def overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def db():
    database = SharingDatabase()
    for user, name in zip(USERS[:3], ["alice", "bob", "eve"]): database.add(user, name)
    database.profiles[USERS[0]]["timezone"] = "Pacific/Kiritimati"
    database.profiles[USERS[1]]["timezone"] = "America/Los_Angeles"
    return database


def befriend(db, owner=USERS[0], recipient=USERS[1]):
    with client(db, owner) as c:
        request = c.post("/friend-requests", json={"recipient_user_id": recipient}).json()["id"]
    with client(db, recipient) as c:
        assert c.post(f"/friend-requests/{request}/accept").status_code == 200
    return request


def create(db, owner=USERS[0], config=None):
    with client(db, owner) as c:
        response = c.post("/habits", json=config or BASE)
        assert response.status_code == 201
        return response.json()["id"]


def grant(db, habit, owner=USERS[0], recipient=USERS[1]):
    with client(db, owner) as c:
        response = c.put(f"/habits/{habit}/shares/{recipient}")
        assert response.status_code == 200
        return response.json()


@pytest.mark.parametrize("method,path", ENDPOINTS)
@pytest.mark.parametrize("token", [None, "expired-token"])
def test_all_routes_validate_authentication(monkeypatch, method, path, token):
    original = httpx.AsyncClient
    def reject(request):
        assert request.url.path == "/auth/v1/user"
        assert request.headers["authorization"] == "Bearer expired-token"
        return httpx.Response(401, json={"message": "expired"})
    monkeypatch.setattr("app.auth.httpx.AsyncClient", lambda *a, **kw: original(transport=httpx.MockTransport(reject)))
    with TestClient(app) as c:
        assert c.request(method, path, headers={"Authorization": f"Bearer {token}"} if token else {}).status_code == 401


@pytest.mark.parametrize("method,path", ENDPOINTS)
def test_all_routes_require_profile(method, path):
    db = SharingDatabase()
    with client(db, USERS[0]) as c:
        response = c.request(method, path)
        assert response.status_code == 404 and response.json()["detail"]["code"] == "profile_not_found"
    assert db.calls == []


def test_private_defaults_selective_grant_list_detail_and_idempotent_revoke(db):
    befriend(db)
    shared, private = create(db), create(db)
    with client(db, USERS[1]) as c:
        assert c.get("/shared-habits").json() == []
        assert c.get(f"/shared-habits/{shared}").json() == NOT_FOUND
    with client(db, USERS[0]) as c:
        assert c.get(f"/habits/{shared}/shares").json() == []
    expected = grant(db, shared)
    assert grant(db, shared) == expected and expected == db.public(USERS[1])
    assert len(db.shares) == 1
    with client(db, USERS[0]) as c:
        assert c.get(f"/habits/{shared}/shares").json() == [expected]
        assert c.get("/shared-habits").json() == []
    with client(db, USERS[1]) as c:
        rows = c.get("/shared-habits").json()
        assert len(rows) == 1 and rows[0]["id"] == shared
        assert c.get(f"/shared-habits/{shared}").json() == rows[0]
        assert c.get(f"/shared-habits/{private}").json() == NOT_FOUND
        assert rows[0]["due_today"] is False and rows[0]["occurrence"] is None
        assert rows[0]["current_streak"] == 2 and rows[0]["provisional"] is True
        assert rows[0]["calculated_at"] == rows[0]["server_time"]
    with client(db, USERS[2]) as c:
        assert c.get("/shared-habits").json() == []
        assert c.get(f"/shared-habits/{shared}").json() == NOT_FOUND
    with client(db, USERS[0]) as c:
        for _ in range(2):
            response = c.delete(f"/habits/{shared}/shares/{USERS[1]}")
            assert response.status_code == 204 and response.content == b""
        assert c.get(f"/habits/{shared}/shares").json() == []
    with client(db, USERS[1]) as c:
        assert c.get("/shared-habits").json() == []
        assert c.get(f"/shared-habits/{shared}").json() == NOT_FOUND


def test_pending_nonfriend_missing_recipient_and_self_share(db):
    habit = create(db)
    with client(db, USERS[0]) as c:
        c.post("/friend-requests", json={"recipient_user_id": USERS[1]})
        for recipient in USERS[1:]:
            response = c.put(f"/habits/{habit}/shares/{recipient}")
            assert response.status_code == 409 and response.json()["detail"]["code"] == "friendship_required"
        response = c.put(f"/habits/{habit}/shares/{USERS[0]}")
        assert response.status_code == 422 and response.json()["detail"]["code"] == "self_share"
    assert db.shares == {}


@pytest.mark.parametrize("actor", USERS[1:3])
def test_inaccessible_and_absent_habits_have_identical_errors_even_for_idempotent_requests(db, actor):
    befriend(db)
    habit = create(db)
    grant(db, habit)
    with client(db, actor) as c:
        for method, suffix in [("GET", "/shares"), ("PUT", f"/shares/{actor}"), ("DELETE", f"/shares/{actor}")]:
            for identifier in [habit, str(uuid4())]:
                response = c.request(method, f"/habits/{identifier}{suffix}")
                assert response.status_code == 404 and response.json() == NOT_FOUND
    assert len(db.shares) == 1


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
@pytest.mark.parametrize("body", [{"owner_id": USERS[0]}, {"user_id": USERS[0]}, {"p_owner": USERS[0]},
                                  {"recipient_user_id": USERS[2]}, {"state": "accepted"}, [], "invalid"])
def test_mutation_bodies_reject_forged_identities_and_unknown_values(db, method, body):
    befriend(db)
    habit = create(db)
    grant(db, habit)
    db.calls.clear()
    with client(db, USERS[1]) as c:
        assert c.request(method, f"/habits/{habit}/shares/{USERS[1]}", json=body).status_code == 422
    assert db.calls == [] and len(db.shares) == 1


def test_actor_is_authenticated_user_even_with_forged_query_and_headers(db):
    befriend(db)
    habit = create(db)
    grant(db, habit)
    db.calls.clear()
    with client(db, USERS[2]) as c:
        headers = {"X-User-Id": USERS[0], "X-Owner-Id": USERS[0]}
        assert c.get(f"/shared-habits/{habit}?user_id={USERS[1]}", headers=headers).status_code == 404
        assert c.get(f"/shared-habits?p_recipient={USERS[1]}", headers=headers).json() == []
        assert c.put(f"/habits/{habit}/shares/{USERS[2]}?p_owner={USERS[0]}", headers=headers).status_code == 404
    assert db.calls == [("detail", USERS[2], habit), ("shared", USERS[2]), ("grant", USERS[2], habit, USERS[2])]


def test_shared_recipient_cannot_use_owner_configuration_or_occurrence_routes(db):
    befriend(db)
    habit = create(db)
    grant(db, habit)
    occurrence = str(uuid4())
    with client(db, USERS[1]) as c:
        assert c.get("/habits").json() == []
        assert c.get(f"/habits/{habit}").json() == NOT_FOUND
        assert c.patch(f"/habits/{habit}", json={"name": "Forged"}).status_code == 404
        assert c.post(f"/habits/{habit}/archive").status_code == 404
        assert c.post(f"/habits/{habit}/restore").status_code == 404
        for method, suffix, body in [("PUT", "completion", {"completed": True}),
                                     ("PUT", "completion", {"completed": False}),
                                     ("PUT", "progress", {"progress": 5}),
                                     ("POST", "progress-adjustments", {"delta": 1})]:
            response = c.request(method, f"/occurrences/{occurrence}/{suffix}", json=body, headers={"Idempotency-Key": "share-test"})
            assert response.status_code == 404 and response.json()["detail"]["code"] == "occurrence_not_found"
        assert c.patch(f"/shared-habits/{habit}", json={"name": "Forged"}).status_code == 405
    assert db.habits[habit]["name"] == "Read" and db.habits[habit]["archived_at"] is None
    assert all(call[1] == USERS[1] for call in db.calls if call[0] == "occurrence")


def test_friendship_removal_invalidates_both_directions_and_refriending_does_not_restore(db):
    befriend(db)
    habits = [create(db, owner) for owner in USERS[:2]]
    grant(db, habits[0])
    grant(db, habits[1], USERS[1], USERS[0])
    with client(db, USERS[1]) as c:
        assert c.delete(f"/friends/{USERS[0]}").status_code == 204
    befriend(db)
    for actor, owned, received in [(USERS[0], habits[0], habits[1]), (USERS[1], habits[1], habits[0])]:
        with client(db, actor) as c:
            assert c.get("/shared-habits").json() == []
            assert c.get(f"/shared-habits/{received}").status_code == 404
            assert c.get(f"/habits/{owned}/shares").json() == []
    grant(db, habits[0])
    with client(db, USERS[1]) as c:
        assert c.get(f"/shared-habits/{habits[0]}").status_code == 200


def test_archive_retains_grant_for_restore_and_owner_can_revoke_while_archived(db):
    befriend(db)
    habit = create(db)
    grant(db, habit)
    with client(db, USERS[0]) as c:
        assert c.post(f"/habits/{habit}/archive").status_code == 200
        assert len(c.get(f"/habits/{habit}/shares").json()) == 1
        assert c.put(f"/habits/{habit}/shares/{USERS[1]}", json={}).status_code == 200
    with client(db, USERS[1]) as c:
        assert c.get("/shared-habits").json() == []
        assert c.get(f"/shared-habits/{habit}").json() == NOT_FOUND
    with client(db, USERS[0]) as c:
        assert c.post(f"/habits/{habit}/restore").status_code == 200
    with client(db, USERS[1]) as c:
        assert c.get(f"/shared-habits/{habit}").status_code == 200
    with client(db, USERS[0]) as c:
        c.post(f"/habits/{habit}/archive")
        assert c.delete(f"/habits/{habit}/shares/{USERS[1]}").status_code == 204
        c.post(f"/habits/{habit}/restore")
    with client(db, USERS[1]) as c:
        assert c.get(f"/shared-habits/{habit}").status_code == 404


def test_owner_local_today_and_snapshot_target_are_returned_without_recalculation(db):
    befriend(db)
    habit = create(db, config=BASE | {"type": "target", "target": 10, "unit": "pages"})
    grant(db, habit)
    snapshot = {key: db.habits[habit][key] for key in HabitCreate.model_fields}
    db.occurrences[habit] = {"id": str(uuid4()), "local_date": "2026-03-02", "timezone": "Pacific/Kiritimati",
                             "closes_at": "2026-03-02T10:00:00Z", "snapshot": snapshot,
                             "progress": 10, "completed": True, "state": "completed"}
    with client(db, USERS[0]) as c:
        assert c.patch(f"/habits/{habit}", json={"target": 20, "name": "Read more", "unit": "chapters"}).status_code == 200
    with client(db, USERS[1]) as c:
        detail = c.get(f"/shared-habits/{habit}?timezone=America/Los_Angeles").json()
        assert detail["configuration"]["target"] == 20 and detail["configuration"]["unit"] == "chapters"
        assert detail["occurrence"]["snapshot"]["target"] == 10 and detail["occurrence"]["snapshot"]["unit"] == "pages"
        assert detail["occurrence"]["completed"] is True and detail["occurrence"]["state"] == "completed"
        assert detail["local_date"] == "2026-03-02" and detail["timezone"] == "Pacific/Kiritimati"
        assert detail["due_today"] is True and c.get("/shared-habits").json() == [detail]


def test_response_models_allow_only_public_identity_and_shared_fields(db, monkeypatch):
    befriend(db)
    habit = create(db)
    db.occurrences[habit] = {"id": str(uuid4()), "local_date": "2026-03-02", "timezone": "Pacific/Kiritimati",
        "closes_at": "2026-03-02T10:00:00Z", "snapshot": {key: db.habits[habit][key] for key in HabitCreate.model_fields},
        "progress": 0, "completed": False, "state": "justification_pending",
        "excuse": {"explanation": "private excuse"}, "explanation": "private excuse", "owner_id": USERS[0]}
    original_public, original_view = db.public, db.shared_view
    monkeypatch.setattr(db, "public", lambda user: original_public(user) | {"email": "secret@example.com", "timezone": "UTC", "auth_metadata": {"private": True}})
    def private_view(actor, identifier):
        view = original_view(actor, identifier)
        if view is None: return None
        return view | {"owner_id": USERS[0], "email": "secret@example.com", "streak": 17,
                       "history": [{"explanation": "private excuse"}], "explanation": "private excuse",
                       "created_at": "2026-01-01T00:00:00Z"}
    monkeypatch.setattr(db, "shared_view", private_view)
    assert set(grant(db, habit)) == PUBLIC_FIELDS
    with client(db, USERS[0]) as c:
        assert set(c.get(f"/habits/{habit}/shares").json()[0]) == PUBLIC_FIELDS
    with client(db, USERS[1]) as c:
        for view in [c.get(f"/shared-habits/{habit}").json(), *c.get("/shared-habits").json()]:
            assert set(view) == {"id", "owner", "configuration", "local_date", "timezone", "server_time", "due_today", "occurrence",
                                 "current_streak", "provisional", "calculated_at"}
            assert set(view["owner"]) == PUBLIC_FIELDS
            assert set(view["occurrence"]) == {"id", "local_date", "timezone", "closes_at", "snapshot", "progress", "completed", "state"}
            assert "streak" not in view


@pytest.mark.parametrize("method,path", [("PUT", f"/habits/bad/shares/{USERS[1]}"),
    ("PUT", f"/habits/{USERS[3]}/shares/bad"), ("DELETE", f"/habits/{USERS[3]}/shares/bad"),
    ("GET", "/habits/bad/shares"), ("GET", "/shared-habits/bad")])
def test_path_ids_are_uuids(db, method, path):
    with client(db, USERS[0]) as c:
        assert c.request(method, path).status_code == 422
    assert db.calls == []


@pytest.mark.parametrize("code,status", [("profile_not_found", 404), ("friendship_required", 409), ("self_share", 422)])
def test_database_errors_are_mapped(db, monkeypatch, code, status):
    async def fail(*args): raise SharingError(code)
    monkeypatch.setattr(db, "grant_habit_share", fail)
    with client(db, USERS[0]) as c:
        response = c.put(f"/habits/{USERS[3]}/shares/{USERS[1]}")
        assert response.status_code == status and response.json()["detail"]["code"] == code
