"""Mocked PostgREST coverage for the atomic history and streak RPCs."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from app.services.supabase import HistoryError
from test_friend_database_adapter import db, transport
from test_history import CURSOR, HABIT, NOW, OCCURRENCE_ROW, OTHER, OWNER, STREAK, decode_cursor, encode_cursor


HISTORY = {"habit_id": HABIT, "occurrences": [OCCURRENCE_ROW], "next_cursor": CURSOR}
OPERATIONS = [
    ("get_habit_history", [OWNER, HABIT],
     {"p_owner": OWNER, "p_habit": HABIT, "p_limit": 30, "p_from_date": None, "p_to_date": None, "p_cursor": None}, HISTORY),
    ("get_habit_history", [OWNER, HABIT, 100, "2026-03-01", "2026-03-05", CURSOR | {"from_date": "2026-03-01", "to_date": "2026-03-05"}],
     {"p_owner": OWNER, "p_habit": HABIT, "p_limit": 100, "p_from_date": "2026-03-01", "p_to_date": "2026-03-05",
      "p_cursor": CURSOR | {"from_date": "2026-03-01", "to_date": "2026-03-05"}}, HISTORY),
    ("get_habit_streak", [OWNER, HABIT], {"p_owner": OWNER, "p_habit": HABIT}, STREAK),
]


@pytest.mark.parametrize("method,args,payload,result", OPERATIONS)
@pytest.mark.parametrize("found", [False, True])
async def test_single_atomic_rpc_payload_service_key_and_result(monkeypatch, method, args, payload, result, found):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST" and request.url.path == f"/rest/v1/rpc/{method}"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        assert json.loads(request.content) == payload
        return httpx.Response(200, json=[result] if found else [])

    transport(monkeypatch, handler)
    assert await getattr(db(), method)(*args) == (result if found else None)
    assert len(calls) == 1


async def test_owned_empty_page_remains_distinct_from_missing_habit(monkeypatch):
    page = {"habit_id": HABIT, "occurrences": [], "next_cursor": None}
    transport(monkeypatch, lambda request: httpx.Response(200, json=[page]))
    assert await db().get_habit_history(OWNER, HABIT) == page


@pytest.mark.parametrize("method,args", [("get_habit_history", [OWNER, HABIT]), ("get_habit_streak", [OWNER, HABIT])])
@pytest.mark.parametrize("code", ["profile_not_found", "invalid_history_cursor", "invalid_history_range", "invalid_history_limit"])
async def test_known_database_errors_are_mapped(monkeypatch, method, args, code):
    transport(monkeypatch, lambda request: httpx.Response(400, json={"code": "P0001", "message": code}))
    with pytest.raises(HistoryError) as caught:
        await getattr(db(), method)(*args)
    assert caught.value.code == code


@pytest.mark.parametrize("method,args", [("get_habit_history", [OWNER, HABIT]), ("get_habit_streak", [OWNER, HABIT])])
@pytest.mark.parametrize("status,payload", [
    (500, {"code": "P0001", "message": "profile_not_found"}),
    (400, {"code": "42501", "message": "invalid_history_cursor"}),
    (400, {"code": "P0001", "message": "unknown"}),
    (400, {"code": "P0001", "message": ["invalid_history_limit"]}),
    (400, {"message": "invalid_history_range"}), (400, []), (400, None), (502, "Bad gateway"),
])
async def test_unknown_database_failures_are_not_empty_successes(monkeypatch, method, args, status, payload):
    transport(monkeypatch, lambda request: httpx.Response(status, text=payload) if isinstance(payload, str)
              else httpx.Response(status, json=payload))
    with pytest.raises(httpx.HTTPStatusError):
        await getattr(db(), method)(*args)


@pytest.mark.parametrize("method", ["get_habit_history", "get_habit_streak"])
async def test_transport_failures_propagate(monkeypatch, method):
    def unavailable(request):
        raise httpx.ConnectError("unavailable", request=request)

    transport(monkeypatch, unavailable)
    with pytest.raises(httpx.ConnectError):
        await getattr(db(), method)(OWNER, HABIT)


@pytest.mark.parametrize("suffix,rpc,payload,result", [
    ("history", "get_habit_history",
     {"p_owner": OWNER, "p_habit": HABIT, "p_limit": 30, "p_from_date": None, "p_to_date": None, "p_cursor": CURSOR}, HISTORY),
    ("streak", "get_habit_streak", {"p_owner": OWNER, "p_habit": HABIT}, STREAK | {"current_streak": 2, "provisional": True}),
])
def test_api_through_real_adapter_uses_one_rpc_and_authenticated_owner(monkeypatch, suffix, rpc, payload, result):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST" and request.url.path == f"/rest/v1/rpc/{rpc}"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        assert json.loads(request.content) == payload
        return httpx.Response(200, json=[result])

    transport(monkeypatch, handler)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = db
    try:
        with TestClient(app) as c:
            response = c.get(f"/habits/{HABIT}/{suffix}", params={"cursor": encode_cursor(CURSOR),
                "owner_id": OTHER, "p_owner": OTHER, "test_clock": "1900-01-01"})
            assert response.status_code == 200
            if suffix == "history":
                row = response.json()
                assert row["habit_id"] == HABIT and row["occurrences"][0]["snapshot"]["name"] == "Read"
                assert decode_cursor(row["next_cursor"]) == CURSOR
            else:
                assert response.json() == STREAK | {"current_streak": 2, "provisional": True}
        assert len(calls) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("suffix", ["history", "streak"])
@pytest.mark.parametrize("body,status,code", [([], 404, "habit_not_found"),
    ({"code": "P0001", "message": "profile_not_found"}, 404, "profile_not_found")])
def test_api_maps_missing_and_profile_errors_from_real_adapter(monkeypatch, suffix, body, status, code):
    transport(monkeypatch, lambda request: httpx.Response(200 if isinstance(body, list) else 400, json=body))
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = db
    try:
        with TestClient(app) as c:
            response = c.get(f"/habits/{HABIT}/{suffix}")
            assert response.status_code == status and response.json()["detail"]["code"] == code
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("method,args,result", [
    ("list_shared_habits", [OTHER], [{"id": HABIT, "current_streak": 2, "provisional": True, "calculated_at": NOW}]),
    ("get_shared_habit", [OTHER, HABIT], [{"id": HABIT, "current_streak": 2, "provisional": True, "calculated_at": NOW}]),
])
async def test_shared_adapter_preserves_atomic_streak_fields(monkeypatch, method, args, result):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == f"/rest/v1/rpc/{method}"
        assert json.loads(request.content) == ({"p_recipient": OTHER} | ({"p_habit": HABIT} if len(args) == 2 else {}))
        return httpx.Response(200, json=result)

    transport(monkeypatch, handler)
    assert await getattr(db(), method)(*args) == (result if method == "list_shared_habits" else result[0])
    assert len(calls) == 1
