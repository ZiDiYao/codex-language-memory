import asyncio
import os
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from store import Patch, Review, SettingsPatch, Store
from study import StudySessions
from test_memory import APPROACH, APP


class StudySessionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "memory.sqlite3"
        self.store = Store(self.path)
        self.study = StudySessions(self.store)
        points = [dict(APPROACH, title=title, kind=kind) for title, kind in (
            ("approach", "word"), ("on the fence", "expression"), ("unreal conditionals", "grammar"))]
        self.ids = [item["id"] for item in self.store.save("session-fixtures", points)["results"]]

    def start(self, **options):
        return self.study.start("round-test-01", language="en", **options)["session"]

    def prepare(self, session, assisted=False):
        point = session["current"]["record"]
        return self.study.prepare(session["id"], session["version"], point["id"], point["revision"],
                                  "Use this point in a new sentence.", assisted)["session"]

    def test_round_survives_restart_and_saves_three_types_without_encounters(self):
        session = self.start()
        kinds = []
        for index in range(3):
            session = self.prepare(session)
            self.study = StudySessions(Store(self.path))
            restored = self.study.get(language="en")["session"]
            self.assertEqual(restored["current"]["prompt"], session["current"]["prompt"])
            kinds.append(restored["current"]["record"]["kind"])
            result = self.study.answer(session["id"], session["version"], f"answer-{index}",
                                      Review(result="correct", answer="A real learner answer"))
            self.assertTrue(result["review"]["scheduled"])
            session = result["session"]
        self.assertEqual(kinds, ["word", "expression", "grammar"])
        self.assertEqual(session["state"], "completed")
        self.assertIsNone(session["current"])
        self.assertEqual(len(session["completed"]), 3)
        self.assertEqual(self.study.get(language="en")["status"], "not_found")
        for identifier in self.ids:
            point = self.store.get_point(identifier)["record"]
            self.assertEqual((point["encounter_count"], point["status"]), (1, "new"))

    def test_hint_pause_resume_and_skip_do_not_train_fsrs(self):
        session = self.prepare(self.start())
        session = self.prepare(session, assisted=True)
        # Re-preparing must not erase the hint flag.
        session = self.prepare(session, assisted=False)
        session = self.study.set_state(session["id"], session["version"], "paused")["session"]
        self.assertEqual(self.store.history(self.ids[0])["reviews"], [])
        result = self.study.answer(session["id"], session["version"], "answer-paused", Review(result="correct", answer="x"))
        self.assertEqual(result["error"], "session_not_active")
        session = StudySessions(Store(self.path)).get()["session"]
        session = self.study.set_state(session["id"], session["version"], "active")["session"]
        result = self.study.answer(session["id"], session["version"], "answer-hinted", Review(result="correct", answer="x", effort="easy"))
        self.assertFalse(result["review"]["scheduled"])
        self.assertTrue(result["session"]["completed"][0]["assisted"])
        session = self.prepare(result["session"])
        result = self.study.answer(session["id"], session["version"], "answer-skipped", Review(result="skipped"))
        self.assertFalse(result["review"]["scheduled"])
        self.assertEqual(len(result["session"]["completed"]), 2)

    def test_concurrent_retry_is_exactly_once_and_stale_answer_rejected(self):
        session = self.prepare(self.start())
        def answer(_):
            return StudySessions(Store(self.path)).answer(session["id"], session["version"], "retry-answer",
                                                         Review(result="incorrect", answer="wrong"))
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(answer, range(4)))
        self.assertEqual(sum(item["replayed"] for item in replies), 3)
        self.assertEqual(len(self.store.history(self.ids[0])["reviews"]), 1)
        changed = self.study.answer(session["id"], session["version"], "retry-answer", Review(result="correct", answer="different"))
        self.assertEqual(changed["error"], "request_id_conflict")
        stale = self.study.answer(session["id"], session["version"], "stale-answer", Review(result="correct", answer="x"))
        self.assertEqual(stale["error"], "version_conflict")
        self.assertEqual(self.store.history(self.ids[1])["reviews"], [])

    def test_edits_deletion_mastery_and_empty_notes_are_respected(self):
        session = self.prepare(self.start())
        self.store.update(self.ids[0], Patch(note="A user-edited explanation"))
        self.assertTrue(self.study.get(session["id"])["session"]["current"]["question_stale"])
        result = self.study.answer(session["id"], session["version"], "edited-answer", Review(result="correct", answer="x"))
        self.assertEqual(result["error"], "content_changed")
        self.store.delete(self.ids[0])
        self.assertEqual(self.study.get(session["id"])["session"]["current"]["record"]["id"], self.ids[1])
        result = self.study.answer(session["id"], session["version"], "deleted-answer", Review(result="correct", answer="x"))
        self.assertEqual(result["error"], "no_pending_question")
        self.store.update(self.ids[1], Patch(status="mastered"))
        self.store.update(self.ids[2], Patch(note=""))
        session = self.study.get(session["id"])["session"]
        self.assertIsNone(session["current"])
        self.assertEqual(session["remaining"], 0)
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM study_items WHERE record_id = ?", (self.ids[0],)).fetchone()[0], 0)

    def test_review_and_progress_rollback_together(self):
        session = self.prepare(self.start())
        with self.store.connection(write=True) as db:
            db.execute("""CREATE TRIGGER fail_progress BEFORE UPDATE OF review_event_id ON study_items
                          BEGIN SELECT RAISE(ABORT, 'injected failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.study.answer(session["id"], session["version"], "atomic-answer", Review(result="correct", answer="x"))
        self.assertEqual(self.store.history(self.ids[0])["reviews"], [])
        self.assertFalse(self.store.history(self.ids[0])["memory"]["assessed"])
        self.assertEqual(self.study.get(session["id"])["session"]["version"], session["version"])

    def test_selection_scope_empty_start_retries_and_finish(self):
        self.assertEqual(self.study.start("empty-japanese", language="ja")["status"], "empty")
        session = self.start(kind="grammar")
        self.assertEqual(session["current"]["record"]["id"], self.ids[2])
        self.assertTrue(self.study.start(session["id"], language="en", kind="grammar")["replayed"])
        self.assertEqual(self.study.start(session["id"], language="ja")["error"], "request_id_conflict")
        self.study.start("another-round", language="en", kind="word")
        self.assertEqual(self.study.get(language="en")["status"], "choose_session")
        result = self.study.answer(session["id"], session["version"], "no-question", Review(result="correct", answer="x"))
        self.assertEqual(result["error"], "no_pending_question")
        session = self.prepare(session)
        result = self.study.answer(session["id"], session["version"], "no-answer", Review(result="correct"))
        self.assertEqual(result["error"], "answer_required")
        session = self.study.set_state(session["id"], session["version"], "completed")["session"]
        self.assertEqual(self.store.history(self.ids[2])["reviews"], [])
        self.assertEqual(self.study.set_state(session["id"], session["version"], "active")["error"], "session_completed")


class StudyMCPTests(unittest.TestCase):
    def test_real_stdio_restart_and_answer(self):
        asyncio.run(self.exercise())

    async def exercise(self):
        with tempfile.TemporaryDirectory() as directory:
            params = StdioServerParameters(command=sys.executable, args=[str(APP / "server.py")],
                                           env={**os.environ, "LANGUAGE_MEMORY_DB": str(Path(directory) / "mcp.sqlite3")}, cwd=directory)
            async def call(client, name, args=None):
                response = await client.call_tool(name, args)
                self.assertFalse(response.isError, response.content)
                return response.structuredContent
            async with stdio_client(params) as streams, ClientSession(*streams) as client:
                await client.initialize()
                await call(client, "save_points", {"request_id": "stdio-fixture", "items": [APPROACH]})
                await call(client, "update_settings", {"patch": {"first_language": "zh"}})
                session = (await call(client, "start_study", {"request_id": "stdio-round", "language": "en"}))["session"]
                point = session["current"]["record"]
                session = (await call(client, "prepare_study_question", {
                    "session_id": session["id"], "expected_version": session["version"], "record_id": point["id"],
                    "expected_revision": point["revision"], "prompt": "What does approach mean here: a new approach to learning?"}))["session"]
            # A fresh MCP process cannot rely on any conversation variables.
            async with stdio_client(params) as streams, ClientSession(*streams) as client:
                await client.initialize()
                resumed = (await call(client, "get_study", {"language": "en"}))["session"]
                self.assertEqual(resumed["current"]["prompt"], session["current"]["prompt"])
                profile = await call(client, "get_learning_profile", {"language": "en"})
                self.assertEqual(profile["language_preferences"]["explanation_language"], "zh")
                result = await call(client, "submit_study_answer", {
                    "session_id": resumed["id"], "expected_version": resumed["version"], "request_id": "stdio-answer",
                    "review": {"result": "correct", "answer": "A method."}})
                self.assertEqual(result["session"]["state"], "completed")
                self.assertTrue(result["review"]["scheduled"])
