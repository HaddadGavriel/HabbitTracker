from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import devices, infrastructure, profiles

app = FastAPI(title="Habit Tracker API", version="0.2.0")
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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}
