from fastapi import APIRouter, Depends, HTTPException
import httpx

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..schemas import DeviceRegistration, DeviceRegistrationResult, DeviceUnregistration, DeviceUnregistrationResult
from ..services.supabase import SupabaseDatabase

router = APIRouter(prefix="/devices", tags=["devices"])


def unavailable():
    return HTTPException(503, detail={"code": "device_registration_unavailable", "message": "Device registration change could not be confirmed. Retry cleanup."})


@router.post("/register", response_model=DeviceRegistrationResult)
async def register_device(
    registration: DeviceRegistration,
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
) -> DeviceRegistrationResult:
    try:
        updated_at = await database.register_device(user.id, registration.expo_push_token, registration.platform, str(registration.registration_id))
    except (httpx.HTTPError, ValueError) as exc:
        raise unavailable() from exc
    if updated_at is None:
        raise HTTPException(409, detail={"code": "registration_superseded", "message": "This registration was cancelled or replaced."})
    return DeviceRegistrationResult(registration_id=registration.registration_id, platform=registration.platform, updated_at=updated_at)


@router.post("/unregister", response_model=DeviceUnregistrationResult)
async def unregister_device(
    registration: DeviceUnregistration,
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
) -> DeviceUnregistrationResult:
    try:
        removed = await database.unregister_device(user.id, str(registration.registration_id))
    except (httpx.HTTPError, ValueError) as exc:
        raise unavailable() from exc
    # False also confirms that this exact intent is absent and fenced; it says
    # nothing about registrations belonging to another owner or newer intent.
    return DeviceUnregistrationResult(removed=removed)
