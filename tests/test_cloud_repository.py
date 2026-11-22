"""Run against isolated SQLite files, or TEST_DATABASE_URL for real PostgreSQL."""

import copy
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from cloud.database import create_database, create_session_factory
from cloud.models import (Base, Encounter, MemoryState, PointScene, ReviewEvent,
                          SaveRequest, Tenant)
from cloud.repository import Repository, tenant_identity
from store import Patch, Review, SettingsPatch


POINT = {
    "kind": "word", "language": "en", "title": "rinse", "sense_key": "wash",
    "meaning": "冲洗", "explanation": "Use rinse for cleaning something with water.",
    "examples": [{"text": "Rinse the cup.", "translation": "冲洗杯子。"},
                 {"text": "Rinse your mouth.", "translation": "漱口。"}],
    "scenes": ["Cleaning & hygiene", "At home"],
}


class CloudRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        url = os.environ.get("TEST_DATABASE_URL") or "sqlite:///" + str(Path(self.directory.name) / "cloud.sqlite3")
        self.engine = create_database(url, allow_sqlite=not bool(os.environ.get("TEST_DATABASE_URL")))
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.factory = create_session_factory(self.engine)
        suffix = uuid4().hex
        self.alice = SimpleNamespace(issuer="https://trusted.example/", subject="alice-" + suffix)
        self.bob = SimpleNamespace(issuer="https://trusted.example/", subject="bob-" + suffix)
        self.other_issuer = SimpleNamespace(issuer="https://another.example/", subject=self.alice.subject)
        self.repo = Repository(self.factory, self.alice)
        self.other = Repository(self.factory, self.bob)
        self.addCleanup(self.clean_tenants)

    def clean_tenants(self):
        with self.factory.begin() as session:
            session.execute(delete(Tenant).where(Tenant.id.in_([
                tenant_identity(principal)[0] for principal in (self.alice, self.bob, self.other_issuer)])))

    def save(self, repo=None, request_id=None, **kwargs):
        repo = repo or self.repo
        response = repo.save(request_id or "save-" + uuid4().hex, [dict(POINT, **kwargs)])
        self.assertEqual(response["results"][0]["status"], "added", response)
        return response["results"][0]["id"]

    def test_principal_isolation_covers_every_read_write_and_receipt(self):
        identifier = self.save(request_id="same-request")
        self.assertEqual(self.other.query()["records"], [])
        self.assertEqual(self.other.scenes()["total"], 0)
        self.assertEqual(self.other.languages()["counts"], {})
        self.assertEqual(self.other.get_point(identifier)["status"], "not_found")
        self.assertEqual(self.other.update(identifier, Patch(note="stolen"))["status"], "not_found")
        self.assertEqual(self.other.delete(identifier)["status"], "not_found")
        self.assertEqual(self.other.record_review(identifier, "same-review", Review(result="correct"))["status"], "not_found")
        self.assertEqual(self.other.review()["records"], [])
        self.assertEqual(Repository(self.factory, self.other_issuer).query()["records"], [])
        forged = Repository(self.factory, {"issuer": self.bob.issuer, "subject": self.bob.subject, "user_id": self.repo.tenant_id})
        self.assertEqual(forged.query()["records"], [])
        other_id = self.save(self.other, request_id="same-request")
        self.assertNotEqual(other_id, identifier)
        self.other.settings(SettingsPatch(enabled=False, first_language="fr"))
        self.assertTrue(self.repo.settings()["enabled"])
        self.assertIsNone(self.repo.settings()["first_language"])

    def test_idempotent_save_and_word_meanings_preserve_note_and_encounter(self):
        first = copy.deepcopy(POINT)
        second = dict(POINT, sense_key="rinse food", meaning="冲掉食物表面的杂质", context="Rinse the rice.", scenes=["Cooking"])
        batch = [first, second]
        response = self.repo.save("two-meanings", batch)
        self.assertEqual([result["status"] for result in response["results"]], ["added", "merged"])
        identifier = response["results"][0]["id"]
        self.assertEqual(response["results"][1]["encounter_count"], 1)
        point = self.repo.get_point(identifier)["record"]
        self.assertEqual(len(point["additional_senses"]), 1)
        self.assertEqual(point["scenes"], ["Cleaning & hygiene", "At home", "Cooking"])
        with self.factory() as session:
            self.assertEqual(session.scalar(select(func.count()).select_from(Encounter).where(Encounter.tenant_id == self.repo.tenant_id)), 1)
        replay = self.repo.save("two-meanings", batch)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["results"], response["results"])
        self.assertEqual(self.repo.save("two-meanings", [first])["error"], "request_id_conflict")
        self.repo.update(identifier, Patch(note="rinse\nMy edited note"))
        self.repo.save("later-encounter", [dict(POINT, context="Rinse your hands.")])
        current = self.repo.get_point(identifier)["record"]
        self.assertEqual(current["note"], "rinse\nMy edited note")
        self.assertEqual(current["encounter_count"], 2)
        self.repo.delete(identifier)
        self.assertTrue(self.repo.save("two-meanings", batch)["results"][0]["deleted"])
        self.assertEqual(self.repo.query()["records"], [])

    def test_paused_capture_and_kind_restrictions_remain_tenant_local(self):
        self.repo.settings(SettingsPatch(enabled=False))
        self.assertEqual(self.repo.save("paused-save", [POINT], "explicit")["status"], "paused")
        self.repo.settings(SettingsPatch(enabled=True, enabled_types=["grammar"]))
        self.assertEqual(self.repo.save("only-grammar", [POINT], "explicit")["results"][0]["reason"], "type_disabled")
        self.assertEqual(self.repo.query()["records"], [])
        self.assertTrue(self.other.settings()["enabled"])
        self.assertEqual(self.repo.versions()["preferences"], 2)

    def test_scenes_cross_types_and_filter_language_variants_with_unicode_keys(self):
        identifier = self.save()
        expression = self.save(kind="expression", title="wash your hands", scenes=["Cleaning & hygiene"])
        regional = self.save(language="en-CA", title="wipe", scenes=["Cleaning & hygiene"])
        self.save(language="fr", title="rincer", scenes=["Cleaning & hygiene"])
        self.assertEqual({p["id"] for p in self.repo.query(scene="cleaning & hygiene", language="en")["records"]}, {identifier, expression})
        self.assertEqual({p["id"] for p in self.repo.query(scene="Cleaning & hygiene", language="en", kind="word", include_variants=True)["records"]}, {identifier, regional})
        scenes = self.repo.scenes(language="en")
        self.assertEqual(scenes["total"], 2)
        self.assertEqual(sum(s["count"] for s in scenes["scenes"]), 3)
        long_label = "ß" * 80
        unicode_id = self.save(title="Unicode", sense_key="ß" * 150, scenes=[long_label])
        self.assertEqual(self.repo.query(scene="ss" * 80)["records"][0]["id"], unicode_id)
        self.assertEqual(self.repo.get_point(unicode_id)["record"]["sense_key"], "ss" * 150)

    def test_revision_checks_identity_conflict_and_manual_scenes_are_atomic(self):
        identifier = self.save()
        revision = self.repo.get_point(identifier)["record"]["revision"]
        changed = self.repo.update(identifier, Patch(scenes=["At home"]), revision)
        self.assertEqual(changed["status"], "updated")
        stale = self.repo.update(identifier, Patch(scenes=["Kitchen"], note="lost edit"), revision)
        self.assertEqual(stale["error"], "edit_conflict")
        self.repo.save("encounter-after-edit", [POINT])
        self.assertEqual(self.repo.get_point(identifier)["record"]["scenes"], ["At home"])
        self.repo.update(identifier, Patch(scenes=[]))
        self.repo.save("after-clear-scenes", [POINT])
        self.assertEqual(self.repo.get_point(identifier)["record"]["scenes"], [])
        conflict_id = self.save(title="wipe")
        result = self.repo.update(conflict_id, Patch(title="rinse", scenes=["Other"]))
        self.assertEqual(result["error"], "identity_conflict")
        self.assertEqual(self.repo.get_point(conflict_id)["record"]["title"], "wipe")

    def test_real_reviews_are_idempotent_and_leave_mastery_user_controlled(self):
        identifier = self.save()
        self.repo.save("repeat-before-review", [POINT])
        assisted = self.repo.record_review(identifier, "assisted-review", Review(result="correct", assisted=True, answer="rinse"))
        self.assertFalse(assisted["scheduled"])
        self.assertEqual(self.repo.get_point(identifier)["record"]["repeat_priority"], 1)
        partial = self.repo.record_review(identifier, "partial-review", Review(result="partial", answer="wash"))
        self.assertEqual(partial["rating"], 1)
        review = Review(result="correct", answer="rinse", effort="easy")
        result = self.repo.record_review(identifier, "correct-review", review)
        self.assertTrue(result["scheduled"])
        self.assertEqual(result["rating"], 4)
        replay = self.repo.record_review(identifier, "correct-review", review)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["event_id"], result["event_id"])
        self.assertEqual(replay["memory"]["rated_reviews"], 2)
        self.assertEqual(self.repo.get_point(identifier)["record"]["status"], "new")
        self.assertEqual(self.repo.get_point(identifier)["record"]["repeat_priority"], 0)
        self.repo.update(identifier, Patch(status="mastered"))
        self.repo.record_review(identifier, "incorrect-after-mastered", Review(result="incorrect", answer="?"))
        self.assertEqual(self.repo.get_point(identifier)["record"]["status"], "mastered")
        self.assertEqual(self.repo.review(include_upcoming=True)["records"], [])
        self.repo.delete(identifier)
        self.assertTrue(self.repo.record_review(identifier, "correct-review", review)["deleted"])
        with self.factory() as session:
            self.assertEqual(session.scalar(select(func.count()).select_from(ReviewEvent).where(ReviewEvent.tenant_id == self.repo.tenant_id)), 0)
            self.assertEqual(session.scalar(select(func.count()).select_from(MemoryState).where(MemoryState.tenant_id == self.repo.tenant_id)), 0)

    def test_concurrent_identical_requests_apply_capture_and_review_once(self):
        with ThreadPoolExecutor(max_workers=6) as workers:
            results = list(workers.map(lambda _: self.repo.save("concurrent-save", [POINT]), range(6)))
        self.assertEqual(sum(not r["replayed"] for r in results), 1)
        identifier = results[0]["results"][0]["id"]
        with ThreadPoolExecutor(max_workers=6) as workers:
            reviews = list(workers.map(lambda _: self.repo.record_review(identifier, "concurrent-review", Review(result="correct", answer="rinse")), range(6)))
        self.assertEqual(sum(not r["replayed"] for r in reviews), 1)
        self.assertEqual(self.repo.get_point(identifier)["record"]["encounter_count"], 1)
        self.assertEqual(len({r["event_id"] for r in reviews}), 1)

    def test_relational_foreign_keys_reject_cross_tenant_scene_memberships(self):
        identifier = self.save()
        self.save(self.other, title="secret", scenes=["Private"])
        with self.assertRaises(IntegrityError), self.factory.begin() as session:
            session.add(PointScene(tenant_id=self.other.tenant_id, point_id=identifier, scene_key="private", position=0))
        self.assertEqual(self.repo.get_point(identifier)["record"]["scenes"], POINT["scenes"])

    def test_concurrent_tenants_can_reuse_request_ids_without_sharing_records(self):
        def save_for(repo):
            return repo.save("shared-concurrent-id", [POINT])
        with ThreadPoolExecutor(max_workers=4) as workers:
            results = list(workers.map(save_for, [self.repo, self.other, self.repo, self.other]))
        self.assertEqual(sum(not result["replayed"] for result in results), 2)
        mine = self.repo.query()["records"]
        theirs = self.other.query()["records"]
        self.assertEqual((len(mine), len(theirs)), (1, 1))
        self.assertNotEqual(mine[0]["id"], theirs[0]["id"])

    def test_postgres_invalid_unicode_rejects_one_item_without_losing_partial_batch(self):
        items = [dict(POINT, meaning="bad\x00text"), dict(POINT, title="bad-surrogate", meaning="bad\ud800text"), POINT]
        result = self.repo.save("invalid-text-batch", items)
        self.assertEqual([r["status"] for r in result["results"]], ["failed", "failed", "added"])
        self.assertTrue(self.repo.save("invalid-text-batch", items)["replayed"])
        identifier = result["results"][2]["id"]
        with self.assertRaises(ValueError):
            self.repo.update(identifier, Patch(note="bad\x00note"))
        with self.assertRaises(ValueError):
            self.repo.query(keyword="bad\x00query")

    def test_scoped_cursor_search_and_partial_batch_do_not_leak_or_drop_results(self):
        ids = [self.save(title=title) for title in ("rinse", "rinse off", "rinsing", "other")]
        first = self.repo.query(keyword="rinse", limit=1)
        self.assertEqual(first["records"][0]["id"], ids[0])
        seen = [ids[0]]
        cursor = first["next_cursor"]
        while cursor:
            page = self.repo.query(keyword="rinse", limit=1, cursor=cursor)
            seen.extend(point["id"] for point in page["records"])
            cursor = page["next_cursor"]
        # All fixture examples contain "rinse"; exact title still ranks first.
        self.assertEqual(set(seen), set(ids))
        with self.assertRaises(ValueError):
            self.other.query(keyword="rinse", limit=1, cursor=first["next_cursor"])
        with self.assertRaises(ValueError):
            self.repo.query(cursor="malformed")
        result = self.repo.save("partial-batch", [{"kind": "word"}, dict(POINT, title="new item")])
        self.assertEqual([r["status"] for r in result["results"]], ["failed", "added"])

    def test_scene_overflow_is_atomic_and_scene_names_reuse_canonical_labels(self):
        identifier = self.save(scenes=[f"Scene {n}" for n in range(12)])
        before = self.repo.get_point(identifier)["record"]
        overflow = self.repo.save("overflow-scenes", [dict(POINT, scenes=["Another scene"])])
        self.assertEqual(overflow["results"][0]["error"], "scene_limit_exceeded")
        after = self.repo.get_point(identifier)["record"]
        self.assertEqual(after["encounter_count"], before["encounter_count"])
        self.assertEqual(after["scenes"], before["scenes"])
        second = self.save(title="wipe", scenes=["  SCENE   0  "])
        self.assertEqual(self.repo.get_point(second)["record"]["scenes"], ["Scene 0"])


if __name__ == "__main__":
    unittest.main()
