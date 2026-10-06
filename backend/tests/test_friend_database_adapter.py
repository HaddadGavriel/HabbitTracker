import json
from uuid import UUID

import httpx
import pytest

from app.config import Settings
from app.services.supabase import RelationshipConflict, SupabaseDatabase


def db():
    return SupabaseDatabase(Settings(supabase_url="https://example.supabase.co", supabase_publishable_key="sb_publishable_test", supabase_secret_key="sb_secret_test"))


def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr("app.services.supabase.httpx.AsyncClient", lambda *a, **kw: original(transport=httpx.MockTransport(handler)))


async def test_adapter_rpc_payload_headers_and_result(monkeypatch):
    actor, recipient = str(UUID(int=1)), str(UUID(int=2))
    def handler(request):
        assert request.url.path == "/rest/v1/rpc/send_friend_request"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        assert json.loads(request.content) == {"p_requester": actor, "p_recipient": recipient}
        return httpx.Response(200, json=[{"id": str(UUID(int=3))}])
    transport(monkeypatch, handler)
    assert (await db().send_friend_request(actor, recipient))["id"] == str(UUID(int=3))


@pytest.mark.parametrize("code", ["outgoing_request_exists", "incoming_request_exists", "friendship_exists", "recipient_not_found", "profile_not_found", "self_request"])
async def test_adapter_maps_only_known_relationship_errors(monkeypatch, code):
    transport(monkeypatch, lambda request: httpx.Response(400, json={"code": "P0001", "message": code}))
    with pytest.raises(RelationshipConflict) as raised:
        await db().send_friend_request(str(UUID(int=1)), str(UUID(int=2)))
    assert raised.value.code == code


async def test_adapter_does_not_mislabel_unknown_error(monkeypatch):
    transport(monkeypatch, lambda request: httpx.Response(500, json={"message": "friendship-ish"}))
    with pytest.raises(httpx.HTTPStatusError):
        await db().send_friend_request(str(UUID(int=1)), str(UUID(int=2)))


@pytest.mark.parametrize("status,payload", [
    (400, {"code": "42501", "message": "friendship_exists"}),
    (500, {"code": "P0001", "message": "incoming_request_exists"}),
    (400, {"message": "recipient_not_found"}),
    (400, {"code": "P0001", "message": ["outgoing_request_exists"]}),
    (400, []),
    (400, None),
])
async def test_adapter_does_not_classify_unrelated_or_malformed_errors(monkeypatch, status, payload):
    transport(monkeypatch, lambda request: httpx.Response(status, json=payload))
    with pytest.raises(httpx.HTTPStatusError):
        await db().send_friend_request(str(UUID(int=1)), str(UUID(int=2)))


async def test_adapter_preserves_non_json_errors(monkeypatch):
    transport(monkeypatch, lambda request: httpx.Response(502, text="Bad gateway"))
    with pytest.raises(httpx.HTTPStatusError):
        await db().send_friend_request(str(UUID(int=1)), str(UUID(int=2)))


ACTOR, OTHER, REQUEST = [str(UUID(int=i)) for i in range(1, 4)]


@pytest.mark.parametrize("method,args,function,body,result,expected", [
    ("list_friend_requests", (ACTOR,), "list_friend_requests", {"p_user": ACTOR}, [], []),
    ("list_friend_requests", (ACTOR,), "list_friend_requests", {"p_user": ACTOR}, [{"id": REQUEST}], [{"id": REQUEST}]),
    ("accept_friend_request", (REQUEST, ACTOR), "accept_friend_request", {"p_request": REQUEST, "p_actor": ACTOR}, [], None),
    ("accept_friend_request", (REQUEST, ACTOR), "accept_friend_request", {"p_request": REQUEST, "p_actor": ACTOR}, [{"id": REQUEST}], {"id": REQUEST}),
    ("reject_friend_request", (REQUEST, ACTOR), "reject_friend_request", {"p_request": REQUEST, "p_actor": ACTOR}, False, False),
    ("reject_friend_request", (REQUEST, ACTOR), "reject_friend_request", {"p_request": REQUEST, "p_actor": ACTOR}, True, True),
    ("list_friends", (ACTOR,), "list_friends", {"p_user": ACTOR}, [], []),
    ("list_friends", (ACTOR,), "list_friends", {"p_user": ACTOR}, [{"id": REQUEST}], [{"id": REQUEST}]),
    ("remove_friend", (ACTOR, OTHER), "remove_friend", {"p_actor": ACTOR, "p_friend": OTHER}, False, False),
    ("remove_friend", (ACTOR, OTHER), "remove_friend", {"p_actor": ACTOR, "p_friend": OTHER}, True, True),
])
async def test_all_rpc_payloads_and_empty_or_success_results(monkeypatch, method, args, function, body, result, expected):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST"
        assert request.url.path == f"/rest/v1/rpc/{function}"
        assert request.headers["apikey"] == "sb_secret_test"
        assert "authorization" not in request.headers
        assert json.loads(request.content) == body
        return httpx.Response(200, json=result)

    transport(monkeypatch, handler)
    assert await getattr(db(), method)(*args) == expected
    assert len(calls) == 1  # No read-then-unconditional-write authorization.


@pytest.mark.parametrize("method,args", [
    ("list_friend_requests", (ACTOR,)),
    ("accept_friend_request", (REQUEST, ACTOR)),
    ("reject_friend_request", (REQUEST, ACTOR)),
    ("list_friends", (ACTOR,)),
    ("remove_friend", (ACTOR, OTHER)),
])
async def test_rpc_failures_are_not_empty_successes(monkeypatch, method, args):
    transport(monkeypatch, lambda request: httpx.Response(503, json={"message": "unavailable"}))
    with pytest.raises(httpx.HTTPStatusError):
        await getattr(db(), method)(*args)
