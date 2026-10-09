"""History/streak HTTP contracts; occurrence calculations are tested in PostgreSQL."""
import base64
import json
from copy import deepcopy
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.habit_schemas import HabitCreate
from app.main import app
from app.services.supabase import HistoryError
from test_friends import USERS, client
from test_habits import BASE
from test_occurrences import ROW
from test_sharing import NOT_FOUND, SharingDatabase, befriend, grant


OWNER, FRIEND, OTHER = USERS[:3]
HABIT, ABSENT, OCCURRENCE, EXCUSE_ID = [str(UUID(int=i)) for i in range(20, 24)]
NOW = "2026-03-05T12:00:00Z"
OCCURRENCE_ROW = ROW | {"id": OCCURRENCE, "habit_id": HABIT, "owner_id": OWNER,
                        "state": "completed", "completed": True, "excuse": None}
CURSOR = {"v": 1, "habit_id": HABIT, "from_date": None, "to_date": None,
          "local_date": "2026-03-01", "id": OCCURRENCE}
STREAK = {"habit_id": HABIT, "current_streak": 0, "provisional": False, "calculated_at": NOW}
ENDPOINTS = [f"/habits/{HABIT}/history", f"/habits/{HABIT}/streak"]


def encode_cursor(value):
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()


def decode_cursor(value):
    return json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))


class HistoryDatabase(SharingDatabase):
    """Prepared RPC results only; no duplicate reconciliation or streak algorithm."""

    def __init__(self):
        super().__init__()
        for actor, name in zip(USERS[:3], ["alice", "bob", "eve"]):
            self.add(actor, name)
        self.habits[HABIT] = HabitCreate.model_validate(BASE).model_dump() | {
            "id": HABIT, "owner_id": OWNER, "created_at": NOW, "updated_at": NOW, "archived_at": None}
        self.page = {"habit_id": HABIT, "occurrences": [], "next_cursor": None}
        self.streak = deepcopy(STREAK)
        self.failure = None

    def owned(self, actor, habit):
        if self.failure:
            raise HistoryError(self.failure)
        if actor not in self.profiles:
            raise HistoryError("profile_not_found")
        return habit in self.habits and self.habits[habit]["owner_id"] == actor

    async def get_habit_history(self, user_id, habit_id, limit=30, from_date=None, to_date=None, cursor=None):
        self.calls.append(("history", user_id, habit_id, limit, from_date, to_date, cursor))
        return deepcopy(self.page) if self.owned(user_id, habit_id) else None

    async def get_habit_streak(self, user_id, habit_id):
        self.calls.append(("streak", user_id, habit_id))
        return deepcopy(self.streak) if self.owned(user_id, habit_id) else None


@pytest.fixture(autouse=True)
def overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def api():
    database = HistoryDatabase()
    with client(database, OWNER) as c:
        yield c, database


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("token", [None, "expired-token"])
def test_routes_require_valid_authentication(monkeypatch, path, token):
    original = httpx.AsyncClient

    def reject(request):
        assert request.url.path == "/auth/v1/user"
        assert request.headers["authorization"] == "Bearer expired-token"
        return httpx.Response(401)

    monkeypatch.setattr("app.auth.httpx.AsyncClient", lambda *a, **kw: original(transport=httpx.MockTransport(reject)))
    with TestClient(app) as c:
        response = c.get(path, headers={"Authorization": "Bearer " + token} if token else {})
        assert response.status_code == 401


def test_empty_history_and_zero_streak_contract(api):
    c, db = api
    history = c.get(ENDPOINTS[0])
    streak = c.get(ENDPOINTS[1])
    assert history.status_code == streak.status_code == 200
    assert history.json() == {"habit_id": HABIT, "occurrences": [], "next_cursor": None}
    assert streak.json() == STREAK
    assert db.calls == [("history", OWNER, HABIT, 30, None, None, None), ("streak", OWNER, HABIT)]


