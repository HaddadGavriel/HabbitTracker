import json
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from ..auth import AuthenticatedUser, get_current_user
from ..dependencies import get_database
from ..excuse_schemas import ExcuseDecision, ExcuseResult, ExcuseSubmission
from ..services.supabase import ExcuseError, SupabaseDatabase
from .profiles import error


class ExcuseRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def validated(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                # JSON can transport escaped lone surrogates. Validation rejects
                # them, but its echoed input must also be safe to encode as UTF-8.
                content = json.dumps({"detail": jsonable_encoder(exc.errors())}, ensure_ascii=True)
                return Response(content=content, status_code=422, media_type="application/json")

        return validated


router = APIRouter(tags=["excuses"], route_class=ExcuseRoute)

ERRORS = {
    "profile_not_found": (404, "Create a profile to complete onboarding"),
    "invalid_excuse_explanation": (422, "Explanation must contain 1 to 1,000 characters after trimming"),
    "occurrence_closed": (409, "Occurrence is closed"),
    "occurrence_not_in_progress": (409, "Only an in-progress occurrence can be excused"),
    "excuse_exists": (409, "An excuse already exists for this occurrence"),
    "excuse_already_decided": (409, "Excuse has already been decided"),
    "invalid_excuse_decision": (422, "Decision must be approve or reject"),
}


async def result(operation, *, submitting: bool = False):
    try:
        row = await operation
    except ExcuseError as exc:
        status, message = ERRORS[exc.code]
        raise error(status, exc.code, message) from exc
    if row is None:
        if submitting:
            raise error(404, "occurrence_not_found", "Occurrence not found")
        raise error(404, "excuse_not_found", "Excuse not found")
    return row


@router.post("/occurrences/{occurrence_id}/excuse", response_model=ExcuseResult, status_code=201)
async def submit(occurrence_id: UUID, body: ExcuseSubmission,
                 user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    return await result(database.submit_occurrence_excuse(user.id, str(occurrence_id), body.explanation), submitting=True)


@router.get("/occurrences/{occurrence_id}/excuse", response_model=ExcuseResult)
async def read(occurrence_id: UUID, user: AuthenticatedUser = Depends(get_current_user),
               database: SupabaseDatabase = Depends(get_database)):
    return await result(database.get_occurrence_excuse(user.id, str(occurrence_id)))


@router.get("/excuses/pending", response_model=list[ExcuseResult])
async def pending(user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    return await result(database.list_pending_excuses(user.id))


@router.post("/excuses/{excuse_id}/decision", response_model=ExcuseResult)
async def decide(excuse_id: UUID, body: ExcuseDecision,
                 user: AuthenticatedUser = Depends(get_current_user), database: SupabaseDatabase = Depends(get_database)):
    return await result(database.decide_occurrence_excuse(user.id, str(excuse_id), body.decision))
