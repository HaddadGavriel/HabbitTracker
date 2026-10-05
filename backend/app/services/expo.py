import httpx


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
