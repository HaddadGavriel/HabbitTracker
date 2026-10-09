"""Reminder API orchestration; SQL tests exercise permission and lock races."""
import asyncio
from copy import deepcopy
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database, get_push_service
from app.main import app
from app.services.supabase import ReminderError


SENDER, OWNER, HABIT, OCCURRENCE, REMINDER, DEVICE, OTHER_DEVICE = [
    str(UUID(int=i)) for i in range(1, 8)
]
NOW = "2026-10-09T10:00:00Z"
RETRY_AT = "2026-10-09T11:00:00Z"
KEY = "mobile-request.1:retry_safe"
PATH = f"/shared-habits/{HABIT}/reminders"
HEADERS = {"Idempotency-Key": KEY}
TOKEN = "ExponentPushToken[private-device-token]"
DEVICES = [{"id": DEVICE, "expo_push_token": TOKEN, "updated_at": NOW}]
NOTIFICATION = {
    "title": "Habit reminder",
    "body": "A friend reminded you about Read.",
    "data": {"type": "habit_reminder", "habit_id": HABIT, "occurrence_id": OCCURRENCE},
}
SUMMARY = {
    "id": REMINDER, "habit_id": HABIT, "occurrence_id": OCCURRENCE,
    "status": "reserved", "reserved_at": NOW, "finished_at": None,
    "retry_at": RETRY_AT, "device_count": 1, "accepted_count": 0,
    "failed_count": 0, "unknown_count": 0,
}
ACCEPTED = SUMMARY | {"status": "provider_accepted", "finished_at": NOW, "accepted_count": 1}
OUTCOMES = [{"device_id": DEVICE, "status": "accepted", "ticket_id": "ticket-1"}]


class ReminderDatabase:
    def __init__(self):
        self.calls = []
        self.reservation = {"dispatch": True, "result": deepcopy(SUMMARY),
                            "devices": deepcopy(DEVICES), "notification": deepcopy(NOTIFICATION)}
        self.finished = deepcopy(ACCEPTED)

    async def reserve_habit_reminder(self, sender, habit, key):
        self.calls.append(("reserve", sender, habit, key))
        return deepcopy(self.reservation)

    async def finish_habit_reminder(self, sender, reminder, results):
        self.calls.append(("finish", sender, reminder, deepcopy(results)))
        return deepcopy(self.finished)


class Push:
    def __init__(self):
        self.calls = []
        self.results = deepcopy(OUTCOMES)

    async def send_reminder(self, devices, notification):
        self.calls.append((deepcopy(devices), deepcopy(notification)))
        return deepcopy(self.results)


@pytest.fixture(autouse=True)
def clear_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def configured():
    database, push = ReminderDatabase(), Push()
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=SENDER)
    app.dependency_overrides[get_database] = lambda: database
    app.dependency_overrides[get_push_service] = lambda: push
    return database, push


@pytest.mark.parametrize("token", [None, "expired-token"])
def test_reminders_require_valid_authentication(monkeypatch, token):
    database, push = ReminderDatabase(), Push()
    app.dependency_overrides[get_database] = lambda: database
    app.dependency_overrides[get_push_service] = lambda: push
    original = httpx.AsyncClient

    def reject(request):
        assert request.url.path == "/auth/v1/user"
        assert request.headers["authorization"] == "Bearer expired-token"
        assert request.headers["apikey"] == "sb_publishable_test"
        return httpx.Response(401, json={"message": "expired"})

    monkeypatch.setattr("app.auth.httpx.AsyncClient", lambda *a, **kw: original(transport=httpx.MockTransport(reject)))
    headers = HEADERS | ({"Authorization": f"Bearer {token}"} if token else {})
    with TestClient(app) as client:
        assert client.post(PATH, headers=headers).status_code == 401
    assert database.calls == [] and push.calls == []


@pytest.mark.parametrize("key", [None, "", "has space", "a/b", "a?b", "a" * 129])
def test_idempotency_key_is_required_and_bounded(configured, key):
    database, push = configured
    with TestClient(app) as client:
        assert client.post(PATH, headers={} if key is None else {"Idempotency-Key": key}).status_code == 422
    assert database.calls == [] and push.calls == []


@pytest.mark.parametrize("body", [
    {"recipient_id": OWNER}, {"owner_id": OWNER}, {"sender_id": OWNER}, {"user_id": OWNER},
    {"expo_push_token": TOKEN}, {"notification": NOTIFICATION}, {"text": "Caller text"},
    {"occurrence_id": OCCURRENCE}, {"test_clock": NOW}, [], "unexpected",
])
def test_caller_cannot_supply_recipient_token_text_or_clock(configured, body):
    database, push = configured
    with TestClient(app) as client:
        assert client.post(PATH, headers=HEADERS, json=body).status_code == 422
    assert database.calls == [] and push.calls == []


