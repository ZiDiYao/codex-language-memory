import copy
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from desktop_store import CloudAccountUnavailable, CloudFeatureUnavailable, RoutingStore
from store import LearnerPreferences, Patch, Review, SettingsPatch, Store
from study import StudySessions


POINT = {
    "kind": "word", "language": "en", "title": "rinse", "sense_key": "wash with water",
    "meaning": "Wash something with clean water.", "explanation": "Use rinse when removing soap or dirt with water.",
    "examples": [{"text": "Rinse the cup."}, {"text": "Rinse your hands with clean water."}],
    "scenes": ["Cleaning & hygiene"],
}


class FakeAccount:
    def __init__(self, mode="cloud", state="connected"):
        self.mode, self.state, self.epoch = mode, state, 1
        self.calls = []
        self.after_call = None
        self.failure = None
        self.responses = {}
        self.expected_epochs = []

    def status(self):
        return {"mode": self.mode, "state": self.state, "epoch": self.epoch,
                "authorization_url": "https://issuer.example/authorize?state=not-for-settings",
                "access_token": "not-a-real-token", "subject": "not-for-settings"}

    def _check_epoch(self, expected_epoch):
        self.expected_epochs.append(expected_epoch)
        if expected_epoch != self.epoch:
            raise CloudAccountUnavailable("account_changed")

    def call_tool(self, name, arguments, *, expected_epoch=None):
        self._check_epoch(expected_epoch)
        self.calls.append((name, copy.deepcopy(arguments)))
        if self.failure:
            raise self.failure
        if self.after_call:
            self.after_call()
        defaults = {
            "get_settings": {"enabled": True, "ui_language": "zh", "first_language": None},
            "update_settings": {"enabled": True, "ui_language": "zh", **arguments.get("patch", {})},
            "get_recording": {"enabled": True}, "set_recording": {"enabled": arguments.get("enabled")},
            "save_points": {"status": "processed", "replayed": False, "results": [{"status": "added", "id": 900}]},
            "find_points": {"records": [{"id": 900, "title": "Cloud note"}], "has_more": False, "next_cursor": None},
            "list_scenes": {"scenes": [{"name": "Cloud scene", "count": 1}], "total": 1},
            "list_languages": {"languages": ["fr"], "counts": {"fr": 1}, "kinds": {"word": 1}, "by_language": {"fr": {"word": 1}}},
            "update_point": {"status": "updated", "record": {"id": arguments.get("record_id")}},
            "delete_point": {"status": "deleted", "id": arguments.get("record_id")},
            "review_queue": {"records": [{"id": 900}], "counts": {"due": 1}},
            "record_review": {"status": "reviewed", "scheduled": True, "replayed": False},
        }
        return copy.deepcopy(self.responses.get(name, defaults[name]))

    def request_api(self, method, path, params=None, json=None, *, expected_epoch=None):
        self._check_epoch(expected_epoch)
        self.calls.append((method, path, params, json))
        if self.failure:
            raise self.failure
        if self.after_call:
            self.after_call()
        if path == "/v1/changes":
            return {"content": 20, "preferences": 3}
        return ({"status": "found", "record": {"id": 900, "title": "Cloud note"}}
                if path == "/v1/points/900" else {"status": "not_found"})


class ForbiddenLocal:
    def __getattr__(self, name):
        raise AssertionError("cloud operation touched SQLite")


class DesktopRoutingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.local = Store(Path(directory.name) / "memory.sqlite3")

    def test_local_mode_preserves_store_records_preferences_and_desktop_features(self):
        account = FakeAccount("local", "signed_out")
        routed = RoutingStore(self.local, account, cloud_only=False)
        self.assertIs(routed.account, account)
        self.assertFalse(routed.is_cloud)
        self.assertIs(routed.database, self.local)
        self.assertIs(routed.db, self.local)
        self.assertEqual(routed.path, self.local.path)
        settings = routed.settings(SettingsPatch(first_language="ja", enabled=True))
        self.assertEqual({key: value for key, value in settings.items() if key != "_connection"}, self.local.settings())
        self.assertEqual(settings["_connection"], {"mode": "local", "state": "signed_out", "epoch": 1})
        self.assertEqual(routed.recording(), {"enabled": True})
        result = routed.save("local-encounter", [POINT], "explicit")
        identifier = result["results"][0]["id"]
        self.assertEqual(routed.query(), self.local.query())
        self.assertEqual(routed.scenes(), self.local.scenes())
        self.assertEqual(routed.languages(), self.local.languages())
        original = routed.get_point(identifier)["record"]
        self.assertEqual(routed.update(identifier, Patch(note="My editable note"), original["revision"])["status"], "updated")
        self.assertEqual(routed.record_review(identifier, "local-review", Review(result="correct", answer="wash with water"))["status"], "reviewed")
        self.assertEqual(routed.history(identifier)["record"], self.local.get_point(identifier)["record"])
        routed.learning_preferences("en", LearnerPreferences(learning_goal="Everyday conversation"))
        self.assertEqual(routed.learning_profile(language="en"), self.local.learning_profile(language="en"))
        self.assertEqual(routed.export_records(), self.local.export_records())
        self.assertIsNone(routed.export_receipt("local-export"))
        self.assertEqual(routed.export_receipt("local-export", {"count": 1}), {"count": 1})
        self.assertEqual(routed.versions(), self.local.versions())
        self.assertEqual(routed.changes(), self.local.versions())
        self.assertEqual(StudySessions(routed).get(), {"status": "not_found"})
        self.assertEqual(routed.delete(identifier)["status"], "deleted")
        self.assertEqual(account.calls, [])

    def test_cloud_routes_all_twelve_tools_without_changing_local_sqlite(self):
        self.local.save("already-local", [POINT])
        before = self.local.path.read_bytes()
        account = FakeAccount()
        routed = RoutingStore(self.local, account, cloud_only=False)
        self.assertTrue(routed.is_cloud)
        settings = routed.settings()
        self.assertEqual(settings["ui_language"], "zh")
        self.assertEqual(settings["_connection"], {"mode": "cloud", "state": "connected", "epoch": 1})
        self.assertNotIn("authorization_url", settings["_connection"])
        routed.settings(SettingsPatch(explanation_language=None))
        routed.recording()
        routed.recording(False)
        original_items = copy.deepcopy([POINT])
        routed.save("cloud-save-once", original_items, "explicit")
        self.assertEqual(original_items, [POINT])
        self.assertEqual(routed.query(keyword="rinse", language="en", kind="word", scene="Kitchen", status="new",
                                      limit=2, offset=4, include_variants=True, needs_enrichment=True)["records"][0]["id"], 900)
        routed.scenes(language="en", kind="word", include_variants=True)
        self.assertEqual(routed.languages()["languages"], ["fr"])
        revision = "a" * 64
        routed.update(900, Patch(context=None, scenes=[]), revision)
        routed.delete(900)
        routed.review(language="en", scene="Kitchen", exclude_ids=[1, 2], include_upcoming=True)
        routed.record_review(900, "cloud-review-once", Review(result="correct", assisted=True, answer="wash"))
        self.assertEqual({name for name, _ in account.calls}, {
            "get_settings", "update_settings", "get_recording", "set_recording", "save_points", "find_points",
            "list_scenes", "list_languages", "update_point", "delete_point", "review_queue", "record_review"})
        calls = dict(account.calls)
        self.assertEqual(calls["update_settings"], {"patch": {"explanation_language": None}})
        self.assertEqual(calls["update_point"], {"record_id": 900, "patch": {"context": None, "scenes": []}, "expected_revision": revision})
        self.assertEqual(calls["save_points"], {"request_id": "cloud-save-once", "items": [POINT], "source": "explicit"})
        self.assertEqual(calls["find_points"], dict(keyword="rinse", kind="word", language="en", status="new", scene="Kitchen",
            limit=2, offset=4, include_variants=True, cursor=None, needs_enrichment=True))
        self.assertEqual(calls["record_review"]["review"], {"result": "correct", "assisted": True, "effort": "standard", "prompt": None, "answer": "wash"})
        self.assertEqual(account.expected_epochs, [1] * 12)
        self.assertEqual(self.local.path.read_bytes(), before)

    def test_cloud_rest_reads_are_exact_and_never_query_local_ids(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        self.assertEqual(routed.versions(), {"content": 20, "preferences": 3})
        self.assertEqual(routed.get_point(900)["record"]["id"], 900)
        self.assertEqual(routed.get_point(1), {"status": "not_found"})
        self.assertEqual(account.calls, [("GET", "/v1/changes", None, None), ("GET", "/v1/points/900", None, None), ("GET", "/v1/points/1", None, None)])
        for invalid in ["../settings", "900", True, 0, -1, 9007199254740992]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                routed.get_point(invalid)
        self.assertEqual(len(account.calls), 3)

    def test_cloud_signed_out_connecting_and_error_fail_closed(self):
        for state in ("signed_out", "connecting", "error"):
            account = FakeAccount(state=state)
            routed = RoutingStore(ForbiddenLocal(), account)
            for operation in (routed.settings, routed.query, lambda: routed.save("no-save", [POINT]),
                              lambda: routed.recording(False), lambda: routed.get_point(1), routed.versions,
                              lambda: routed.update(1, Patch(note="No fallback")), lambda: routed.delete(1)):
                with self.subTest(state=state), self.assertRaises(CloudAccountUnavailable) as error:
                    operation()
                self.assertEqual(error.exception.code, "cloud_not_connected")
            self.assertEqual(account.calls, [])

    def test_cloud_desktop_only_features_cannot_access_local_storage(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        operations = [lambda: routed.history(1), routed.learning_profile,
            lambda: routed.learning_preferences("en", LearnerPreferences(learning_goal="Not written locally")),
            routed.export_records, lambda: routed.export_receipt("receipt", {"count": 1}),
            lambda: routed.path, lambda: routed.database, lambda: routed.db,
            lambda: routed.require_local("study"), lambda: routed.review(_db=object()),
            lambda: routed._record_review(object(), 1, "review-no-local", Review(result="skipped")),
            lambda: StudySessions(routed).get()]
        for operation in operations:
            with self.assertRaises(CloudFeatureUnavailable) as error:
                operation()
            self.assertEqual(str(error.exception), "cloud_feature_unavailable")
            self.assertTrue(error.exception.feature)
        self.assertEqual(account.calls, [])

    def test_transport_failure_and_failed_results_never_fall_back(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        account.failure = RuntimeError("safe_transport_failure")
        with self.assertRaisesRegex(RuntimeError, "safe_transport_failure"):
            routed.query()
        account.failure = None
        account.responses["find_points"] = {"status": "failed", "error": "unavailable"}
        self.assertEqual(routed.query(), {"status": "failed", "error": "unavailable"})
        account.responses["find_points"] = []
        with self.assertRaises(CloudAccountUnavailable) as error:
            routed.query()
        self.assertEqual(error.exception.code, "invalid_cloud_response")

    def test_mode_switch_preserves_distinct_records_and_settings(self):
        identifier = self.local.save("local-before-switch", [POINT])["results"][0]["id"]
        self.local.settings(SettingsPatch(ui_language="ja", enabled=False))
        account = FakeAccount()
        routed = RoutingStore(self.local, account, cloud_only=False)
        self.assertEqual(routed.query()["records"][0]["id"], 900)
        self.assertEqual(routed.settings()["ui_language"], "zh")
        account.mode, account.state, account.epoch = "local", "signed_out", 2
        self.assertEqual(routed.query()["records"][0]["id"], identifier)
        self.assertEqual(routed.settings()["ui_language"], "ja")
        self.assertFalse(routed.recording()["enabled"])
        self.assertEqual(len(self.local.query()["records"]), 1)

    def test_inflight_epoch_change_does_not_return_old_account_data(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        account.after_call = lambda: setattr(account, "epoch", account.epoch + 1)
        with self.assertRaises(CloudAccountUnavailable) as error:
            routed.query()
        self.assertEqual(error.exception.code, "account_changed")
        account = FakeAccount("local", "signed_out")
        routed = RoutingStore(self.local, account, cloud_only=False)
        original = self.local.query
        def changed_query(**filters):
            value = original(**filters)
            account.epoch += 1
            return value
        with patch.object(self.local, "query", changed_query), self.assertRaises(CloudAccountUnavailable):
            routed.query()

    def test_mode_change_inside_local_transaction_rolls_back(self):
        account = FakeAccount("local", "signed_out")
        routed = RoutingStore(self.local, account, cloud_only=False)
        with self.assertRaises(CloudAccountUnavailable):
            with routed.connection(write=True) as database:
                database.execute("UPDATE settings SET recording=0 WHERE id=1")
                account.mode, account.state, account.epoch = "cloud", "connected", 2
        self.assertTrue(self.local.recording()["enabled"])

    def test_mode_change_before_cloud_transport_never_targets_new_account(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        original_status = account.status
        def changed_status():
            value = original_status()
            account.epoch += 1
            return value
        account.status = changed_status
        with self.assertRaises(CloudAccountUnavailable) as error:
            routed.save("must-not-reach-new-account", [POINT])
        self.assertEqual(error.exception.code, "account_changed")
        self.assertEqual(account.calls, [])

    def test_invalid_routing_state_never_silently_selects_sqlite(self):
        account = FakeAccount("unknown")
        routed = RoutingStore(ForbiddenLocal(), account)
        with self.assertRaises(CloudAccountUnavailable):
            routed.query()

    def test_request_epoch_binding_rejects_source_change_before_dispatch(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        with routed.expect_epoch(1):
            account.epoch = 2
            with self.assertRaises(CloudAccountUnavailable) as error:
                routed.update(900, Patch(note="Must not reach a different account"))
            self.assertEqual(error.exception.code, "account_changed")
        self.assertEqual(account.calls, [])
        # Context cleanup permits a later, explicitly fresh request.
        with routed.expect_epoch(2, require_cloud=True):
            self.assertEqual(routed.query()["records"][0]["id"], 900)
        self.assertEqual(account.expected_epochs, [2])

    def test_cloud_write_binding_requires_epoch_but_legacy_local_remains_compatible(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        with self.assertRaises(CloudAccountUnavailable) as error:
            with routed.expect_epoch(None, require_cloud=True):
                routed.delete(900)
        self.assertEqual(error.exception.code, "connection_epoch_required")
        self.assertEqual(account.calls, [])
        account = FakeAccount("local", "signed_out")
        routed = RoutingStore(self.local, account, cloud_only=False)
        with routed.expect_epoch(None, require_cloud=True):
            self.assertEqual(routed.query()["records"], [])
            account.mode, account.state, account.epoch = "cloud", "connected", 2
            with self.assertRaises(CloudAccountUnavailable) as error:
                routed.delete(900)
            self.assertEqual(error.exception.code, "connection_epoch_required")
        self.assertEqual(account.calls, [])

    def test_nested_bindings_cannot_weaken_or_replace_the_request_epoch(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        with routed.expect_epoch(1, require_cloud=True):
            with self.assertRaises(CloudAccountUnavailable):
                with routed.expect_epoch(2):
                    self.fail("replaced outer account")
            with routed.expect_epoch(None):
                account.epoch = 2
                with self.assertRaises(CloudAccountUnavailable):
                    routed.delete(900)
        self.assertEqual(account.calls, [])
        for invalid in (True, -1, "1", 1.0):
            with self.assertRaises(ValueError):
                with routed.expect_epoch(invalid):
                    self.fail("invalid epoch accepted")

    def test_epoch_bindings_are_isolated_between_concurrent_requests(self):
        account = FakeAccount()
        routed = RoutingStore(ForbiddenLocal(), account)
        entered, release = threading.Event(), threading.Event()
        def valid_request():
            with routed.expect_epoch(1, require_cloud=True):
                entered.set()
                self.assertTrue(release.wait(2))
                return routed.query()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(valid_request)
            try:
                self.assertTrue(entered.wait(2))
                with self.assertRaises(CloudAccountUnavailable):
                    with routed.expect_epoch(2, require_cloud=True):
                        self.fail("stale request accepted")
            finally:
                release.set()
            self.assertEqual(future.result(timeout=2)["records"][0]["id"], 900)


if __name__ == "__main__":
    unittest.main()
