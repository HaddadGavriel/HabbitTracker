from datetime import datetime, timezone

import httpx

from ..config import Settings


class SupabaseDatabase:
    def __init__(self, settings: Settings):
        self.base_url = f"{settings.supabase_url.rstrip('/')}/rest/v1"
        self.headers = {
            # Modern sb_secret_ keys are API keys, not JWTs. Sending one as a
            # Bearer token is invalid; the Supabase gateway accepts it here.
            "apikey": settings.supabase_secret_key,
            "Content-Type": "application/json",
        }

    async def register_device(self, user_id: str, token: str, platform: str) -> datetime:
        now = datetime.now(timezone.utc)
        headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=representation"}
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{self.base_url}/device_push_tokens?on_conflict=user_id,expo_push_token",
                headers=headers,
                json={"user_id": user_id, "expo_push_token": token, "platform": platform, "updated_at": now.isoformat()},
            )
        response.raise_for_status()
        return datetime.fromisoformat(response.json()[0]["updated_at"].replace("Z", "+00:00"))

    async def create_test(self, request_id: str, user_id: str, client_started_at: datetime, received_at: datetime) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{self.base_url}/infrastructure_tests",
                headers={**self.headers, "Prefer": "return=minimal"},
                json={"request_id": request_id, "user_id": user_id, "client_started_at": client_started_at.isoformat(), "server_received_at": received_at.isoformat(), "status": "received"},
            )
        response.raise_for_status()

    async def verify_and_mark_test(self, request_id: str, user_id: str) -> bool:
        async with httpx.AsyncClient(timeout=15) as client:
            read = await client.get(
                f"{self.base_url}/infrastructure_tests",
                headers=self.headers,
                params={"request_id": f"eq.{request_id}", "user_id": f"eq.{user_id}", "select": "request_id,user_id"},
            )
            read.raise_for_status()
            verified = len(read.json()) == 1
            if verified:
                update = await client.patch(
                    f"{self.base_url}/infrastructure_tests",
                    headers={**self.headers, "Prefer": "return=minimal"},
                    params={"request_id": f"eq.{request_id}", "user_id": f"eq.{user_id}"},
                    json={"status": "database_verified", "database_verified_at": datetime.now(timezone.utc).isoformat()},
                )
                update.raise_for_status()
        return verified

    async def latest_token(self, user_id: str) -> str | None:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"{self.base_url}/device_push_tokens",
                headers=self.headers,
                params={"user_id": f"eq.{user_id}", "select": "expo_push_token", "order": "updated_at.desc", "limit": "1"},
            )
        response.raise_for_status()
        rows = response.json()
        return rows[0]["expo_push_token"] if rows else None

    async def mark_push(self, request_id: str, ticket_id: str | None, status: str) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.patch(
                f"{self.base_url}/infrastructure_tests",
                headers={**self.headers, "Prefer": "return=minimal"},
                params={"request_id": f"eq.{request_id}"},
                json={"status": status, "expo_ticket_id": ticket_id, "push_requested_at": datetime.now(timezone.utc).isoformat()},
            )
        response.raise_for_status()