def test_habit_id_must_be_a_uuid_before_reserving(configured):
    database, push = configured
    with TestClient(app) as client:
        assert client.post("/shared-habits/not-a-uuid/reminders", headers=HEADERS).status_code == 422
    assert database.calls == [] and push.calls == []


@pytest.mark.parametrize("body", [None, {}])
@pytest.mark.parametrize("key", [KEY, "x", "x" * 128])
def test_authenticated_actor_and_reserved_server_notification_are_used(configured, body, key):
    database, push = configured
    with TestClient(app) as client:
        response = client.post(PATH, json=body,
            headers={"Idempotency-Key": key, "X-User-Id": OWNER, "X-Recipient-Id": SENDER},
            params={"p_sender": OWNER, "recipient_id": SENDER, "token": "forged", "test_clock": "1900-01-01"})
    assert response.status_code == 200 and response.json() == ACCEPTED
    assert database.calls == [("reserve", SENDER, HABIT, key), ("finish", SENDER, REMINDER, OUTCOMES)]
    assert push.calls == [(DEVICES, NOTIFICATION)]
    assert "received" not in response.text and TOKEN not in response.text and "ticket-1" not in response.text


@pytest.mark.parametrize("summary,status", [
    (SUMMARY, 202), (ACCEPTED, 200),
    (SUMMARY | {"status": "no_devices", "device_count": 0, "finished_at": NOW}, 200),
    (SUMMARY | {"status": "failed", "failed_count": 1, "finished_at": NOW}, 200),
    (SUMMARY | {"status": "unknown", "unknown_count": 1, "finished_at": NOW}, 200),
    (SUMMARY | {"status": "partially_accepted", "device_count": 2, "accepted_count": 1,
                "unknown_count": 1, "finished_at": NOW}, 200),
])
def test_replays_and_no_devices_never_send_or_finalize_again(configured, summary, status):
    database, push = configured
    # A replay does not need the private dispatch envelope at all.
    database.reservation = {"dispatch": False, "result": summary}
    with TestClient(app) as client:
        for _ in range(2):
            response = client.post(PATH, headers=HEADERS)
            assert response.status_code == status and response.json() == summary
    assert database.calls == [("reserve", SENDER, HABIT, KEY)] * 2
    assert push.calls == []


def test_inaccessible_and_missing_habit_reservation_never_sends(configured):
    database, push = configured
    database.reservation = None
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "habit_not_found", "message": "Habit not found"}}
    assert push.calls == [] and len(database.calls) == 1


@pytest.mark.parametrize("code,status", [
    ("profile_not_found", 404), ("reminder_not_eligible", 409),
    ("reminder_cooldown", 429), ("invalid_idempotency_key", 422),
])
def test_database_rejections_do_not_dispatch(configured, monkeypatch, code, status):
    database, push = configured

    async def reject(*args):
        raise ReminderError(code, retry_at=RETRY_AT if code == "reminder_cooldown" else None)

    monkeypatch.setattr(database, "reserve_habit_reminder", reject)
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
    assert response.status_code == status and response.json()["detail"]["code"] == code
    if code == "reminder_cooldown":
        assert response.json()["detail"]["retry_at"] == RETRY_AT
    assert push.calls == [] and database.calls == []


@pytest.mark.parametrize("dispatch", [False, True])
def test_response_projection_does_not_leak_dispatch_details_or_credentials(configured, dispatch):
    database, push = configured
    private = {"devices": DEVICES, "notification": NOTIFICATION, "recipient_id": OWNER,
               "expo_push_token": TOKEN, "secret": "sb_secret_do-not-leak", "ticket_id": "private-ticket"}
    database.reservation["dispatch"] = dispatch
    database.reservation["result"].update(private)
    database.finished.update(private)
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
    assert response.status_code == (200 if dispatch else 202)
    assert set(response.json()) == set(SUMMARY)
    for secret in [TOKEN, "sb_secret_do-not-leak", "private-ticket", NOTIFICATION["body"]]:
        assert secret not in response.text


