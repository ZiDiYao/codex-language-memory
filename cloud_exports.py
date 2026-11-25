"""Bounded, account-bound cloud snapshots and local receipt metadata only."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import re
import time
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field

from exports import ExportError, ExportSelection
from store import Kind, Language, SceneName, Status, StrictModel, Title

MAX_RECORDS = 10_000
MAX_SOURCE_BYTES = 16 * 1024 * 1024
EXPORT_BUDGET = 50.0


class ExportPageQuery(StrictModel):
    keyword: Title | None = None
    kind: Kind | None = None
    language: Language | None = None
    status: Status | None = None
    scene: SceneName | None = None
    include_variants: bool = True
    limit: Literal[50] = 50
    cursor: Annotated[str, Field(min_length=1, max_length=300)] | None = None


class ExportReceipt(StrictModel):
    exported_at: Annotated[AwareDatetime, Field(strict=False)]
    through_at: Annotated[AwareDatetime, Field(strict=False)]
    start_at: Annotated[AwareDatetime, Field(strict=False)] | None = None
    format: Literal["pdf", "xlsx", "docx", "notion", "json"]
    count: Annotated[int, Field(ge=0, le=MAX_RECORDS)]


def _connected(account, epoch):
    from desktop_store import CloudAccountUnavailable
    status = account.status()
    if status.get("epoch") != epoch or status.get("mode") != "cloud":
        raise CloudAccountUnavailable("account_changed")
    if status.get("state") != "connected":
        raise CloudAccountUnavailable()


def _date(value):
    if not isinstance(value, str):
        raise ExportError("exportChanged")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise ExportError("exportChanged") from None


def export_records(account, *, expected_epoch, **filters):
    selection = ExportSelection.model_validate(filters)
    _connected(account, expected_epoch)
    fingerprint = account.account_fingerprint(expected_epoch=expected_epoch)
    deadline = time.monotonic() + EXPORT_BUDGET
    source_bytes = 0

    def read(path, params=None):
        nonlocal source_bytes
        _connected(account, expected_epoch)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ExportError("exportTimeout")
        if source_bytes >= MAX_SOURCE_BYTES:
            raise ExportError("exportTooLarge")
        reply = account.request_export_page(path, params=params, expected_epoch=expected_epoch,
            budget=remaining, max_bytes=MAX_SOURCE_BYTES - source_bytes)
        _connected(account, expected_epoch)
        if (not isinstance(reply, dict) or reply.get("identity") != fingerprint
                or reply.get("epoch") != expected_epoch or type(reply.get("source_bytes")) is not int
                or reply["source_bytes"] < 1 or not isinstance(reply.get("data"), dict)):
            raise ExportError("exportChanged")
        source_bytes += reply["source_bytes"]
        if source_bytes > MAX_SOURCE_BYTES:
            raise ExportError("exportTooLarge")
        if time.monotonic() > deadline:
            raise ExportError("exportTimeout")
        return reply["data"]

    def version():
        value = read("/v1/changes").get("content")
        if type(value) is not int or value < 0:
            raise ExportError("exportChanged")
        return value

    before = version()
    params = {name: getattr(selection, name) for name in
              ("keyword", "kind", "language", "status", "scene", "include_variants")}
    params["limit"] = 50
    kinds = set(selection.kinds or ([selection.kind] if selection.kind else []))
    identifiers = set(selection.record_ids) if selection.record_ids else None
    found, seen_ids, cursors, scanned = [], set(), set(), 0
    while True:
        page = read("/v1/points", params)
        rows, more, cursor = page.get("records"), page.get("has_more"), page.get("next_cursor")
        if not isinstance(rows, list) or len(rows) > 50 or type(more) is not bool:
            raise ExportError("exportChanged")
        scanned += len(rows)
        if scanned > MAX_RECORDS:
            raise ExportError("exportTooLarge")
        for row in rows:
            if (not isinstance(row, dict) or type(row.get("id")) is not int
                    or not 0 < row["id"] <= 9007199254740991 or row["id"] in seen_ids
                    or row.get("kind") not in ("word", "expression", "grammar", "correction")
                    or not isinstance(row.get("title"), str) or not isinstance(row.get("language"), str)
                    or row.get("status") not in ("new", "mastered")
                    or type(row.get("note_is_custom")) is not bool or not isinstance(row.get("examples"), list)):
                raise ExportError("exportChanged")
            seen_ids.add(row["id"])
            created, encountered = _date(row.get("created_at")), _date(row.get("last_seen_at"))
            if kinds and row["kind"] not in kinds:
                continue
            if identifiers is not None and row["id"] not in identifiers:
                continue
            value = created if selection.date_field == "created_at" else encountered
            if selection.start_at is not None and value < selection.start_at:
                continue
            if selection.end_at is not None and value >= selection.end_at:
                continue
            found.append(row)
        if not more:
            if cursor is not None:
                raise ExportError("exportChanged")
            break
        if (not rows or not isinstance(cursor, str) or not 0 < len(cursor) <= 300 or cursor in cursors):
            raise ExportError("exportChanged")
        cursors.add(cursor)
        params = {**params, "cursor": cursor}
    if version() != before:
        raise ExportError("exportChanged")
    _connected(account, expected_epoch)
    if account.account_fingerprint(expected_epoch=expected_epoch) != fingerprint:
        raise ExportError("exportChanged")
    return found


def export_receipt(account, scope, receipt=None, *, expected_epoch):
    """Persist only bounded metadata under an authenticated account fingerprint."""
    from desktop_store import CloudAccountUnavailable
    if not isinstance(scope, str) or not 0 < len(scope.encode("utf-8")) <= 16384:
        raise ValueError("invalid_export_scope")
    _connected(account, expected_epoch)
    identity = account.account_fingerprint(expected_epoch=expected_epoch)
    if not isinstance(identity, str) or re.fullmatch(r"[a-f0-9]{64}", identity) is None:
        raise CloudAccountUnavailable("invalid_cloud_response")
    selected = ExportReceipt.model_validate(receipt).model_dump(mode="json") if receipt is not None else None
    scope_key = hashlib.sha256(scope.encode("utf-8")).hexdigest()
    with account.state.locked() as state:
        if state["epoch"] != expected_epoch or state["mode"] != "cloud":
            raise CloudAccountUnavailable("account_changed")
        if state["state"] != "connected":
            raise CloudAccountUnavailable()
        histories = state.get("export_receipts", {})
        if (not isinstance(histories, dict) or len(histories) > 8
                or any(not isinstance(key, str) or re.fullmatch(r"[a-f0-9]{64}", key) is None
                       or not isinstance(value, dict) or len(value) > 32 for key, value in histories.items())):
            raise ExportError("exportHistoryError")
        try:
            for scopes in histories.values():
                for key, value in scopes.items():
                    if not isinstance(key, str) or re.fullmatch(r"[a-f0-9]{64}", key) is None:
                        raise ValueError()
                    ExportReceipt.model_validate(value)
        except ValueError:
            raise ExportError("exportHistoryError") from None
        previous = histories.get(identity, {}).get(scope_key)
        if receipt is None:
            return ExportReceipt.model_validate(previous).model_dump(mode="json") if previous is not None else None
        # _StateFile's before snapshot is shallow: publish freshly copied
        # dictionaries so cross-process atomic persistence notices this update.
        updated = copy.deepcopy(histories)
        own = {**updated.get(identity, {}), scope_key: selected}
        while len(own) > 32:
            del own[min(own, key=lambda key: own[key].get("exported_at", ""))]
        updated[identity] = own
        while len(updated) > 8:
            oldest = min((key for key in updated if key != identity), key=lambda key:
                         max((item.get("exported_at", "") for item in updated[key].values()), default=""))
            del updated[oldest]
        state["export_receipts"] = updated
        return copy.deepcopy(selected)
