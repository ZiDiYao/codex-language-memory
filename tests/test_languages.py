import json
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from store import Patch, SettingsPatch, Store
from test_memory import APPROACH


class LanguageTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "languages.sqlite3"
        self.store = Store(self.path)
        self.store.recording(True)

    def test_retired_language_and_manual_preferences_no_longer_block_capture(self):
        original = self.store.save("before-upgrade", [APPROACH])
        with self.store.connection(write=True) as db:
            db.execute("UPDATE capture_preferences SET data = ?", (json.dumps({
                "target_language": "ja", "target_languages": ["ja"],
                "capture_mode": "explicit", "ui_language": "ko",
                "enabled_types": ["word"],
            }),))
        upgraded = Store(self.path)
        self.assertEqual(upgraded.settings(), {
            "enabled": True, "ui_language": "ko", "enabled_types": ["word"],
        })
        self.assertEqual(upgraded.save("before-upgrade", [APPROACH])["results"], original["results"])
        result = upgraded.save("after-upgrade", [dict(APPROACH, language="fr")])
        self.assertEqual(result["results"][0]["status"], "added")
        upgraded.settings(SettingsPatch(ui_language="en"))
        self.assertEqual(upgraded.settings()["enabled_types"], ["word"])
        upgraded.recording(False)
        self.assertFalse(Store(self.path).settings()["enabled"])

    def test_multiple_languages_are_saved_queried_and_reviewed_separately(self):
        self.store.settings(SettingsPatch(ui_language="ja"))
        points = [
            dict(APPROACH, language=language, title=title)
            for language, title in [
                ("en", "approach"), ("en-us", "approach"), ("zh", "方便"),
                ("zh-hant", "方便"), ("ja", "大丈夫"), ("ko", "괜찮아요"), ("fr", "bonjour"),
            ]
        ]
        results = self.store.save("multiple-languages", points)["results"]
        self.assertEqual([row["status"] for row in results], ["added"] * 7)
        for language, count in [("en", 2), ("zh", 2), ("ja", 1), ("ko", 1), ("fr", 1)]:
            records = self.store.query(language=language, include_variants=True)["records"]
            self.assertEqual(len(records), count)
            self.assertTrue(all(row["language"].split("-")[0] == language for row in records))
            queue = self.store.review(language=language, include_variants=True)["records"]
            self.assertEqual(len(queue), count)
        # Existing exact-language queries retain their old meaning.
        self.assertEqual(len(self.store.query(language="en")["records"]), 1)
        japanese = self.store.query(language="ja")["records"][0]
        self.store.update(japanese["id"], Patch(status="mastered"))
        self.assertEqual(self.store.review(language="ja")["records"], [])
        self.assertEqual(len(self.store.review(language="ko")["records"]), 1)
        self.assertEqual(self.store.languages()["counts"], {"en": 2, "zh": 2, "ja": 1, "ko": 1, "fr": 1})
        other = Store(self.path)
        self.assertEqual(other.settings()["ui_language"], "ja")
        self.assertEqual(other.languages()["counts"], self.store.languages()["counts"])

    def test_same_spelling_in_different_languages_is_not_merged(self):
        items = [dict(APPROACH, title="手", language="zh"), dict(APPROACH, title="手", language="ja")]
        results = self.store.save("same-spelling", items)["results"]
        self.assertNotEqual(results[0]["id"], results[1]["id"])

    def test_invalid_settings_do_not_change_existing_preferences(self):
        original = self.store.settings()
        for patch in [SettingsPatch(enabled_types=None), SettingsPatch(ui_language=None)]:
            with self.assertRaises(ValidationError):
                self.store.settings(patch)
            self.assertEqual(self.store.settings(), original)
        with self.assertRaises(ValidationError):
            SettingsPatch(capture_mode="explicit")
        self.assertEqual(self.store.settings(), original)
        with self.assertRaises(ValidationError):
            SettingsPatch(ui_language="invalid")

    def test_all_interface_locales_persist_without_changing_learning_data(self):
        self.store.save("locale-independent-data", [APPROACH])
        original = self.store.query()["records"]
        for language in ["en", "zh", "ja", "ko", "fr", "es"]:
            with self.subTest(language=language):
                self.store.settings(SettingsPatch(ui_language=language))
                reopened = Store(self.path)
                self.assertEqual(reopened.settings()["ui_language"], language)
                self.assertEqual(reopened.query()["records"], original)
