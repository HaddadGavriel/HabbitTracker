from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import devices, excuses, friends, habits, history, infrastructure, occurrences, profiles, reminders, sharing

app = FastAPI(title="Habit Tracker API", version="0.9.0")
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=settings.cors_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
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
