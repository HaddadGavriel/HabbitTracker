from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..occurrence_schemas import CompletionSet, OccurrenceResult, ProgressAdjustment, ProgressSet, TodayResult
from ..services.supabase import OccurrenceError, SupabaseDatabase
from .profiles import error

router = APIRouter(tags=["occurrences"])

ERRORS = {
    "profile_not_found": (404, "Create a profile to complete onboarding"),
    "wrong_occurrence_type": (409, "Operation does not match occurrence type"),
    "occurrence_closed": (409, "Occurrence is closed"),
    "occurrence_locked": (409, "Occurrence is locked by an excuse submission"),
    "negative_progress": (422, "Progress cannot be negative"),
    "invalid_occurrence_value": (422, "Invalid occurrence value"),
    "invalid_idempotency_key": (422, "Invalid idempotency key"),
    "idempotency_conflict": (409, "Idempotency key was used with a different delta"),
}


async def result(operation):
    try:
        row = await operation
    except OccurrenceError as exc:
        status, message = ERRORS[exc.code]
        raise error(status, exc.code, message) from exc
    if row is None:
        raise error(404, "occurrence_not_found", "Occurrence not found")
    return row


@router.get("/today", response_model=TodayResult)
async def today(user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    return await result(database.get_today(user.id))


@router.put("/occurrences/{occurrence_id}/completion", response_model=OccurrenceResult)
async def completion(occurrence_id: UUID, body: CompletionSet, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    return await result(database.mutate_occurrence(user.id, str(occurrence_id), "completion", body.completed))


@router.put("/occurrences/{occurrence_id}/progress", response_model=OccurrenceResult)
async def progress(occurrence_id: UUID, body: ProgressSet, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    return await result(database.mutate_occurrence(user.id, str(occurrence_id), "progress", body.progress))


@router.post("/occurrences/{occurrence_id}/progress-adjustments", response_model=OccurrenceResult)
async def adjust(occurrence_id: UUID, body: ProgressAdjustment,
                 idempotency_key: Annotated[str, Header(pattern=r"^[A-Za-z0-9._:-]{1,128}$")],
                 user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    return await result(database.mutate_occurrence(user.id, str(occurrence_id), "adjustment", body.delta, idempotency_key))
