import json

import httpx
import pytest

from app.services.supabase import SharingError
from test_friend_database_adapter import db, transport


CASES = [
    ("grant_habit_share", ["owner", "habit", "friend"], {"p_owner": "owner", "p_habit": "habit", "p_recipient": "friend"}, [{"user_id": "friend"}], {"user_id": "friend"}),
    ("grant_habit_share", ["owner", "habit", "friend"], {"p_owner": "owner", "p_habit": "habit", "p_recipient": "friend"}, [], None),
    ("revoke_habit_share", ["owner", "habit", "friend"], {"p_owner": "owner", "p_habit": "habit", "p_recipient": "friend"}, True, True),
    ("revoke_habit_share", ["owner", "habit", "friend"], {"p_owner": "owner", "p_habit": "habit", "p_recipient": "friend"}, False, None),
    ("list_habit_shares", ["owner", "habit"], {"p_owner": "owner", "p_habit": "habit"}, [], []),
    ("list_habit_shares", ["owner", "habit"], {"p_owner": "owner", "p_habit": "habit"}, None, None),
    ("list_habit_shares", ["owner", "habit"], {"p_owner": "owner", "p_habit": "habit"}, [{"user_id": "friend"}], [{"user_id": "friend"}]),
    ("list_shared_habits", ["recipient"], {"p_recipient": "recipient"}, [], []),
    ("list_shared_habits", ["recipient"], {"p_recipient": "recipient"}, [{"id": "habit"}], [{"id": "habit"}]),
    ("get_shared_habit", ["recipient", "habit"], {"p_recipient": "recipient", "p_habit": "habit"}, [], None),
    ("get_shared_habit", ["recipient", "habit"], {"p_recipient": "recipient", "p_habit": "habit"}, [{"id": "habit"}], {"id": "habit"}),
]


@pytest.mark.parametrize("method,args,payload,result,expected", CASES)
async def test_atomic_rpc_payload_headers_and_results(monkeypatch, method, args, payload, result, expected):
    def handler(request):
        assert request.method == "POST" and request.url.path == f"/rest/v1/rpc/{method}"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        assert json.loads(request.content) == payload
        return httpx.Response(200, json=result) if result is not None else httpx.Response(200, content="null")
    transport(monkeypatch, handler)
    assert await getattr(db(), method)(*args) == expected


@pytest.mark.parametrize("method,args", [
    ("grant_habit_share", ["owner", "habit", "friend"]),
    ("revoke_habit_share", ["owner", "habit", "friend"]),
    ("list_habit_shares", ["owner", "habit"]),
    ("list_shared_habits", ["recipient"]),
    ("get_shared_habit", ["recipient", "habit"]),
])
@pytest.mark.parametrize("code", ["profile_not_found", "self_share", "friendship_required"])
async def test_domain_errors(monkeypatch, method, args, code):
    transport(monkeypatch, lambda r: httpx.Response(400, json={"code": "P0001", "message": code}))
    with pytest.raises(SharingError) as caught:
        await getattr(db(), method)(*args)
    assert caught.value.code == code


@pytest.mark.parametrize("status,payload", [
    (500, {"code": "P0001", "message": "profile_not_found"}),
    (400, {"code": "XX000", "message": "self_share"}),
    (400, {"code": "P0001", "message": "unknown"}),
    (400, {"message": "friendship_required"}), (400, []), (400, "invalid json"),
])
async def test_unknown_database_failures_propagate(monkeypatch, status, payload):
    transport(monkeypatch, lambda r: httpx.Response(status, text=payload) if isinstance(payload, str) else httpx.Response(status, json=payload))
    with pytest.raises(httpx.HTTPStatusError):
        await db().grant_habit_share("owner", "habit", "friend")
