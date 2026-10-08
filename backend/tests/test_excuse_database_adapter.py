import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from app.routers.excuses import ERRORS
from app.services.supabase import ExcuseError, OccurrenceError
from test_excuses import EID, EXCUSE, FRIEND, OID, OWNER
from test_friend_database_adapter import db, transport


OPERATIONS = [
    ("submit_occurrence_excuse", ["owner", "occurrence", "חולה 🌡️"],
     {"p_owner": "owner", "p_occurrence": "occurrence", "p_explanation": "חולה 🌡️"}),
    ("get_occurrence_excuse", ["actor", "occurrence"], {"p_actor": "actor", "p_occurrence": "occurrence"}),
    ("list_pending_excuses", ["actor"], {"p_actor": "actor"}),
    ("decide_occurrence_excuse", ["actor", "excuse", "approve"],
     {"p_actor": "actor", "p_excuse": "excuse", "p_decision": "approve"}),
    ("decide_occurrence_excuse", ["actor", "excuse", "reject"],
     {"p_actor": "actor", "p_excuse": "excuse", "p_decision": "reject"}),
]


@pytest.mark.parametrize("method,args,payload", OPERATIONS)
@pytest.mark.parametrize("rows", [[], [EXCUSE]])
async def test_atomic_rpc_payload_service_key_and_result(monkeypatch, method, args, payload, rows):
    def handler(request):
        assert request.method == "POST" and request.url.path == f"/rest/v1/rpc/{method}"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        assert json.loads(request.content) == payload
        return httpx.Response(200, json=rows)
    transport(monkeypatch, handler)
    expected = rows if method == "list_pending_excuses" else (rows[0] if rows else None)
    assert await getattr(db(), method)(*args) == expected


@pytest.mark.parametrize("method,args,payload", OPERATIONS)
@pytest.mark.parametrize("code", list(ERRORS))
@pytest.mark.parametrize("envelope", [False, True])
async def test_known_database_errors_and_committed_envelopes(monkeypatch, method, args, payload, code, envelope):
    transport(monkeypatch, lambda request: httpx.Response(200, json=[{"error": code}]) if envelope else
              httpx.Response(400, json={"code": "P0001", "message": code}))
    with pytest.raises(ExcuseError) as caught:
        await getattr(db(), method)(*args)
    assert caught.value.code == code


@pytest.mark.parametrize("method,args,payload", OPERATIONS)
@pytest.mark.parametrize("status,body", [
    (500, {"code": "P0001", "message": "profile_not_found"}),
    (400, {"code": "XX000", "message": "excuse_exists"}),
    (400, {"code": "P0001", "message": "unknown"}),
    (400, {"message": "excuse_already_decided"}), (400, []), (400, "not JSON"),
])
async def test_unknown_database_failures_propagate(monkeypatch, method, args, payload, status, body):
    transport(monkeypatch, lambda request: httpx.Response(status, text=body) if isinstance(body, str) else httpx.Response(status, json=body))
    with pytest.raises(httpx.HTTPStatusError):
        await getattr(db(), method)(*args)


async def test_normal_occurrence_adapter_maps_excuse_lock(monkeypatch):
    transport(monkeypatch, lambda request: httpx.Response(200, json=[{"error": "occurrence_locked"}]))
    with pytest.raises(OccurrenceError, match="occurrence_locked"):
        await db().mutate_occurrence(OWNER, OID, "progress", 0)


@pytest.mark.parametrize("method,path,body,rpc,payload,response_status", [
    ("POST", f"/occurrences/{OID}/excuse", {"explanation": "\u2003חולה 🌡️\n"}, "submit_occurrence_excuse",
     {"p_owner": OWNER, "p_occurrence": OID, "p_explanation": "חולה 🌡️"}, 201),
    ("GET", f"/occurrences/{OID}/excuse", None, "get_occurrence_excuse",
     {"p_actor": OWNER, "p_occurrence": OID}, 200),
    ("GET", "/excuses/pending", None, "list_pending_excuses", {"p_actor": OWNER}, 200),
    ("POST", f"/excuses/{EID}/decision", {"decision": "reject"}, "decide_occurrence_excuse",
     {"p_actor": OWNER, "p_excuse": EID, "p_decision": "reject"}, 200),
])
def test_api_through_real_adapter_uses_one_atomic_rpc(monkeypatch, method, path, body, rpc, payload, response_status):
    requests = []
    def handler(request):
        requests.append(request)
        assert request.method == "POST" and request.url.path == f"/rest/v1/rpc/{rpc}"
        assert json.loads(request.content) == payload
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        return httpx.Response(200, json=[EXCUSE])
    transport(monkeypatch, handler)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = db
    try:
        with TestClient(app) as client:
            response = client.request(method, path + f"?p_actor={FRIEND}&test_clock=1900-01-01", json=body)
            assert response.status_code == response_status
            row = response.json()[0] if rpc == "list_pending_excuses" else response.json()
            assert row["id"] == EID and row["occurrence"]["state"] == "justification_pending"
        assert len(requests) == 1
    finally:
        app.dependency_overrides.clear()
