import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dashboard import dispatch
from exports import ExportRequest
from store import Patch, Store
from test_memory import APPROACH


class DocumentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "documents.sqlite3"
        self.store = Store(self.path)

    def save(self, title="approach", language="en", kind="word"):
        return self.store.save(f"document-{title}-{language}", [dict(
            APPROACH, title=title, language=language, kind=kind,
        )])["results"][0]["id"]

    def test_language_pages_follow_observed_records_and_deletions(self):
        self.assertEqual(self.store.languages()["languages"], [])
        first = self.save()
        second = self.save("method", "en-us")
        grammar = self.save("past tense", kind="grammar")
        catalog = self.store.languages()
        self.assertEqual(catalog["counts"], {"en": 3})
        self.assertEqual(catalog["by_language"], {"en": {"word": 2, "grammar": 1}})
        french = self.save("bonjour", "fr")
        self.assertEqual(self.store.languages()["counts"], {"en": 3, "fr": 1})
        for record_id in (first, second, grammar):
            self.store.delete(record_id)
        self.assertEqual(self.store.languages()["counts"], {"fr": 1})
        self.store.delete(french)
        self.assertEqual(self.store.languages()["kinds"], {})

    def test_document_edits_persist_without_encounters_or_reviews(self):
        record_id = self.save()
        before = self.store.get_point(record_id)["record"]
        updated = self.store.update(record_id, Patch(
            title="my approach", explanation="My own explanation", context=None,
            examples=[{"text": "Try another approach.", "translation": "A different method."}],
        ), before["revision"])
        self.assertEqual(updated["status"], "updated")
        after = Store(self.path).get_point(record_id)["record"]
        self.assertEqual(after["title"], "my approach")
        self.assertEqual(after["explanation"], "My own explanation")
        for key in ("encounter_count", "last_seen_at", "last_reviewed_at", "status"):
            self.assertEqual(after[key], before[key])
        self.assertNotEqual(after["revision"], before["revision"])
        stale = self.store.update(record_id, Patch(meaning="Stale content"), before["revision"])
        self.assertEqual(stale["error"], "edit_conflict")
        self.assertEqual(stale["record"], after)
        self.assertEqual(self.store.get_point(record_id)["record"], after)

    def test_only_one_concurrent_editor_can_use_a_revision(self):
        record_id = self.save()
        revision = self.store.get_point(record_id)["record"]["revision"]
        def update(text):
            return Store(self.path).update(record_id, Patch(explanation=text), revision)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(update, ["First edit", "Second edit"]))
        self.assertEqual(sorted(item["status"] for item in results), ["failed", "updated"])
        self.assertEqual(next(item for item in results if item["status"] == "failed")["error"], "edit_conflict")

    def test_encounter_does_not_invalidate_unchanged_content_and_delete_never_resurrects(self):
        record_id = self.save()
        revision = self.store.get_point(record_id)["record"]["revision"]
        self.store.save("another-encounter", [APPROACH])
        self.assertEqual(self.store.get_point(record_id)["record"]["revision"], revision)
        self.assertEqual(self.store.update(record_id, Patch(status="mastered"), revision)["status"], "updated")
        self.store.delete(record_id)
        self.assertEqual(self.store.update(record_id, Patch(meaning="No resurrection"), revision)["status"], "not_found")
        self.assertEqual(self.store.get_point(record_id)["status"], "not_found")

    def test_dashboard_read_conflict_and_exact_export_scope(self):
        first, second = self.save(), self.save("method")
        def call(action, **arguments):
            return dispatch(self.store, {"action": action, "arguments": arguments})
        original = call("points/read", record_id=first)["record"]
        call("points/update", record_id=first, patch={"meaning": "Updated meaning"}, expected_revision=original["revision"])
        self.assertEqual(call("points/update", record_id=first, patch={"meaning": "Old meaning"}, expected_revision=original["revision"])["error"], "edit_conflict")
        request = ExportRequest(format="json", record_ids=[second])
        filters = request.filters()
        self.assertEqual([record["id"] for record in self.store.export_records(**filters)], [second])


if __name__ == "__main__":
    unittest.main()
