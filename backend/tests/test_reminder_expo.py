import json

import httpx
import pytest

from app.services.expo import ExpoPushService


PUSH_URL = "https://exp.host/--/api/v2/push/send"
NOTIFICATION = {
    "title": "Habit reminder",
    "body": "A friend reminded you about your habit.",
    "data": {"type": "habit_reminder", "habit_id": "habit-1", "occurrence_id": "occurrence-1"},
}


def device(index=1, token=None):
    return {
        "id": f"device-{index}",
        "expo_push_token": token if token is not None else f"ExpoPushToken[token_{index}]",
        "updated_at": "2026-10-09T00:00:00Z",
    }


def install_transport(monkeypatch, handler):
    original = httpx.AsyncClient

    def client(*args, **kwargs):
        assert kwargs["timeout"] == 15
        return original(*args, **kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr("app.services.expo.httpx.AsyncClient", client)


async def test_reminder_posts_server_notification_and_safe_device_results(monkeypatch):
    devices = [device(1, "ExponentPushToken[abc-DEF_123]"), device(2)]

    def handler(request):
        assert request.method == "POST"
        assert str(request.url) == PUSH_URL
        assert request.headers["accept"] == "application/json"
        assert request.headers["accept-encoding"] == "gzip, deflate"
        assert json.loads(request.content) == [
            {"to": item["expo_push_token"], "sound": "default", **NOTIFICATION}
            for item in devices
        ]
        return httpx.Response(200, json={"data": [
            {"status": "ok", "id": "ticket-1"}, {"status": "ok", "id": "ticket-2"},
        ]})

    install_transport(monkeypatch, handler)
    assert await ExpoPushService(PUSH_URL).send_reminder(devices, NOTIFICATION) == [
        {"device_id": "device-1", "status": "accepted", "ticket_id": "ticket-1"},
        {"device_id": "device-2", "status": "accepted", "ticket_id": "ticket-2"},
    ]


@pytest.mark.parametrize("token", [
    "", "plain-token", "ExpoPushToken[]", "expopushToken[value]",
    "ExpoPushToken[value with spaces]", "ExpoPushToken[value.]",
    "ExpoPushToken[value]\n", " ExpoPushToken[value]", "ExpoPushToken[value]tail",
    "ExpoPushToken[é]", "ExpoPushToken[" + "a" * 242 + "]",
    None, 123, [], {},
])
async def test_invalid_local_tokens_do_not_make_http_requests(monkeypatch, token):
    def unexpected_client(*args, **kwargs):
        pytest.fail("Invalid tokens must be rejected before creating an HTTP client")

    monkeypatch.setattr("app.services.expo.httpx.AsyncClient", unexpected_client)
    item = device()
    item["expo_push_token"] = token
    assert await ExpoPushService(PUSH_URL).send_reminder([item], NOTIFICATION) == [
        {"device_id": "device-1", "status": "invalid_token", "ticket_id": None},
    ]


async def test_empty_devices_do_not_make_http_requests(monkeypatch):
    def unexpected_client(*args, **kwargs):
        pytest.fail("No devices must not make an HTTP request")

    monkeypatch.setattr("app.services.expo.httpx.AsyncClient", unexpected_client)
    assert await ExpoPushService(PUSH_URL).send_reminder([], NOTIFICATION) == []


async def test_maximum_length_token_is_valid(monkeypatch):
    token = "ExpoPushToken[" + "a" * 241 + "]"
    assert len(token) == 256

    def handler(request):
        assert json.loads(request.content)[0]["to"] == token
        return httpx.Response(200, json={"data": [{"status": "ok", "id": "ticket"}]})

    install_transport(monkeypatch, handler)
    result = await ExpoPushService(PUSH_URL).send_reminder([device(token=token)], NOTIFICATION)
    assert result[0]["status"] == "accepted"


async def test_partial_success_and_local_invalid_tokens_keep_device_order_without_leaks(monkeypatch):
    sensitive = "ExpoPushToken[secret] provider diagnostic credentials=secret"
    devices = [device(1), device(2, "invalid"), device(3), device(4), device(5)]

    def handler(request):
        assert [item["to"] for item in json.loads(request.content)] == [
            devices[index]["expo_push_token"] for index in [0, 2, 3, 4]
        ]
        return httpx.Response(200, json={"data": [
            {"status": "ok", "id": "accepted-ticket", "message": sensitive},
            {"status": "error", "message": sensitive, "details": {"error": "DeviceNotRegistered"}},
            {"status": "error", "message": sensitive, "details": {"error": "MessageRateExceeded"}},
            {"status": "error", "message": sensitive, "details": {"error": "UnexpectedProviderError"}},
        ]})

    install_transport(monkeypatch, handler)
    result = await ExpoPushService(PUSH_URL).send_reminder(devices, NOTIFICATION)
    assert result == [
        {"device_id": "device-1", "status": "accepted", "ticket_id": "accepted-ticket"},
        {"device_id": "device-2", "status": "invalid_token", "ticket_id": None},
        {"device_id": "device-3", "status": "invalid_token", "ticket_id": None},
        {"device_id": "device-4", "status": "rejected", "ticket_id": None},
        {"device_id": "device-5", "status": "unknown", "ticket_id": None},
    ]
    assert sensitive not in json.dumps(result)
    assert "ExpoPushToken" not in json.dumps(result)


@pytest.mark.parametrize("error", ["MessageTooBig", "MessageRateExceeded", "MismatchSenderId", "InvalidCredentials"])
async def test_known_ticket_errors_are_rejected(monkeypatch, error):
    install_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": [
        {"status": "error", "details": {"error": error}, "message": "private provider error"},
    ]}))
    assert await ExpoPushService(PUSH_URL).send_reminder([device()], NOTIFICATION) == [
        {"device_id": "device-1", "status": "rejected", "ticket_id": None},
    ]


