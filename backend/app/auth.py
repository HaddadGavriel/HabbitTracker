from dataclasses import dataclass
from uuid import UUID

import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    email: str | None = None


async def get_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    settings: Settings = Depends(get_settings),
) -> AuthenticatedUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="A Supabase access token is required")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{settings.supabase_url.rstrip('/')}/auth/v1/user",
                headers={"apikey": settings.supabase_publishable_key, "Authorization": f"Bearer {credentials.credentials}"},
            )
        if response.status_code in (401, 403):
            raise HTTPException(status_code=401, detail="Invalid or expired Supabase access token")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
            raise ValueError("Invalid identity response")
        identity = str(UUID(payload["id"]))
        email = payload.get("email")
        if email is not None and not isinstance(email, str):
            raise ValueError("Invalid identity response")
        return AuthenticatedUser(id=identity, email=email)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(status_code=503, detail={"code": "auth_unavailable", "message": "Unable to verify your session. Please retry."}) from None


async def get_current_user(user: AuthenticatedUser = Depends(get_authenticated_user),
                           settings: Settings = Depends(get_settings)) -> AuthenticatedUser:
    from .services.supabase import SupabaseDatabase
    try:
        pending = await SupabaseDatabase(settings).deletion_rpc('account_is_deleting', {'p_user': user.id})
    except httpx.HTTPError:
        raise HTTPException(503, detail={'code': 'account_status_unavailable', 'message': 'Unable to verify account status.'}) from None
    if pending:
        raise HTTPException(409, detail={'code': 'account_deletion_pending', 'message': 'Account deletion is pending. Recover using your saved receipt.'})
    return user