@pytest.mark.parametrize("results,summary", [
    ([{"device_id": DEVICE, "status": "rejected", "ticket_id": None}],
     SUMMARY | {"status": "failed", "failed_count": 1, "finished_at": NOW}),
    ([{"device_id": DEVICE, "status": "invalid_token", "ticket_id": None}],
     SUMMARY | {"status": "failed", "failed_count": 1, "finished_at": NOW}),
    ([{"device_id": DEVICE, "status": "unknown", "ticket_id": None}],
     SUMMARY | {"status": "unknown", "unknown_count": 1, "finished_at": NOW}),
    (OUTCOMES + [{"device_id": OTHER_DEVICE, "status": "unknown", "ticket_id": None}],
     SUMMARY | {"status": "partially_accepted", "device_count": 2, "accepted_count": 1,
                "unknown_count": 1, "finished_at": NOW}),
])
def test_provider_failures_and_partial_acceptance_are_persisted(configured, results, summary):
    database, push = configured
    if len(results) == 2:
        database.reservation["devices"].append({"id": OTHER_DEVICE,
            "expo_push_token": "ExpoPushToken[other-private]", "updated_at": NOW})
    push.results, database.finished = results, summary
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
        assert response.status_code == 200 and response.json() == summary
        database.reservation = {"dispatch": False, "result": summary}
        assert client.post(PATH, headers=HEADERS).json() == summary
    assert database.calls[1] == ("finish", SENDER, REMINDER, results)
    assert len(push.calls) == 1


@pytest.mark.parametrize("exception", [httpx.ReadTimeout("Expo token secret"), RuntimeError("sb_secret_private")])
def test_unexpected_push_exception_is_unknown_and_never_retried(configured, monkeypatch, exception):
    database, push = configured
    calls = []

    async def failed(devices, notification):
        calls.append((devices, notification))
        raise exception

    monkeypatch.setattr(push, "send_reminder", failed)
    database.finished = SUMMARY | {"status": "unknown", "unknown_count": 1, "finished_at": NOW}
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
        assert response.status_code == 200 and response.json() == database.finished
        database.reservation = {"dispatch": False, "result": database.finished}
        assert client.post(PATH, headers=HEADERS).status_code == 200
    assert database.calls[1] == ("finish", SENDER, REMINDER,
                                [{"device_id": DEVICE, "status": "unknown", "ticket_id": None}])
    assert len(calls) == 1 and str(exception) not in response.text


@pytest.mark.parametrize("stage,code", [("reserve", "reminder_unavailable"), ("finish", "reminder_outcome_unavailable")])
@pytest.mark.parametrize("exception_kind", ["transport", "database"])
def test_database_failure_never_retries_push_and_has_safe_response(configured, monkeypatch, stage, code, exception_kind):
    database, push = configured
    calls = []

    async def failed(*args):
        calls.append(args)
        if exception_kind == "transport":
            raise httpx.ReadTimeout("private database credentials")
        request = httpx.Request("POST", "https://example.supabase.co/rest/v1/rpc/private")
        response = httpx.Response(503, text="private database credentials", request=request)
        raise httpx.HTTPStatusError("private database credentials", request=request, response=response)

    monkeypatch.setattr(database, f"{stage}_habit_reminder", failed)
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
    assert response.status_code == 503 and response.json()["detail"]["code"] == code
    if stage == "finish":
        assert response.json()["detail"]["reminder_id"] == REMINDER
    assert "private database credentials" not in response.text
    assert len(calls) == 1 and len(push.calls) == (1 if stage == "finish" else 0)


def test_invalid_provider_result_persistence_is_internal_failure(configured, monkeypatch):
    database, push = configured

    async def failed(*args):
        raise ReminderError("invalid_reminder_results")

    monkeypatch.setattr(database, "finish_habit_reminder", failed)
    with TestClient(app) as client:
        response = client.post(PATH, headers=HEADERS)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "reminder_outcome_unavailable"
    assert response.json()["detail"]["reminder_id"] == REMINDER
    assert len(push.calls) == 1


async def test_retry_while_first_external_request_is_running_returns_reserved_without_dispatch(configured, monkeypatch):
    database, push = configured
    started, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def blocked(devices, notification):
        calls.append((devices, notification))
        # Model the committed reservation returned by the real database to retries.
        database.reservation = {"dispatch": False, "result": SUMMARY}
        started.set()
        await release.wait()
        return deepcopy(OUTCOMES)

    monkeypatch.setattr(push, "send_reminder", blocked)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        first = asyncio.create_task(client.post(PATH, headers=HEADERS))
        await asyncio.wait_for(started.wait(), timeout=3)
        try:
            retry = await asyncio.wait_for(client.post(PATH, headers=HEADERS), timeout=3)
            assert retry.status_code == 202 and retry.json() == SUMMARY
        finally:
            release.set()
        response = await asyncio.wait_for(first, timeout=3)
    assert response.status_code == 200 and response.json() == ACCEPTED
    assert len(calls) == 1
    assert [call[0] for call in database.calls] == ["reserve", "reserve", "finish"]
