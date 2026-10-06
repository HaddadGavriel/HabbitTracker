"""Private habit configuration; PATCH validates combinations in the locked DB RPC."""
import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator


class HabitFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=1000)
    target: StrictInt | None = Field(default=None, gt=0)
    unit: str | None = Field(default=None, min_length=1, max_length=30)
    schedule: Literal["daily", "selected"]
    weekdays: list[StrictInt] = Field(default_factory=list)
    reminder_times: list[str] = Field(min_length=1)

    @field_validator("name", "unit", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("weekdays")
    @classmethod
    def days(cls, value):
        if value is None:
            return value
        if len(set(value)) != len(value) or any(day < 1 or day > 7 for day in value):
            raise ValueError("weekdays must be distinct ISO days 1 through 7")
        return sorted(value)

    @field_validator("reminder_times")
    @classmethod
    def times(cls, value):
        if value is None:
            return value
        if len(set(value)) != len(value) or any(not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", t) for t in value):
            raise ValueError("reminder times must be distinct strict HH:MM values")
        return sorted(value)


class HabitCreate(HabitFields):
    type: Literal["binary", "target"]

    @model_validator(mode="after")
    def combinations(self):
        if self.type == "binary" and (self.target is not None or self.unit is not None):
            raise ValueError("binary habits cannot have a target or unit")
        if self.type == "target" and self.target is None:
            raise ValueError("target habits require a positive integer target")
        if (self.schedule == "daily" and self.weekdays) or (self.schedule == "selected" and not self.weekdays):
            raise ValueError("daily requires empty weekdays; selected requires 1-7 days")
        return self


class HabitUpdate(HabitFields):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    schedule: Literal["daily", "selected"] | None = None
    weekdays: list[StrictInt] | None = None
    reminder_times: list[str] | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def update_fields(self):
        if not self.model_fields_set:
            raise ValueError("at least one configuration field is required")
        if any(getattr(self, key) is None for key in self.model_fields_set - {"description", "target", "unit"}):
            raise ValueError("null is only allowed for description, target, and unit")
        return self


class HabitResult(HabitCreate):
    id: UUID
    owner_id: UUID
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


class HabitMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
