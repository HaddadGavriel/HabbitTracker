"""Provider acceptance is distinct from delivery to a phone."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ReminderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReminderResult(BaseModel):
    id: UUID
    habit_id: UUID
    occurrence_id: UUID
    status: Literal["reserved", "provider_accepted", "partially_accepted", "failed", "unknown", "no_devices"]
    reserved_at: datetime
    finished_at: datetime | None
    retry_at: datetime
    device_count: int = Field(ge=0)
    accepted_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    unknown_count: int = Field(ge=0)
