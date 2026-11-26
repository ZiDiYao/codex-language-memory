"""UI-only view metadata fixtures; never write to an actual account or learning store."""
import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from dashboard_actions import dispatch
from desktop_store import CloudAccountUnavailable, RoutingStore
from mcp_app import AppTransport
from store import Patch, SettingsPatch, Store
from ui_state import HistoryViewRead, HistoryViewState, HistoryViewWrite
from test_memory import APPROACH


def position(**changes):
    return {"anchor_id": 12, "anchor_top": -25.5, "scroll_y": 900,
            "loaded_count": 40, "expanded_ids": [12, 19], "latest_point_id": 22, **changes}


def payload(key="all", **changes):
    return {"filter_key": key, "filters": {"language": "en", "kind": None}, "view": position(**changes)}


class LocalHistoryViewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "memory.sqlite3"
        self.store = Store(self.path)

    def call(self, name, arguments=None):
        return dispatch(self.store, {"action": name, "arguments": arguments or {}})

    def test_metadata_survives_a_new_page_and_store_without_learning_writes(self):
        before = self.store.versions()
        self.assertEqual(self.call("history/view/read"), {"filter_key": None, "filters": None, "view": None})
        self.call("history/view/write", payload())
        self.call("history/view/write", {**payload("word"), "filters": {"language": "en", "kind": "word"}})
        reopened = Store(self.path)
        restored = reopened.history_view_read()
        self.assertEqual(restored["filter_key"], "word")
        self.assertEqual(restored["filters"]["kind"], "word")
        self.assertEqual(restored["view"], position())
        self.assertEqual(reopened.history_view_read("all")["view"], position())
        self.assertIsNone(reopened.history_view_read("different")["view"])
        self.assertEqual(self.store.versions(), before)
        self.assertEqual(self.store.query()["records"], [])
        self.assertTrue(self.path.with_suffix(".sqlite3.ui-state.json").is_file())

    def test_latest_point_id_changes_only_for_the_newest_existing_record(self):
        self.assertEqual(self.store.versions()["latest_point_id"], 0)
        first = self.store.save("history-first", [APPROACH])["results"][0]["id"]
        self.assertEqual(self.store.versions()["latest_point_id"], first)
        self.store.update(first, Patch(note="fixture edit"))
        self.store.settings(SettingsPatch(ui_language="fr"))
        self.assertEqual(self.store.versions()["latest_point_id"], first)
        second = self.store.save("history-next", [{**APPROACH, "title": "different fixture target"}])["results"][0]["id"]
        self.assertGreater(second, first)
        self.assertEqual(self.store.versions()["latest_point_id"], second)
        self.store.delete(second)
        self.assertEqual(self.store.versions()["latest_point_id"], first)

    def test_filters_and_positions_are_strict_and_bounded(self):
        for invalid in (payload(anchor_id=True), payload(anchor_id=-1), payload(loaded_count=0),
                        payload(loaded_count=2001), payload(scroll_y=-1), payload(scroll_y=float("inf")),
                        payload(anchor_top=float("nan")), payload(latest_point_id=True),
                        payload(expanded_ids=list(range(1, 102))), payload(expanded_ids=[1, "2"]),
                        {**payload(), "path": "/not/a/client/path"},
                        {**payload(), "filters": {"language": "en", "offset": 20}},
                        {**payload(), "view": {**position(), "note": "not metadata"}},
                        {**payload(), "filter_key": "x" * 1501}):
            with self.subTest(payload=str(invalid)[:60]), self.assertRaises(ValidationError):
                self.call("history/view/write", invalid)
        for invalid in ({"account_id": "untrusted"}, {"path": "somewhere"}, {"filter_key": ""}):
            with self.assertRaises(ValidationError):
                HistoryViewRead.model_validate(invalid)
        self.assertIsNone(self.call("history/view/read")["view"])

    def test_concurrent_writers_keep_complete_bounded_filter_entries(self):
        state_path = self.path.with_suffix(".sqlite3.ui-state.json")
        with ThreadPoolExecutor(max_workers=8) as workers:
            list(workers.map(lambda index: HistoryViewState(state_path).write("local", payload(str(index))), range(30)))
        contents = json.loads(state_path.read_text())
        self.assertEqual(len(contents["entries"]), 20)
        for key, entry in contents["entries"].items():
            self.assertEqual(HistoryViewWrite.model_validate({"filter_key": key, **entry}).view.scroll_y, 900)
        self.assertEqual(HistoryViewState(state_path).read("local")["view"], position())
        self.assertLessEqual(state_path.stat().st_size, 256 * 1024)

    def test_invalid_or_different_scope_files_do_not_restore_old_views(self):
        state_path = self.path.with_suffix(".sqlite3.ui-state.json")
        state = HistoryViewState(state_path)
        for contents in ("not JSON", json.dumps({"format": 1, "scope": "different", "entries": {}}),
                         json.dumps({"format": 1, "scope": "local", "last_filter": "bad", "entries": {
                             "bad": {"view": {"scroll_y": -1}}}})):
            state_path.write_text(contents)
            self.assertIsNone(state.read("local")["view"])
        state.write("local", payload())
        self.assertEqual(state.read("local")["view"], position())


