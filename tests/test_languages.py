import json
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from store import LearnerPreferences, Patch, SettingsPatch, Store
from test_memory import APPROACH


class LanguageTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "languages.sqlite3"
        self.store = Store(self.path)
        self.store.recording(True)

    def test_first_language_is_confirmed_not_inferred_from_interface_or_target(self):
        self.store.settings(SettingsPatch(ui_language="fr"))
        self.store.save("chinese-learning", [dict(APPROACH, language="zh")])
        policy = self.store.learning_profile(language="zh")["language_preferences"]
        self.assertTrue(policy["needs_first_language_confirmation"])
        self.assertIsNone(policy["explanation_language"])
        self.store.settings(SettingsPatch(first_language="fr"))
        reopened = Store(self.path)
        policy = reopened.learning_profile(language="zh")["language_preferences"]
        self.assertEqual(policy["explanation_language"], "fr")
        self.assertEqual(policy["explanation_source"], "first_language")
        self.assertFalse(policy["needs_first_language_confirmation"])
        self.assertEqual(reopened.query()["records"][0]["language"], "zh")

    def test_explanation_overrides_are_shared_by_page_and_conversation(self):
        self.store.settings(SettingsPatch(first_language="zh", ui_language="en"))
        self.assertEqual(self.store.learning_profile(language="ja")["language_preferences"]["explanation_language"], "zh")
        self.store.learning_preferences(patch=LearnerPreferences(explanation_language="en", interests=["travel"]))
        self.assertEqual(self.store.settings()["explanation_language"], "en")
        self.store.learning_preferences("ja", LearnerPreferences(explanation_language="ko"))
        self.assertEqual(self.store.learning_profile(language="ja")["language_preferences"]["explanation_language"], "ko")
        self.store.settings(SettingsPatch(explanation_language="fr"))
        self.assertEqual(self.store.learning_profile(language="zh")["language_preferences"]["explanation_language"], "fr")
        self.assertEqual(self.store.learning_preferences()["preferences"]["interests"], ["travel"])
        self.store.settings(SettingsPatch(explanation_language=None))
        self.assertEqual(self.store.learning_profile(language="fr")["language_preferences"]["explanation_language"], "zh")
        self.assertEqual(self.store.learning_profile(language="ja")["language_preferences"]["explanation_language"], "ko")
        self.assertEqual(self.store.settings()["ui_language"], "en")

    def test_language_preference_changes_preserve_records_and_can_be_reset(self):
        self.store.save("unchanged-record", [APPROACH])
        before = self.store.query()["records"]
        self.store.settings(SettingsPatch(first_language="fr", explanation_language="es"))
        self.assertEqual(self.store.query()["records"], before)
        # Older Betas reject unknown capture fields. Keep new preferences in the
        # extensible learner data so a binary rollback can still read settings.
        with self.store.connection() as db:
            capture = json.loads(db.execute("SELECT data FROM capture_preferences").fetchone()[0])
        self.assertEqual(set(capture), {"ui_language", "enabled_types"})
        self.store.settings(SettingsPatch(first_language=None, explanation_language=None))
        self.assertTrue(Store(self.path).learning_profile()["language_preferences"]["needs_first_language_confirmation"])
        settings = self.store.settings()
        with self.assertRaises(ValidationError):
            SettingsPatch(first_language="not a language")
        self.assertEqual(self.store.settings(), settings)

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
            "first_language": None, "explanation_language": None,
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
