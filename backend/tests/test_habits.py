from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from app.habit_schemas import HabitCreate
from app.main import app
from app.services.supabase import HabitError
from test_friends import FriendDatabase, USERS, client


BASE = {"name": " Read ", "type": "binary", "schedule": "daily", "reminder_times": ["21:00", "08:00"]}
TARGET = BASE | {"type": "target", "target": 10, "unit": " pages ", "schedule": "selected", "weekdays": [7, 1, 3]}
ENDPOINTS = [("POST", "/habits", BASE), ("GET", "/habits", None), ("GET", f"/habits/{USERS[3]}", None),
             ("PATCH", f"/habits/{USERS[3]}", {"name": "New"}), ("POST", f"/habits/{USERS[3]}/archive", {}),
             ("POST", f"/habits/{USERS[3]}/restore", {})]


class HabitDatabase(FriendDatabase):
    """API isolation double; the real atomicity contract is tested in PostgreSQL."""
    def __init__(self):
        super().__init__()
        self.habits = {}

    async def create_habit(self, actor, values):
        now = datetime.now(timezone.utc).isoformat()
        row = values | {"id": str(uuid4()), "owner_id": actor, "created_at": now, "updated_at": now, "archived_at": None}
        self.habits[row["id"]] = row
        return deepcopy(row)

    async def get_habit(self, actor, habit):
        row = self.habits.get(habit)
        return deepcopy(row) if row and row["owner_id"] == actor else None

    async def list_habits(self, actor, status):
        return sorted([deepcopy(r) for r in self.habits.values() if r["owner_id"] == actor and
                       (status == "all" or (r["archived_at"] is None) == (status == "active"))], key=lambda r: (r["created_at"], r["id"]))

    async def update_habit(self, actor, habit, values):
        row = await self.get_habit(actor, habit)
        if row is None: return None
        if row["archived_at"]: raise HabitError("habit_archived")
        config = {k: row[k] for k in HabitCreate.model_fields}
        try: config = HabitCreate.model_validate(config | values).model_dump()
        except ValidationError as exc: raise HabitError("invalid_habit_configuration") from exc
        self.habits[habit].update(config, updated_at=datetime.now(timezone.utc).isoformat())
        return deepcopy(self.habits[habit])

    async def set_habit_archived(self, actor, habit, archived):
        row = await self.get_habit(actor, habit)
        if row is None: return None
        if (row["archived_at"] is not None) != archived:
            now = datetime.now(timezone.utc).isoformat()
            self.habits[habit].update(archived_at=now if archived else None, updated_at=now)
        return deepcopy(self.habits[habit])


@pytest.fixture(autouse=True)
def overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def db():
    database = HabitDatabase()
    for user, name in zip(USERS[:3], ["alice", "bob", "eve"]): database.add(user, name)
    return database


@pytest.mark.parametrize("method,path,body", ENDPOINTS)
@pytest.mark.parametrize("token", [None, "expired-token"])
def test_authentication(monkeypatch, method, path, body, token):
    from fastapi.testclient import TestClient
    original = httpx.AsyncClient
    def reject(request):
        assert request.url.path == "/auth/v1/user"
        assert request.headers["authorization"] == "Bearer expired-token"
        return httpx.Response(401, json={"message": "expired"})
    monkeypatch.setattr("app.auth.httpx.AsyncClient", lambda *a, **kw: original(transport=httpx.MockTransport(reject)))
    with TestClient(app) as c:
        assert c.request(method, path, json=body, headers={"Authorization": f"Bearer {token}"} if token else {}).status_code == 401


@pytest.mark.parametrize("method,path,body", ENDPOINTS)
def test_missing_profile(method, path, body):
    database = HabitDatabase()
    with client(database, USERS[0]) as c:
        response = c.request(method, path, json=body)
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "profile_not_found"
    assert not database.habits


