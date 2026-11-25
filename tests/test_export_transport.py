"""Isolated export delivery tests: no cloud account, tokens, user files or network."""
import base64
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from pydantic import ValidationError

from dashboard import Dashboard
from desktop_store import RoutingStore
from exports import ExportRequest
from mcp_app import AppTransport


RECORD = {
    "id": 900, "kind": "word", "language": "en", "title": "fixture-only",
    "note": "fixture-only\n\nOld-account export bytes", "note_title": "fixture-only", "note_is_custom": False,
    "status": "new", "encounter_count": 1, "created_at": "2026-11-20T12:00:00Z",
    "last_seen_at": "2026-11-20T12:00:00Z", "sense_key": "test fixture",
}


class Account:
    epoch = 7
    state = "connected"

    def status(self):
        return {"mode": "cloud", "state": self.state, "epoch": self.epoch}


class ExportStore(RoutingStore):
    """Exercise the real routing epoch binder, with memory-only records/receipts."""
    def __init__(self):
        self.fixture_account = Account()
        super().__init__(None, self.fixture_account)
        self.reads = []
        self.history = []

    def export_records(self, **filters):
        snapshot = self._snapshot()
        self._connected(snapshot)
        self.reads.append((snapshot["epoch"], filters))
        return [deepcopy(RECORD)]

    def export_receipt(self, scope, receipt=None):
        snapshot = self._snapshot()
        self._connected(snapshot)
        if receipt is not None:
            self.history.append((snapshot["epoch"], scope, deepcopy(receipt)))
        return self.history[-1][2] if self.history else None


class ExportTransportTests(unittest.TestCase):
    def setUp(self):
        self.store = ExportStore()
        self.bridge = AppTransport(self.store)

    def prepare(self, **values):
        return self.bridge.request("export", {"format": "json", "expected_epoch": 7, **values})

    def complete(self, token, epoch=7):
        return self.bridge.request("export_complete", {"receipt": token, "expected_epoch": epoch})

    def test_envelope_keeps_epoch_out_of_selection_and_requires_current_cloud_epoch(self):
        with self.assertRaises(ValidationError):
            ExportRequest.model_validate({"format": "json", "expected_epoch": 7})
        for payload, status, code in [
            ({"format": "json"}, 409, "connection_epoch_required"),
            ({"format": "json", "expected_epoch": None}, 409, "connection_epoch_required"),
            ({"format": "json", "expected_epoch": 6}, 409, "account_changed"),
            *[({"format": "json", "expected_epoch": epoch}, 400, "invalid_request")
              for epoch in (True, -1, "7", 7.0, {}, [])],
        ]:
            with self.subTest(payload=payload):
                self.assertEqual(self.bridge.request("export", payload), {"status": status, "data": {"error": code}})
        self.assertEqual(self.store.reads, [])
        result = self.prepare(language="en")
        self.assertEqual(result["status"], 200)
        self.assertEqual(self.store.reads[0][0], 7)
        self.assertNotIn("expected_epoch", self.store.reads[0][1])

    def test_switch_during_render_discards_old_bytes_and_receipt(self):
        def render(*_args):
            self.store.fixture_account.epoch += 1
            return b"OLD-ACCOUNT-PDF"
        with patch("exports.pdf_document", side_effect=render):
            result = self.prepare(format="pdf")
        self.assertEqual(result, {"status": 409, "data": {"error": "account_changed"}})
        self.assertNotIn("file", result)
        self.assertEqual(self.bridge.pending_exports, {})
        self.assertEqual(self.store.history, [])

    def test_switch_during_native_binary_encoding_also_discards_old_bytes(self):
        original = base64.b64encode
        def encode(data):
            encoded = original(data)
            self.store.fixture_account.epoch += 1
            return encoded
        with patch("mcp_app.base64.b64encode", side_effect=encode):
            result = self.prepare()
        self.assertEqual(result, {"status": 409, "data": {"error": "account_changed"}})
        self.assertEqual(self.bridge.pending_exports, {})
        self.assertEqual(self.store.history, [])

    def test_pending_ack_cannot_cross_accounts_with_old_or_current_epoch(self):
        token = self.prepare()["file"]["receipt"]
        self.store.fixture_account.epoch = 8
        for epoch in (7, 8):
            with self.subTest(epoch=epoch):
                self.assertEqual(self.complete(token, epoch), {"status": 409, "data": {"error": "account_changed"}})
        self.assertEqual(self.store.history, [])

    def test_ack_requires_original_epoch_and_is_idempotent_only_for_the_same_account(self):
        token = self.prepare()["file"]["receipt"]
        self.assertEqual(self.store.history, [], "preparing a file does not advance export history")
        self.assertEqual(self.bridge.request("export_complete", {"receipt": token}),
                         {"status": 409, "data": {"error": "connection_epoch_required"}})
        first = self.complete(token)
        replay = self.complete(token)
        self.assertEqual(first["data"], {"status": "ok", "replayed": False})
        self.assertEqual(replay["data"], {"status": "ok", "replayed": True})
        self.assertEqual(len(self.store.history), 1)
        self.assertEqual(self.store.history[0][0], 7)
        self.assertEqual(self.bridge.pending_exports, {})
        self.store.fixture_account.epoch = 8
        self.assertEqual(self.complete(token, 8), {"status": 409, "data": {"error": "account_changed"}})
        self.assertEqual(len(self.store.history), 1)

    def test_unknown_or_malformed_receipts_cannot_claim_success_or_update_history(self):
        for payload in [{"receipt": "unknown", "expected_epoch": 7}, {"receipt": [], "expected_epoch": 7},
                        {"receipt": "", "expected_epoch": 7}, {"receipt": "unknown", "expected_epoch": True},
                        {"receipt": "unknown", "expected_epoch": 7, "scope": "private"}]:
            self.assertEqual(self.bridge.request("export_complete", payload),
                             {"status": 400, "data": {"error": "invalid_request"}})
        self.assertEqual(self.store.history, [])

    def test_pending_metadata_is_bounded_and_does_not_cache_export_bytes(self):
        tokens = [self.prepare()["file"]["receipt"] for _ in range(17)]
        self.assertEqual(len(self.bridge.pending_exports), 16)
        for binding, selection, receipt in self.bridge.pending_exports.values():
            self.assertEqual(binding.epoch, 7)
            self.assertEqual(selection.format, "json")
            self.assertEqual(set(receipt), {"exported_at", "through_at", "start_at", "format", "count"})
        self.assertEqual(self.complete(tokens[0])["status"], 400)
        self.assertEqual(self.complete(tokens[-1])["status"], 200)


