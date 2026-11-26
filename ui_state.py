"""Small account-bound library view state; never part of learning data or MCP tools."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
import threading
from typing import Annotated

from pydantic import Field, StringConstraints, field_validator

from store import Kind, Language, SceneName, Status, StrictModel, Title


FilterKey = Annotated[str, StringConstraints(min_length=1, max_length=1500)]
SafeId = Annotated[int, Field(ge=1, le=9007199254740991)]
LatestId = Annotated[int, Field(ge=0, le=9007199254740991)]


class HistoryFilters(StrictModel):
    keyword: Title | None = None
    kind: Kind | None = None
    scene: SceneName | None = None
    language: Language | None = None
    status: Status | None = None
    include_variants: bool = False
    needs_enrichment: bool = False


class HistoryView(StrictModel):
    anchor_id: SafeId | None = None
    anchor_top: Annotated[float, Field(ge=-1000000, le=1000000, allow_inf_nan=False)] = 0
    scroll_y: Annotated[float, Field(ge=0, le=100000000, allow_inf_nan=False)]
    loaded_count: Annotated[int, Field(ge=1, le=2000)]
    expanded_ids: Annotated[list[SafeId], Field(max_length=100)]
    latest_point_id: LatestId

    @field_validator("expanded_ids")
    @classmethod
    def unique_expanded_ids(cls, values):
        return list(dict.fromkeys(values))


class HistoryViewRead(StrictModel):
    filter_key: FilterKey | None = None


class HistoryViewWrite(StrictModel):
    filter_key: FilterKey
    filters: HistoryFilters
    view: HistoryView


_thread_locks = {}
_thread_locks_guard = threading.Lock()
_MAX_FILE_BYTES = 256 * 1024
_MAX_FILTERS = 20


class HistoryViewUnavailable(ValueError):
    code = "history_view_unavailable"

    def __init__(self):
        super().__init__(self.code)


@contextmanager
def _locked(path):
    """Serialize independent native/loopback processes as well as their threads."""
    canonical = str(path.resolve())
    with _thread_locks_guard:
        lock = _thread_locks.setdefault(canonical, threading.RLock())
    with lock, _safe_io():
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(path.with_suffix(path.suffix + ".lock"),
                             os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        acquired = False
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"\0")
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            acquired = True
            yield
        finally:
            try:
                if acquired:
                    if os.name == "nt":
                        os.lseek(descriptor, 0, os.SEEK_SET)
                        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)


@contextmanager
def _safe_io():
    try:
        yield
    except OSError:
        raise HistoryViewUnavailable() from None


class HistoryViewState:
    def __init__(self, path):
        self.path = Path(path)

    def _read(self, scope):
        try:
            if self.path.stat().st_size > _MAX_FILE_BYTES:
                return {}
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if (not isinstance(value, dict) or value.get("format") != 1 or value.get("scope") != scope
                    or not isinstance(value.get("entries"), dict) or len(value["entries"]) > _MAX_FILTERS):
                return {}
            return value
        except (OSError, ValueError, UnicodeError):
            return {}

    @staticmethod
    def _entry(filter_key, value):
        if not value:
            return {"filter_key": filter_key, "filters": None, "view": None}
        try:
            entry = HistoryViewWrite.model_validate({**value, "filter_key": filter_key})
            return entry.model_dump(mode="json")
        except (ValueError, TypeError):
            return {"filter_key": filter_key, "filters": None, "view": None}

    def read(self, scope, filter_key=None, *, guard=lambda: None):
        request = HistoryViewRead(filter_key=filter_key)
        with _locked(self.path):
            guard()
            value = self._read(scope)
            selected = request.filter_key if request.filter_key is not None else value.get("last_filter")
            if selected is not None:
                try:
                    selected = HistoryViewRead(filter_key=selected).filter_key
                except ValueError:
                    selected = None
            entry = value.get("entries", {}).get(selected) if selected is not None else None
            result = self._entry(selected, entry)
            guard()
            return result

    def write(self, scope, request, *, guard=lambda: None):
        request = HistoryViewWrite.model_validate(request)
        entry = request.model_dump(mode="json")
        with _locked(self.path):
            guard()
            previous = self._read(scope)
            entries = previous.get("entries", {})
            entries.pop(request.filter_key, None)
            entries[request.filter_key] = {"filters": entry["filters"], "view": entry["view"]}
            entries = dict(list(entries.items())[-_MAX_FILTERS:])
            value = {"format": 1, "scope": scope, "last_filter": request.filter_key, "entries": entries}
            encoded = json.dumps(value, ensure_ascii=True, allow_nan=False).encode("utf-8")
            while len(encoded) > _MAX_FILE_BYTES and len(entries) > 1:
                entries.pop(next(iter(entries)))
                encoded = json.dumps(value, ensure_ascii=True, allow_nan=False).encode("utf-8")
            if len(encoded) > _MAX_FILE_BYTES:
                raise ValueError("Invalid history view size")
            descriptor, temporary = tempfile.mkstemp(prefix=".history-view-", dir=self.path.parent)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                guard()  # Keep the original epoch check adjacent to the atomic commit.
                os.replace(temporary, self.path)
                guard()
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return entry
