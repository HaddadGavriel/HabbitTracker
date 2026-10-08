"""Read-only shared views keep current configuration separate from Today snapshots."""
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from .habit_schemas import HabitCreate
from .schemas import PublicProfile


class ShareMutation(BaseModel):
    """The authenticated actor and path parameters are the only inputs."""

    model_config = ConfigDict(extra="forbid")


class SharedOccurrence(BaseModel):
    id: UUID
    local_date: date
    timezone: str
    closes_at: datetime
    snapshot: HabitCreate
    progress: int
    completed: bool
    state: Literal["in_progress", "completed", "missed", "justification_pending", "excused"]


class SharedHabitResult(BaseModel):
    id: UUID
    owner: PublicProfile
    configuration: HabitCreate
    local_date: date
    timezone: str
    server_time: datetime
    due_today: bool
    occurrence: SharedOccurrence | None
