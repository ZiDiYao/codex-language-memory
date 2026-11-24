"""Cloud desktop facade; legacy SQLite routing is available only to explicit fixtures."""

from contextlib import contextmanager
from contextvars import ContextVar

from store import LearnerPreferences, Patch, Review, SettingsPatch, Store


class CloudFeatureUnavailable(ValueError):
    code = "cloud_feature_unavailable"

    def __init__(self, feature):
        self.feature = feature
        super().__init__(self.code)


class CloudAccountUnavailable(ValueError):
    def __init__(self, code="cloud_not_connected"):
        self.code = code
        super().__init__(code)


def _remote_id(value):
    if type(value) is not int or not 0 < value <= 9007199254740991:
        raise ValueError("invalid_record_id")
    return value


class RoutingStore:
    """Store-compatible facade shared by the desktop dashboard and MCP tools."""

    def __init__(self, local_store: Store | None, account_manager, *, cloud_only=True, migration=None):
        self._local = local_store
        self._account = account_manager
        self._cloud_only = cloud_only
        self._migration = migration
        self._expectation = ContextVar("sayrove_store_epoch", default=None)

    @property
    def account(self):
        return self._account

    def _snapshot(self):
        state = self._account.status()
        if (not isinstance(state, dict) or state.get("mode") not in ("local", "cloud")
                or state.get("state") not in ("signed_out", "connecting", "connected", "error")
                or type(state.get("epoch")) is not int or state["epoch"] < 0):
            raise CloudAccountUnavailable()
        if self._cloud_only and state["mode"] != "cloud":
            raise CloudAccountUnavailable()
        expectation = self._expectation.get()
        if expectation is not None:
            expected_epoch, require_cloud = expectation
            if require_cloud and state["mode"] == "cloud" and expected_epoch is None:
                raise CloudAccountUnavailable("connection_epoch_required")
            if expected_epoch is not None and expected_epoch != state["epoch"]:
                raise CloudAccountUnavailable("account_changed")
        return {key: state[key] for key in ("mode", "state", "epoch")}

    @contextmanager
    def expect_epoch(self, expected_epoch, require_cloud=False):
        """Bind a UI/tool request to its original data source.

        Legacy local operations can omit an epoch. Cloud mutations can require
        one, so a stale point ID cannot be applied to a different account.
        """
        if (expected_epoch is not None and (type(expected_epoch) is not int or expected_epoch < 0)
                or type(require_cloud) is not bool):
            raise ValueError("invalid_connection_epoch")
        inherited = self._expectation.get()
        if inherited is not None:
            previous_epoch, previous_required = inherited
            if previous_epoch is not None:
                if expected_epoch is not None and expected_epoch != previous_epoch:
                    raise CloudAccountUnavailable("account_changed")
                expected_epoch = previous_epoch
            require_cloud = require_cloud or previous_required
        token = self._expectation.set((expected_epoch, require_cloud))
        try:
            self._snapshot()
            yield self
        finally:
            self._expectation.reset(token)

    @staticmethod
    def _connected(snapshot):
        if snapshot["state"] != "connected":
            raise CloudAccountUnavailable()

    def _unchanged(self, snapshot):
        current = self._snapshot()
        if current["mode"] != snapshot["mode"] or current["epoch"] != snapshot["epoch"]:
            # A completed write may need an idempotent retry after the caller
            # rereads account state. Never return the previous account's data.
            raise CloudAccountUnavailable("account_changed")
        if current["mode"] == "cloud":
            self._connected(current)

    def connection_status(self):
        """Safe routing metadata only; no login URLs, tokens, or user claims."""
        return self._snapshot()

    @property
    def is_cloud(self):
        return self._snapshot()["mode"] == "cloud"

    def _local_snapshot(self, feature):
        snapshot = self._snapshot()
        if snapshot["mode"] == "cloud":
            self._connected(snapshot)
            raise CloudFeatureUnavailable(feature)
        return snapshot

    def require_local(self, feature):
        """Guard a desktop-only operation before accessing its SQLite store."""
        self._local_snapshot(feature)
        return self._local

    @property
    def path(self):
        self._local_snapshot("local_files")
        return self._local.path

    @property
    def database(self):
        return self.require_local("sqlite_database")

    @property
    def db(self):
        return self.require_local("sqlite_database")

    @contextmanager
    def connection(self, *, write=False):
        snapshot = self._local_snapshot("sqlite_connection")
        with self._local.connection(write=write) as database:
            yield database
            # Raise before SQLite commits if the account changed while a local
            # study transaction was open.
            self._unchanged(snapshot)

    @staticmethod
    def _response(value):
        if not isinstance(value, dict):
            raise CloudAccountUnavailable("invalid_cloud_response")
        return value

    def _tool(self, name, arguments, *, epoch):
        return self._response(self._account.call_tool(name, arguments, expected_epoch=epoch))

    def _api(self, path, *, epoch):
        return self._response(self._account.request_api("GET", path, expected_epoch=epoch))

    def _dispatch(self, method, *, arguments=(), keywords=None, cloud, metadata=False, migrate=True):
        snapshot = self._snapshot()
        if snapshot["mode"] == "local":
            value = getattr(self._local, method)(*arguments, **(keywords or {}))
        else:
            self._connected(snapshot)
            if migrate and self._migration is not None:
                self._migration.ensure(self._account, expected_epoch=snapshot["epoch"])
            value = cloud(snapshot["epoch"])
        self._unchanged(snapshot)
        if metadata:
            value = {**value, "_connection": snapshot}
        return value

    @staticmethod
    def _unsupported(feature):
        raise CloudFeatureUnavailable(feature)

    def versions(self):
        return self._dispatch("versions", cloud=lambda epoch: self._api("/v1/changes", epoch=epoch))

    def changes(self):
        return self.versions()

    def settings(self, patch: SettingsPatch | None = None):
        def cloud(epoch):
            return (self._tool("get_settings", {}, epoch=epoch) if patch is None else
                    self._tool("update_settings", {"patch": patch.model_dump(mode="json", exclude_unset=True)}, epoch=epoch))
        return self._dispatch("settings", arguments=(patch,), cloud=cloud, metadata=True)

    def capture_context(self):
        ready = self._migration is None or self._migration.capture_ready()
        result = self._dispatch("settings", cloud=lambda epoch: self._response(
            self._account.capture_context(expected_epoch=epoch)), metadata=True, migrate=False)
        return {**result, "_capture": {**result.get("_capture", {}), "capture_ready": ready}}

    def recording(self, enabled: bool | None = None):
        return self._dispatch("recording", arguments=(enabled,), cloud=lambda epoch: (
            self._tool("get_recording", {}, epoch=epoch) if enabled is None else self._tool("set_recording", {"enabled": enabled}, epoch=epoch)))

    def save(self, request_id, items, source="automatic"):
        if source == "automatic" and self._migration is not None and not self._migration.capture_ready():
            raise CloudAccountUnavailable("cloud_import_unavailable")
        return self._dispatch("save", arguments=(request_id, items, source), cloud=lambda epoch: self._tool(
            "save_points", {"request_id": request_id, "items": items, "source": source}, epoch=epoch), migrate=source != "automatic")

    def capture(self, request_id, items, source="automatic"):
        """Persist observed learning gaps; enrichment belongs to the cloud worker."""
        snapshot = self._snapshot()
        if snapshot["mode"] != "cloud":
            raise CloudFeatureUnavailable("lightweight_capture")
        if source == "automatic" and self._migration is not None and not self._migration.capture_ready():
            raise CloudAccountUnavailable("cloud_import_unavailable")
        return self._dispatch("capture", cloud=lambda epoch: self._tool(
            "capture_points", {"request_id": request_id, "items": items, "source": source}, epoch=epoch),
            migrate=source != "automatic")

    def capture_with_context(self, request_id, items, source="automatic"):
        """One cloud transaction returns the receipt and confirmed preferences."""
        snapshot = self._snapshot()
        if snapshot["mode"] != "cloud":
            raise CloudFeatureUnavailable("single_call_capture")
        if source == "automatic" and self._migration is not None and not self._migration.capture_ready():
            raise CloudAccountUnavailable("cloud_import_unavailable")
        return self._dispatch("capture_with_context", cloud=lambda epoch: self._tool(
            "capture_and_context", {"request_id": request_id, "items": items, "source": source}, epoch=epoch),
            metadata=True, migrate=source != "automatic")

    def query(self, *, keyword=None, kind=None, language=None, status=None, scene=None, limit=10, offset=0,
              include_variants=False, cursor=None, needs_enrichment=False):
        filters = dict(keyword=keyword, kind=kind, language=language, status=status, scene=scene, limit=limit,
                       offset=offset, include_variants=include_variants, cursor=cursor, needs_enrichment=needs_enrichment)
        return self._dispatch("query", keywords=filters, cloud=lambda epoch: self._tool("find_points", filters, epoch=epoch))

    def scenes(self, *, language=None, kind=None, include_variants=False):
        filters = dict(language=language, kind=kind, include_variants=include_variants)
        return self._dispatch("scenes", keywords=filters, cloud=lambda epoch: self._tool("list_scenes", filters, epoch=epoch))

    def languages(self):
        return self._dispatch("languages", cloud=lambda epoch: self._tool("list_languages", {}, epoch=epoch))

    def get_point(self, record_id):
        return self._dispatch("get_point", arguments=(record_id,),
                              cloud=lambda epoch: self._api(f"/v1/points/{_remote_id(record_id)}", epoch=epoch))

    def update(self, record_id, patch: Patch, expected_revision=None):
        return self._dispatch("update", arguments=(record_id, patch, expected_revision), cloud=lambda epoch: self._tool(
            "update_point", {"record_id": record_id, "patch": patch.model_dump(mode="json", exclude_unset=True),
                             "expected_revision": expected_revision}, epoch=epoch))

    def delete(self, record_id):
        return self._dispatch("delete", arguments=(record_id,), cloud=lambda epoch: self._tool("delete_point", {"record_id": record_id}, epoch=epoch))

    def review(self, *, language=None, kind=None, scene=None, limit=5, include_variants=False, include_upcoming=False,
               exclude_ids=None, _db=None):
        filters = dict(language=language, kind=kind, scene=scene, limit=limit, include_variants=include_variants,
                       include_upcoming=include_upcoming, exclude_ids=exclude_ids)
        def cloud(epoch):
            if _db is not None:
                raise CloudFeatureUnavailable("sqlite_transaction")
            return self._tool("review_queue", filters, epoch=epoch)
        return self._dispatch("review", keywords={**filters, "_db": _db}, cloud=cloud)

    def record_review(self, record_id, request_id, review: Review):
        return self._dispatch("record_review", arguments=(record_id, request_id, review), cloud=lambda epoch: self._tool(
            "record_review", {"record_id": record_id, "request_id": request_id, "review": review.model_dump(mode="json")}, epoch=epoch))

    def _record_review(self, database, record_id, request_id, review):
        return self._dispatch("_record_review", arguments=(database, record_id, request_id, review),
                              cloud=lambda _epoch: self._unsupported("sqlite_transaction"))

    def history(self, record_id, *, limit=20, before_encounter_id=None, before_review_id=None):
        return self._dispatch("history", arguments=(record_id,), keywords=dict(limit=limit,
            before_encounter_id=before_encounter_id, before_review_id=before_review_id),
            cloud=lambda _epoch: self._unsupported("point_history"))

    def learning_preferences(self, language=None, patch: LearnerPreferences | None = None):
        return self._dispatch("learning_preferences", arguments=(language, patch),
                              cloud=lambda _epoch: self._unsupported("learning_preferences"))

    def learning_profile(self, *, language=None, include_variants=False):
        return self._dispatch("learning_profile", keywords=dict(language=language, include_variants=include_variants),
                              cloud=lambda _epoch: self._unsupported("learning_profile"))

    def export_records(self, *, kinds=None, date_field="created_at", start_at=None, end_at=None, **filters):
        return self._dispatch("export_records", keywords=dict(kinds=kinds, date_field=date_field,
            start_at=start_at, end_at=end_at, **filters), cloud=lambda _epoch: self._unsupported("export"))

    def export_receipt(self, scope, receipt=None):
        return self._dispatch("export_receipt", arguments=(scope, receipt), cloud=lambda _epoch: self._unsupported("export"))
