from copy import deepcopy
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from app.routers.excuses import ERRORS
from app.services.supabase import ExcuseError, OccurrenceError
from test_occurrences import OWNER, OID, ROW

EID, FRIEND = str(UUID(int=10)), str(UUID(int=11))
EXCUSE = {
    "id": EID, "occurrence_id": OID, "habit_id": ROW["habit_id"], "owner_id": OWNER,
    "explanation": "Recovering from illness", "status": "pending", "decision_source": None,
    "decided_by": None, "decided_at": None, "created_at": "2026-03-01T12:00:00Z",
    "occurrence": ROW | {"state": "justification_pending"},
}
ENDPOINTS = [
    ("POST", f"/occurrences/{OID}/excuse", {"explanation": "Recovering from illness"}, 201),
    ("GET", f"/occurrences/{OID}/excuse", None, 200),
    ("GET", "/excuses/pending", None, 200),
    ("POST", f"/excuses/{EID}/decision", {"decision": "approve"}, 200),
]


class Database:
    """API dispatch double; permission/state/concurrency assertions use PostgreSQL."""

    def __init__(self):
        self.calls = []
        self.failure = None
        self.missing = False
        self.rows = [deepcopy(EXCUSE)]

    def call(self, method, *args, many=False):
        self.calls.append((method, *args))
        if self.failure:
            raise ExcuseError(self.failure)
        if many:
            return deepcopy(self.rows)
        return None if self.missing else deepcopy(self.rows[0])

    async def submit_occurrence_excuse(self, *args):
        return self.call("submit", *args)

    async def get_occurrence_excuse(self, *args):
        return self.call("read", *args)

    async def list_pending_excuses(self, *args):
        return self.call("pending", *args, many=True)

    async def decide_occurrence_excuse(self, *args):
        return self.call("decide", *args)

    async def get_today(self, owner):
        self.calls.append(("today", owner))
        return {"local_date": "2026-03-01", "timezone": "UTC", "server_time": "2026-03-01T12:00:00Z",
                "occurrences": [self.rows[0]["occurrence"] | {"explanation": "private"}]}

    async def get_profile(self, actor):
        return {"user_id": actor}

    def shared(self):
        return {"id": ROW["habit_id"], "owner": {"user_id": OWNER, "username": "owner", "display_name": "Owner"},
                "configuration": ROW["snapshot"], "local_date": "2026-03-01", "timezone": "UTC",
                "server_time": "2026-03-01T12:00:00Z", "due_today": True,
                "occurrence": self.rows[0]["occurrence"] | {"explanation": "private"}, "explanation": "private"}

    async def get_shared_habit(self, actor, habit):
        return self.shared()

    async def list_shared_habits(self, actor):
        return [self.shared()]

    async def mutate_occurrence(self, *args):
        self.calls.append(("mutate", *args))
        raise OccurrenceError("occurrence_locked")


@pytest.fixture(autouse=True)
def overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def api():
    database = Database()
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = lambda: database
    with TestClient(app) as client:
        yield client, database


@pytest.mark.parametrize("method,path,body,status", ENDPOINTS)
@pytest.mark.parametrize("token", [None, "expired-token"])
def test_all_routes_require_authentication(monkeypatch, method, path, body, status, token):
    original = httpx.AsyncClient
    monkeypatch.setattr("app.auth.httpx.AsyncClient", lambda *a, **kw: original(transport=httpx.MockTransport(lambda r: httpx.Response(401))))
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        assert client.request(method, path, json=body, headers=headers).status_code == 401


@pytest.mark.parametrize("endpoint,expected", [
    (ENDPOINTS[0], ("submit", OWNER, OID, "Recovering from illness")),
    (ENDPOINTS[1], ("read", OWNER, OID)),
    (ENDPOINTS[2], ("pending", OWNER)),
    (ENDPOINTS[3], ("decide", OWNER, EID, "approve")),
])
def test_routes_derive_actor_from_authentication(api, endpoint, expected):
    client, database = api
    method, path, body, status = endpoint
    response = client.request(method, path + f"?p_actor={FRIEND}&owner_id={FRIEND}", json=body,
                              headers={"X-User-Id": FRIEND, "X-Owner-Id": FRIEND})
    assert response.status_code == status
    assert database.calls == [expected]


