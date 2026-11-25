"""Strict page-only activity envelopes; no notes or arbitrary client metadata."""
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, field_validator

from store import StrictModel


class ActivityScope(StrictModel):
    # The backend is authoritative for the supported IANA timezone names.
    timezone: Annotated[str, Field(strict=True, min_length=1, max_length=80,
        pattern=r"^[A-Za-z0-9_+.-]+(?:/[A-Za-z0-9_+.-]+){0,3}$")] = "UTC"


class ActivityEvent(StrictModel):
    event_id: Annotated[str, Field(strict=True,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    kind: Literal["button", "pronunciation"]
    occurred_at: Annotated[AwareDatetime, Field(strict=False)]

    @field_validator("occurred_at", mode="before")
    @classmethod
    def timestamp_string(cls, value):
        if not isinstance(value, str) or len(value) > 64:
            raise ValueError("Expected an ISO timestamp with timezone")
        return value


class ActivityEvents(StrictModel):
    events: Annotated[list[ActivityEvent], Field(min_length=1, max_length=20)]
