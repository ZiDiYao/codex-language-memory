import os
import json
import sqlite3
import sys
import tempfile
import unittest
from urllib.request import urlopen
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from store import Patch, Review, Store


APP = Path(__file__).resolve().parents[1]
APPROACH = {
    "kind": "word",
    "language": "en",
    "title": "approach",
    "sense_key": "method",
    "meaning": "A method or way of doing something.",
    "explanation": "Here approach is a countable noun describing a method, not movement toward something.",
    "context": "The new approach worked.",
    "examples": [{"text": "Try a different approach.", "translation": "试试另一种方法。"},
                 {"text": "Her approach to teaching is practical.", "translation": "她的教学方法很实用。"}],
}


class StoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "memory.sqlite3"
        self.store = Store(self.path)

    def test_pause_is_persistent_and_blocks_only_new_saves(self):
        self.assertEqual(self.store.recording(), {"enabled": True})
        self.store.recording(False)
        self.assertEqual(self.store.save("enable-test", [APPROACH])["status"], "paused")
        self.store.recording(True)
        other = Store(self.path)
        self.assertTrue(other.recording()["enabled"])
        self.assertEqual(other.save("enable-test", [APPROACH])["results"][0]["status"], "added")
        other.recording(False)
        self.assertFalse(self.store.recording()["enabled"])
        self.assertEqual(self.store.save("pause-test", [APPROACH])["status"], "paused")
        self.assertEqual(len(self.store.query()["records"]), 1)

    def test_dedupe_distinguishes_sense_new_encounter_and_retry(self):
        self.store.recording(True)
        first = self.store.save("first-save", [APPROACH])["results"][0]
        other = Store(self.path)
        repeated = dict(APPROACH, title=" ＡＰＰＲＯＡＣＨ ", sense_key=" Method ",
                        context="We need a fresh approach.")
        merged = other.save("new-encounter", [repeated])["results"][0]
        self.assertEqual(merged, dict(first, status="merged", encounter_count=2))
        retry = other.save("new-encounter", [repeated])
        self.assertTrue(retry["replayed"])
        self.assertEqual(retry["results"], [merged])
        self.assertEqual(other.save("new-encounter", [APPROACH])["error"], "request_id_conflict")
        second_sense = dict(APPROACH, sense_key="move closer", meaning="靠近")
        other.save("other-sense", [second_sense])
        rows = other.query(keyword="APPROACH")["records"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["encounter_count"], 1)
        self.assertEqual(rows[1]["encounter_count"], 2)
        self.assertEqual(rows[1]["context"], repeated["context"])
        self.assertGreater(rows[1]["last_seen_at"], rows[1]["created_at"])

    def test_partial_batch_and_duplicate_inside_batch(self):
        self.store.recording(True)
        items = [APPROACH, {"kind": "word"}, APPROACH, dict(APPROACH, language="en-US")]
        results = self.store.save("mixed-batch", items)["results"]
        self.assertEqual([r["status"] for r in results], ["added", "failed", "failed", "added"])
        self.assertEqual(results[2]["error"], "duplicate_in_batch")
        self.assertEqual(self.store.save("mixed-batch", items)["results"], results)
        self.assertEqual(self.store.query(language="en-us")["records"][0]["encounter_count"], 1)

    def test_storage_error_rolls_back_batch_and_receipt(self):
        self.store.recording(True)
        with self.store.connection(write=True) as db:
            db.execute("""CREATE TRIGGER injected_failure BEFORE INSERT ON knowledge
                          WHEN new.title = 'fail' BEGIN SELECT RAISE(ABORT, 'fail'); END""")
        items = [APPROACH, dict(APPROACH, title="fail")]
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.save("atomic-test", items)
        self.assertEqual(self.store.query()["records"], [])
        with self.store.connection(write=True) as db:
            db.execute("DROP TRIGGER injected_failure")
        self.assertFalse(self.store.save("atomic-test", items)["replayed"])

    def test_concurrent_replays_count_once(self):
        self.store.recording(True)
        ids = ["same-request"] * 4 + [f"separate-{i}" for i in range(5)]
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda key: Store(self.path).save(key, [APPROACH]), ids))
        self.assertEqual(sum(result["replayed"] for result in results), 3)
        self.assertEqual(self.store.query()["records"][0]["encounter_count"], 6)

    def test_filter_review_and_edit(self):
        self.store.recording(True)
        points = [APPROACH, dict(APPROACH, kind="grammar", title="in vs at", context="100%"),
                  dict(APPROACH, language="fr", title="bonjour", meaning="你好")]
        ids = [row["id"] for row in self.store.save("test-query", points)["results"]]
        self.assertEqual(self.store.query(keyword="_")["records"], [])
        self.assertEqual(self.store.query(keyword="%", kind="grammar")["records"][0]["id"], ids[1])
        self.assertEqual(self.store.query(language="fr")["records"][0]["id"], ids[2])
        self.assertEqual(self.store.query(limit=1, offset=1)["records"][0]["id"], ids[1])

        self.store.record_review(ids[0], "review-query", Review(result="correct"))
        updated = self.store.update(ids[0], Patch(status="new", meaning="办法", context=None))["record"]
        self.assertIsNone(updated["context"])
        self.assertEqual(updated["meaning"], "办法")
        self.assertEqual(updated["last_review_result"], "correct")
        self.assertTrue(updated["last_reviewed_at"])
        self.assertEqual(self.store.query(keyword="办法", status="new")["records"], [updated])
        self.assertEqual([r["id"] for r in self.store.review(language="en")["records"]],
                         [ids[1]])
        self.store.update(ids[1], Patch(status="mastered"))
        self.assertEqual(self.store.review(language="en")["records"], [])
        self.assertEqual(self.store.review(language="en", include_upcoming=True)["records"][0]["id"], ids[0])
        self.assertEqual(self.store.update(ids[0], Patch(title="strategy"))["status"], "updated")
        self.assertEqual(self.store.query(keyword="strategy")["records"][0]["id"], ids[0])

    def test_edit_conflict_and_delete_do_not_resurrect_on_retry(self):
        self.store.recording(True)
        points = [APPROACH, dict(APPROACH, sense_key="move closer", meaning="靠近")]
        ids = [row["id"] for row in self.store.save("delete-test", points)["results"]]
        self.assertEqual(self.store.update(ids[1], Patch(sense_key="Method"))["error"],
                         "identity_conflict")
        self.assertEqual(self.store.delete(ids[0])["status"], "deleted")
        self.assertEqual(self.store.delete(ids[0])["status"], "not_found")
        self.assertEqual(self.store.update(ids[0], Patch(status="new"))["status"], "not_found")
        self.assertTrue(self.store.save("delete-test", points)["results"][0]["deleted"])
        self.assertEqual([r["id"] for r in self.store.query()["records"]], [ids[1]])
        recreated = self.store.save("fresh-after-delete", [APPROACH])["results"][0]
        self.assertGreater(recreated["id"], max(ids))


class MCPTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, session, name, arguments=None):
        result = await session.call_tool(name, arguments)
        self.assertFalse(result.isError, result.content)
        return result.structuredContent

    async def test_stdio_session_restart_and_review_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            params = StdioServerParameters(
                command=sys.executable,
                args=[str(APP / "server.py")],
                cwd=directory,
                env={**os.environ, "LANGUAGE_MEMORY_DB": str(Path(directory) / "mcp.sqlite3")},
            )
            async with stdio_client(params) as streams, ClientSession(*streams) as session:
                await session.initialize()
                tools = await session.list_tools()
                self.assertEqual({tool.name for tool in tools.tools}, {
                    "get_recording", "set_recording", "save_points", "find_points",
                    "review_queue", "update_point", "delete_point",
                    "get_settings", "update_settings", "open_memory_page", "list_languages", "export_points",
                    "record_review", "get_point_history", "get_learning_profile", "update_learning_preferences",
                })
                self.assertTrue((await self.call(session, "get_recording"))["enabled"])
                self.assertTrue((await self.call(session, "set_recording", {"enabled": True}))["enabled"])
                saved = await self.call(session, "save_points", {
                    "request_id": "mcp-encounter", "items": [APPROACH],
                })
                record_id = saved["results"][0]["id"]
                await self.call(session, "update_settings", {
                    "patch": {"ui_language": "ko"},
                })
                page = await self.call(session, "open_memory_page")
                with urlopen(page["url"]) as response:
                    self.assertIn("Language memory", response.read().decode())
            async with stdio_client(params) as streams, ClientSession(*streams) as session:
                await session.initialize()
                settings = await self.call(session, "get_settings")
                self.assertEqual(settings["ui_language"], "ko")
                exported = await self.call(session, "export_points", {
                    "request": {"format": "json", "language": "en"},
                })
                self.assertEqual(exported["count"], 1)
                self.assertEqual(json.loads(Path(exported["path"]).read_bytes())["records"][0]["id"], record_id)
                merged = await self.call(session, "save_points", {
                    "request_id": "new-automatic-request", "items": [APPROACH],
                })
                self.assertEqual(merged["results"][0]["status"], "merged")
                self.assertEqual(merged["results"][0]["encounter_count"], 2)
                found = await self.call(session, "find_points", {"keyword": "approach", "language": "EN"})
                self.assertEqual(found["records"][0]["id"], record_id)
                queue = await self.call(session, "review_queue", {"kind": "word"})
                self.assertEqual(queue["records"][0]["id"], record_id)
                result = await self.call(session, "record_review", {
                    "record_id": record_id, "request_id": "mcp-review-once", "review": {"result": "correct"},
                })
                self.assertTrue(result["scheduled"])
                retry = await self.call(session, "record_review", {
                    "record_id": record_id, "request_id": "mcp-review-once", "review": {"result": "correct"},
                })
                self.assertTrue(retry["replayed"])
                history = await self.call(session, "get_point_history", {"record_id": record_id})
                self.assertEqual(len(history["reviews"]), 1)
                await self.call(session, "update_learning_preferences", {
                    "language": "en", "patch": {"explanation_language": "zh"},
                })
                profile = await self.call(session, "get_learning_profile", {"language": "en"})
                self.assertEqual(profile["rated_reviews"], 1)
                self.assertEqual(profile["preferences"][0]["preferences"]["explanation_language"], "zh")
                result = await self.call(session, "update_point", {
                    "record_id": record_id, "patch": {"status": "mastered"},
                })
                self.assertEqual(result["record"]["last_review_result"], "correct")
                self.assertEqual((await self.call(session, "review_queue"))["records"], [])
                self.assertEqual((await self.call(session, "delete_point", {
                    "record_id": record_id,
                }))["status"], "deleted")
                self.assertEqual((await self.call(session, "find_points"))["records"], [])
