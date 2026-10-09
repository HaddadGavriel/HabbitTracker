import base64
import binascii
from datetime import date
import json
import re
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..history_schemas import HistoryResult, StreakResult
from ..services.supabase import HistoryError, SupabaseDatabase
from .profiles import error

router = APIRouter(tags=["history"])

ERRORS = {
    "profile_not_found": (404, "Create a profile to complete onboarding"),
    "invalid_history_cursor": (422, "Invalid history cursor for this habit and date range"),
    "invalid_history_range": (422, "from_date must not be after to_date"),
    "invalid_history_limit": (422, "limit must be an integer between 1 and 100"),
}
CURSOR_KEYS = {"v", "habit_id", "from_date", "to_date", "local_date", "id"}


def iso_date(value: str) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("Expected YYYY-MM-DD")
    return date.fromisoformat(value)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate cursor field")
        result[key] = value
    return result


def decode_cursor(value: str, habit_id: str, from_date: str | None, to_date: str | None) -> dict:
    # A cursor only selects a position. The RPC independently verifies ownership
    # from the authenticated actor and revalidates scope before reconciliation.
    try:
        if len(value) > 4096 or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("Invalid base64url")
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != value:
            raise ValueError("Noncanonical base64url")
        cursor = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
        if not isinstance(cursor, dict) or set(cursor) != CURSOR_KEYS:
            raise ValueError("Invalid cursor fields")
        if type(cursor["v"]) is not int or cursor["v"] != 1:
            raise ValueError("Invalid cursor version")
        if (cursor["habit_id"], cursor["from_date"], cursor["to_date"]) != (habit_id, from_date, to_date):
            raise ValueError("Invalid cursor scope")
        local_date = iso_date(cursor["local_date"])
        if not isinstance(cursor["id"], str) or str(UUID(cursor["id"])) != cursor["id"]:
            raise ValueError("Invalid occurrence ID")
        if from_date is not None and local_date < iso_date(from_date):
            raise ValueError("Cursor precedes range")
        if to_date is not None and local_date > iso_date(to_date):
            raise ValueError("Cursor follows range")
        return cursor
    except (ValueError, TypeError, binascii.Error, UnicodeError, RecursionError) as exc:
        status, message = ERRORS["invalid_history_cursor"]
        raise error(status, "invalid_history_cursor", message) from exc


async def result(operation):
    try:
        row = await operation
    except HistoryError as exc:
        status, message = ERRORS[exc.code]
        raise error(status, exc.code, message) from exc
    if row is None:
        raise error(404, "habit_not_found", "Habit not found")
    return row


@router.get("/habits/{habit_id}/history", response_model=HistoryResult)
async def history(habit_id: UUID, limit: Annotated[str, Query()] = "30",
                  from_date: Annotated[str | None, Query()] = None,
                  to_date: Annotated[str | None, Query()] = None,
                  cursor: Annotated[str | None, Query()] = None,
                  user: AuthenticatedUser = Depends(get_current_user),
                  database: SupabaseDatabase = Depends(get_database)):
    if not re.fullmatch(r"[0-9]{1,3}", limit) or not 1 <= int(limit) <= 100:
        status, message = ERRORS["invalid_history_limit"]
        raise error(status, "invalid_history_limit", message)
    try:
        start = iso_date(from_date) if from_date is not None else None
        end = iso_date(to_date) if to_date is not None else None
    except ValueError as exc:
        raise error(422, "invalid_history_date", "Dates must be valid YYYY-MM-DD values") from exc
    if start is not None and end is not None and start > end:
        status, message = ERRORS["invalid_history_range"]
        raise error(status, "invalid_history_range", message)
    position = decode_cursor(cursor, str(habit_id), from_date, to_date) if cursor is not None else None
    page = await result(database.get_habit_history(user.id, str(habit_id), int(limit), from_date, to_date, position))
    next_cursor = page["next_cursor"]
    return page | {"next_cursor": base64.urlsafe_b64encode(
        json.dumps(next_cursor, separators=(",", ":")).encode()
    ).rstrip(b"=").decode() if next_cursor is not None else None}


@router.get("/habits/{habit_id}/streak", response_model=StreakResult)
async def streak(habit_id: UUID, user: AuthenticatedUser = Depends(get_current_user),
                 database: SupabaseDatabase = Depends(get_database)):
    return await result(database.get_habit_streak(user.id, str(habit_id)))