@pytest.mark.parametrize("body", [BASE, TARGET])
def test_create_and_read_normalization(db, body):
    with client(db, USERS[0]) as c:
        response = c.post("/habits", json=body)
        assert response.status_code == 201
        row = response.json()
        assert row["name"] == "Read" and row["reminder_times"] == ["08:00", "21:00"]
        assert row["owner_id"] == USERS[0] and row["archived_at"] is None
        assert row["weekdays"] == ([1, 3, 7] if body["type"] == "target" else [])
        assert row["unit"] == ("pages" if body["type"] == "target" else None)
        assert c.get(f"/habits/{row['id']}").json() == row
        assert c.get("/habits").json() == [row]


INVALID = [
    {"name": " "}, {"name": "x" * 101}, {"name": None}, {"description": "x" * 1001},
    {"type": "other"}, {"type": "target"}, {"target": 1}, {"unit": "x"},
    {"type": "target", "target": True}, {"type": "target", "target": 1.5},
    {"type": "target", "target": "1"}, {"type": "target", "target": 0}, {"type": "target", "target": -1},
    {"type": "target", "target": 1, "unit": " "}, {"type": "target", "target": 1, "unit": "x" * 31},
    {"weekdays": [1]}, {"schedule": "selected"}, {"schedule": "selected", "weekdays": [1, 1]},
    {"schedule": "selected", "weekdays": [0]}, {"schedule": "selected", "weekdays": [8]},
    {"schedule": "selected", "weekdays": [True]}, {"schedule": "selected", "weekdays": [1.5]},
    {"schedule": "selected", "weekdays": ["1"]}, {"weekdays": None}, {"schedule": None},
    {"reminder_times": []}, {"reminder_times": None}, {"reminder_times": ["8:00"]},
    {"reminder_times": ["24:00"]}, {"reminder_times": ["12:60"]}, {"reminder_times": ["08:00:00"]},
    {"reminder_times": ["08:00", "08:00"]}, {"reminder_times": ["08:00\n"]}, {"reminder_times": [800]},
]


@pytest.mark.parametrize("changes", INVALID)
def test_creation_rejects_invalid_configuration(db, changes):
    with client(db, USERS[0]) as c:
        assert c.post("/habits", json=BASE | changes).status_code == 422
    assert not db.habits


@pytest.mark.parametrize("field", ["id", "owner_id", "user_id", "created_at", "updated_at", "archived_at", "unexpected"])
def test_server_fields_and_unknown_fields_rejected(db, field):
    with client(db, USERS[0]) as c:
        assert c.post("/habits", json=BASE | {field: USERS[0]}).status_code == 422
        habit = c.post("/habits", json=BASE).json()["id"]
        before = deepcopy(db.habits)
        assert c.patch(f"/habits/{habit}", json={field: USERS[0]}).status_code == 422
        assert db.habits == before


def test_patch_omission_null_combinations_and_atomic_rejection(db):
    with client(db, USERS[0]) as c:
        row = c.post("/habits", json=TARGET | {"description": "Old"}).json()
        path = f"/habits/{row['id']}"
        changed = c.patch(path, json={"name": "Changed", "description": None, "unit": None}).json()
        assert changed["description"] is None and changed["unit"] is None
        for key in ("id", "owner_id", "created_at", "type", "target", "schedule", "weekdays", "reminder_times"):
            assert changed[key] == row[key]
        for bad in [{}, {"type": "target"}, {"target": None}, {"name": None}, {"schedule": "daily"},
                    {"weekdays": None}, {"reminder_times": None}, {"name": "Lost", "target": 0}]:
            before = deepcopy(db.habits)
            assert c.patch(path, json=bad).status_code == 422
            assert db.habits == before
        changed = c.patch(path, json={"schedule": "daily", "weekdays": [], "target": 20}).json()
        assert changed["schedule"] == "daily" and changed["weekdays"] == [] and changed["target"] == 20
        assert c.patch(path, json={"schedule": "selected", "weekdays": [6, 2]}).json()["weekdays"] == [2, 6]
        binary = c.post("/habits", json=BASE).json()["id"]
        assert c.patch(f"/habits/{binary}", json={"target": None, "unit": None}).status_code == 200
        assert c.patch(f"/habits/{binary}", json={"target": 1}).status_code == 422


