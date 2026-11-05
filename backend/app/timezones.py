"""Identifier contract shared with the Android reminder planner.

Keep OS-local names, Java-only offsets and ambiguous short IDs out of writes.
Reads deliberately preserve legacy values so the account can repair its profile.
"""
from pathlib import Path

SUPPORTED_TIMEZONES = frozenset(
    line for line in Path(__file__).with_name("data").joinpath("timezones-v1.txt").read_text().splitlines()
    if line and not line.startswith("#")
)


def validate_timezone(value: str) -> str:
    if value not in SUPPORTED_TIMEZONES:
        raise ValueError("must be a supported IANA timezone such as Asia/Jerusalem or UTC")
    return value
