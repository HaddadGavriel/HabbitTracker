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


@pytest.mark.parametrize("code", ["outgoing_request_exists", "incoming_request_exists", "friendship_exists", "recipient_not_found"])
async def test_adapter_maps_only_known_relationship_errors(monkeypatch, code):
    transport(monkeypatch, lambda request: httpx.Response(400, json={"code": "P0001", "message": code}))
    with pytest.raises(RelationshipConflict) as raised:
        await db().send_friend_request(str(UUID(int=1)), str(UUID(int=2)))
    assert raised.value.code == code


async def test_adapter_does_not_mislabel_unknown_error(monkeypatch):
    transport(monkeypatch, lambda request: httpx.Response(500, json={"message": "friendship-ish"}))
    with pytest.raises(httpx.HTTPStatusError):
        await db().send_friend_request(str(UUID(int=1)), str(UUID(int=2)))
