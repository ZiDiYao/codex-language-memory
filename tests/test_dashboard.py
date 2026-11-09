import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pydantic import ValidationError

from dashboard import Dashboard
from store import SettingsPatch, Store
from test_memory import APPROACH


class SettingsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "memory.sqlite3"
        self.store = Store(self.path)
        self.store.recording(True)

    def test_old_database_and_receipts_survive_upgrade(self):
        saved = self.store.save("legacy-request", [APPROACH])
        with self.store.connection(write=True) as db:
            db.execute("DROP TABLE capture_preferences")
        upgraded = Store(self.path)
        self.assertTrue(upgraded.settings()["enabled"])
        self.assertEqual(upgraded.settings()["ui_language"], "en")
        self.assertEqual(len(upgraded.query()["records"]), 1)
        retry = upgraded.save("legacy-request", [APPROACH])
        self.assertTrue(retry["replayed"])
        self.assertEqual(retry["results"], saved["results"])

    def test_automatic_capture_accepts_all_languages_and_respects_types(self):
        self.store.settings(SettingsPatch(
            enabled_types=["word"],
        ))
        items = [APPROACH, dict(APPROACH, language="fr"),
                 dict(APPROACH, kind="grammar"), dict(APPROACH, language="en-GB")]
        results = self.store.save("automatic-test", items)["results"]
        self.assertEqual([r["status"] for r in results], ["added", "added", "skipped", "added"])
        self.assertEqual(results[2]["reason"], "type_disabled")
        other = Store(self.path)
        self.assertEqual(other.settings(), self.store.settings())
        self.assertTrue(other.save("automatic-test", items)["replayed"])
        self.assertEqual(other.save("automatic-test", items, source="explicit")["error"], "request_id_conflict")
        self.store.recording(False)
        self.assertFalse(other.settings()["enabled"])
        self.assertEqual(other.save("paused-explicit", items, source="explicit")["status"], "paused")

    def test_partial_settings_and_invalid_updates_are_atomic(self):
        self.store.settings(SettingsPatch(enabled_types=["grammar"]))
        self.store.settings(SettingsPatch(ui_language="ja"))
        self.assertEqual(self.store.settings()["enabled_types"], ["grammar"])
        before = self.store.settings()
        with self.assertRaises(ValidationError):
            self.store.settings(SettingsPatch(enabled=False, enabled_types=None))
        self.assertEqual(self.store.settings(), before)
        self.store.settings(SettingsPatch(enabled_types=[]))
        self.assertEqual(self.store.save("disabled-types", [APPROACH], source="explicit")["results"][0]["reason"],
                         "type_disabled")


class PageTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "page.sqlite3")
        self.store.recording(True)
        self.record_id = self.store.save("page-original", [APPROACH])["results"][0]["id"]
        self.dashboard = Dashboard(self.store)
        self.addCleanup(self.dashboard.close)
        self.url = self.dashboard.start()
        self.assertEqual(self.dashboard.start(), self.url)

    def call(self, action, arguments=None, **headers):
        request = Request(self.url + "api", data=json.dumps({
            "action": action, "arguments": arguments or {},
        }).encode(), headers={
            "Content-Type": "application/json", "X-Language-Memory": "1", **headers,
        })
        with urlopen(request) as response:
            return json.load(response)

    def test_page_settings_and_records_share_mcp_store(self):
        with urlopen(self.url) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("Language memory", response.read().decode())
        for asset in ("app.js", "record-feed.js", "style.css"):
            with urlopen(self.url + asset) as response:
                self.assertEqual(response.status, 200)
        self.call("settings/update", {"enabled": False, "ui_language": "en"})
        self.assertFalse(self.store.recording()["enabled"])
        self.assertEqual(self.call("settings/read")["ui_language"], "en")
        data = self.call("points/query", {"keyword": "approach"})
        self.assertEqual(data["records"][0]["id"], self.record_id)
        self.call("points/update", {"record_id": self.record_id, "patch": {"status": "mastered"}})
        self.assertEqual(self.store.review()["records"], [])
        self.call("points/delete", {"record_id": self.record_id})
        self.assertEqual(self.store.query()["records"], [])

    def test_local_api_requires_token_origin_and_valid_input(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(self.url.replace(self.url.split("/")[-2], "wrong-token"))
        self.assertEqual(error.exception.code, 404)
        with self.assertRaises(HTTPError) as error:
            self.call("settings/update", {"enabled": False}, Origin="https://unrelated.example")
        self.assertEqual(error.exception.code, 403)
        self.assertTrue(self.store.recording()["enabled"])
        with self.assertRaises(HTTPError) as error:
            self.call("points/update", {"record_id": self.record_id, "patch": {"unknown": 123}})
        self.assertEqual(error.exception.code, 400)
        with self.assertRaises(HTTPError) as error:
            self.call("settings/update", {"enabled": None})
        self.assertEqual(error.exception.code, 400)
        self.assertTrue(self.store.recording()["enabled"])

    def test_pagination_has_more(self):
        for number in range(22):
            self.store.save(f"page-record-{number}", [dict(APPROACH, title=f"word {number}")])
        first = self.call("points/query", {"limit": 20})
        second = self.call("points/query", {"limit": 20, "offset": 20})
        self.assertEqual(len(first["records"]), 20)
        self.assertEqual(len(second["records"]), 3)
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertFalse(set(r["id"] for r in first["records"]) & set(r["id"] for r in second["records"]))
