import copy
import json
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from dashboard_actions import dispatch
from desktop_store import CloudAccountUnavailable, CloudFeatureUnavailable, RoutingStore
from store import LearnerPreferences, LearningSettings, SettingsPatch, Store


class CustomLearningInstructionsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "instructions.sqlite3"
        self.store = Store(self.path)

    def test_settings_round_trip_and_clearing_preserve_other_preferences(self):
        self.assertEqual(self.store.settings()["english_learning_instructions"], "")
        self.store.settings(SettingsPatch(first_language="zh", enabled_types=["word"]))
        self.store.learning_preferences(patch=LearnerPreferences(interests=["travel"]))
        content_version = self.store.versions()["content"]
        instructions = "先讲当前用法，再用旅行场景举例。\nInclude one natural collocation."
        result = dispatch(self.store, {"action": "settings/update", "arguments": {
            "english_learning_instructions": "  " + instructions + "\n",
        }})
        self.assertEqual(result["english_learning_instructions"], instructions)
        reopened = Store(self.path)
        reopened.settings(SettingsPatch(ui_language="fr"))
        settings = reopened.settings()
        self.assertEqual(settings["english_learning_instructions"], instructions)
        self.assertEqual(settings["first_language"], "zh")
        self.assertEqual(settings["enabled_types"], ["word"])
        self.assertEqual(self.store.versions()["content"], content_version)
        with self.store.connection() as db:
            capture = json.loads(db.execute("SELECT data FROM capture_preferences").fetchone()[0])
        self.assertNotIn("english_learning_instructions", capture, "older binaries must still parse capture settings on rollback")
        self.assertEqual(self.store.learning_preferences()["preferences"]["english_learning_instructions"], instructions)
        cleared = self.store.settings(SettingsPatch(english_learning_instructions=" \n\t"))
        self.assertEqual(cleared["english_learning_instructions"], "")
        preferences = self.store.learning_preferences()["preferences"]
        self.assertEqual(preferences["interests"], ["travel"])
        self.assertEqual(preferences["first_language"], "zh")
        self.assertNotIn("english_learning_instructions", preferences)

    def test_scalar_limit_and_invalid_unicode_are_validated_before_persistence(self):
        self.assertEqual(LearningSettings().english_learning_instructions, "")
        text = "😀" * 1500
        self.assertEqual(self.store.settings(SettingsPatch(english_learning_instructions=text))["english_learning_instructions"], text)
        before = self.store.settings()
        for invalid in ("😀" * 1501, "a\x00b", "\ud800", "\udfff", 123, False, []):
            with self.subTest(invalid=repr(invalid)[:30]), self.assertRaises(ValidationError):
                self.store.settings(SettingsPatch(english_learning_instructions=invalid))
            self.assertEqual(self.store.settings(), before)
        with self.assertRaises(ValidationError):
            self.store.settings(SettingsPatch(enabled=False, english_learning_instructions=None))
        self.assertEqual(self.store.settings(), before, "invalid compound updates remain atomic")


class NoLocalStore:
    def __getattr__(self, _name):
        raise AssertionError("cloud request accessed the local store")


class ContextAccount:
    def __init__(self):
        self.epoch = 3
        self.calls = []
        self.reply = {"status": "processed", "replayed": False, "results": [],
                      "_context": {"enabled": True, "english_learning_instructions": "Use cooking examples."}}
        self.change_epoch = False

    def status(self):
        return {"mode": "cloud", "state": "connected", "epoch": self.epoch}

    def call_tool(self, name, arguments, *, expected_epoch):
        self.calls.append((name, copy.deepcopy(arguments), expected_epoch))
        if expected_epoch != self.epoch:
            raise CloudAccountUnavailable("account_changed")
        if self.change_epoch:
            self.epoch += 1
        return copy.deepcopy(self.reply)


class CustomInstructionsRoutingTests(unittest.TestCase):
    def test_capture_context_forwards_current_preferences_on_pause_and_replay_without_extra_reads(self):
        account = ContextAccount()
        store = RoutingStore(NoLocalStore(), account)
        items = [{"kind": "word", "language": "en", "title": "fixture target"}]
        for status, replayed, instructions in (("processed", False, "Use cooking examples."),
                                               ("paused", False, "Explain briefly."),
                                               ("processed", True, "Include a collocation.")):
            account.reply.update(status=status, replayed=replayed)
            account.reply["_context"]["english_learning_instructions"] = instructions
            result = store.capture_with_context("same-request", items)
            self.assertEqual(result["_context"]["english_learning_instructions"], instructions)
            self.assertEqual(result["_connection"]["epoch"], 3)
            self.assertEqual(result["replayed"], replayed)
        account.reply["_context"].pop("english_learning_instructions")
        self.assertNotIn("english_learning_instructions", store.capture_with_context("same-request", items)["_context"])
        self.assertEqual([call[0] for call in account.calls], ["capture_and_context"] * 4)
        account.change_epoch = True
        with self.assertRaisesRegex(CloudAccountUnavailable, "account_changed"):
            store.capture_with_context("same-request", items)

    def test_settings_forward_patch_and_never_invent_support_for_an_older_service(self):
        account = ContextAccount()
        account.reply = {"enabled": True, "ui_language": "en"}
        store = RoutingStore(NoLocalStore(), account)
        result = store.settings()
        self.assertNotIn("_capabilities", result)
        self.assertNotIn("english_learning_instructions", result)
        account.reply = {"english_learning_instructions": "Use work examples.",
                         "_capabilities": {"custom_learning_instructions": True}}
        result = store.settings(SettingsPatch(english_learning_instructions="Use work examples."))
        self.assertEqual(account.calls[-1], ("update_settings", {"patch": {
            "english_learning_instructions": "Use work examples."}}, 3))
        self.assertTrue(result["_capabilities"]["custom_learning_instructions"])

    def test_minimal_single_call_capture_stays_cloud_only(self):
        class LocalAccount:
            def status(self):
                return {"mode": "local", "state": "signed_out", "epoch": 1}
        store = RoutingStore(NoLocalStore(), LocalAccount(), cloud_only=False)
        with self.assertRaisesRegex(CloudFeatureUnavailable, "cloud_feature_unavailable"):
            store.capture_with_context("unused-request", [])


if __name__ == "__main__":
    unittest.main()
