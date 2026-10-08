from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from .habit_schemas import HabitCreate


class CompletionSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    completed: StrictBool


class ProgressSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    progress: StrictInt = Field(ge=0)


class ProgressAdjustment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    delta: StrictInt


class OccurrenceResult(BaseModel):
    id: UUID
    habit_id: UUID
    owner_id: UUID
    local_date: date
    timezone: str
    closes_at: datetime
    snapshot: HabitCreate
    progress: int
    completed: bool
    state: Literal["in_progress", "completed", "missed", "justification_pending", "excused"]
    created_at: datetime
    updated_at: datetime


class TodayResult(BaseModel):
    local_date: date
    timezone: str
    server_time: datetime
    occurrences: list[OccurrenceResult]