@pytest.mark.parametrize("ticket", [
    None, [], "ok", {}, {"status": "ok"}, {"status": "ok", "id": None},
    {"status": "ok", "id": ""}, {"status": "ok", "id": " \t"},
    {"status": "ok", "id": 123}, {"status": "ok", "id": "x" * 257},
    {"status": "error", "id": "do-not-expose"},
    {"status": "error", "details": []}, {"status": "error", "details": {"error": []}},
    {"status": "error", "details": {"error": "new-unknown-error"}},
    {"status": "unexpected", "id": "do-not-expose"},
])
async def test_malformed_or_unrecognized_ticket_does_not_infer_success(monkeypatch, ticket):
    install_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": [ticket]}))
    assert await ExpoPushService(PUSH_URL).send_reminder([device()], NOTIFICATION) == [
        {"device_id": "device-1", "status": "unknown", "ticket_id": None},
    ]


async def test_ticket_at_persistence_length_limit_is_accepted(monkeypatch):
    ticket_id = "x" * 256
    install_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": [
        {"status": "ok", "id": ticket_id},
    ]}))
    assert await ExpoPushService(PUSH_URL).send_reminder([device()], NOTIFICATION) == [
        {"device_id": "device-1", "status": "accepted", "ticket_id": ticket_id},
    ]


@pytest.mark.parametrize("envelope", [
    None, [], "private provider error", {}, {"errors": [{"message": "private provider error"}]},
    {"data": None}, {"data": {}}, {"data": {"status": "ok", "id": "ticket"}},
    {"data": []}, {"data": [{"status": "ok", "id": "ticket"}] * 2},
])
async def test_malformed_envelope_or_ticket_count_is_unknown(monkeypatch, envelope):
    install_transport(monkeypatch, lambda request: httpx.Response(200, json=envelope))
    assert await ExpoPushService(PUSH_URL).send_reminder([device()], NOTIFICATION) == [
        {"device_id": "device-1", "status": "unknown", "ticket_id": None},
    ]


@pytest.mark.parametrize("content", [b"", b"not-json with ExpoPushToken[secret]", b"\xff"])
async def test_malformed_json_is_unknown(monkeypatch, content):
    install_transport(monkeypatch, lambda request: httpx.Response(200, content=content))
    assert await ExpoPushService(PUSH_URL).send_reminder([device()], NOTIFICATION) == [
        {"device_id": "device-1", "status": "unknown", "ticket_id": None},
    ]


