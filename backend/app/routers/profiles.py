from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import TypeAdapter, ValidationError

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..schemas import ProfileCreate, ProfileResult, ProfileSearchResult, ProfileUpdate
from ..services.supabase import ProfileAlreadyExists, SupabaseDatabase, UsernameTaken

router = APIRouter(prefix="/profiles", tags=["profiles"])


def error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@router.post("/me", response_model=ProfileResult, status_code=status.HTTP_201_CREATED)
async def create_profile(body: ProfileCreate, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)) -> dict:
    try:
        return await database.create_profile(user.id, body.model_dump())
    except ProfileAlreadyExists as exc:
        raise error(409, "profile_already_exists", "This user already has a profile") from exc
    except UsernameTaken as exc:
        raise error(409, "username_taken", "That username is already taken") from exc


@router.get("/me", response_model=ProfileResult)
async def read_profile(user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)) -> dict:
    profile = await database.get_profile(user.id)
    if profile is None:
        raise error(404, "profile_not_found", "Create a profile to complete onboarding")
    return profile


@router.patch("/me", response_model=ProfileResult)
async def update_profile(body: ProfileUpdate, user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)) -> dict:
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise error(422, "empty_update", "At least one profile field is required")
    if any(value is None for value in values.values()):
        raise error(422, "null_not_allowed", "Profile fields cannot be null")
    try:
        profile = await database.update_profile(user.id, values)
    except UsernameTaken as exc:
        raise error(409, "username_taken", "That username is already taken") from exc
    if profile is None:
        raise error(404, "profile_not_found", "Create a profile to complete onboarding")
    return profile


@router.get("/search", response_model=ProfileSearchResult)
async def search_profile(
    username: str = Query(...),
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
) -> dict:
    try:
        normalized = TypeAdapter(ProfileCreate).validate_python(
            {"username": username, "display_name": "x", "timezone": "UTC"}
        ).username
    except ValidationError as exc:
        raise error(422, "invalid_username", "Username must be 3-30 ASCII letters, digits, or underscores") from exc
    own_profile = await database.get_profile(user.id)
    if own_profile is None:
        raise error(404, "profile_not_found", "Create a profile to complete onboarding")
    match = await database.search_profile(normalized)
    if match is None or match["user_id"] == user.id:
        raise error(404, "profile_not_found", "No other profile has that username")
    return match
