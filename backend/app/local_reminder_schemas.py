from datetime import date, datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel


class EffectiveReminder(BaseModel):
    habit_id: UUID
    local_date: date
    timezone: str
    closes_at: datetime
    reminder_times: list[str]


class FutureReminder(BaseModel):
    habit_id: UUID
    schedule: Literal['daily', 'selected']
    weekdays: list[int]
    reminder_times: list[str]
    eligible_from: date


class LocalReminderPlan(BaseModel):
    version: Literal[1]
    owner_id: UUID
    server_time: datetime
    local_date: date
    timezone: str
    effective: list[EffectiveReminder]
    future: list[FutureReminder]
