from datetime import datetime, timezone
import re

import httpx

from ..config import Settings


class ProfileAlreadyExists(Exception):
    pass


class UsernameTaken(Exception):
    pass


class RelationshipConflict(Exception):
    def __init__(self, code: str):
        self.code = code


class HabitError(Exception):
    def __init__(self, code: str):
        self.code = code


class OccurrenceError(Exception):
    def __init__(self, code: str):
        self.code = code


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

    @staticmethod
    def _raise_profile_conflict(response: httpx.Response) -> None:
        if response.status_code != 409:
            response.raise_for_status()
            return
        try:
            error = response.json()
        except ValueError:
            response.raise_for_status()
            return
        if not isinstance(error, dict) or error.get("code") != "23505" or not isinstance(error.get("message"), str):
            response.raise_for_status()
            return
        match = re.search(r'unique constraint "([^"]+)"', error["message"])
        constraint = match.group(1) if match else None
        if constraint == "profiles_pkey":
            raise ProfileAlreadyExists
        if constraint == "profiles_username_key":
            raise UsernameTaken
        response.raise_for_status()

    async def create_profile(self, user_id: str, values: dict[str, str]) -> dict:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{self.base_url}/profiles",
                headers={**self.headers, "Prefer": "return=representation"},
                json={"user_id": user_id, **values},
            )
        self._raise_profile_conflict(response)
        return response.json()[0]

    async def get_profile(self, user_id: str) -> dict | None:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"{self.base_url}/profiles",
                headers=self.headers,
                params={"user_id": f"eq.{user_id}", "select": "user_id,username,display_name,timezone,created_at,updated_at", "limit": "1"},
            )
        response.raise_for_status()
        rows = response.json()
        return rows[0] if rows else None

    async def update_profile(self, user_id: str, values: dict[str, str]) -> dict | None:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.patch(
                f"{self.base_url}/profiles",
                headers={**self.headers, "Prefer": "return=representation"},
                params={"user_id": f"eq.{user_id}"},
                json=values,
            )
        self._raise_profile_conflict(response)
        rows = response.json()
        return rows[0] if rows else None

    async def search_profile(self, username: str) -> dict | None:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"{self.base_url}/profiles",
                headers=self.headers,
                params={"username": f"eq.{username}", "select": "user_id,username,display_name", "limit": "1"},
            )
        response.raise_for_status()
        rows = response.json()
        return rows[0] if rows else None

    async def _rpc(self, function: str, body: dict) -> httpx.Response:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(f"{self.base_url}/rpc/{function}", headers=self.headers, json=body)
        return response

    @staticmethod
    def _relationship_error(response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        try:
            error = response.json()
            code = error.get("code")
            message = error.get("message")
        except (ValueError, AttributeError):
            response.raise_for_status()
            return
        codes = {"outgoing_request_exists", "incoming_request_exists", "friendship_exists", "recipient_not_found", "profile_not_found", "self_request"}
        if response.status_code == 400 and code == "P0001" and isinstance(message, str) and message in codes:
            raise RelationshipConflict(message)
        response.raise_for_status()

    async def send_friend_request(self, requester_id: str, recipient_id: str) -> dict:
        response = await self._rpc("send_friend_request", {"p_requester": requester_id, "p_recipient": recipient_id})
        self._relationship_error(response)
        return response.json()[0]

    async def list_friend_requests(self, user_id: str) -> list[dict]:
        response = await self._rpc("list_friend_requests", {"p_user": user_id})
        response.raise_for_status()
        return response.json()

    async def accept_friend_request(self, request_id: str, user_id: str) -> dict | None:
        response = await self._rpc("accept_friend_request", {"p_request": request_id, "p_actor": user_id})
        response.raise_for_status()
        rows = response.json()
        return rows[0] if rows else None

    async def reject_friend_request(self, request_id: str, user_id: str) -> bool:
        response = await self._rpc("reject_friend_request", {"p_request": request_id, "p_actor": user_id})
        response.raise_for_status()
        return bool(response.json())

    async def list_friends(self, user_id: str) -> list[dict]:
        response = await self._rpc("list_friends", {"p_user": user_id})
        response.raise_for_status()
        return response.json()

    async def remove_friend(self, user_id: str, friend_id: str) -> bool:
        response = await self._rpc("remove_friend", {"p_actor": user_id, "p_friend": friend_id})
        response.raise_for_status()
        return bool(response.json())

    async def _habit_rpc(self, function: str, body: dict, *, many: bool = False):
        response = await self._rpc(function, body)
        if response.status_code >= 400:
            try:
                payload = response.json()
            except ValueError:
                payload = None
            if isinstance(payload, dict) and payload.get("code") == "P0001" and payload.get("message") in {
                "profile_not_found", "habit_archived", "invalid_habit_configuration",
            }:
                raise HabitError(payload["message"])
        response.raise_for_status()
        rows = response.json()
        return rows if many else (rows[0] if rows else None)

    async def create_habit(self, user_id: str, values: dict) -> dict:
        return await self._habit_rpc("create_habit", {"p_owner": user_id, "p_config": values})

    async def list_habits(self, user_id: str, status: str = "active") -> list[dict]:
        return await self._habit_rpc("list_habits", {"p_owner": user_id, "p_status": status}, many=True)

    async def get_habit(self, user_id: str, habit_id: str) -> dict | None:
        return await self._habit_rpc("get_habit", {"p_owner": user_id, "p_habit": habit_id})

    async def update_habit(self, user_id: str, habit_id: str, values: dict) -> dict | None:
        return await self._habit_rpc("update_habit", {"p_owner": user_id, "p_habit": habit_id, "p_changes": values})

    async def set_habit_archived(self, user_id: str, habit_id: str, archived: bool) -> dict | None:
        function = "archive_habit" if archived else "restore_habit"
        return await self._habit_rpc(function, {"p_owner": user_id, "p_habit": habit_id})

    async def get_today(self, user_id: str) -> dict:
        response = await self._rpc("get_today", {"p_owner": user_id})
        self._occurrence_error(response)
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _occurrence_error(response: httpx.Response) -> None:
        if response.status_code >= 400:
            try:
                payload = response.json()
            except ValueError:
                payload = None
            if isinstance(payload, dict) and payload.get("code") == "P0001" and payload.get("message") == "profile_not_found":
                raise OccurrenceError("profile_not_found")

    async def mutate_occurrence(self, user_id: str, occurrence_id: str, operation: str, value: bool | int, key: str | None = None) -> dict | None:
        response = await self._rpc("mutate_occurrence", {
            "p_owner": user_id, "p_occurrence": occurrence_id, "p_operation": operation, "p_value": value, "p_key": key,
        })
        self._occurrence_error(response)
        response.raise_for_status()
        rows = response.json()
        row = rows[0] if rows else None
        if isinstance(row, dict) and row.get("error") in {
            "wrong_occurrence_type", "occurrence_closed", "negative_progress", "invalid_occurrence_value",
            "invalid_idempotency_key", "idempotency_conflict",
        }:
            raise OccurrenceError(row["error"])
        return row