@pytest.mark.parametrize("archived", [False, True])
def test_owner_can_read_active_and_archived_habits(api, archived):
    c, db = api
    if archived:
        assert c.post(f"/habits/{HABIT}/archive").status_code == 200
    db.page["occurrences"] = [deepcopy(OCCURRENCE_ROW)]
    db.streak.update(current_streak=1)
    assert c.get(ENDPOINTS[0]).json()["occurrences"][0]["id"] == OCCURRENCE
    assert c.get(ENDPOINTS[1]).json()["current_streak"] == 1


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("actor", [OWNER, FRIEND, OTHER])
def test_missing_and_foreign_are_identical_even_for_accepted_shared_friend(path, actor):
    db = HistoryDatabase()
    befriend(db)
    grant(db, HABIT)
    db.calls.clear()
    with client(db, actor) as c:
        missing = c.get(path.replace(HABIT, ABSENT))
        assert missing.status_code == 404 and missing.json() == NOT_FOUND
        if actor != OWNER:
            foreign = c.get(path)
            assert foreign.status_code == 404 and foreign.json() == missing.json()
            assert all(call[1] == actor for call in db.calls)


def test_cursor_does_not_establish_owner_authorization():
    db = HistoryDatabase()
    befriend(db)
    grant(db, HABIT)
    with client(db, FRIEND) as c:
        response = c.get(ENDPOINTS[0], params={"cursor": encode_cursor(CURSOR), "owner_id": OWNER})
        assert response.status_code == 404 and response.json() == NOT_FOUND
    assert db.calls[-1] == ("history", FRIEND, HABIT, 30, None, None, CURSOR)


@pytest.mark.parametrize("path", ENDPOINTS)
def test_missing_profile_is_reported(api, path):
    c, db = api
    del db.profiles[OWNER]
    response = c.get(path)
    assert response.status_code == 404 and response.json()["detail"]["code"] == "profile_not_found"


@pytest.mark.parametrize("value", [0, 1, 7])
@pytest.mark.parametrize("provisional", [False, True])
def test_streak_uses_authoritative_database_count_flag_and_time(api, value, provisional):
    c, db = api
    db.streak.update(current_streak=value, provisional=provisional)
    response = c.get(ENDPOINTS[1], params={"owner_id": OTHER, "now": "1900-01-01", "test_clock": "1900-01-01"})
    assert response.status_code == 200
    assert response.json() == STREAK | {"current_streak": value, "provisional": provisional}
    assert db.calls == [("streak", OWNER, HABIT)]


@pytest.mark.parametrize("status,source,decider,decided_at,state", [
    ("pending", None, None, None, "justification_pending"),
    ("approved", "automatic", None, NOW, "excused"),
    ("approved", "friend", FRIEND, NOW, "excused"),
    ("rejected", "friend", FRIEND, NOW, "missed"),
])
def test_history_returns_stored_snapshot_and_compact_excuse_metadata(api, status, source, decider, decided_at, state):
    c, db = api
    snapshot = HabitCreate.model_validate(BASE | {"type": "target", "target": 10, "unit": "pages", "name": "Old name"}).model_dump()
    excuse = {"id": EXCUSE_ID, "explanation": "חולה 🌡️", "status": status, "decision_source": source,
              "decided_by": decider, "decided_at": decided_at, "created_at": NOW}
    db.page["occurrences"] = [OCCURRENCE_ROW | {"snapshot": snapshot, "progress": 4, "completed": False, "state": state,
        "timezone": "Pacific/Kiritimati", "local_date": "2026-03-02", "closes_at": "2026-03-02T10:00:00Z",
        "excuse": excuse | {"occurrence": deepcopy(ROW), "occurrence_id": OCCURRENCE, "owner_id": OWNER}}]
    db.habits[HABIT].update(snapshot)
    assert c.patch(f"/habits/{HABIT}", json={"name": "New name", "target": 20, "unit": "chapters"}).status_code == 200
    response = c.get(ENDPOINTS[0], params={"timezone": "America/Los_Angeles"})
    assert response.status_code == 200
    row = response.json()["occurrences"][0]
    assert row["snapshot"] == snapshot and row["snapshot"]["name"] != db.habits[HABIT]["name"]
    assert (row["local_date"], row["timezone"], row["closes_at"]) == ("2026-03-02", "Pacific/Kiritimati", "2026-03-02T10:00:00Z")
    assert (row["progress"], row["completed"], row["state"]) == (4, False, state)
    assert row["excuse"] == excuse


