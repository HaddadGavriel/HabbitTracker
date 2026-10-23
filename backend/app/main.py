import httpx

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import account, devices, excuses, friends, habits, history, infrastructure, occurrences, profiles, reminders, sharing

app = FastAPI(title="Habit Tracker API", version="0.9.0")
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=settings.cors_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(account.router)
app.include_router(devices.router)
app.include_router(infrastructure.router)
app.include_router(profiles.router)
app.include_router(friends.router)
app.include_router(habits.router)
app.include_router(occurrences.router)
app.include_router(sharing.router)
app.include_router(excuses.router)
app.include_router(history.router)
app.include_router(reminders.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}


@app.exception_handler(RequestValidationError)
async def redact_account_validation(request: Request, exc: RequestValidationError):
    if request.url.path.startswith('/account/deletion'):
        return JSONResponse(status_code=422, content={'detail': {'code': 'invalid_deletion_request', 'message': 'Check confirmation, password and recovery receipt.'}})
    return await request_validation_exception_handler(request, exc)


@app.exception_handler(httpx.HTTPError)
async def service_unavailable(_request: Request, _exc: httpx.HTTPError):
    # Do not send provider response bodies, URLs or credentials to the client.
    # A timed-out write may have committed; callers must reconcile before retry.
    return JSONResponse(status_code=503, content={'detail': {
        'code': 'service_unavailable',
        'message': 'Unable to confirm the server response. Check your connection and refresh before retrying a change.',
    }})
