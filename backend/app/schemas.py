from datetime import datetime
from typing import Literal

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator


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


def normalize_username(value: str) -> str:
    return value.strip().lower()


class ProfileFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=30, pattern=r"^[a-z0-9_]+$")
    display_name: str = Field(min_length=1, max_length=80)
    timezone: str

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username_field(cls, value: object) -> object:
        return normalize_username(value) if isinstance(value, str) else value

    @field_validator("display_name", mode="before")
    @classmethod
    def trim_display_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("must be a valid IANA timezone") from exc
        return value


class ProfileCreate(ProfileFields):
    pass


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str | None = Field(default=None, min_length=3, max_length=30, pattern=r"^[a-z0-9_]+$")
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    timezone: str | None = None

    _normalize_username = field_validator("username", mode="before")(ProfileFields.normalize_username_field.__func__)
    _trim_display_name = field_validator("display_name", mode="before")(ProfileFields.trim_display_name.__func__)
    _valid_timezone = field_validator("timezone")(ProfileFields.valid_timezone.__func__)


class ProfileResult(ProfileFields):
    user_id: str
    created_at: datetime
    updated_at: datetime


class ProfileSearchResult(BaseModel):
    user_id: str
    username: str
    display_name: str
