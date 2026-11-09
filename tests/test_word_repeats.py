import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from exports import ExportRequest, build_export
from store import Patch, Review, Store, encode
from study import StudySessions
from test_memory import APPROACH


START = datetime(2026, 11, 1, tzinfo=timezone.utc)
QUALIFICATION = dict(APPROACH, title="credential", sense_key="qualification",
                     meaning="Proof of qualifications.", explanation="Usually plural: professional credentials.")
LOGIN = dict(QUALIFICATION, sense_key="authentication", meaning="Information used to authenticate.",
             explanation="Use login credentials for authentication details.", context="Enter your credentials.",
             examples=[{"text": "Check your login credentials."}, {"text": "Keep those credentials private."}])


class WordRepeatTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "memory.sqlite3"
        self.store = Store(self.path)

    def save_at(self, key, items, days=0):
        with patch("store.now", return_value=(START + timedelta(days=days)).isoformat(timespec="microseconds")):
            return self.store.save(key, items)

    def test_two_meanings_share_one_card_one_encounter_and_export(self):
        result = self.save_at("two-meanings", [QUALIFICATION, LOGIN])
        first, second = result["results"]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual([first["status"], second["status"]], ["added", "merged"])
        self.assertEqual(second["encounter_count"], 1)
        point = self.store.get_point(first["id"])["record"]
        self.assertEqual(point["repeat_priority"], 0)
        for meaning in (QUALIFICATION, LOGIN):
            for field in ("meaning", "explanation"):
                self.assertIn(meaning[field], point["note"])
            for example in meaning["examples"]:
                self.assertIn(example["text"], point["note"])
        history = self.store.history(first["id"])
        self.assertEqual(len(history["encounters"]), 1)
        self.assertIn(LOGIN["context"], history["encounters"][0]["context"])
        exported = json.loads(build_export(self.store, ExportRequest(format="json")).data)
        self.assertEqual(len(exported["records"]), 1)
        self.assertEqual(exported["records"][0]["note"], point["note"])
        sections = json.loads(build_export(self.store, ExportRequest(
            format="json", content="sections", fields=["meaning", "examples"])).data)["records"][0]
        self.assertIn(LOGIN["meaning"], sections["meaning"])
        self.assertIn(QUALIFICATION["meaning"], sections["meaning"])
        self.assertEqual(len(sections["examples"]), 4)

    def test_multiple_senses_of_existing_word_boost_once_per_batch(self):
        identifier = self.store.save("initial-word", [QUALIFICATION])["results"][0]["id"]
        self.store.save("another-word", [APPROACH])
        batch = [QUALIFICATION, LOGIN]
        self.store.save("repeat-two-senses", batch)
        self.store.save("repeat-two-senses", batch)
        point = self.store.get_point(identifier)["record"]
        self.assertEqual((point["encounter_count"], point["repeat_priority"]), (2, 1))
        self.store.save("repeat-another-word", [APPROACH])
        self.store.save("repeat-word-again", [LOGIN])
        queue = self.store.review()["records"]
        self.assertEqual([r["repeat_priority"] for r in queue], [2, 1])
        self.assertEqual(queue[0]["id"], identifier)
        self.store.recording(False)
        self.assertEqual(self.store.save("paused-repeat", [LOGIN])["status"], "paused")
        self.assertEqual(self.store.get_point(identifier)["record"]["repeat_priority"], 2)

    def test_repeat_moves_to_top_and_retry_does_not_boost_or_move_again(self):
        identifier = self.save_at("first-encounter", [QUALIFICATION])["results"][0]["id"]
        self.save_at("another-point", [APPROACH], 1)
        repeated = self.save_at("repeat-encounter", [dict(LOGIN, title=" ＣＲＥＤＥＮＴＩＡＬ ")], 2)
        point = self.store.query()["records"][0]
        self.assertEqual(point["id"], identifier)
        self.assertEqual((point["encounter_count"], point["repeat_priority"]), (2, 1))
        replay = self.save_at("repeat-encounter", [dict(LOGIN, title=" ＣＲＥＤＥＮＴＩＡＬ ")], 3)
        self.assertTrue(replay["replayed"])
        self.assertEqual(repeated["results"], replay["results"])
        self.assertEqual(self.store.get_point(identifier)["record"], point)
        self.assertEqual(Store(self.path).review()["records"][0]["id"], identifier)

    def test_concurrent_new_senses_do_not_duplicate_word_or_retry_count(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda i: Store(self.path).save(f"new-context-{i % 2}",
                [QUALIFICATION if i % 2 else LOGIN]), range(8)))
        self.assertEqual(sum(r["replayed"] for r in results), 6)
        points = self.store.query()["records"]
        self.assertEqual(len(points), 1)
        self.assertEqual((points[0]["encounter_count"], points[0]["repeat_priority"]), (2, 1))

    def test_languages_and_nonword_senses_remain_separate(self):
        points = [QUALIFICATION, dict(QUALIFICATION, language="fr"),
                  dict(QUALIFICATION, kind="expression"), dict(LOGIN, kind="expression")]
        self.store.save("distinct-identities", points)
        self.assertEqual(len(self.store.query()["records"]), 4)

    def test_custom_note_survives_new_meaning_and_is_not_rebuilt(self):
        identifier = self.store.save("custom-original", [QUALIFICATION])["results"][0]["id"]
        self.store.update(identifier, Patch(note="My credential note\n\nMy personal reminder."))
        self.store.save("custom-new-meaning", [LOGIN])
        point = self.store.get_point(identifier)["record"]
        self.assertEqual(point["note"], "My credential note\n\nMy personal reminder.")
        self.assertEqual(point["additional_senses"][0]["meaning"], LOGIN["meaning"])
        self.assertEqual(self.store.query(keyword="authenticate")["records"][0]["id"], identifier)

    def test_priority_is_separate_from_fsrs_and_clears_only_after_success(self):
        identifier = self.save_at("priority-original", [QUALIFICATION])["results"][0]["id"]
        with patch("store.now", return_value=START.isoformat(timespec="microseconds")):
            original = self.store.record_review(identifier, "priority-first-review", Review(result="correct", effort="easy"))
        self.save_at("priority-repeat", [QUALIFICATION])
        self.save_at("priority-new-word", [APPROACH])
        with patch("store.now", return_value=START.isoformat(timespec="microseconds")):
            queue = self.store.review(language="en")
            self.assertEqual(queue["records"][0]["id"], identifier)
            self.assertEqual(queue["records"][0]["review_reason"], "repeated_question")
            self.assertEqual(queue["records"][0]["memory"], original["memory"])
            session = StudySessions(self.store).start("priority-study", language="en")
            self.assertEqual(session["session"]["current"]["record"]["id"], identifier)
        for i, review in enumerate((Review(result="skipped"), Review(result="correct", assisted=True), Review(result="incorrect"))):
            self.store.record_review(identifier, f"priority-keep-{i}", review)
            self.assertEqual(self.store.get_point(identifier)["record"]["repeat_priority"], 1)
        self.store.record_review(identifier, "priority-clear", Review(result="correct"))
        self.assertEqual(self.store.get_point(identifier)["record"]["repeat_priority"], 0)
        self.store.save("priority-later-question", [QUALIFICATION])
        self.store.record_review(identifier, "priority-clear", Review(result="correct"))
        self.assertEqual(self.store.get_point(identifier)["record"]["repeat_priority"], 1)
        self.store.update(identifier, Patch(status="mastered"))
        self.assertNotIn(identifier, [r["id"] for r in self.store.review()["records"]])

    def legacy_duplicates(self):
        first = self.store.save("legacy-original", [QUALIFICATION])["results"][0]["id"]
        with self.store.connection(write=True) as db:
            db.execute("DROP INDEX one_word_per_language")
            row = dict(db.execute("SELECT * FROM knowledge WHERE id = ?", (first,)).fetchone())
            row.pop("id")
            row.update(LOGIN, examples=encode(LOGIN["examples"]))
            columns = ", ".join(row)
            second = db.execute(f"INSERT INTO knowledge ({columns}) VALUES ({', '.join('?' for _ in row)})",
                                tuple(row.values())).lastrowid
            db.execute("INSERT INTO encounters (record_id, request_id, occurred_at, context, source) VALUES (?, ?, ?, ?, ?)",
                       (second, "legacy-original", row["last_seen_at"], LOGIN["context"], "automatic"))
            receipt = json.loads(db.execute("SELECT results FROM save_requests WHERE request_id = 'legacy-original'").fetchone()[0])
            receipt.append({**receipt[0], "id": second, "index": 1})
            db.execute("UPDATE save_requests SET results = ? WHERE request_id = 'legacy-original'", (encode(receipt),))
        return first, second

    def test_migration_preserves_notes_history_receipts_and_study(self):
        first, second = self.legacy_duplicates()
        self.store.record_review(second, "legacy-review", Review(result="incorrect"))
        self.store.update(second, Patch(note="My authentication note\n\nKeep this custom text."))
        # Both senses were selected before the schema changed.
        study = StudySessions(self.store)
        study.start("legacy-round", language="en", include_upcoming=True)
        migrated = Store(self.path)
        point = migrated.get_point(second)["record"]
        self.assertEqual(point["id"], first)
        self.assertEqual(point["encounter_count"], 1)
        self.assertIn(QUALIFICATION["meaning"], point["note"])
        self.assertIn("Keep this custom text.", point["note"])
        self.assertEqual(len(migrated.history(first)["encounters"]), 1)
        self.assertEqual(len(migrated.history(first)["reviews"]), 1)
        self.assertTrue(migrated.record_review(second, "legacy-review", Review(result="incorrect"))["replayed"])
        replay = migrated.save("legacy-original", [QUALIFICATION])
        self.assertEqual([r["id"] for r in replay["results"]], [first, first])
        self.assertEqual(StudySessions(migrated).get("legacy-round")["session"]["remaining"], 1)
        self.assertEqual(migrated.review(exclude_ids=[second], include_upcoming=True)["records"], [])
        self.assertEqual(migrated.export_records(record_ids=[second])[0]["id"], first)
        self.assertEqual(Store(self.path).get_point(first)["record"], point)
        with migrated.connection() as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(json.loads(db.execute("SELECT card FROM memory_states").fetchone()[0])["card_id"], first)
            self.assertEqual(json.loads(db.execute("SELECT original FROM merged_words").fetchone()[0])["record"]["id"], second)
        migrated.delete(second)
        self.assertEqual(migrated.query()["records"], [])
        self.assertTrue(migrated.save("legacy-original", [QUALIFICATION])["results"][0]["deleted"])
        self.assertTrue(migrated.record_review(second, "legacy-review", Review(result="incorrect"))["deleted"])
        self.assertEqual(migrated.query()["records"], [])

    def test_migration_keeps_latest_rated_state_after_a_later_skipped_attempt(self):
        first, second = self.legacy_duplicates()
        with patch("store.now", return_value=START.isoformat(timespec="microseconds")):
            self.store.record_review(first, "earlier-rated", Review(result="correct"))
        with patch("store.now", return_value=(START + timedelta(days=1)).isoformat(timespec="microseconds")):
            newer = self.store.record_review(second, "later-rated", Review(result="incorrect"))
        with patch("store.now", return_value=(START + timedelta(days=2)).isoformat(timespec="microseconds")):
            self.store.record_review(first, "latest-skipped", Review(result="skipped"))
        migrated = Store(self.path)
        self.assertEqual(migrated.history(first)["memory"]["due_at"], newer["memory"]["due_at"])
        self.assertEqual(migrated.get_point(first)["record"]["last_review_result"], "skipped")
        self.assertEqual(len(migrated.history(first)["reviews"]), 3)

    def test_migration_failure_is_atomic(self):
        first, second = self.legacy_duplicates()
        with self.store.connection(write=True) as db:
            db.execute("CREATE TRIGGER block_migration BEFORE DELETE ON knowledge BEGIN SELECT RAISE(ABORT, 'blocked'); END")
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError):
            Store(self.path)
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM knowledge").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM merged_words").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT record_id FROM encounters ORDER BY id").fetchall()[1][0], second)


if __name__ == "__main__":
    unittest.main()
