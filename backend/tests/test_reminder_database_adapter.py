"""Mocked HTTP tests for reminder RPCs and atomic device reassignment."""
from datetime import datetime, timezone
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database, get_push_service
from app.main import app
from app.services.supabase import ReminderError
from test_friend_database_adapter import db, transport
from test_reminders import (
    ACCEPTED, DEVICES, HABIT, HEADERS, KEY, NOTIFICATION, NOW, OUTCOMES,
    OWNER, PATH, Push, REMINDER, RETRY_AT, SENDER, SUMMARY, TOKEN,
)


RESERVATION = {"dispatch": True, "result": SUMMARY, "devices": DEVICES, "notification": NOTIFICATION}
OPERATIONS = [
    ("reserve_habit_reminder", (SENDER, HABIT, KEY),
     {"p_sender": SENDER, "p_habit": HABIT, "p_key": KEY}, RESERVATION),
    ("finish_habit_reminder", (SENDER, REMINDER, OUTCOMES),
     {"p_sender": SENDER, "p_reminder": REMINDER, "p_results": OUTCOMES}, ACCEPTED),
]


@pytest.fixture(autouse=True)
def clear_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


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


@pytest.mark.parametrize("method,args,payload,result", OPERATIONS)
@pytest.mark.parametrize("code", [
    "profile_not_found", "invalid_idempotency_key", "reminder_not_eligible", "reminder_cooldown", "invalid_reminder_results",
])
@pytest.mark.parametrize("committed", [False, True])
async def test_only_known_database_errors_and_committed_envelopes_are_mapped(monkeypatch, method, args, payload, result, code, committed):
    retry_at = RETRY_AT if committed and code == "reminder_cooldown" else None
    response = httpx.Response(200, json=[{"error": code, "retry_at": retry_at}]) if committed else (
        httpx.Response(400, json={"code": "P0001", "message": code}))
    transport(monkeypatch, lambda request: response)
    with pytest.raises(ReminderError) as caught:
        await getattr(db(), method)(*args)
    assert caught.value.code == code and caught.value.retry_at == retry_at


@pytest.mark.parametrize("method,args,payload,result", OPERATIONS)
@pytest.mark.parametrize("status,body", [
    (500, {"code": "P0001", "message": "profile_not_found"}),
    (400, {"code": "42501", "message": "reminder_not_eligible"}),
    (400, {"code": "P0001", "message": "unknown"}),
    (400, {"code": "P0001", "message": ["reminder_cooldown"]}),
    (400, {"message": "invalid_idempotency_key"}), (400, []), (400, None), (502, "Bad gateway"),
])
async def test_unknown_database_failures_are_not_empty_successes(monkeypatch, method, args, payload, result, status, body):
    transport(monkeypatch, lambda request: httpx.Response(status, text=body) if isinstance(body, str)
              else httpx.Response(status, json=body))
    with pytest.raises(httpx.HTTPStatusError):
        await getattr(db(), method)(*args)


@pytest.mark.parametrize("method,args,payload,result", OPERATIONS)
async def test_transport_failure_is_not_retried_by_adapter(monkeypatch, method, args, payload, result):
    calls = []

    def unavailable(request):
        calls.append(request)
        raise httpx.ReadTimeout("unavailable", request=request)

    transport(monkeypatch, unavailable)
    with pytest.raises(httpx.ReadTimeout):
        await getattr(db(), method)(*args)
    assert len(calls) == 1


@pytest.mark.parametrize("summary", [SUMMARY, ACCEPTED,
    SUMMARY | {"status": "no_devices", "device_count": 0, "finished_at": NOW}])
async def test_replay_preserves_dispatch_false_and_has_no_private_fields(monkeypatch, summary):
    replay = {"dispatch": False, "result": summary}
    transport(monkeypatch, lambda request: httpx.Response(200, json=[replay]))
    assert await db().reserve_habit_reminder(SENDER, HABIT, KEY) == replay