class LoopbackExportTests(unittest.TestCase):
    def setUp(self):
        self.store = ExportStore()
        self.dashboard = Dashboard(self.store)
        self.addCleanup(self.dashboard.close)
        self.url = self.dashboard.start()
        split = urlsplit(self.url)
        self.origin = split.scheme + "://" + split.netloc

    def post(self, route, payload, **headers):
        return urlopen(Request(self.url + route, data=json.dumps(payload).encode(), headers={
            "Content-Type": "application/json", "X-Language-Memory": "1", "Origin": self.origin, **headers,
        }), timeout=3)

    def assert_error(self, route, payload, status, code):
        with self.assertRaises(HTTPError) as raised:
            self.post(route, payload)
        self.assertEqual(raised.exception.code, status)
        self.assertEqual(json.load(raised.exception), {"error": code})
        raised.exception.close()

    def test_loopback_returns_receipt_but_advances_history_only_after_epoch_bound_ack(self):
        with self.post("export", {"format": "json", "expected_epoch": 7}) as response:
            token = response.headers["X-Export-Receipt"]
            self.assertTrue(token)
            self.assertEqual(json.load(response)["records"][0]["note"], RECORD["note"])
        self.assertEqual(self.store.history, [])
        with self.post("export_complete", {"receipt": token, "expected_epoch": 7}) as response:
            self.assertEqual(json.load(response), {"status": "ok", "replayed": False})
        with self.post("export_complete", {"receipt": token, "expected_epoch": 7}) as response:
            self.assertEqual(json.load(response), {"status": "ok", "replayed": True})
        self.assertEqual(len(self.store.history), 1)

    def test_loopback_stale_render_never_returns_old_file_or_receipt(self):
        def render(*_args):
            self.store.fixture_account.epoch = 8
            return b"OLD-ACCOUNT-PDF"
        with patch("exports.pdf_document", side_effect=render):
            self.assert_error("export", {"format": "pdf", "expected_epoch": 7}, 409, "account_changed")
        self.assertEqual(self.dashboard.httpd.exports.pending, {})
        self.assertEqual(self.store.history, [])

    def test_loopback_missing_stale_and_cross_account_ack_never_write_history(self):
        self.assert_error("export", {"format": "json"}, 409, "connection_epoch_required")
        with self.post("export", {"format": "json", "expected_epoch": 7}) as response:
            token = response.headers["X-Export-Receipt"]
            response.read()
        self.assert_error("export_complete", {"receipt": token}, 409, "connection_epoch_required")
        self.store.fixture_account.epoch = 8
        self.assert_error("export_complete", {"receipt": token, "expected_epoch": 7}, 409, "account_changed")
        self.assert_error("export_complete", {"receipt": token, "expected_epoch": 8}, 409, "account_changed")
        self.assert_error("export_complete", {"receipt": "unknown", "expected_epoch": 8}, 400, "invalid_request")
        self.assertEqual(self.store.history, [])

    def test_loopback_ack_keeps_origin_guard_before_accessing_pending_metadata(self):
        with self.assertRaises(HTTPError) as raised:
            self.post("export_complete", {"receipt": "unknown", "expected_epoch": 7}, Origin="https://unrelated.example")
        self.assertEqual(raised.exception.code, 403)
        raised.exception.close()
        self.assertEqual(self.store.history, [])


if __name__ == "__main__":
    unittest.main()
