from datetime import datetime, timezone
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database, get_push_service
from ..schemas import InfrastructureTestRequest, InfrastructureTestResult, Timings
from ..services.expo import ExpoPushService
from ..services.supabase import SupabaseDatabase

router = APIRouter(tags=["infrastructure"])


@router.post("/infrastructure-test", response_model=InfrastructureTestResult)
async def infrastructure_test(
    body: InfrastructureTestRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    database: SupabaseDatabase = Depends(get_database),
    push: ExpoPushService = Depends(get_push_service),
) -> InfrastructureTestResult:
    started = perf_counter()
    received_at = datetime.now(timezone.utc)
    database_started = perf_counter()
    await database.create_test(body.request_id, user.id, body.client_started_at, received_at)
    verified = await database.verify_and_mark_test(body.request_id, user.id)
    token = await database.latest_token(user.id)
    database_ms = round((perf_counter() - database_started) * 1000)
    if not verified:
        raise HTTPException(status_code=500, detail="Database row could not be verified after write")
    if token is None:
        raise HTTPException(status_code=409, detail="No push token is registered for this user")
    push_started = perf_counter()
    try:
        ticket_id = await push.send(token, body.request_id, received_at.isoformat())
    except Exception as exc:
        await database.mark_push(body.request_id, None, "push_failed")
        raise HTTPException(status_code=502, detail=f"Expo push request failed: {exc}") from exc
    push_ms = round((perf_counter() - push_started) * 1000)
    await database.mark_push(body.request_id, ticket_id, "push_accepted")
    return InfrastructureTestResult(
        request_id=body.request_id,
        success=True,
        database_verified=True,
        push_requested=True,
        expo_ticket_id=ticket_id,
        server_received_at=received_at,
        timings_ms=Timings(database=database_ms, push_request=push_ms, server_total=round((perf_counter() - started) * 1000)),
    )
