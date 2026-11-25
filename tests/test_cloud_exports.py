"""Isolated cloud export fixtures: no real accounts, storage or remote traffic."""
import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import httpx
from pydantic import ValidationError

import cloud_exports
import desktop_account as account
from desktop_store import CloudAccountUnavailable, RoutingStore
from exports import ExportError, ExportRequest, build_export
from test_desktop_account import AudioStream, FakeCallback, MemoryKeyring, MockCloud


def record(identifier, *, kind="word", created="2026-11-01T00:00:00+00:00", seen="2026-11-03T00:00:00+00:00"):
    return {"id": identifier, "kind": kind, "title": "Fixture " + str(identifier), "language": "en",
            "status": "new", "note_title": "Fixture " + str(identifier), "note_is_custom": False,
            "note": "# Fixture note", "meaning": "Fixture meaning", "explanation": None, "examples": [],
            "created_at": created, "last_seen_at": seen, "encounter_count": 1, "sense_key": "fixture",
            "last_reviewed_at": None, "last_review_result": None, "scenes": ["Fixture scene"]}


def page(records, more=False, cursor=None):
    return {"records": records, "has_more": more, "next_cursor": cursor}


class ForbiddenLocal:
    def __getattr__(self, name):
        raise AssertionError("cloud export touched SQLite: " + name)


class FixtureAccount:
    def __init__(self, path, *, identity="a" * 64):
        self.state = account._StateFile(path)
        self.epoch, self.identity = 7, identity
        with self.state.locked() as state:
            state.update(mode="cloud", state="connected", epoch=self.epoch)
        self.pages = {None: page([record(3)], True, "next-page"), "next-page": page([record(2), record(1)])}
        self.versions = [20, 20]
        self.calls = []
        self.after_page = None

    def status(self):
        return {key: self.state.read()[key] for key in ("mode", "state", "epoch")}

    def account_fingerprint(self, *, expected_epoch=None):
        if expected_epoch != self.state.read()["epoch"]:
            raise account.AccountError("account_changed")
        return self.identity

    def request_export_page(self, path, params=None, *, expected_epoch, budget, max_bytes):
        self.calls.append((path, copy.deepcopy(params), expected_epoch, budget, max_bytes))
        data = {"content": self.versions.pop(0), "preferences": 1} if path == "/v1/changes" else self.pages[params.get("cursor")]
        if self.after_page and path == "/v1/points":
            self.after_page(params)
        return {"data": copy.deepcopy(data), "identity": self.identity, "epoch": expected_epoch,
                "source_bytes": len(json.dumps(data).encode())}


class CloudSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.account = FixtureAccount(Path(self.directory.name) / "account.json")
        class ForbiddenMigration:
            def ensure(self, *args, **kwargs): raise AssertionError("export started a legacy import")
        self.store = RoutingStore(ForbiddenLocal(), self.account, migration=ForbiddenMigration())

    def test_all_pages_are_read_with_server_scope_and_final_version_before_render(self):
        with self.store.expect_epoch(7, require_cloud=True):
            records = self.store.export_records(keyword="Fixture", language="en", status="new", scene="Fixture scene",
                                                include_variants=False)
        self.assertEqual([row["id"] for row in records], [3, 2, 1])
        self.assertEqual([call[0] for call in self.account.calls], ["/v1/changes", "/v1/points", "/v1/points", "/v1/changes"])
        self.assertEqual(self.account.calls[1][1], {"keyword": "Fixture", "kind": None, "language": "en", "status": "new",
            "scene": "Fixture scene", "include_variants": False, "limit": 50})
        self.assertEqual(self.account.calls[2][1]["cursor"], "next-page")
        self.assertTrue(all(call[2] == 7 and 0 < call[3] <= 50 and call[4] <= 16 * 1024 * 1024 for call in self.account.calls))

    def test_local_multiple_kind_id_and_half_open_date_filters_preserve_complete_result(self):
        self.account.pages = {None: page([
            record(4, kind="grammar", created="2026-11-02T00:00:00Z"),
            record(3, kind="expression", created="2026-11-03T00:00:00Z"),
        ], True, "last"), "last": page([
            record(2, kind="word", created="2026-11-02T00:00:00Z"), record(1),
        ])}
        with self.store.expect_epoch(7, require_cloud=True):
            result = self.store.export_records(kinds=["word", "expression"], record_ids=[2, 3, 4],
                start_at="2026-11-02T00:00:00Z", end_at="2026-11-03T00:00:00Z")
        self.assertEqual([row["id"] for row in result], [2])
        self.account.versions = [20, 20]
        with self.store.expect_epoch(7, require_cloud=True):
            result = self.store.export_records(kinds=["word"], date_field="last_seen_at", start_at="2026-11-03T00:00:00Z")
        self.assertEqual([row["id"] for row in result], [2, 1])

    def test_changed_versions_duplicate_cursors_or_records_never_return_partial_data(self):
        for scenario in ("version", "cursor", "record", "empty-page", "malformed"):
            with self.subTest(scenario=scenario):
                self.account.versions = [20, 21 if scenario == "version" else 20]
                self.account.pages = {None: page([record(3)], True, "next-page"), "next-page": page([record(2)])}
                if scenario == "cursor": self.account.pages["next-page"] = page([record(2)], True, "next-page")
                if scenario == "record": self.account.pages["next-page"] = page([record(3)])
                if scenario == "empty-page": self.account.pages[None] = page([], True, "next-page")
                if scenario == "malformed": self.account.pages["next-page"]["has_more"] = "false"
                with self.assertRaisesRegex(ExportError, "exportChanged"):
                    self.store.export_records()

    def test_midway_account_or_transport_failure_never_renders_a_partial_file(self):
        def change(_):
            with self.account.state.locked() as state:
                state["epoch"] += 1
        self.account.after_page = change
        with self.assertRaises(CloudAccountUnavailable):
            build_export(self.store, ExportRequest(format="json"))
        self.assertNotIn("export_receipts", self.account.state.read())

    def test_midway_transport_failure_or_unexpected_identity_cannot_return_or_record_partial_export(self):
        original = self.account.request_export_page
        for scenario in ("transport", "identity"):
            def interrupted(path, params=None, **kwargs):
                if path == "/v1/points" and params.get("cursor"):
                    if scenario == "transport": raise account.AccountError("cloud_unavailable")
                    reply = original(path, params, **kwargs)
                    reply["identity"] = "b" * 64
                    return reply
                return original(path, params, **kwargs)
            self.account.request_export_page = interrupted
            self.account.versions = [20, 20]
            with self.subTest(scenario=scenario), self.assertRaises((account.AccountError, ExportError)):
                build_export(self.store, ExportRequest(format="json"))
            self.assertNotIn("export_receipts", self.account.state.read())

    def test_source_record_and_total_time_bounds_fail_closed(self):
        for name, value in [("MAX_RECORDS", 1), ("MAX_SOURCE_BYTES", 100), ("EXPORT_BUDGET", .001)]:
            with self.subTest(limit=name):
                self.account.versions = [20, 20]
                self.account.after_page = (lambda _: time.sleep(.005)) if name == "EXPORT_BUDGET" else None
                with patch.object(cloud_exports, name, value), self.assertRaisesRegex(ExportError, "exportTimeout" if name == "EXPORT_BUDGET" else "exportTooLarge"):
                    self.store.export_records()

    def test_invalid_selection_and_stale_or_missing_epoch_do_not_fetch_records(self):
        for filters in ({"date_field": "updated_at"}, {"kind": "word", "kinds": ["word"]}, {"record_ids": [True]},
                        {"start_at": "2026-11-03T00:00:00Z", "end_at": "2026-11-01T00:00:00Z"}):
            with self.assertRaises((ValueError, ValidationError)):
                self.store.export_records(**filters)
        with self.assertRaises(CloudAccountUnavailable):
            with self.store.expect_epoch(6, require_cloud=True): self.store.export_records()
        with self.assertRaises(CloudAccountUnavailable):
            with self.store.expect_epoch(None, require_cloud=True): self.store.export_records()
        self.assertEqual(self.account.calls, [])


class CloudReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "account.json"
        self.account = FixtureAccount(self.path)
        self.store = RoutingStore(ForbiddenLocal(), self.account)
        self.receipt = {"exported_at": "2026-11-24T20:00:00Z", "through_at": "2026-11-24T20:00:00Z",
                        "start_at": None, "format": "json", "count": 3}

    def test_receipts_persist_cross_instance_and_reconnect_only_for_the_same_account(self):
        self.assertIsNone(self.store.export_receipt("private keyword scope"))
        self.assertEqual(self.store.export_receipt("private keyword scope", self.receipt), self.receipt)
        other = RoutingStore(ForbiddenLocal(), FixtureAccount(self.path))
        self.assertEqual(other.export_receipt("private keyword scope"), self.receipt)
        self.account.identity = "b" * 64
        self.assertIsNone(self.store.export_receipt("private keyword scope"))
        self.store.export_receipt("private keyword scope", {**self.receipt, "count": 2})
        self.account.identity = "a" * 64
        self.assertEqual(self.store.export_receipt("private keyword scope")["count"], 3)
        with self.account.state.locked() as state: state["epoch"] = 9
        self.assertEqual(self.store.export_receipt("private keyword scope")["count"], 3)
        saved = self.path.read_text()
        self.assertNotIn("private keyword", saved); self.assertNotIn("Fixture note", saved)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_simultaneous_receipts_preserve_both_updates_and_do_not_store_arbitrary_fields(self):
        second = RoutingStore(ForbiddenLocal(), FixtureAccount(self.path))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [pool.submit(store.export_receipt, name, self.receipt) for store, name in
                       [(self.store, "first"), (second, "second")]]
            for pending in results: pending.result(timeout=3)
        self.assertEqual(self.store.export_receipt("first"), self.receipt)
        self.assertEqual(second.export_receipt("second"), self.receipt)
        with self.assertRaises(ValidationError): self.store.export_receipt("bad", {**self.receipt, "access_token": "forbidden-fixture"})
        with self.assertRaises(ValidationError): self.store.export_receipt("bad", {**self.receipt, "count": 10001})
        self.assertNotIn("forbidden-fixture", self.path.read_text())

    def test_epoch_change_after_fingerprint_before_atomic_receipt_write_is_rejected(self):
        original = self.account.account_fingerprint
        def changed(**kwargs):
            value = original(**kwargs)
            with self.account.state.locked() as state: state["epoch"] += 1
            return value
        self.account.account_fingerprint = changed
        with self.assertRaises(CloudAccountUnavailable): self.store.export_receipt("scope", self.receipt)
        self.assertNotIn("export_receipts", self.account.state.read())

    def test_history_metadata_has_bounded_accounts_and_scope_hashes(self):
        for index in range(34): self.store.export_receipt(str(index), self.receipt)
        self.assertEqual(len(self.account.state.read()["export_receipts"][self.account.identity]), 32)
        for index in range(1, 10):
            self.account.identity = f"{index:064x}"
            self.store.export_receipt("scope", self.receipt)
        self.assertEqual(len(self.account.state.read()["export_receipts"]), 8)


class ExportAccountTransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.cloud = MockCloud(); self.respond = None; self.requests = []
        async def transport(request):
            if request.url.path == "/v1/points" and request.headers.get("Authorization"):
                self.requests.append(request)
                if self.respond: return self.respond(request)
                return httpx.Response(200, json=page([record(1)]))
            return await self.cloud(request)
        self.manager = account.AccountManager(state_path=Path(self.directory.name) / "account.json",
            credentials=account.KeychainCredentials(MemoryKeyring()), http_transport=httpx.MockTransport(transport),
            request_timeout=3, login_timeout=3)
        self.addCleanup(self.manager.close)
        with patch.object(account, "_Loopback", FakeCallback):
            self.manager.begin_login(); self.manager._login_future.result(timeout=4)
        self.epoch = self.manager.status()["epoch"]

    def request(self, **kwargs):
        return self.manager.request_export_page("/v1/points", {"limit": 50, "include_variants": False},
            expected_epoch=self.epoch, budget=2, max_bytes=10000, **kwargs)

    def test_authenticated_bounded_get_and_connected_capability_do_not_change_learning_data(self):
        self.assertTrue(self.manager.status()["capabilities"]["export"])
        result = self.request()
        self.assertEqual(result["identity"], self.manager.account_fingerprint(expected_epoch=self.epoch))
        self.assertEqual(result["data"]["records"][0]["id"], 1)
        request = self.requests[-1]
        self.assertEqual((request.method, request.url.host, request.url.path), ("GET", "language-memory-api.up.railway.app", "/v1/points"))
        self.assertEqual(request.url.params["include_variants"], "false")
        self.assertTrue(request.headers["Authorization"].startswith("Bearer "))
        for path, params in [("https://unrelated.invalid", None), ("/v1/points/1", None), ("/v1/changes", {"cursor": "bad"}),
                             ("/v1/points", {"limit": 51}), ("/v1/points", {"url": "https://unrelated.invalid"})]:
            with self.assertRaises((account.AccountError, ValidationError)):
                self.manager.request_export_page(path, params, expected_epoch=self.epoch, budget=2, max_bytes=10000)
        self.assertEqual(len(self.requests), 1)
        for epoch in (None, True, -1):
            with self.assertRaises(account.AccountError):
                self.manager.request_export_page("/v1/points", expected_epoch=epoch, budget=2, max_bytes=10000)
        self.assertEqual(len(self.requests), 1)

    def test_oversize_declared_or_streamed_and_invalid_responses_fail_without_partial_records(self):
        for response in [
            lambda: httpx.Response(200, headers={"Content-Type": "application/json", "Content-Length": "10001"}, stream=AudioStream([b'{}'])),
            lambda: httpx.Response(200, headers={"Content-Type": "application/json"}, stream=AudioStream([b'x' * 10001])),
            lambda: httpx.Response(200, headers={"Content-Type": "text/html"}, content=b'private upstream details'),
            lambda: httpx.Response(302, headers={"Location": "https://unrelated.invalid"}),
            lambda: httpx.Response(200, headers={"Content-Type": "application/json"}, content=b'{private malformed json'),
        ]:
            self.respond = lambda request: response()
            with self.assertRaises((account.AccountError, ExportError)) as raised: self.request()
            self.assertNotIn("private", str(raised.exception))
        self.assertEqual(self.cloud.unexpected_urls, [])

    def test_slow_export_page_releases_credential_lock_so_chat_calls_can_complete(self):
        entered, release = threading.Event(), threading.Event()
        stream = AudioStream([json.dumps(page([record(1)])).encode()], entered=entered, release=release)
        self.respond = lambda request: httpx.Response(200, headers={"Content-Type": "application/json"}, stream=stream)
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.request)
            try:
                self.assertTrue(entered.wait(2))
                chat = pool.submit(self.manager.call_tool, "get_settings", expected_epoch=self.epoch)
                self.assertTrue(chat.result(timeout=1)["enabled"])
            finally: release.set()
            self.assertEqual(pending.result(timeout=3)["data"]["records"][0]["id"], 1)
        self.assertTrue(stream.closed)


if __name__ == "__main__":
    unittest.main()