def test_api_through_real_adapter_reserves_before_external_send_and_finalizes_once(monkeypatch):
    events = []

    def handler(request):
        assert request.method == "POST"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        function = request.url.path.rsplit("/", 1)[-1]
        events.append(function)
        if function == "reserve_habit_reminder":
            assert json.loads(request.content) == {"p_sender": SENDER, "p_habit": HABIT, "p_key": KEY}
            return httpx.Response(200, json=[RESERVATION])
        assert function == "finish_habit_reminder"
        assert json.loads(request.content) == {"p_sender": SENDER, "p_reminder": REMINDER, "p_results": OUTCOMES}
        return httpx.Response(200, json=[ACCEPTED])

    class OrderedPush(Push):
        async def send_reminder(self, devices, notification):
            events.append("external_send")
            return await super().send_reminder(devices, notification)

    push = OrderedPush()
    transport(monkeypatch, handler)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=SENDER)
    app.dependency_overrides[get_database] = db
    app.dependency_overrides[get_push_service] = lambda: push
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS | {"X-User-Id": OWNER}, json={},
            params={"sender_id": OWNER, "recipient_id": SENDER, "test_clock": "1900-01-01"})
    assert response.status_code == 200 and response.json() == ACCEPTED
    assert push.calls == [(DEVICES, NOTIFICATION)]
    assert events == ["reserve_habit_reminder", "external_send", "finish_habit_reminder"]


@pytest.mark.parametrize("body,http_status,response_status,code", [
    ([], 200, 404, "habit_not_found"),
    ({"code": "P0001", "message": "profile_not_found"}, 400, 404, "profile_not_found"),
    ([{"error": "reminder_not_eligible"}], 200, 409, "reminder_not_eligible"),
    ([{"error": "reminder_cooldown", "retry_at": RETRY_AT}], 200, 429, "reminder_cooldown"),
])
def test_api_maps_atomic_database_rejections_without_push(monkeypatch, body, http_status, response_status, code):
    push = Push()
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == "/rest/v1/rpc/reserve_habit_reminder"
        return httpx.Response(http_status, json=body)

    transport(monkeypatch, handler)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=SENDER)
    app.dependency_overrides[get_database] = db
    app.dependency_overrides[get_push_service] = lambda: push
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
    assert response.status_code == response_status and response.json()["detail"]["code"] == code
    if code == "reminder_cooldown":
        assert response.json()["detail"]["retry_at"] == RETRY_AT
    assert len(calls) == 1 and push.calls == []


@pytest.mark.parametrize("platform", ["android", "ios"])
async def test_device_registration_uses_atomic_reassignment_rpc_and_database_timestamp(monkeypatch, platform):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST" and request.url.path == "/rest/v1/rpc/register_device"
        assert request.headers["apikey"] == "sb_secret_test" and "authorization" not in request.headers
        assert json.loads(request.content) == {"p_user": OWNER, "p_token": TOKEN, "p_platform": platform}
        return httpx.Response(200, json=NOW)

    transport(monkeypatch, handler)
    assert await db().register_device(OWNER, TOKEN, platform) == datetime(2026, 10, 9, 10, tzinfo=timezone.utc)
    assert len(calls) == 1


def test_registration_still_works_before_profile_and_derives_account_from_authentication(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        # No profile requirement or client timestamp is introduced.
        assert request.url.path == "/rest/v1/rpc/register_device"
        assert json.loads(request.content) == {"p_user": SENDER, "p_token": TOKEN, "p_platform": "android"}
        return httpx.Response(200, json=NOW)

    transport(monkeypatch, handler)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=SENDER)
    app.dependency_overrides[get_database] = db
    with TestClient(app) as client:
        response = client.post("/devices/register", json={"expo_push_token": TOKEN, "platform": "android", "user_id": OWNER},
            headers={"X-User-Id": OWNER}, params={"p_user": OWNER})
    assert response.status_code == 200
    assert response.json() == {"registered": True, "platform": "android", "updated_at": NOW}
    assert len(calls) == 1


@pytest.mark.parametrize("token", [
    "", "plain-token", "ExponentPushToken[]", "ExpoPushToken[has space]", "ExpoPushToken[abc]extra",
    " ExpoPushToken[abc]", "ExpoPushToken[abc]\n", "ExpoPushToken[א]", "ExpoPushToken[" + "x" * 244 + "]",
])
def test_device_registration_rejects_invalid_tokens_without_database_access(monkeypatch, token):
    calls = []

    def handler(request):
        calls.append(request)
        raise AssertionError("Invalid registration must not access the database")

    transport(monkeypatch, handler)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=SENDER)
    app.dependency_overrides[get_database] = db
    with TestClient(app) as client:
        response = client.post("/devices/register", json={"expo_push_token": token, "platform": "android"})
    assert response.status_code == 422 and calls == []


@pytest.mark.parametrize("status,body", [(400, {"code": "P0001", "message": "invalid_device_registration"}),
                                        (500, {"message": "database unavailable"})])
async def test_device_registration_database_failures_are_not_success(monkeypatch, status, body):
    transport(monkeypatch, lambda request: httpx.Response(status, json=body))
    with pytest.raises(httpx.HTTPStatusError):
        await db().register_device(OWNER, TOKEN, "android")
