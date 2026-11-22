import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import speech
from dashboard_actions import dispatch
from store import Store
from test_memory import APPROACH


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "speech.sqlite3")
        self.identifier = self.store.save("speech-fixture", [dict(APPROACH, title="grudge")])["results"][0]["id"]
        self.process = MagicMock()
        self.process.poll.return_value = None
        self.spawn = self.enterContext(patch("speech.subprocess.Popen", return_value=self.process))
        self.enterContext(patch("speech.Path.is_file", return_value=True))
        speech._process = None
        self.addCleanup(lambda: setattr(speech, "_process", None))

    def test_toggle_reads_current_title_without_changing_learning_evidence(self):
        before = self.store.history(self.identifier)
        result = dispatch(self.store, {"action": "speech/play", "arguments": {"record_id": self.identifier}})
        self.assertTrue(result["playing"])
        self.process.stdin.write.assert_called_once_with(b"grudge")
        self.assertNotIn("grudge", self.spawn.call_args.args[0])
        self.assertEqual(self.store.history(self.identifier), before)
        self.assertFalse(speech.play(self.store, self.identifier)["playing"])
        self.process.terminate.assert_called_once()

    def test_invalid_records_and_unavailable_voices_do_not_start_speech(self):
        self.assertEqual(speech.play(self.store, 999)["status"], "not_found")
        other = self.store.save("speech-unknown-lang", [dict(APPROACH, language="xx")])["results"][0]["id"]
        self.assertEqual(speech.play(self.store, other)["error"], "speechUnavailable")
        self.spawn.assert_not_called()

    def test_current_note_and_failures_are_reflected(self):
        from store import Patch
        self.store.update(self.identifier, Patch(note="lip balm\nMy edited note"))
        speech.play(self.store, self.identifier)
        self.process.stdin.write.assert_called_once_with(b"lip balm")
        self.process.poll.return_value = 1
        self.assertEqual(speech.status()["error"], "speechUnavailable")

    def test_os_failure_is_reported_without_false_playing_state(self):
        self.spawn.side_effect = OSError("voice service unavailable")
        self.assertEqual(speech.play(self.store, self.identifier)["error"], "speechUnavailable")
        self.assertFalse(speech.status()["playing"])
