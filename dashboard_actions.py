"""Validated page actions shared by the loopback server and native MCP App."""

from dataclasses import dataclass
from typing import Annotated, Callable

from pydantic import Field

from exports import ExportSelection, export_history, preview_export
from store import (Kind, Language, Patch, RecordId, Revision, SettingsPatch,
                   Status, Store, StrictModel, Title)


class Query(StrictModel):
    keyword: Title | None = None
    kind: Kind | None = None
    language: Language | None = None
    status: Status | None = None
    limit: Annotated[int, Field(ge=1)] = 20
    offset: Annotated[int, Field(ge=0)] = 0
    include_variants: bool = False
    cursor: Annotated[str, Field(max_length=300)] | None = None
    needs_enrichment: bool = False


class PointUpdate(StrictModel):
    record_id: RecordId
    patch: Patch
    expected_revision: Revision | None = None


class PointReference(StrictModel):
    record_id: RecordId


@dataclass(frozen=True)
class Action:
    arguments: type[StrictModel]
    execute: Callable

    def call(self, store, arguments):
        return self.execute(store, self.arguments.model_validate(arguments))


# Keep the allowlist, argument schema and operation together. No arbitrary Store
# method names or paths from a client are ever executed.
ACTIONS = {
    "changes/read": Action(StrictModel, lambda store, _: store.versions()),
    "settings/read": Action(StrictModel, lambda store, _: store.settings()),
    "settings/update": Action(SettingsPatch, lambda store, patch: store.settings(patch)),
    "languages/list": Action(StrictModel, lambda store, _: store.languages()),
    "exports/preview": Action(ExportSelection, preview_export),
    "exports/history": Action(ExportSelection, export_history),
    "points/query": Action(Query, lambda store, query: store.query(**query.model_dump())),
    "points/read": Action(PointReference, lambda store, point: store.get_point(point.record_id)),
    "points/update": Action(PointUpdate, lambda store, update: store.update(
        update.record_id, update.patch, update.expected_revision)),
    "points/delete": Action(PointReference, lambda store, point: store.delete(point.record_id)),
}


def dispatch(store: Store, request):
    if not isinstance(request, dict) or set(request) != {"action", "arguments"}:
        raise ValueError("Invalid envelope")
    name = request["action"]
    if not isinstance(name, str) or name not in ACTIONS:
        raise ValueError("Unknown action")
    return ACTIONS[name].call(store, request["arguments"])
