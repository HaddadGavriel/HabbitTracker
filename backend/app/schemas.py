from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class DeviceRegistration(BaseModel):
    expo_push_token: str = Field(pattern=r"^ExponentPushToken\[[^]]+\]$|^ExpoPushToken\[[^]]+\]$")
    platform: Literal["android", "ios"]


class DeviceRegistrationResult(BaseModel):
    registered: bool = True
    platform: str
    updated_at: datetime


class InfrastructureTestRequest(BaseModel):
    request_id: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    client_started_at: datetime


class Timings(BaseModel):
    database: int
    push_request: int
    server_total: int


class InfrastructureTestResult(BaseModel):
    request_id: str
    success: bool
    database_verified: bool
    push_requested: bool
    expo_ticket_id: str | None = None
    server_received_at: datetime
    timings_ms: Timings
