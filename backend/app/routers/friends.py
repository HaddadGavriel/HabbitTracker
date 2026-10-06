from uuid import UUID

from fastapi import APIRouter, Depends, Response, status

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..schemas import FriendRequestCreate, FriendRequestLists, RelationshipMutation, RelationshipResult
from ..services.supabase import RelationshipConflict, SupabaseDatabase
from .profiles import error

router = APIRouter(tags=["friends"])


async def require_profile(user: AuthenticatedUser, database: SupabaseDatabase) -> None:
    if await database.get_profile(user.id) is None:
        raise error(404, "profile_not_found", "Create a profile to complete onboarding")


@router.post("/friend-requests", response_model=RelationshipResult, status_code=status.HTTP_201_CREATED)
async def send_request(body: FriendRequestCreate, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)) -> dict:
    await require_profile(user, database)
    if str(body.recipient_user_id) == user.id:
        raise error(422, "self_request", "A user cannot request friendship with themselves")
    try:
        row = await database.send_friend_request(user.id, str(body.recipient_user_id))
    except RelationshipConflict as exc:
        messages = {
            "outgoing_request_exists": "An outgoing request is already pending",
            "incoming_request_exists": "This user has already sent you a request",
            "friendship_exists": "You are already friends",
            "recipient_not_found": "The recipient profile does not exist",
            "profile_not_found": "Create a profile to complete onboarding",
            "self_request": "A user cannot request friendship with themselves",
        }
        status_code = 409
        if exc.code in {"recipient_not_found", "profile_not_found"}:
            status_code = 404
        elif exc.code == "self_request":
            status_code = 422
        raise error(status_code, exc.code, messages[exc.code]) from exc
    return row


@router.get("/friend-requests", response_model=FriendRequestLists)
async def list_requests(user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)) -> dict:
    await require_profile(user, database)
    rows = await database.list_friend_requests(user.id)
    return {"incoming": [r for r in rows if r["direction"] == "incoming"], "outgoing": [r for r in rows if r["direction"] == "outgoing"]}


@router.post("/friend-requests/{request_id}/accept", response_model=RelationshipResult)
async def accept_request(
    request_id: UUID,
    body: RelationshipMutation | None = None,
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
) -> dict:
    await require_profile(user, database)
    row = await database.accept_friend_request(str(request_id), user.id)
    if row is None:
        raise error(404, "friend_request_not_found", "No pending request is available to accept")
    return row


@router.post("/friend-requests/{request_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
async def reject_request(
    request_id: UUID,
    body: RelationshipMutation | None = None,
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
) -> Response:
    await require_profile(user, database)
    if not await database.reject_friend_request(str(request_id), user.id):
        raise error(404, "friend_request_not_found", "No pending request is available to reject")
    return Response(status_code=204)


@router.get("/friends", response_model=list[RelationshipResult])
async def list_friends(user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)) -> list[dict]:
    await require_profile(user, database)
    return await database.list_friends(user.id)


@router.delete("/friends/{friend_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_friend(
    friend_user_id: UUID,
    body: RelationshipMutation | None = None,
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
) -> Response:
    await require_profile(user, database)
    if not await database.remove_friend(user.id, str(friend_user_id)):
        raise error(404, "friendship_not_found", "No accepted friendship exists with that user")
    return Response(status_code=204)
