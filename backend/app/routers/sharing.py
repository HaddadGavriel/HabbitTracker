from uuid import UUID

from fastapi import APIRouter, Depends, Response

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..schemas import PublicProfile
from ..services.supabase import SharingError, SupabaseDatabase
from ..sharing_schemas import ShareMutation, SharedHabitResult
from .friends import require_profile
from .profiles import error

router = APIRouter(tags=["sharing"])

ERRORS = {
    "profile_not_found": (404, "Create a profile to complete onboarding"),
    "self_share": (422, "A user cannot share a habit with themselves"),
    "friendship_required": (409, "Sharing requires an accepted friendship"),
}


async def result(operation):
    try:
        row = await operation
    except SharingError as exc:
        status, message = ERRORS[exc.code]
        raise error(status, exc.code, message) from exc
    if row is None:
        raise error(404, "habit_not_found", "Habit not found")
    return row


@router.put("/habits/{habit_id}/shares/{friend_user_id}", response_model=PublicProfile)
async def grant(habit_id: UUID, friend_user_id: UUID, body: ShareMutation | None = None,
                user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await result(database.grant_habit_share(user.id, str(habit_id), str(friend_user_id)))


@router.delete("/habits/{habit_id}/shares/{friend_user_id}", status_code=204)
async def revoke(habit_id: UUID, friend_user_id: UUID, body: ShareMutation | None = None,
                 user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    await result(database.revoke_habit_share(user.id, str(habit_id), str(friend_user_id)))
    return Response(status_code=204)


@router.get("/habits/{habit_id}/shares", response_model=list[PublicProfile])
async def list_shares(habit_id: UUID, user: AuthenticatedUser = Depends(get_current_user),
                      database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await result(database.list_habit_shares(user.id, str(habit_id)))


@router.get("/shared-habits", response_model=list[SharedHabitResult])
async def list_shared(user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await result(database.list_shared_habits(user.id))


@router.get("/shared-habits/{habit_id}", response_model=SharedHabitResult)
async def read_shared(habit_id: UUID, user: AuthenticatedUser = Depends(get_current_user),
                      database: SupabaseDatabase = Depends(get_database)):
    await require_profile(user, database)
    return await result(database.get_shared_habit(user.id, str(habit_id)))
