from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Response
import httpx

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database, get_push_service
from ..reminder_schemas import ReminderRequest, ReminderResult
from ..services.expo import ExpoPushService
from ..services.supabase import ReminderError, SupabaseDatabase
from .profiles import error

router = APIRouter(tags=["reminders"])

ERRORS = {
    "profile_not_found": (404, "Create a profile to complete onboarding"),
    "invalid_idempotency_key": (422, "Invalid idempotency key"),
    "reminder_not_eligible": (409, "A reminder requires an incomplete, open occurrence due today"),
    "reminder_cooldown": (429, "Wait 60 minutes between reminders for this habit"),
}


@router.post("/shared-habits/{habit_id}/reminders", response_model=ReminderResult)
async def remind(habit_id: UUID, response: Response,
                 idempotency_key: Annotated[str, Header(pattern=r"^[A-Za-z0-9._:-]{1,128}$")],
                 body: ReminderRequest | None = None,
                 user: AuthenticatedUser = Depends(get_current_user),
                 database: SupabaseDatabase = Depends(get_database),
                 push: ExpoPushService = Depends(get_push_service)):
    try:
        reservation = await database.reserve_habit_reminder(user.id, str(habit_id), idempotency_key)
    except ReminderError as exc:
        status, message = ERRORS[exc.code]
        detail = {"code": exc.code, "message": message}
        if exc.retry_at is not None:
            detail["retry_at"] = exc.retry_at
        raise HTTPException(status_code=status, detail=detail) from exc
    except httpx.HTTPError as exc:
        # The database may have committed before its response was lost. Only a
        # replay of this key is safe; never manufacture new dispatch authority.
        raise error(503, "reminder_unavailable", "Reminder reservation unavailable; retry with the same idempotency key") from exc
    if reservation is None:
        raise error(404, "habit_not_found", "Habit not found")
    result = reservation["result"]
    if not reservation["dispatch"]:
        if result["status"] == "reserved":
            response.status_code = 202
        return result

    # The reservation RPC has committed and released all locks before any HTTP
    # request. Only its original caller receives the private dispatch snapshot.
    # Replays (even after worker failure) cannot enter this branch.
    devices = reservation["devices"]
    try:
        outcomes = await push.send_reminder(devices, reservation["notification"])
    except Exception:
        # Unexpected provider failures can occur after transmission. Persist an
        # uncertain outcome without exposing raw exceptions or attempting again.
        outcomes = [{"device_id": device["id"], "status": "unknown", "ticket_id": None} for device in devices]
    try:
        finished = await database.finish_habit_reminder(user.id, result["id"], outcomes)
        if finished is None:
            raise RuntimeError("Missing reminder reservation")
    except (httpx.HTTPError, ReminderError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail={
            "code": "reminder_outcome_unavailable",
            "message": "Reminder outcome unavailable; retry with the same idempotency key without resending",
            "reminder_id": result["id"],
        }) from exc
    return finished
