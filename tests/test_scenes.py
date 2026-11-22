import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pydantic import ValidationError

from dashboard_actions import dispatch
from exports import ExportSelection, export_scope, preview_export
from store import KnowledgePoint, Patch, Review, Store
from test_memory import APPROACH


class SceneTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "scenes.sqlite3"
        self.store = Store(self.path)
        self.encounter = 0

    def save(self, title, *, kind="word", language="en", **kwargs):
        self.encounter += 1
        result = self.store.save(f"scene-save-{self.encounter}", [dict(
            APPROACH, title=title, kind=kind, language=language, **kwargs)])
        self.assertEqual(result["results"][0]["status"], "added", result)
        return result["results"][0]["id"]

    def test_scenes_overlap_across_types_and_combine_with_other_filters(self):
        rinse = self.save("rinse", scenes=["Cleaning & hygiene", "At home"])
        wash = self.save("wash your hands", kind="expression", scenes=["Cleaning & hygiene"])
        regional = self.save("rub", language="en-CA", scenes=["Cleaning & hygiene"])
        self.save("rinse", language="fr", scenes=["Cleaning & hygiene"])
        self.assertEqual({r["id"] for r in self.store.query(scene="Cleaning & hygiene", language="en")["records"]}, {rinse, wash})
        self.assertEqual([r["id"] for r in self.store.query(scene="Cleaning & hygiene", language="en", kind="word")["records"]], [rinse])
        self.assertEqual({r["id"] for r in self.store.query(scene="Cleaning & hygiene", language="en", kind="word", include_variants=True)["records"]}, {rinse, regional})
        self.assertEqual([r["id"] for r in self.store.query(scene="At home")["records"]], [rinse])
        self.assertEqual(self.store.query(scene="Missing")["records"], [])
        self.assertEqual(self.store.query(scene="At home", keyword="not present")["records"], [])

    def test_names_are_normalized_reused_and_counts_are_distinct(self):
        self.save("alpha", scenes=["  At   home ", "at home", "ＡＴ　ＨＯＭＥ", "Travel"])
        second = self.save("beta", scenes=["AT HOME"])
        self.assertEqual(self.store.get_point(second)["record"]["scenes"], ["At home"])
        self.assertEqual(self.store.scenes(), {"scenes": [{"name": "At home", "count": 2}, {"name": "Travel", "count": 1}], "total": 2})
        self.assertEqual(self.store.scenes(language="fr"), {"scenes": [], "total": 0})
        self.assertEqual(len(self.store.query(scene="ａｔ　ｈｏｍｅ")["records"]), 2)

    def test_offline_defaults_group_targets_without_matching_incidental_examples(self):
        for title, expected in [("rinse", "Cleaning & hygiene"), ("rub", "Cleaning & hygiene"),
                                ("turn on", "Device controls"), ("turn off", "Device controls"),
                                ("sneeze", "Body reactions"), ("fart", "Body reactions"), ("cough", "Body reactions")]:
            meaning = {"rub": "Rub soap between your hands to clean them.", "turn on": "Start an electrical device.", "turn off": "Switch off an electrical device."}.get(title, "A bodily action.")
            identifier = self.save(title, meaning=meaning, kind="expression" if " " in title else "word")
            self.assertEqual(self.store.get_point(identifier)["record"]["scenes"], [expected])
        for title in ("rub it in", "cough up", "approach"):
            identifier = self.save(title, examples=[{"text": "Rinse the cup."}, {"text": "Turn on the light."}])
            self.assertEqual(self.store.get_point(identifier)["record"]["scenes"], [])
        identifier = self.save("turn on", language="en-US", meaning="To sexually arouse or excite someone.")
        self.assertEqual(self.store.get_point(identifier)["record"]["scenes"], [])
        for title, meaning in [("rub", "Massage a sore shoulder."), ("turn off", "Leave the main road."), ("hiccup", "A small technical problem.")]:
            identifier = self.save(title, language="en-CA", meaning=meaning)
            self.assertEqual(self.store.get_point(identifier)["record"]["scenes"], [])

    def test_new_sense_merges_labels_without_overwriting_custom_notes_or_review(self):
        identifier = self.save("rub", scenes=["Cleaning & hygiene"])
        self.store.update(identifier, Patch(note="My own rub note"))
        self.store.record_review(identifier, "scene-review-1", Review(result="correct", answer="rub"))
        before = self.store.history(identifier)
        point = dict(APPROACH, title="rub", sense_key="massage", scenes=["Body care"])
        self.store.save("scene-new-meaning", [point])
        after = self.store.history(identifier)
        self.assertEqual(after["record"]["scenes"], ["Cleaning & hygiene", "Body care"])
        self.assertEqual(after["record"]["note"], "My own rub note")
        self.assertEqual(after["record"]["encounter_count"], 2)
        self.assertEqual(after["reviews"], before["reviews"])
        self.assertEqual(after["memory"].get("due_at"), before["memory"].get("due_at"))
        self.assertTrue(self.store.save("scene-new-meaning", [point])["replayed"])
        self.assertEqual(self.store.get_point(identifier)["record"]["encounter_count"], 2)

    def test_manual_subset_and_empty_labels_survive_capture_and_restart(self):
        identifier = self.save("rinse", scenes=["Cleaning & hygiene", "At home"])
        point = dict(APPROACH, title="rinse", scenes=["Cleaning & hygiene", "At home", "Other"])
        for index, labels in enumerate((["At home"], [])):
            self.assertEqual(self.store.update(identifier, Patch(scenes=labels))["status"], "updated")
            self.store.save(f"scene-repeat-{index}", [point])
            self.store = Store(self.path)
            self.assertEqual(self.store.get_point(identifier)["record"]["scenes"], labels)
        self.assertEqual(self.store.scenes()["scenes"], [])

    def test_legacy_backfill_preserves_notes_timestamps_counts_and_evidence(self):
        identifier = self.save("sneeze")
        self.store.update(identifier, Patch(note="sneeze\n打喷嚏"))
        self.store.record_review(identifier, "scene-migrate-review", Review(result="partial", answer="sneezed"))
        before = self.store.history(identifier)
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET scenes = NULL WHERE id = ?", (identifier,))
        # Concurrent process starts must serialize additive migration safely.
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda _: Store(self.path), range(3)))
        after = self.store.history(identifier)
        self.assertEqual(after["record"]["scenes"], ["Body reactions"])
        for field in ("note", "created_at", "last_seen_at", "encounter_count", "repeat_priority", "status"):
            self.assertEqual(after["record"][field], before["record"][field])
        self.assertEqual(after["encounters"], before["encounters"])
        self.assertEqual(after["reviews"], before["reviews"])

    def test_legacy_word_merge_preserves_scene_union_and_manual_precedence(self):
        for index, (primary_custom, duplicate_custom, expected) in enumerate([
            (False, False, ["Cleaning & hygiene", "Body care"]),
            (True, False, ["Cleaning & hygiene"]),
            (False, True, ["Body care"]),
            (True, True, ["Cleaning & hygiene"]),
        ]):
            with self.subTest(primary_custom=primary_custom, duplicate_custom=duplicate_custom):
                path = self.path.parent / f"legacy-{index}.sqlite3"
                store = Store(path)
                identifier = store.save("legacy-scene-first", [dict(APPROACH, title="rub", scenes=["Cleaning & hygiene"])])["results"][0]["id"]
                with store.connection(write=True) as db:
                    db.execute("DROP INDEX one_word_per_language")
                    db.execute("UPDATE knowledge SET scenes_custom = ? WHERE id = ?", (primary_custom, identifier))
                    duplicate = dict(db.execute("SELECT * FROM knowledge WHERE id = ?", (identifier,)).fetchone())
                    duplicate.pop("id")
                    duplicate.update(sense_key="massage", scenes=json.dumps(["Body care"]), scenes_custom=int(duplicate_custom))
                    cursor = db.execute(f"INSERT INTO knowledge ({', '.join(duplicate)}) VALUES ({', '.join('?' for _ in duplicate)})", tuple(duplicate.values()))
                    duplicate_id = cursor.lastrowid
                migrated = Store(path)
                record = migrated.get_point(identifier)["record"]
                self.assertEqual(record["scenes"], expected)
                self.assertEqual(record["encounter_count"], 2)
                self.assertEqual(migrated.get_point(duplicate_id)["record"]["id"], identifier)
                with migrated.connection() as db:
                    row = db.execute("SELECT scenes_custom FROM knowledge WHERE id = ?", (identifier,)).fetchone()
                    self.assertEqual(bool(row[0]), primary_custom or duplicate_custom)
                    original = json.loads(db.execute("SELECT original FROM merged_words WHERE old_id = ?", (duplicate_id,)).fetchone()[0])
                    self.assertEqual(json.loads(original["record"]["scenes"]), ["Body care"])

    def test_migration_respects_custom_notes_instead_of_historical_meanings(self):
        identifier = self.save("rinse")
        self.store.update(identifier, Patch(note="My different note\nNo cleaning content"))
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET scenes = NULL WHERE id = ?", (identifier,))
        self.store = Store(self.path)
        self.assertEqual(self.store.get_point(identifier)["record"]["scenes"], [])

    def test_revision_conflicts_and_validation_prevent_lost_scene_edits(self):
        identifier = self.save("rinse")
        revision = self.store.get_point(identifier)["record"]["revision"]
        self.store.update(identifier, Patch(scenes=["Kitchen"]), revision)
        rejected = self.store.update(identifier, Patch(scenes=["Bathroom"]), revision)
        self.assertEqual(rejected["error"], "edit_conflict")
        self.assertEqual(self.store.get_point(identifier)["record"]["scenes"], ["Kitchen"])
        for labels in ([" "], ["a" * 81], ["\ufdfa" * 5], ["Work, meetings"], ["Work；meetings"], [str(i) for i in range(13)]):
            with self.assertRaises(ValidationError):
                Patch(scenes=labels)
        self.assertEqual(self.store.update(identifier, Patch(scenes=None))["error"], "scenes_cannot_be_null")

    def test_merged_scene_limit_does_not_partially_add_an_encounter(self):
        labels = [f"Scene {index}" for index in range(12)]
        identifier = self.save("rinse", scenes=labels)
        before = self.store.get_point(identifier)["record"]
        result = self.store.save("scene-overflow", [dict(APPROACH, title="rinse", scenes=["Another scene"])])
        self.assertEqual(result["results"][0]["error"], "scene_limit_exceeded")
        after = self.store.get_point(identifier)["record"]
        self.assertEqual(after["scenes"], labels)
        self.assertEqual(after["encounter_count"], before["encounter_count"])
        self.assertEqual(after["last_seen_at"], before["last_seen_at"])

    def test_page_actions_export_and_review_use_the_same_scene_scope(self):
        identifier = self.save("rinse", scenes=["Cleaning & hygiene", "At home"])
        self.save("turn on", kind="expression", scenes=["Device controls"])
        def call(action, arguments):
            return dispatch(self.store, {"action": action, "arguments": arguments})
        self.assertEqual(call("scenes/list", {"kind": "word"})["total"], 1)
        self.assertEqual([r["id"] for r in call("points/query", {"scene": "At home", "kind": "word"})["records"]], [identifier])
        self.assertEqual(preview_export(self.store, ExportSelection(scene="At home", kind="word"))["count"], 1)
        self.assertEqual(preview_export(self.store, ExportSelection(scene="At home", kind="expression"))["count"], 0)
        self.assertEqual([r["id"] for r in self.store.review(scene="At home")["records"]], [identifier])
        # Empty scene filters must retain the pre-upgrade export history key.
        self.assertNotIn("scene", json.loads(export_scope(ExportSelection())))
        self.assertEqual(json.loads(export_scope(ExportSelection(scene="At home")))["scene"], "At home")


if __name__ == "__main__":
    unittest.main()
