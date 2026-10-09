"""Owner history and derived current streak response contracts."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from .occurrence_schemas import OccurrenceResult


class HistoryExcuse(BaseModel):
    id: UUID
    explanation: str
    status: Literal["pending", "approved", "rejected"]
    decision_source: Literal["automatic", "friend"] | None
    decided_by: UUID | None
    decided_at: datetime | None
    created_at: datetime


class HistoryOccurrence(OccurrenceResult):
    excuse: HistoryExcuse | None


class HistoryResult(BaseModel):
    habit_id: UUID
    occurrences: list[HistoryOccurrence]
    next_cursor: str | None


class StreakFields(BaseModel):
    current_streak: int = Field(ge=0)
    provisional: bool
    calculated_at: datetime


class StreakResult(StreakFields):
    habit_id: UUID
