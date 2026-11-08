import hashlib
import tempfile
import unittest
from pathlib import Path

from store import Patch, Store, encode
from test_memory import APPROACH


class ContentQualityTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "memory.sqlite3"
        self.store = Store(self.path)

    def seed(self):
        return self.store.save("initial-save", [APPROACH])["results"][0]["id"]

    def test_capture_requires_two_distinct_originals_and_keeps_partial_results(self):
        invalid = [[], APPROACH["examples"][:1], [
            {"text": "Try a different approach.", "translation": "First translation"},
            {"text": "  ＴＲＹ  A DIFFERENT APPROACH.  ", "translation": "Different translation"},
        ]]
        results = self.store.save("quality-batch", [
            *[dict(APPROACH, examples=examples) for examples in invalid], APPROACH,
        ])["results"]
        self.assertEqual([item["status"] for item in results], ["failed"] * 3 + ["added"])
        self.assertTrue(all(item["errors"][0]["field"] == "examples" for item in results[:3]))
        saved = Store(self.path).query()["records"]
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0]["content_ready"])
        self.assertEqual(saved[0]["examples"], APPROACH["examples"])

    def test_legacy_single_example_is_enriched_without_new_learning_evidence(self):
        identifier = self.seed()
        self.store.update(identifier, Patch(examples=APPROACH["examples"][:1], status="mastered"))
        old = Store(self.path).query(needs_enrichment=True)["records"][0]
        self.assertFalse(old["content_ready"])
        result = self.store.update(identifier, Patch(examples=APPROACH["examples"]), old["revision"])
        self.assertEqual(result["status"], "updated")
        self.assertTrue(result["record"]["content_ready"])
        for field in ("encounter_count", "last_seen_at", "status", "last_reviewed_at", "last_review_result"):
            self.assertEqual(result["record"][field], old[field])
        self.assertEqual(Store(self.path).query(needs_enrichment=True)["records"], [])

    def test_duplicate_legacy_examples_do_not_count_twice(self):
        identifier = self.seed()
        self.store.update(identifier, Patch(examples=[APPROACH["examples"][0]] * 2))
        result = self.store.query(needs_enrichment=True)["records"]
        self.assertEqual([item["id"] for item in result], [identifier])
        self.assertFalse(result[0]["content_ready"])

    def test_new_encounter_appends_examples_preserving_the_existing_translation(self):
        identifier = self.seed()
        original = dict(APPROACH["examples"][0], translation="My original translation")
        self.store.update(identifier, Patch(examples=[original]))
        self.store.save("later-encounter", [APPROACH])
        point = self.store.query()["records"][0]
        self.assertEqual(point["examples"], [original, APPROACH["examples"][1]])
        self.assertTrue(point["content_ready"])
        self.assertEqual(point["encounter_count"], 2)
        self.assertTrue(self.store.save("later-encounter", [APPROACH])["replayed"])
        self.assertEqual(self.store.query()["records"][0]["encounter_count"], 2)

    def test_custom_notes_including_empty_notes_are_not_regenerated(self):
        identifier = self.seed()
        for index, note in enumerate(("My edited note", "")):
            self.store.update(identifier, Patch(note=note, examples=[], explanation=None))
            self.store.save(f"new-encounter-{index}", [APPROACH])
            point = self.store.query()["records"][0]
            self.assertEqual(point["note"], note)
            self.assertEqual(point["examples"], [])
            self.assertTrue(point["content_ready"])
            self.assertEqual(self.store.query(needs_enrichment=True)["records"], [])

    def test_pre_upgrade_receipt_replays_before_stricter_validation(self):
        identifier = self.seed()
        items = [dict(APPROACH, examples=APPROACH["examples"][:1])]
        original_results = [{"index": 0, "status": "added", "id": identifier, "encounter_count": 1}]
        with self.store.connection(write=True) as db:
            db.execute("INSERT INTO save_requests VALUES (?, ?, ?)", (
                "old-version-save", hashlib.sha256(encode(items).encode()).hexdigest(), encode(original_results),
            ))
        replay = Store(self.path).save("old-version-save", items)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["results"], original_results)
        self.assertEqual(self.store.query()["records"][0]["encounter_count"], 1)


if __name__ == "__main__":
    unittest.main()
