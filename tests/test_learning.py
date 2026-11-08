import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fsrs import Card, Rating, Scheduler
from pydantic import ValidationError

from store import LearnerPreferences, Patch, Review, Store
from test_memory import APPROACH


START = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)


class LearningTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "learning.sqlite3"
        self.store = Store(self.path)
        with patch("store.now", return_value=START.isoformat(timespec="microseconds")):
            self.identifier = self.store.save("initial-encounter", [APPROACH])["results"][0]["id"]

    def review_at(self, key, result, instant=START, **extra):
        with patch("store.now", return_value=instant.isoformat(timespec="microseconds")):
            return self.store.record_review(self.identifier, key, Review(result=result, **extra))

    def test_matches_upstream_fsrs_over_success_and_lapse_sequence(self):
        scheduler = Scheduler(enable_fuzzing=False)
        expected = Card(card_id=self.identifier, due=START)
        for index, (days, result, rating) in enumerate([
            (0, "correct", Rating.Good), (1, "correct", Rating.Good),
            (8, "incorrect", Rating.Again), (9, "correct", Rating.Good),
            (20, "partial", Rating.Again),
        ]):
            instant = START + timedelta(days=days)
            expected, _ = scheduler.review_card(expected, rating, review_datetime=instant)
            actual = self.review_at(f"fsrs-sequence-{index}", result, instant)
            self.assertEqual(actual["memory"]["due_at"], expected.due.isoformat(timespec="microseconds"))
            self.assertAlmostEqual(actual["memory"]["stability_days"], expected.stability)
            self.assertAlmostEqual(actual["memory"]["difficulty"], expected.difficulty)
        reopened = Store(self.path)
        self.assertEqual(reopened.history(self.identifier)["memory"]["rated_reviews"], 5)
        record = reopened.query()["records"][0]
        self.assertEqual((record["status"], record["encounter_count"]), ("new", 1))

    def test_encounters_and_mastery_never_invent_retrieval_evidence(self):
        self.store.save("another-encounter", [dict(APPROACH, context="We need a fresh approach.")])
        self.store.save("another-encounter", [dict(APPROACH, context="We need a fresh approach.")])
        self.store.update(self.identifier, Patch(status="mastered"))
        history = self.store.history(self.identifier)
        self.assertEqual(len(history["encounters"]), 2)
        self.assertEqual(history["encounters"][1]["context"], APPROACH["context"])
        self.assertEqual(history["reviews"], [])
        self.assertIsNone(history["memory"]["estimated_recall"])
        self.assertEqual(self.store.learning_profile()["evidence_status"], "not_assessed")

    def test_skip_and_assistance_preserve_schedule_partial_is_again(self):
        first = self.review_at("first-review", "correct")
        for index, review in enumerate([Review(result="skipped"), Review(result="correct", assisted=True),
                                         Review(result="incorrect", assisted=True)]):
            result = self.store.record_review(self.identifier, f"unrated-attempt-{index}", review)
            self.assertFalse(result["scheduled"])
            self.assertEqual(result["memory"]["due_at"], first["memory"]["due_at"])
            self.assertEqual(result["memory"]["rated_reviews"], 1)
        partial = self.review_at("partial-answer", "partial", START + timedelta(days=1))
        self.assertEqual(partial["rating"], int(Rating.Again))
        hard = self.review_at("correct-but-hard", "correct", START + timedelta(days=2), effort="hard")
        self.assertEqual(hard["rating"], int(Rating.Hard))
        with self.assertRaises(ValidationError):
            Review(result="partial", effort="hard")

    def test_review_retry_is_atomic_concurrent_and_payload_checked(self):
        def attempt(_):
            return Store(self.path).record_review(self.identifier, "same-review-id", Review(result="correct"))
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(attempt, range(4)))
        self.assertEqual(sum(result["replayed"] for result in results), 3)
        self.assertEqual(len(self.store.history(self.identifier)["reviews"]), 1)
        self.assertEqual(self.store.history(self.identifier)["memory"]["rated_reviews"], 1)
        conflict = self.store.record_review(self.identifier, "same-review-id", Review(result="incorrect"))
        self.assertEqual(conflict["error"], "request_id_conflict")
        self.assertEqual(self.store.query()["records"][0]["encounter_count"], 1)

    def test_failed_event_rolls_back_scheduler_summary_and_receipt(self):
        with self.store.connection(write=True) as db:
            db.execute("CREATE TRIGGER fail_review BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT, 'fail'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.review_at("atomic-review", "correct")
        history = self.store.history(self.identifier)
        self.assertFalse(history["memory"]["assessed"])
        self.assertIsNone(history["record"]["last_reviewed_at"])
        with self.store.connection(write=True) as db:
            db.execute("DROP TRIGGER fail_review")
        self.assertFalse(self.review_at("atomic-review", "correct")["replayed"])

    def test_due_queue_filters_language_mastery_and_future(self):
        result = self.review_at("first-queue-review", "correct")
        unseen = self.store.save("queue-new-points", [dict(APPROACH, title="strategy"), dict(APPROACH, language="ja")])["results"]
        with patch("store.now", return_value=START.isoformat(timespec="microseconds")):
            queue = self.store.review(language="en")
            self.assertEqual([r["id"] for r in queue["records"]], [unseen[0]["id"]])
            self.assertEqual(queue["next_due_at"], result["memory"]["due_at"])
            early = self.store.review(language="en", include_upcoming=True)
            self.assertEqual(early["records"][-1]["review_reason"], "upcoming")
        with patch("store.now", return_value=(START + timedelta(days=1)).isoformat(timespec="microseconds")):
            queue = self.store.review(language="en")
            self.assertEqual([r["id"] for r in queue["records"]], [self.identifier, unseen[0]["id"]])
        self.store.update(self.identifier, Patch(status="mastered"))
        self.assertNotIn(self.identifier, [r["id"] for r in self.store.review()["records"]])
        self.store.update(self.identifier, Patch(status="new"))
        self.assertEqual(self.store.history(self.identifier)["memory"]["rated_reviews"], 1)

    def test_profile_uses_scoped_evidence_and_prequential_predictions(self):
        self.review_at("profile-review-one", "correct")
        self.review_at("profile-review-two", "incorrect", START + timedelta(days=5))
        self.review_at("profile-review-skip", "skipped", START + timedelta(days=6))
        self.store.save("separate-japanese", [dict(APPROACH, language="ja")])
        english = self.store.learning_profile(language="en")
        japanese = self.store.learning_profile(language="ja")
        self.assertEqual(english["rated_reviews"], 2)
        self.assertEqual(japanese["rated_reviews"], 0)
        self.assertEqual(english["recurring_points"][0]["unsuccessful_recalls"], 1)
        self.assertEqual(english["prediction_evaluation"]["predictions"], 1)
        predicted = self.store.history(self.identifier)["reviews"][1]["predicted_recall"]
        self.assertAlmostEqual(english["prediction_evaluation"]["brier_score"], predicted ** 2)
        self.assertFalse(english["algorithm"]["personal_parameters_trained"])

    def test_preferences_are_explicit_scoped_clearable_and_independent_of_ui(self):
        self.store.learning_preferences(patch=LearnerPreferences(explanation_language="zh"))
        self.store.learning_preferences("ja", LearnerPreferences(explanation_style="concise", interests=["travel"]))
        reopened = Store(self.path)
        self.assertEqual(len(reopened.learning_profile(language="ja")["preferences"]), 2)
        self.assertEqual(len(reopened.learning_profile(language="en")["preferences"]), 1)
        self.assertEqual(reopened.settings()["ui_language"], "en")
        cleared = reopened.learning_preferences("ja", LearnerPreferences(interests=None))
        self.assertNotIn("interests", cleared["preferences"])
        self.assertEqual(cleared["preferences"]["explanation_style"], "concise")

    def test_deletion_removes_evidence_and_does_not_resurrect_on_review_retry(self):
        self.review_at("delete-review", "incorrect", prompt="What does approach mean?", answer="Near")
        self.store.delete(self.identifier)
        retry = self.review_at("delete-review", "incorrect", prompt="What does approach mean?", answer="Near")
        self.assertTrue(retry["replayed"])
        self.assertTrue(retry["deleted"])
        self.assertEqual(self.store.history(self.identifier)["status"], "not_found")
        self.assertEqual(self.store.learning_profile()["rated_reviews"], 0)
        with self.store.connection() as db:
            for table in ("memory_states", "encounters", "review_events"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
            receipt = db.execute("SELECT result FROM review_requests").fetchone()[0]
            self.assertNotIn("Near", receipt)

    def test_history_paginates_and_reports_missing_legacy_contexts(self):
        for index in range(4):
            self.store.save(f"history-encounter-{index}", [dict(APPROACH, context=f"Context {index}")])
            self.review_at(f"history-review-{index}", "correct", START + timedelta(days=index))
        for collection, cursor_name, next_name, expected in (
            ("encounters", "before_encounter_id", "next_encounter_before_id", 5),
            ("reviews", "before_review_id", "next_review_before_id", 4),
        ):
            collected, cursor = [], None
            while True:
                result = self.store.history(self.identifier, limit=2, **{cursor_name: cursor})
                collected.extend(r["id"] for r in result[collection])
                cursor = result[next_name]
                if cursor is None:
                    break
            self.assertEqual(len(set(collected)), expected)
            self.assertEqual(len(collected), expected)
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET encounter_count = encounter_count + 3")
        self.assertEqual(Store(self.path).history(self.identifier)["encounters_without_history"], 3)

    def test_legacy_review_summary_does_not_seed_a_fabricated_memory_model(self):
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET last_review_result = 'correct', last_reviewed_at = ?", (START.isoformat(),))
        reopened = Store(self.path)
        self.assertFalse(reopened.history(self.identifier)["memory"]["assessed"])
        self.assertEqual(reopened.learning_profile()["rated_reviews"], 0)
        rejected = reopened.update(self.identifier, Patch(status="mastered", review_result="correct"))
        self.assertEqual(rejected["error"], "use_record_review_with_request_id")
        self.assertEqual(reopened.query()["records"][0]["status"], "new")

    def test_clock_reversal_does_not_corrupt_memory(self):
        self.review_at("clock-first-review", "correct", START + timedelta(days=1))
        rejected = self.review_at("clock-old-review", "incorrect", START)
        self.assertEqual(rejected["error"], "clock_moved_backwards")
        self.assertEqual(len(self.store.history(self.identifier)["reviews"]), 1)

    def test_pre_upgrade_connection_deletion_also_removes_learning_evidence(self):
        self.review_at("legacy-client-review", "correct")
        with sqlite3.connect(self.path) as legacy:
            self.assertEqual(legacy.execute("PRAGMA foreign_keys").fetchone()[0], 0)
            legacy.execute("DELETE FROM knowledge WHERE id = ?", (self.identifier,))
        with self.store.connection() as db:
            for table in ("encounters", "review_events", "memory_states"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