def test_archive_restore_filtering_preservation(db):
    with client(db, USERS[0]) as c:
        row = c.post("/habits", json=TARGET).json()
        other = c.post("/habits", json=BASE).json()
        path = f"/habits/{row['id']}"
        archived = c.post(path + "/archive").json()
        assert archived["archived_at"] is not None
        assert c.post(path + "/archive", json={}).json() == archived
        assert c.get(path).json() == archived
        assert c.get("/habits").json() == [other]
        assert c.get("/habits?status=archived").json() == [archived]
        assert c.get("/habits?status=all").json() == [archived, other]
        assert c.get("/habits?status=bad").status_code == 422
        before = deepcopy(db.habits)
        response = c.patch(path, json={"name": "Changed"})
        assert response.status_code == 409 and response.json()["detail"]["code"] == "habit_archived"
        assert db.habits == before
        restored = c.post(path + "/restore").json()
        assert restored["archived_at"] is None
        assert c.post(path + "/restore", json={}).json() == restored
        for key in HabitCreate.model_fields:
            assert restored[key] == row[key] == archived[key]
        assert restored["id"] == row["id"]
        assert c.patch(path, json={"name": "Changed"}).status_code == 200
        assert c.delete(path).status_code == 405


@pytest.mark.parametrize("action", ["archive", "restore"])
@pytest.mark.parametrize("body", [{"name": "bad"}, {"archived_at": None}, {"owner_id": USERS[1]}, [], "bad"])
def test_lifecycle_body_cannot_edit_configuration(db, action, body):
    with client(db, USERS[0]) as c:
        row = c.post("/habits", json=BASE).json()
        before = deepcopy(db.habits)
        assert c.post(f"/habits/{row['id']}/{action}", json=body).status_code == 422
        assert db.habits == before


def test_other_users_and_accepted_friends_have_same_not_found(db):
    with client(db, USERS[0]) as c:
        habit = c.post("/habits", json=BASE).json()["id"]
        request = c.post("/friend-requests", json={"recipient_user_id": USERS[1]}).json()["id"]
    with client(db, USERS[1]) as c:
        assert c.post(f"/friend-requests/{request}/accept").status_code == 200
    for actor in USERS[1:3]:
        with client(db, actor) as c:
            assert c.get("/habits?status=all").json() == []
            for method, suffix, body in [("GET", "", None), ("PATCH", "", {"name": "Bad"}), ("POST", "/archive", {}), ("POST", "/restore", {})]:
                actual = c.request(method, f"/habits/{habit}{suffix}", json=body)
                missing = c.request(method, f"/habits/{uuid4()}{suffix}", json=body)
                assert actual.status_code == missing.status_code == 404
                assert actual.json() == missing.json() == {"detail": {"code": "habit_not_found", "message": "Habit not found"}}


@pytest.mark.parametrize("method,suffix,body", [("GET", "", None), ("PATCH", "", {"name": "X"}), ("POST", "/archive", {}), ("POST", "/restore", {})])
def test_invalid_uuid(db, method, suffix, body):
    with client(db, USERS[0]) as c:
        assert c.request(method, f"/habits/not-a-uuid{suffix}", json=body).status_code == 422


@pytest.mark.parametrize("code,expected", [("profile_not_found", 404), ("invalid_habit_configuration", 422), ("habit_archived", 409)])
def test_rpc_errors(db, monkeypatch, code, expected):
    async def failed(*args): raise HabitError(code)
    monkeypatch.setattr(db, "update_habit", failed)
    with client(db, USERS[0]) as c:
        response = c.patch(f"/habits/{USERS[3]}", json={"name": "New"})
        assert response.status_code == expected and response.json()["detail"]["code"] == code
