import re

import httpx


_EXPO_TOKEN = re.compile(r"(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]")
_REJECTED_TICKET_ERRORS = {
    "MessageTooBig", "MessageRateExceeded", "MismatchSenderId", "InvalidCredentials",
}


class ExpoPushService:
    def __init__(self, push_url: str):
        self.push_url = push_url

    async def send(self, token: str, request_id: str, server_timestamp: str) -> str | None:
        payload = {
            "to": token,
            "sound": "default",
            "title": "Infrastructure Test Passed",
            "body": f"Request {request_id} completed successfully.",
            "data": {"request_id": request_id, "server_timestamp": server_timestamp},
        }
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(self.push_url, json=payload, headers={"Accept": "application/json", "Accept-Encoding": "gzip, deflate"})
        response.raise_for_status()
        ticket = response.json().get("data", {})
        if ticket.get("status") != "ok":
            raise RuntimeError(f"Expo rejected push notification: {ticket.get('message', 'unknown error')}")
        return ticket.get("id")

    async def send_reminder(self, devices: list[dict], notification: dict) -> list[dict]:
        """Submit each device once; acceptance is an Expo ticket, not delivery.

        Unknown results may already have reached Expo and must not be retried
        automatically. Return only safe, structured outcomes for persistence.
        """
        outcomes = [
            {"device_id": device["id"], "status": "unknown", "ticket_id": None}
            for device in devices
        ]
        valid_indexes = []
        for index, device in enumerate(devices):
            token = device.get("expo_push_token")
            if not isinstance(token, str) or len(token) > 256 or not _EXPO_TOKEN.fullmatch(token):
                outcomes[index]["status"] = "invalid_token"
            else:
                valid_indexes.append(index)

        if not valid_indexes:
            return outcomes

        async with httpx.AsyncClient(timeout=15) as client:
            for start in range(0, len(valid_indexes), 100):
                indexes = valid_indexes[start:start + 100]
                payload = [
                    {
                        "to": devices[index]["expo_push_token"],
                        "sound": "default",
                        "title": notification["title"],
                        "body": notification["body"],
                        "data": notification["data"],
                    }
                    for index in indexes
                ]
                try:
                    response = await client.post(
                        self.push_url, json=payload,
                        headers={"Accept": "application/json", "Accept-Encoding": "gzip, deflate"},
                    )
                except httpx.RequestError:
                    # The request may have been accepted before the connection failed.
                    continue
                if 400 <= response.status_code < 500:
                    for index in indexes:
                        outcomes[index]["status"] = "rejected"
                    continue
                if not 200 <= response.status_code < 300:
                    continue
                try:
                    envelope = response.json()
                except ValueError:
                    continue
                tickets = envelope.get("data") if isinstance(envelope, dict) else None
                if not isinstance(tickets, list) or len(tickets) != len(indexes):
                    # Without an exact positional match no device can be identified safely.
                    continue
                for index, ticket in zip(indexes, tickets):
                    if not isinstance(ticket, dict):
                        continue
                    ticket_id = ticket.get("id")
                    if (
                        ticket.get("status") == "ok" and isinstance(ticket_id, str)
                        and ticket_id.strip() and len(ticket_id) <= 256
                    ):
                        outcomes[index].update(status="accepted", ticket_id=ticket_id)
                    elif ticket.get("status") == "error":
                        details = ticket.get("details")
                        error = details.get("error") if isinstance(details, dict) else None
                        if error == "DeviceNotRegistered":
                            outcomes[index]["status"] = "invalid_token"
                        elif isinstance(error, str) and error in _REJECTED_TICKET_ERRORS:
                            outcomes[index]["status"] = "rejected"
        return outcomes
