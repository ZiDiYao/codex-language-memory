"""Offline migration fixtures only: no user databases, network, or credentials."""

import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import stat
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import uuid

from desktop_migration import DesktopMigration, MigrationError, TABLES
from desktop_store import CloudAccountUnavailable, RoutingStore
from store import Patch, Review, SettingsPatch, Store


POINT = {
    "kind": "word", "language": "en", "title": "fixture migration term", "sense_key": "fixture sense",
    "meaning": "Temporary test content.", "explanation": "This record exists only in a temporary test database.",
    "examples": [{"text": "This is the first fixture sentence."}, {"text": "This is the second fixture sentence."}],
    "scenes": ["Fixture scene"],
}


class FakeAccount:
    def __init__(self, subject="fixture-account-a", *, state="connected"):
        self.subject, self.state, self.epoch = subject, state, 1
        self.calls = []
        self.fingerprint_calls = 0
        self.tool_calls = []
        self.outcomes = []
        self.on_request = None

    def status(self):
        return {"mode": "cloud", "state": self.state, "epoch": self.epoch}

    def _check(self, expected_epoch):
        if expected_epoch != self.epoch:
            raise CloudAccountUnavailable("account_changed")
        if self.state != "connected":
            raise CloudAccountUnavailable()

    def account_fingerprint(self, *, expected_epoch):
        self._check(expected_epoch)
        self.fingerprint_calls += 1
        return hashlib.sha256(("https://issuer.example/\0" + self.subject).encode()).hexdigest()

    def request_api(self, method, path, *, json, expected_epoch):
        self._check(expected_epoch)
        self.calls.append((method, path, copy.deepcopy(json), expected_epoch))
        if self.on_request:
            self.on_request()
        outcome = self.outcomes.pop(0) if self.outcomes else "imported"
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, dict):
            return outcome
        return {"status": outcome, "source_id": json["source_id"],
                "counts": {name: len(rows) for name, rows in json["tables"].items()}}

    def call_tool(self, name, arguments, *, expected_epoch):
        self._check(expected_epoch)
        self.tool_calls.append((name, arguments))
        return {"records": [], "has_more": False, "next_cursor": None}


class DesktopMigrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="sayrove-migration-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.database = self.directory / "fixture.sqlite3"
        self.store = Store(self.database)
        self.record_id = self.store.save("fixture-capture", [POINT], "explicit")["results"][0]["id"]
        self.store.update(self.record_id, Patch(note="Frozen fixture note"))
        self.store.settings(SettingsPatch(ui_language="zh", first_language="en"))
        self.store.record_review(self.record_id, "fixture-review", Review(result="correct", answer="fixture response"))
        self.migration = DesktopMigration(self.database)
        self.account = FakeAccount()

    def receipt(self):
        return json.loads(self.migration.receipt.read_text())

    def test_uploads_raw_learning_tables_once_and_keeps_source_database_unchanged(self):
        before = self.database.read_bytes()
        self.migration.ensure(self.account, expected_epoch=1)
        self.migration.ensure(self.account, expected_epoch=1)
        DesktopMigration(self.database).ensure(self.account, expected_epoch=1)
        self.assertEqual(len(self.account.calls), 1)
        method, path, payload, epoch = self.account.calls[0]
        self.assertEqual((method, path, epoch), ("POST", "/v1/desktop-imports", 1))
        self.assertEqual(set(payload), {"schema_version", "source_id", "tables"})
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(str(uuid.UUID(payload["source_id"])), payload["source_id"])
        self.assertEqual(set(payload["tables"]), set(TABLES))
        self.assertEqual(len(payload["tables"]), 11)
        self.assertEqual(payload["tables"]["knowledge"][0]["note"], "Frozen fixture note")
        self.assertEqual(payload["tables"]["encounters"][0]["source"], "explicit")
        self.assertEqual(payload["tables"]["review_events"][0]["answer"], "fixture response")
        self.assertTrue(payload["tables"]["memory_states"])
        self.assertEqual(payload["tables"]["study_sessions"], [])
        self.assertEqual(self.receipt()["status"], "complete")
        self.assertEqual(self.database.read_bytes(), before)
        backup = self.migration._backup_path(payload["source_id"])
        for private_file in (backup, self.migration.receipt, self.migration.receipt.with_suffix(".lock")):
            self.assertEqual(stat.S_IMODE(private_file.stat().st_mode), 0o600)

    def test_retry_after_lost_network_response_reuses_source_id_and_frozen_data_even_after_source_changes(self):
        self.account.outcomes = [ConnectionError("fixture connection lost after upload"), "already_imported"]
        with self.assertRaises(MigrationError) as failure:
            self.migration.ensure(self.account, expected_epoch=1)
        self.assertEqual(failure.exception.code, "cloud_import_unavailable")
        pending = self.receipt()
        first_payload = self.account.calls[0][2]
        self.assertEqual(pending["status"], "pending")
        self.store.update(self.record_id, Patch(note="Source edited after first upload"))
        self.store.save("later-fixture", [{**POINT, "title": "later fixture term"}], "explicit")
        DesktopMigration(self.database).ensure(self.account, expected_epoch=1)
        self.assertEqual(self.account.calls[1][2], first_payload)
        self.assertEqual(self.receipt()["snapshot_sha"], pending["snapshot_sha"])
        self.assertEqual(self.receipt()["status"], "complete")
        self.assertEqual(len(self.account.calls[1][2]["tables"]["knowledge"]), 1)

    def test_pending_import_is_bound_to_first_account_and_can_resume_only_for_it(self):
        self.account.outcomes = [ConnectionError("fixture offline")]
        with self.assertRaises(MigrationError):
            self.migration.ensure(self.account, expected_epoch=1)
        other = FakeAccount("fixture-account-b")
        with self.assertRaises(MigrationError) as failure:
            DesktopMigration(self.database).ensure(other, expected_epoch=1)
        self.assertEqual(failure.exception.code, "cloud_import_account_mismatch")
        self.assertEqual(other.calls, [])
        self.assertEqual(self.receipt()["status"], "pending")
        self.migration.ensure(self.account, expected_epoch=1)
        self.assertEqual(self.receipt()["status"], "complete")

    def test_completed_import_is_never_replayed_into_another_account(self):
        self.migration.ensure(self.account, expected_epoch=1)
        original = self.migration.receipt.read_bytes()
        other = FakeAccount("fixture-account-b")
        DesktopMigration(self.database).ensure(other, expected_epoch=1)
        self.assertEqual(other.calls, [])
        self.assertEqual(other.fingerprint_calls, 0)
        self.assertEqual(self.migration.receipt.read_bytes(), original)

    def test_upload_excludes_credentials_and_non_whitelisted_tables_and_receipt_keeps_only_safe_counts(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("CREATE TABLE oauth_credentials (access_token TEXT, refresh_token TEXT)")
            connection.execute("INSERT INTO oauth_credentials VALUES (?, ?)", ("fixture-access-secret", "fixture-refresh-secret"))
            connection.execute("CREATE TABLE arbitrary_private_table (body TEXT)")
            connection.execute("INSERT INTO arbitrary_private_table VALUES ('fixture-private-body')")
        def response():
            payload = self.account.calls[-1][2]
            return {"status": "imported", "source_id": payload["source_id"], "counts": {
                "knowledge": 1, "encounters": True, "review_events": -1, "memory_states": "1",
                "access_token": "fixture-returned-secret", "notes": "fixture-returned-note"}}
        self.account.on_request = lambda: self.account.outcomes.append(response())
        self.migration.ensure(self.account, expected_epoch=1)
        uploaded = json.dumps(self.account.calls[0][2])
        for private in ("oauth_credentials", "arbitrary_private_table", "fixture-access-secret", "fixture-refresh-secret", "fixture-private-body", "save_requests", "review_requests"):
            self.assertNotIn(private, uploaded)
        receipt = self.migration.receipt.read_text()
        for private in ("fixture-returned-secret", "fixture-returned-note", "Frozen fixture note", self.account.subject):
            self.assertNotIn(private, receipt)
        self.assertEqual(self.receipt()["counts"], {"knowledge": 1})

    def test_account_change_during_upload_does_not_mark_migration_complete(self):
        self.account.on_request = lambda: setattr(self.account, "epoch", 2)
        with self.assertRaises(CloudAccountUnavailable) as failure:
            self.migration.ensure(self.account, expected_epoch=1)
        self.assertEqual(failure.exception.code, "account_changed")
        self.assertEqual(self.receipt()["status"], "pending")

    def test_modified_frozen_backup_fails_before_a_retry_is_uploaded(self):
        self.account.outcomes = [ConnectionError("fixture offline")]
        with self.assertRaises(MigrationError):
            self.migration.ensure(self.account, expected_epoch=1)
        backup = self.migration._backup_path(self.receipt()["source_id"])
        with sqlite3.connect(backup) as connection:
            connection.execute("UPDATE knowledge SET note = 'tampered fixture' WHERE id = ?", (self.record_id,))
        with self.assertRaises(MigrationError):
            self.migration.ensure(self.account, expected_epoch=1)
        self.assertEqual(len(self.account.calls), 1)
        self.assertEqual(self.receipt()["status"], "pending")

    def test_router_never_starts_migration_until_cloud_login_succeeds_and_never_falls_back_after_failure(self):
        for state in ("signed_out", "connecting", "error"):
            with self.subTest(state=state):
                account = FakeAccount(state=state)
                routed = RoutingStore(None, account, migration=self.migration)
                with patch.object(self.migration, "ensure", wraps=self.migration.ensure) as ensure:
                    with self.assertRaises(CloudAccountUnavailable):
                        routed.query()
                    ensure.assert_not_called()
                self.assertFalse(self.migration.receipt.exists())
                self.assertEqual(account.calls, [])
        self.account.outcomes = [ConnectionError("fixture offline")]
        routed = RoutingStore(None, self.account, migration=self.migration)
        with self.assertRaises(MigrationError):
            routed.query()
        self.assertEqual(self.account.tool_calls, [])
        self.assertEqual(self.receipt()["status"], "pending")

    def test_separate_migration_instances_serialize_concurrent_uploads(self):
        entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
        def blocking_request():
            entered.set()
            if not release.wait(3):
                raise AssertionError("fixture upload was not released")
        self.account.on_request = blocking_request
        other = DesktopMigration(self.database)
        def second():
            second_started.set()
            other.ensure(self.account, expected_epoch=1)
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.migration.ensure, self.account, expected_epoch=1)
            try:
                self.assertTrue(entered.wait(3))
                second_result = executor.submit(second)
                self.assertTrue(second_started.wait(3))
                self.assertEqual(len(self.account.calls), 1)
            finally:
                release.set()
            first.result(timeout=3)
            second_result.result(timeout=3)
        self.assertEqual(len(self.account.calls), 1)
        self.assertEqual(self.receipt()["status"], "complete")

    def test_fresh_cloud_installation_with_no_legacy_database_needs_no_import(self):
        migration = DesktopMigration(self.directory / "new-install" / "absent.sqlite3")
        migration.ensure(self.account, expected_epoch=1)
        self.assertEqual(self.account.calls, [])
        self.assertFalse(migration.receipt.exists())
        self.assertFalse(migration.database.exists())

    def test_databases_in_the_same_directory_have_independent_receipts_and_uploads(self):
        other_store = Store(self.directory / "second-fixture.sqlite3")
        other_store.save("second-capture", [{**POINT, "title": "independent fixture term"}], "explicit")
        other = DesktopMigration(other_store.path)
        self.migration.ensure(self.account, expected_epoch=1)
        other.ensure(self.account, expected_epoch=1)
        self.assertNotEqual(self.migration.receipt, other.receipt)
        self.assertNotEqual(self.migration.receipt.with_suffix(".lock"), other.receipt.with_suffix(".lock"))
        self.assertEqual(len(self.account.calls), 2)
        self.assertNotEqual(self.account.calls[0][2]["source_id"], self.account.calls[1][2]["source_id"])
        self.assertEqual(self.account.calls[1][2]["tables"]["knowledge"][0]["title"], "independent fixture term")
        self.assertEqual(json.loads(other.receipt.read_text())["status"], "complete")

    def test_symlink_alias_of_the_same_database_shares_its_completed_receipt(self):
        alias = self.directory / "alias-fixture.sqlite3"
        alias.symlink_to(self.database)
        other = DesktopMigration(alias)
        self.assertEqual(other.receipt, self.migration.receipt)
        self.migration.ensure(self.account, expected_epoch=1)
        other.ensure(self.account, expected_epoch=1)
        self.assertEqual(len(self.account.calls), 1)


if __name__ == "__main__":
    unittest.main()
