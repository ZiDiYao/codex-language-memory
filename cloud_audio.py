"""Strict page-only audio proxy. It never invokes platform speech or accepts text."""
from typing import Annotated

from pydantic import Field

from desktop_store import CloudFeatureUnavailable
from store import RecordId, StrictModel


class AudioRequest(StrictModel):
    record_id: RecordId
    expected_epoch: Annotated[int, Field(strict=True, ge=0)] | None = None


def audio_response(store, payload):
    request = AudioRequest.model_validate(payload)
    binder = getattr(store, "expect_epoch", None)
    if binder is None or not hasattr(store, "audio"):
        raise CloudFeatureUnavailable("cloud_speech")
    with binder(request.expected_epoch, require_cloud=True):
        result = store.audio(request.record_id)
    if result.get("status") == "not_found":
        return 404, {"error": "not_found"}, "application/json"
    if result.get("status") != "ok":
        code = result.get("error")
        if code not in ("speech_busy", "speech_language_unavailable", "speech_unavailable"):
            code = "speech_unavailable"
        return {"speech_busy": 429, "speech_language_unavailable": 422}.get(code, 503), {"error": code}, "application/json"
    body, mime = result.get("audio"), result.get("mime_type")
    if not isinstance(body, bytes) or not 0 < len(body) <= 2 * 1024 * 1024 or mime not in ("audio/wav", "audio/mpeg"):
        raise ValueError("Invalid audio response")
    return 200, body, mime