@pytest.mark.parametrize("status,expected", [
    (400, "rejected"), (401, "rejected"), (403, "rejected"), (408, "rejected"),
    (413, "rejected"), (429, "rejected"), (500, "unknown"), (502, "unknown"),
    (503, "unknown"), (301, "unknown"), (307, "unknown"),
])
async def test_provider_http_errors_are_safe_and_never_retried_or_followed(monkeypatch, status, expected):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, headers={"location": "https://other.invalid/push"},
                              json={"message": "secret provider diagnostic", "data": [{"status": "ok", "id": "ignored"}]})

    install_transport(monkeypatch, handler)
    assert await ExpoPushService(PUSH_URL).send_reminder([device()], NOTIFICATION) == [
        {"device_id": "device-1", "status": expected, "ticket_id": None},
    ]
    assert len(requests) == 1


@pytest.mark.parametrize("error_type", [
    httpx.ReadTimeout, httpx.ConnectTimeout, httpx.WriteTimeout, httpx.PoolTimeout,
    httpx.ConnectError, httpx.ReadError, httpx.WriteError, httpx.RemoteProtocolError,
])
async def test_transport_failures_are_unknown_without_retry(monkeypatch, error_type):
    requests = []

    def handler(request):
        requests.append(request)
        raise error_type("private credentials and ExpoPushToken[secret]", request=request)

    install_transport(monkeypatch, handler)
    assert await ExpoPushService(PUSH_URL).send_reminder([device()], NOTIFICATION) == [
        {"device_id": "device-1", "status": "unknown", "ticket_id": None},
    ]
    assert len(requests) == 1


@pytest.mark.parametrize("failure,expected", [
    ("timeout", "unknown"), ("server_error", "unknown"), ("rejected", "rejected"),
    ("malformed_json", "unknown"), ("wrong_count", "unknown"), ("redirect", "unknown"),
])
async def test_large_batches_continue_after_a_provider_failure(monkeypatch, failure, expected):
    devices = [device(index) for index in range(205)]
    devices.insert(100, device("invalid", "bad-token"))
    batches = []

    def handler(request):
        batch = json.loads(request.content)
        batches.append(batch)
        if len(batches) == 2:
            if failure == "timeout":
                raise httpx.ReadTimeout("Response lost after Expo may have accepted", request=request)
            if failure == "malformed_json":
                return httpx.Response(200, content=b"not-json")
            if failure == "wrong_count":
                return httpx.Response(200, json={"data": [{"status": "ok", "id": "unsafe"}]})
            return httpx.Response({"server_error": 503, "rejected": 400, "redirect": 307}[failure])
        return httpx.Response(200, json={"data": [
            {"status": "ok", "id": f"ticket-{len(batches)}-{index}"} for index in range(len(batch))
        ]})

    install_transport(monkeypatch, handler)
    result = await ExpoPushService(PUSH_URL).send_reminder(devices, NOTIFICATION)
    assert [len(batch) for batch in batches] == [100, 100, 5]
    assert [item["to"] for batch in batches for item in batch] == [
        item["expo_push_token"] for item in devices if item["id"] != "device-invalid"
    ]
    assert [item["device_id"] for item in result] == [item["id"] for item in devices]
    assert [item["status"] for item in result] == (
        ["accepted"] * 100 + ["invalid_token"] + [expected] * 100 + ["accepted"] * 5
    )


async def test_existing_infrastructure_send_contract_is_unchanged(monkeypatch):
    def handler(request):
        assert json.loads(request.content) == {
            "to": "ExponentPushToken[infrastructure]", "sound": "default",
            "title": "Infrastructure Test Passed", "body": "Request request-1 completed successfully.",
            "data": {"request_id": "request-1", "server_timestamp": "2026-10-09T00:00:00Z"},
        }
        return httpx.Response(200, json={"data": {"status": "ok", "id": "infra-ticket"}})

    install_transport(monkeypatch, handler)
    assert await ExpoPushService(PUSH_URL).send(
        "ExponentPushToken[infrastructure]", "request-1", "2026-10-09T00:00:00Z",
    ) == "infra-ticket"
