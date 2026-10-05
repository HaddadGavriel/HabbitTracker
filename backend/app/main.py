from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import devices, infrastructure

app = FastAPI(title="Habit Tracker Infrastructure Proof", version="0.1.0")
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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}
