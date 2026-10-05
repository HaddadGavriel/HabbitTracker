from fastapi import APIRouter, Depends

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..schemas import DeviceRegistration, DeviceRegistrationResult
from ..services.supabase import SupabaseDatabase

router = APIRouter(prefix="/devices", tags=["devices"])


@router.post("/register", response_model=DeviceRegistrationResult)
async def register_device(
    registration: DeviceRegistration,
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
) -> DeviceRegistrationResult:
    updated_at = await database.register_device(user.id, registration.expo_push_token, registration.platform)
    return DeviceRegistrationResult(platform=registration.platform, updated_at=updated_at)
