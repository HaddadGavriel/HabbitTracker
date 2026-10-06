import json

import httpx
import pytest

from app.services.supabase import HabitError
from test_friend_database_adapter import db, transport


CASES = [
    ("create_habit", ["owner", {"name": "Read"}], "create_habit", {"p_owner": "owner", "p_config": {"name": "Read"}}, False),
    ("list_habits", ["owner", "archived"], "list_habits", {"p_owner": "owner", "p_status": "archived"}, True),
    ("get_habit", ["owner", "habit"], "get_habit", {"p_owner": "owner", "p_habit": "habit"}, False),
    ("update_habit", ["owner", "habit", {"description": None}], "update_habit", {"p_owner": "owner", "p_habit": "habit", "p_changes": {"description": None}}, False),
    ("set_habit_archived", ["owner", "habit", True], "archive_habit", {"p_owner": "owner", "p_habit": "habit"}, False),
    ("set_habit_archived", ["owner", "habit", False], "restore_habit", {"p_owner": "owner", "p_habit": "habit"}, False),
]


@pytest.mark.parametrize("method,args,function,payload,many", CASES)
@pytest.mark.parametrize("rows", [[], [{"id": "habit"}]])
async def test_rpc_owner_payload_headers_and_results(monkeypatch, method, args, function, payload, many, rows):
    def handler(request):
        assert request.method == "POST" and request.url.path == f"/rest/v1/rpc/{function}"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        assert json.loads(request.content) == payload
        return httpx.Response(200, json=rows)
    transport(monkeypatch, handler)
    assert await getattr(db(), method)(*args) == (rows if many else (rows[0] if rows else None))


@pytest.mark.parametrize("method,args,function,payload,many", CASES)
@pytest.mark.parametrize("code", ["profile_not_found", "habit_archived", "invalid_habit_configuration"])
async def test_rpc_known_errors(monkeypatch, method, args, function, payload, many, code):
    transport(monkeypatch, lambda r: httpx.Response(400, json={"code": "P0001", "message": code}))
    with pytest.raises(HabitError) as caught:
        await getattr(db(), method)(*args)
    assert caught.value.code == code


@pytest.mark.parametrize("status,payload", [(500, {"code": "XX000", "message": "habit_archived"}),
    (400, {"code": "P0001", "message": "unknown"}), (400, []), (400, {"message": "profile_not_found"}), (400, "invalid json")])
async def test_unknown_errors_propagate(monkeypatch, status, payload):
    transport(monkeypatch, lambda r: httpx.Response(status, text=payload) if isinstance(payload, str) else httpx.Response(status, json=payload))
    with pytest.raises(httpx.HTTPStatusError):
        await db().update_habit("owner", "habit", {"name": "New"})