def test_history_preserves_rpc_order_and_encodes_continuation_without_requery(api):
    c, db = api
    newer = OCCURRENCE_ROW | {"id": str(UUID(int=30)), "local_date": "2026-03-02"}
    db.page.update(occurrences=[newer, deepcopy(OCCURRENCE_ROW)], next_cursor=deepcopy(CURSOR))
    response = c.get(ENDPOINTS[0], params={"limit": 2})
    assert response.status_code == 200
    result = response.json()
    assert [row["id"] for row in result["occurrences"]] == [newer["id"], OCCURRENCE]
    assert "=" not in result["next_cursor"] and decode_cursor(result["next_cursor"]) == CURSOR
    assert db.calls == [("history", OWNER, HABIT, 2, None, None, None)]
    db.page.update(occurrences=[], next_cursor=None)
    assert c.get(ENDPOINTS[0], params={"cursor": result["next_cursor"], "limit": 100}).json()["next_cursor"] is None
    assert db.calls[-1] == ("history", OWNER, HABIT, 100, None, None, CURSOR)


@pytest.mark.parametrize("filters", [{"from_date": "2026-03-01"}, {"to_date": "2026-03-05"},
                                     {"from_date": "2026-03-01", "to_date": "2026-03-01"}])
def test_inclusive_date_filters_and_scoped_cursor_are_forwarded(api, filters):
    c, db = api
    cursor = CURSOR | filters
    response = c.get(ENDPOINTS[0], params=filters | {"cursor": encode_cursor(cursor), "limit": 1})
    assert response.status_code == 200 and response.json()["occurrences"] == []
    assert db.calls == [("history", OWNER, HABIT, 1, filters.get("from_date"), filters.get("to_date"), cursor)]


@pytest.mark.parametrize("field", ["from_date", "to_date"])
@pytest.mark.parametrize("value", ["", "2026-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026-3-1",
                                  "20260301", "2026-03-01T00:00:00Z", "0", " 2026-03-01", "0000-01-01"])
def test_invalid_dates_are_rejected_before_database_call(api, field, value):
    c, db = api
    assert c.get(ENDPOINTS[0], params={field: value}).status_code == 422
    assert db.calls == []


def test_reversed_range_is_rejected_before_database_call(api):
    c, db = api
    response = c.get(ENDPOINTS[0], params={"from_date": "2026-03-02", "to_date": "2026-03-01"})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "invalid_history_range"
    assert db.calls == []


@pytest.mark.parametrize("limit", ["", "0", "-1", "101", "1.0", "1.5", "true", "null", "all", "99999999999999999999"])
def test_invalid_limits_are_rejected_before_database_call(api, limit):
    c, db = api
    assert c.get(ENDPOINTS[0], params={"limit": limit}).status_code == 422
    assert db.calls == []


INVALID_CURSORS = [
    "", "%%%", "a", "eyJ", "null", "a" * 4097, encode_cursor(CURSOR) + "=",
    *[encode_cursor(value) for value in [None, [], 1, "cursor", {}, CURSOR | {"v": 2}, CURSOR | {"v": True},
        CURSOR | {"v": "1"}, CURSOR | {"extra": "unexpected"}, CURSOR | {"id": "not-a-uuid"},
        CURSOR | {"local_date": "2026-02-29"}, CURSOR | {"local_date": "2026-3-1"},
        CURSOR | {"habit_id": ABSENT}, CURSOR | {"from_date": "2026-03-01"}, CURSOR | {"to_date": "2026-03-01"},
        {key: value for key, value in CURSOR.items() if key != "from_date"}]],
]


@pytest.mark.parametrize("cursor", INVALID_CURSORS)
def test_malformed_and_cross_scope_cursors_are_rejected_before_database_call(api, cursor):
    c, db = api
    response = c.get(ENDPOINTS[0], params={"cursor": cursor})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "invalid_history_cursor"
    assert db.calls == []


@pytest.mark.parametrize("filters", [{"from_date": "2026-02-01"}, {"to_date": "2026-03-31"}])
def test_unfiltered_cursor_cannot_be_reused_with_filters(api, filters):
    c, db = api
    response = c.get(ENDPOINTS[0], params=filters | {"cursor": encode_cursor(CURSOR)})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "invalid_history_cursor"
    assert db.calls == []


@pytest.mark.parametrize("suffix", ["history", "streak"])
def test_path_habit_id_must_be_uuid(api, suffix):
    c, db = api
    assert c.get(f"/habits/not-a-uuid/{suffix}").status_code == 422
    assert db.calls == []


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("code,status", [("profile_not_found", 404), ("invalid_history_cursor", 422),
                                        ("invalid_history_range", 422), ("invalid_history_limit", 422)])
def test_database_domain_errors_are_mapped(api, path, code, status):
    c, db = api
    db.failure = code
    response = c.get(path)
    assert response.status_code == status and response.json()["detail"]["code"] == code