@pytest.mark.parametrize("explanation,expected", [
    ("  Still ill\n", "Still ill"), ("\u2003\u00a0חולה היום 🌡️\u3000", "חולה היום 🌡️"),
    ("x", "x"), (" 🌍 " , "🌍"), ("\t" + "🌍" * 1000 + "\n", "🌍" * 1000),
])
def test_explanation_unicode_trim_and_codepoint_boundaries(api, explanation, expected):
    client, database = api
    response = client.post(f"/occurrences/{OID}/excuse", json={"explanation": explanation})
    assert response.status_code == 201
    assert database.calls == [("submit", OWNER, OID, expected)]


@pytest.mark.parametrize("body", [
    {}, None, [], "explanation", {"explanation": None}, {"explanation": 1}, {"explanation": True},
    {"explanation": []}, {"explanation": {}}, {"explanation": ""}, {"explanation": " \t\n\u2003\u00a0"},
    {"explanation": "🌍" * 1001}, {"explanation": "x\x00y"},
])
def test_invalid_explanation_never_reaches_database(api, body):
    client, database = api
    assert client.post(f"/occurrences/{OID}/excuse", json=body).status_code == 422
    assert database.calls == []


@pytest.mark.parametrize("path,content", [
    (f"/occurrences/{OID}/excuse", b'{"explanation":"\\ud800"}'),
    (f"/occurrences/{OID}/excuse", b'{"explanation":"\\udfff"}'),
    (f"/occurrences/{OID}/excuse", b'{"explanation":"ill","extra":"\\ud800"}'),
    (f"/occurrences/{OID}/excuse", b'{"explanation":"ill","\\ud800":"extra"}'),
    (f"/excuses/{EID}/decision", b'{"decision":"\\ud800"}'),
    (f"/excuses/{EID}/decision", b'{"decision":"approve","extra":"\\ud800"}'),
])
def test_escaped_lone_surrogates_return_validation_error_without_database_call(api, path, content):
    client, database = api
    response = client.post(path, content=content, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.headers["content-type"] == "application/json"
    assert isinstance(response.json()["detail"], list)
    assert database.calls == []


def test_valid_escaped_unicode_pair_round_trips_unchanged(api):
    client, database = api
    explanation = "חולה 🌍"
    database.rows[0]["explanation"] = explanation
    response = client.post(f"/occurrences/{OID}/excuse",
                           content=b'{"explanation":"\\u05d7\\u05d5\\u05dc\\u05d4 \\ud83c\\udf0d"}',
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 201 and response.json()["explanation"] == explanation
    assert database.calls == [("submit", OWNER, OID, explanation)]


@pytest.mark.parametrize("extra", ["owner_id", "actor_id", "p_owner", "occurrence_id", "status", "decision",
                                   "decision_source", "decided_by", "decided_at", "created_at", "now", "test_clock"])
def test_submission_rejects_client_authority_fields(api, extra):
    client, database = api
    assert client.post(f"/occurrences/{OID}/excuse", json={"explanation": "ill", extra: "forged"}).status_code == 422
    assert database.calls == []


@pytest.mark.parametrize("body", [{}, None, [], {"decision": None}, {"decision": True}, {"decision": "approved"},
                                   {"decision": "APPROVE"}, {"decision": " approve "}, {"decision": "automatic"}])
def test_decision_requires_explicit_supported_value(api, body):
    client, database = api
    assert client.post(f"/excuses/{EID}/decision", json=body).status_code == 422
    assert database.calls == []


@pytest.mark.parametrize("extra", ["actor_id", "decided_by", "owner_id", "p_actor", "explanation", "status",
                                   "decision_source", "decided_at", "created_at", "now", "test_clock"])
def test_decision_rejects_client_identity_and_timestamps(api, extra):
    client, database = api
    assert client.post(f"/excuses/{EID}/decision", json={"decision": "approve", extra: "forged"}).status_code == 422
    assert database.calls == []


@pytest.mark.parametrize("method,path,body,status", ENDPOINTS)
def test_existing_profile_required(api, method, path, body, status):
    client, database = api
    database.failure = "profile_not_found"
    response = client.request(method, path, json=body)
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "profile_not_found"


@pytest.mark.parametrize("code", list(ERRORS))
def test_domain_error_conventions(api, code):
    client, database = api
    database.failure = code
    response = client.post(f"/occurrences/{OID}/excuse", json={"explanation": "ill"})
    assert response.status_code == ERRORS[code][0]
    assert response.json() == {"detail": {"code": code, "message": ERRORS[code][1]}}


@pytest.mark.parametrize("endpoint,identifier,code", [
    (ENDPOINTS[0], OID, "occurrence_not_found"), (ENDPOINTS[1], OID, "excuse_not_found"),
    (ENDPOINTS[3], EID, "excuse_not_found"),
])
def test_missing_and_inaccessible_resources_share_404(api, endpoint, identifier, code):
    client, database = api
    database.missing = True
    method, path, body, _ = endpoint
    inaccessible = client.request(method, path, json=body)
    missing = client.request(method, path.replace(identifier, str(UUID(int=999))), json=body)
    assert inaccessible.status_code == missing.status_code == 404
    assert inaccessible.json() == missing.json()
    assert inaccessible.json()["detail"]["code"] == code


@pytest.mark.parametrize("status,source,actor,state", [
    ("pending", None, None, "justification_pending"),
    ("approved", "automatic", None, "excused"),
    ("approved", "friend", FRIEND, "excused"),
    ("rejected", "friend", FRIEND, "missed"),
])
def test_submission_and_read_preserve_decision_metadata_progress_and_snapshots(api, status, source, actor, state):
    client, database = api
    row = database.rows[0]
    row.update(status=status, decision_source=source, decided_by=actor,
               decided_at=None if status == "pending" else "2026-03-02T06:00:00Z")
    row["occurrence"].update(state=state, progress=3, snapshot=ROW["snapshot"] | {"type": "target", "target": 10, "unit": "pages"})
    for method, path, body, expected_status in ENDPOINTS[:2]:
        response = client.request(method, path, json=body)
        assert response.status_code == expected_status
        value = response.json()
        assert value["status"] == status and value["decision_source"] == source and value["decided_by"] == actor
        assert value["occurrence"]["state"] == state and value["occurrence"]["completed"] is False
        assert value["occurrence"]["progress"] == 3 and value["occurrence"]["snapshot"]["target"] == 10


@pytest.mark.parametrize("decision,state,status", [("approve", "excused", "approved"), ("reject", "missed", "rejected")])
def test_friend_decision_contract(api, decision, state, status):
    client, database = api
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=FRIEND)
    database.rows[0].update(status=status, decision_source="friend", decided_by=FRIEND, decided_at="2026-03-02T06:00:00Z")
    database.rows[0]["occurrence"]["state"] = state
    response = client.post(f"/excuses/{EID}/decision", json={"decision": decision})
    assert response.status_code == 200 and response.json()["status"] == status
    assert response.json()["decided_by"] == FRIEND and response.json()["occurrence"]["state"] == state
    assert database.calls == [("decide", FRIEND, EID, decision)]


def test_pending_list_retains_database_order_and_older_occurrences(api):
    client, database = api
    older = deepcopy(EXCUSE)
    older.update(id=str(UUID(int=9)), created_at="2026-02-01T12:00:00Z")
    older["occurrence"].update(local_date="2026-02-01", closes_at="2026-02-02T00:00:00Z")
    database.rows.insert(0, older)
    response = client.get("/excuses/pending")
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [older["id"], EID]
    assert response.json()[0]["occurrence"]["local_date"] == "2026-02-01"
    database.rows.clear()
    assert client.get("/excuses/pending").json() == []


@pytest.mark.parametrize("state", ["justification_pending", "excused", "missed"])
def test_today_and_shared_views_accept_states_without_leaking_explanations(api, state):
    client, database = api
    database.rows[0]["occurrence"]["state"] = state
    today = client.get("/today")
    shared = client.get(f'/shared-habits/{ROW["habit_id"]}')
    listing = client.get("/shared-habits")
    assert today.status_code == shared.status_code == listing.status_code == 200
    for occurrence in [today.json()["occurrences"][0], shared.json()["occurrence"], listing.json()[0]["occurrence"]]:
        assert occurrence["state"] == state and occurrence["completed"] is False
        assert "explanation" not in occurrence
    assert "explanation" not in shared.json() and "explanation" not in listing.json()[0]


@pytest.mark.parametrize("method,suffix,body", [("PUT", "completion", {"completed": False}),
    ("PUT", "progress", {"progress": 0}), ("POST", "progress-adjustments", {"delta": 0})])
def test_progress_routes_map_excuse_lock_conflict(api, method, suffix, body):
    client, database = api
    response = client.request(method, f"/occurrences/{OID}/{suffix}", json=body, headers={"Idempotency-Key": "retry"})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "occurrence_locked"


@pytest.mark.parametrize("method,path,body", [("POST", "/occurrences/bad/excuse", {"explanation": "ill"}),
    ("GET", "/occurrences/bad/excuse", None), ("POST", "/excuses/bad/decision", {"decision": "approve"})])
def test_path_ids_require_uuids(api, method, path, body):
    client, database = api
    assert client.request(method, path, json=body).status_code == 422
    assert database.calls == []
