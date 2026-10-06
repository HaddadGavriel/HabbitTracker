from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..habit_schemas import HabitCreate, HabitMutation, HabitResult, HabitUpdate
from ..services.supabase import HabitError, SupabaseDatabase
from .friends import require_profile
from .profiles import error

router = APIRouter(prefix="/habits", tags=["habits"])


async def owned_result(operation):
    try:
        row = await operation
    except HabitError as exc:
        messages = {
            "profile_not_found": (404, "Create a profile to complete onboarding"),
            "habit_archived": (409, "Restore the habit before editing its configuration"),
            "invalid_habit_configuration": (422, "Invalid resulting habit configuration"),
        }
        code, message = messages[exc.code]
        raise error(code, exc.code, message) from exc
    if row is None:
        raise error(404, "habit_not_found", "Habit not found")
    return row


@router.post("", response_model=HabitResult, status_code=201)
async def create(body: HabitCreate, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await owned_result(database.create_habit(user.id, body.model_dump()))


@router.get("", response_model=list[HabitResult])
async def list_habits(status: Literal["active", "archived", "all"] = "active", user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await owned_result(database.list_habits(user.id, status))


@router.get("/{habit_id}", response_model=HabitResult)
async def read(habit_id: UUID, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await owned_result(database.get_habit(user.id, str(habit_id)))


@router.patch("/{habit_id}", response_model=HabitResult)
async def update(habit_id: UUID, body: HabitUpdate, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await owned_result(database.update_habit(user.id, str(habit_id), body.model_dump(exclude_unset=True)))


@router.post("/{habit_id}/archive", response_model=HabitResult)
async def archive(habit_id: UUID, body: HabitMutation | None = None, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await owned_result(database.set_habit_archived(user.id, str(habit_id), True))


@router.post("/{habit_id}/restore", response_model=HabitResult)
async def restore(habit_id: UUID, body: HabitMutation | None = None, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await owned_result(database.set_habit_archived(user.id, str(habit_id), False))