class ForbiddenStore:
    def __getattr__(self, name):
        raise AssertionError("cloud UI view accessed learning database: " + name)


class HistoryAccount:
    def __init__(self, path):
        self.state = SimpleNamespace(path=path)
        self.epoch = 7
        self.connected = True

    def status(self):
        return {"mode": "cloud", "state": "connected" if self.connected else "signed_out", "epoch": self.epoch}


class CloudHistoryViewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.account = HistoryAccount(Path(temporary.name) / "desktop-account.json")
        self.store = RoutingStore(ForbiddenStore(), self.account, migration=ForbiddenStore())
        self.bridge = AppTransport(self.store)

    def call(self, action, arguments=None, epoch=7):
        return self.bridge.request("api", {"action": action, "arguments": arguments or {}, "expected_epoch": epoch})

    def test_page_actions_require_the_current_connected_epoch_and_never_use_network(self):
        for action, arguments in (("history/view/read", {}), ("history/view/write", payload())):
            for epoch, error in ((None, "connection_epoch_required"), (6, "account_changed")):
                self.assertEqual(self.call(action, arguments, epoch), {"status": 409, "data": {"error": error}})
        self.assertEqual(self.call("history/view/write", payload())["status"], 200)
        reopened = AppTransport(RoutingStore(ForbiddenStore(), self.account))
        result = reopened.request("api", {"action": "history/view/read", "arguments": {}, "expected_epoch": 7})
        self.assertEqual(result["data"]["view"], position())
        self.account.connected = False
        self.assertEqual(self.call("history/view/read")["status"], 401)

    def test_account_switch_never_restores_or_accepts_the_previous_accounts_position(self):
        self.call("history/view/write", payload())
        self.account.epoch += 1
        self.assertEqual(self.call("history/view/write", payload(scroll_y=2000))["status"], 409)
        self.assertIsNone(self.call("history/view/read", epoch=8)["data"]["view"])
        self.assertEqual(self.call("history/view/write", payload("new-account", scroll_y=20), epoch=8)["status"], 200)
        self.assertEqual(self.call("history/view/read", epoch=8)["data"]["view"]["scroll_y"], 20)

    def test_change_immediately_before_atomic_replace_discards_the_old_pending_write(self):
        import ui_state
        original = ui_state.os.fsync
        def switch(descriptor):
            original(descriptor)
            self.account.epoch += 1
        with patch.object(ui_state.os, "fsync", side_effect=switch):
            self.assertEqual(self.call("history/view/write", payload())["status"], 409)
        self.assertIsNone(self.call("history/view/read", epoch=8)["data"]["view"])
        self.assertFalse(self.account.state.path.with_suffix(".json.ui-state.json").exists())

    def test_change_while_reading_drops_the_previous_accounts_view(self):
        self.call("history/view/write", payload())
        original = HistoryViewState._read
        def switch(state, scope):
            value = original(state, scope)
            self.account.epoch += 1
            return value
        with patch.object(HistoryViewState, "_read", switch):
            self.assertEqual(self.call("history/view/read")["status"], 409)

    def test_failed_disk_write_keeps_previous_view_and_returns_a_safe_error(self):
        self.call("history/view/write", payload())
        with patch("ui_state.os.replace", side_effect=PermissionError("private filesystem detail")):
            result = self.call("history/view/write", payload(scroll_y=42))
        self.assertEqual(result, {"status": 503, "data": {"error": "history_view_unavailable"}})
        self.assertEqual(self.call("history/view/read")["data"]["view"], position())


if __name__ == "__main__":
    unittest.main()
