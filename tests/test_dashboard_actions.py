import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from dashboard_actions import dispatch
from store import Store
from test_memory import APPROACH


class ActionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "actions.sqlite3")
        self.record_id = self.store.save("actions-fixture", [APPROACH])["results"][0]["id"]

    def call(self, action, arguments=None):
        return dispatch(self.store, {"action": action, "arguments": arguments or {}})

    def test_read_actions_and_export_filters_use_the_same_records(self):
        self.assertEqual(self.call("changes/read"), self.store.versions())
        self.assertEqual(self.call("settings/read"), self.store.settings())
        self.assertEqual(self.call("languages/list")["counts"], {"en": 1})
        point = self.call("points/read", {"record_id": self.record_id})
        self.assertEqual(point, self.store.get_point(self.record_id))
        self.assertEqual(self.call("exports/preview", {"language": "en"})["count"], 1)
        self.assertEqual(self.call("exports/preview", {"language": "fr"})["count"], 0)
        self.assertIsNone(self.call("exports/history")["last_export"])

    def test_read_actions_reject_arguments_instead_of_ignoring_them(self):
        for action in ("changes/read", "settings/read", "languages/list"):
            with self.subTest(action=action), self.assertRaises(ValidationError):
                self.call(action, {"enabled": False})
        self.assertTrue(self.store.settings()["enabled"])

    def test_invalid_envelopes_and_unlisted_methods_are_rejected(self):
        for request in (None, [], {}, {"action": "settings/read"},
                        {"action": [], "arguments": {}},
                        {"action": "connection", "arguments": {}},
                        {"action": "settings/read", "arguments": {}, "extra": True}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                dispatch(self.store, request)

    def test_invalid_mutations_do_not_change_content_or_settings(self):
        before = self.store.versions()
        for action, arguments in (
            ("points/update", {"record_id": self.record_id, "patch": {"status": "learning"}}),
            ("points/delete", {"record_id": str(self.record_id)}),
            ("settings/update", {"ui_language": "unknown"}),
        ):
            with self.subTest(action=action), self.assertRaises(ValidationError):
                self.call(action, arguments)
        self.assertEqual(self.store.versions(), before)
