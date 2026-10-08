"""Excuse input and explicit, permission-checked response contracts."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator

from .occurrence_schemas import OccurrenceResult


class ExcuseSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    explanation: StrictStr = Field(min_length=1, max_length=1000)

    @field_validator("explanation", mode="before")
    @classmethod
    def trim_explanation(cls, value):
        if isinstance(value, str):
            # PostgreSQL text cannot store NUL; lone surrogates are not Unicode
            # scalar values and cannot be encoded for the database transport.
            if "\x00" in value or any(0xD800 <= ord(char) <= 0xDFFF for char in value):
                raise ValueError("explanation must contain valid Unicode text without NUL")
            return value.strip()
        return value


class ExcuseDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]


class ExcuseResult(BaseModel):
    id: UUID
    occurrence_id: UUID
    habit_id: UUID
    owner_id: UUID
    explanation: str
    status: Literal["pending", "approved", "rejected"]
    decision_source: Literal["automatic", "friend"] | None
    decided_by: UUID | None
    decided_at: datetime | None
    created_at: datetime
    occurrence: OccurrenceResult
