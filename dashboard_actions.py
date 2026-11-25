"""Validated page actions shared by the loopback server and native MCP App."""

from dataclasses import dataclass
from typing import Annotated, Callable

from pydantic import Field

from activity import ActivityEvents, ActivityScope
from exports import ExportSelection, export_history, preview_export
from desktop_actions import ACCOUNT_ACTIONS, account_action
import speech
from store import (Kind, Language, Patch, RecordId, Revision, SceneName, SettingsPatch,
                   Status, Store, StrictModel, Title)


class Query(StrictModel):
    keyword: Title | None = None
    kind: Kind | None = None
    scene: SceneName | None = None
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


class SceneScope(StrictModel):
    language: Language | None = None
    kind: Kind | None = None
    include_variants: bool = False


@dataclass(frozen=True)
class Action:
    arguments: type[StrictModel]
    execute: Callable

    def call(self, store, arguments):
        return self.execute(store, self.arguments.model_validate(arguments))


def _activity_call(store, name, *arguments):
    operation = getattr(store, name, None)
    if not callable(operation):
        from desktop_store import CloudFeatureUnavailable
        raise CloudFeatureUnavailable("learning_activity")
    return operation(*arguments)


# Keep the allowlist, argument schema and operation together. No arbitrary Store
# method names or paths from a client are ever executed.
ACTIONS = {
    "activity/read": Action(ActivityScope, lambda store, scope: _activity_call(store, "activity", scope.timezone)),
    "activity/events": Action(ActivityEvents, lambda store, batch: _activity_call(store, "activity_events", batch.model_dump(mode="json"))),
    "speech/play": Action(PointReference, lambda store, point: speech.play(store, point.record_id)),
    "speech/status": Action(StrictModel, lambda store, _: speech.status()),
    "changes/read": Action(StrictModel, lambda store, _: store.versions()),
    "settings/read": Action(StrictModel, lambda store, _: store.settings()),
    "settings/update": Action(SettingsPatch, lambda store, patch: store.settings(patch)),
    "languages/list": Action(StrictModel, lambda store, _: store.languages()),
    "scenes/list": Action(SceneScope, lambda store, scope: store.scenes(**scope.model_dump())),
    "exports/preview": Action(ExportSelection, preview_export),
    "exports/history": Action(ExportSelection, export_history),
    "points/query": Action(Query, lambda store, query: store.query(**query.model_dump())),
    "points/read": Action(PointReference, lambda store, point: store.get_point(point.record_id)),
    "points/update": Action(PointUpdate, lambda store, update: store.update(
        update.record_id, update.patch, update.expected_revision)),
    "points/delete": Action(PointReference, lambda store, point: store.delete(point.record_id)),
}


def dispatch(store: Store, request):
    if (not isinstance(request, dict) or not {"action", "arguments"}.issubset(request)
            or not set(request).issubset({"action", "arguments", "expected_epoch"})):
        raise ValueError("Invalid envelope")
    name = request["action"]
    if isinstance(name, str) and name in ACCOUNT_ACTIONS:
        return account_action(store, name, request["arguments"])
    if not isinstance(name, str) or name not in ACTIONS:
        raise ValueError("Unknown action")
    expected = request.get("expected_epoch")
    if expected is not None and (type(expected) is not int or expected < 0):
        raise ValueError("Invalid account epoch")
    binder = getattr(store, "expect_epoch", None)
    if binder is not None:
        with binder(expected, require_cloud=name in {"settings/update", "points/update", "points/delete", "activity/read", "activity/events", "exports/preview", "exports/history"}):
            return ACTIONS[name].call(store, request["arguments"])
    return ACTIONS[name].call(store, request["arguments"])
