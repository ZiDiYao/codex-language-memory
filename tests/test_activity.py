"""Isolated page activity tests; no real accounts, events or provider calls."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from activity import ActivityEvents, ActivityScope
import desktop_account as account
from desktop_store import RoutingStore
from mcp_app import AppTransport
from test_desktop_account import AudioStream, FakeCallback, MemoryKeyring, MockCloud


def event():
    return {"event_id": "02cb1ef7-c232-40fe-95be-f61bf9793932", "kind": "button",
            "occurred_at": datetime.now(timezone.utc).isoformat()}


class ForbiddenLocal:
    def __getattr__(self, name):
        raise AssertionError("activity accessed a local learning store: " + name)


class PageAccount:
    def __init__(self):
        self.epoch = 7
        self.calls = []
        self.change = False

    def status(self):
        return {"mode": "cloud", "state": "connected", "epoch": self.epoch}

    def request_api(self, method, path, params=None, json=None, *, expected_epoch=None):
        self.calls.append((method, path, params, json, expected_epoch))
        if self.change:
            self.epoch += 1
        return {"days": []} if method == "GET" else {"status": "ok", "accepted": 1}


class ActivityPageTests(unittest.TestCase):
    def setUp(self):
        self.account = PageAccount()
        self.bridge = AppTransport(RoutingStore(ForbiddenLocal(), self.account, migration=ForbiddenLocal()))

    def test_both_page_actions_require_current_epoch_before_any_network_or_migration(self):
        for name, arguments in [("activity/read", {"timezone": "America/Toronto"}),
                                ("activity/events", {"events": [event()]})]:
            for epoch, code in [(None, "connection_epoch_required"), (6, "account_changed")]:
                result = self.bridge.request("api", {"action": name, "arguments": arguments, "expected_epoch": epoch})
                self.assertEqual(result, {"status": 409, "data": {"error": code}})
        self.assertEqual(self.account.calls, [])

    def test_read_and_batch_route_only_to_fixed_cloud_paths_and_retain_epoch(self):
        scope = {"action": "activity/read", "arguments": {"timezone": "America/Toronto"}, "expected_epoch": 7}
        self.assertEqual(self.bridge.request("api", scope), {"status": 200, "data": {"days": []}})
        payload = {"events": [event()]}
        self.assertEqual(self.bridge.request("api", {"action": "activity/events", "arguments": payload, "expected_epoch": 7})["data"]["accepted"], 1)
        self.assertEqual(self.account.calls[0], ("GET", "/v1/activity", {"timezone": "America/Toronto"}, None, 7))
        self.assertEqual(self.account.calls[1][0:3], ("POST", "/v1/activity/events", None))
        self.assertEqual(self.account.calls[1][3]["events"][0]["kind"], "button")

    def test_an_account_change_discards_old_activity_results(self):
        self.account.change = True
        result = self.bridge.request("api", {"action": "activity/read", "arguments": {}, "expected_epoch": 7})
        self.assertEqual(result, {"status": 409, "data": {"error": "account_changed"}})

    def test_year_selection_reaches_the_fixed_api_without_losing_account_binding(self):
        result = self.bridge.request("api", {"action": "activity/read", "arguments": {
            "timezone": "America/Toronto", "year": 2024}, "expected_epoch": 7})
        self.assertEqual(result["status"], 200)
        self.assertEqual(self.account.calls, [("GET", "/v1/activity", {
            "timezone": "America/Toronto", "year": 2024}, None, 7)])
        for year in (True, "2024", 1969, 10000, 2024.5):
            reply = self.bridge.request("api", {"action": "activity/read", "arguments": {"year": year}, "expected_epoch": 7})
            self.assertEqual(reply["status"], 400)
        self.assertEqual(len(self.account.calls), 1)

    def test_activity_envelopes_reject_text_paths_unbounded_batches_and_untyped_times(self):
        for payload in [{}, {"events": []}, {"events": [event()] * 21},
                        {"events": [{**event(), "text": "private note"}]},
                        {"events": [{**event(), "kind": "account_signout"}]},
                        {"events": [{**event(), "event_id": "not-a-uuid"}]},
                        {"events": [{**event(), "occurred_at": 1234}]},
                        {"events": [{**event(), "occurred_at": "2026-11-24T12:00:00"}]}]:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                ActivityEvents.model_validate(payload)
        for zone in [True, [], "https://example.com", "UTC?query=private", "America//Toronto", "x" * 81]:
            with self.subTest(zone=zone), self.assertRaises(ValidationError):
                ActivityScope.model_validate({"timezone": zone})
        self.assertEqual(ActivityScope.model_validate({}).timezone, "UTC")

    def test_legacy_store_has_no_activity_fallback(self):
        reply = AppTransport(object()).request("api", {"action": "activity/read", "arguments": {}})
        self.assertEqual(reply, {"status": 400, "data": {"error": "cloud_feature_unavailable"}})


class ActivityCloud(MockCloud):
    def __init__(self):
        super().__init__()
        self.activity_requests = []
        self.respond = lambda request: httpx.Response(200, json={"days": []} if request.method == "GET" else {"status": "ok", "accepted": 1})

    async def __call__(self, request):
        if request.url.path in ("/v1/activity", "/v1/activity/events"):
            self.activity_requests.append(request)
            return self.respond(request)
        return await super().__call__(request)


class ActivityHttpTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="sayrove-activity-")
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "account.json"
        self.credentials = account.KeychainCredentials(MemoryKeyring())
        self.cloud = ActivityCloud()
        self.manager = self.create_manager()
        with patch.object(account, "_Loopback", FakeCallback):
            self.manager.begin_login()
            self.manager._login_future.result(timeout=5)
        self.assertEqual(self.manager.status()["state"], "connected")
        self.epoch = self.manager.status()["epoch"]
        self.cloud.requests.clear()

    def create_manager(self):
        manager = account.AccountManager(state_path=self.path, credentials=self.credentials,
            http_transport=httpx.MockTransport(self.cloud), request_timeout=3, login_timeout=3)
        self.addCleanup(manager.close)
        return manager

    def test_valid_token_activity_uses_one_fixed_bearer_request_without_metadata_or_preflight(self):
        self.assertEqual(self.manager.request_api("GET", "/v1/activity", {"timezone": "America/Toronto"}, expected_epoch=self.epoch), {"days": []})
        payload = {"events": [event()]}
        self.manager.request_api("POST", "/v1/activity/events", json=payload, expected_epoch=self.epoch)
        self.assertEqual(self.cloud.requests, [])
        self.assertEqual(len(self.cloud.activity_requests), 2)
        get, post = self.cloud.activity_requests
        self.assertEqual(get.url.params["timezone"], "America/Toronto")
        self.assertEqual(get.method, "GET")
        self.assertTrue(get.headers["authorization"].startswith("Bearer "))
        self.assertNotIn("cookie", get.headers)
        self.assertEqual(json.loads(post.content)["events"][0]["kind"], "button")

    def test_telemetry_skips_expired_tokens_without_refreshing_or_signing_out(self):
        envelope = self.manager.credentials.read()
        envelope["expires_at"] = time.time() - 1
        self.manager.credentials.write(envelope)
        before = len(self.cloud.exchanges)
        with self.assertRaises(account.AccountError) as raised:
            self.manager.request_api("POST", "/v1/activity/events", json={"events": [event()]}, expected_epoch=self.epoch)
        self.assertEqual(raised.exception.code, "account_busy")
        self.assertEqual(len(self.cloud.exchanges), before)
        self.assertEqual(self.cloud.activity_requests, [])
        self.assertEqual(self.manager.status()["state"], "connected")
        self.assertEqual(self.manager.status()["epoch"], self.epoch)

    def test_year_is_an_integer_query_value_and_not_an_arbitrary_path_or_payload(self):
        self.manager.request_api("GET", "/v1/activity", {"timezone": "America/Toronto", "year": 2024}, expected_epoch=self.epoch)
        self.assertEqual(len(self.cloud.activity_requests), 1)
        request = self.cloud.activity_requests[0]
        self.assertEqual(request.url.path, "/v1/activity")
        self.assertEqual(dict(request.url.params), {"timezone": "America/Toronto", "year": "2024"})
        self.assertEqual(request.content, b"")

    def test_explicit_activity_read_can_refresh_an_expired_token(self):
        envelope = self.manager.credentials.read()
        envelope["expires_at"] = time.time() - 1
        self.manager.credentials.write(envelope)
        before = len(self.cloud.exchanges)
        self.manager.request_api("GET", "/v1/activity", expected_epoch=self.epoch)
        self.assertEqual(len(self.cloud.exchanges), before + 1)
        self.assertEqual(len(self.cloud.activity_requests), 1)

    def test_slow_activity_body_does_not_hold_the_capture_operation_lock(self):
        entered, release = threading.Event(), threading.Event()
        stream = AudioStream([b'{"days":[]}'], entered=entered, release=release)
        self.cloud.respond = lambda request: httpx.Response(200, headers={"Content-Type": "application/json"}, stream=stream)
        other = self.create_manager()
        with ThreadPoolExecutor() as workers:
            future = workers.submit(self.manager.request_api, "GET", "/v1/activity", expected_epoch=self.epoch)
            try:
                self.assertTrue(entered.wait(1))
                result = other.call_tool("capture_and_context", {"request_id": "isolated-fixture", "items": []}, expected_epoch=self.epoch)
                self.assertIsInstance(result, dict)
                self.assertFalse(future.done())
            finally:
                release.set()
            self.assertEqual(future.result(timeout=3), {"days": []})

    def test_a_late_previous_account_response_is_discarded(self):
        def switch(request):
            self.manager.disconnect()
            return httpx.Response(200, json={"days": []})
        self.cloud.respond = switch
        with self.assertRaises(account.AccountError) as raised:
            self.manager.request_api("GET", "/v1/activity", expected_epoch=self.epoch)
        self.assertEqual(raised.exception.code, "account_changed")

    def test_authentication_failure_is_not_replayed_or_refreshed(self):
        self.cloud.respond = lambda request: httpx.Response(401, json={"error": "authentication_required"})
        exchanges = len(self.cloud.exchanges)
        with self.assertRaises(account.AccountError) as raised:
            self.manager.request_api("GET", "/v1/activity", expected_epoch=self.epoch)
        self.assertEqual(raised.exception.code, "authentication_required")
        self.assertEqual(len(self.cloud.activity_requests), 1)
        self.assertEqual(len(self.cloud.exchanges), exchanges)

    def test_oversized_invalid_json_and_redirects_are_safe_without_changing_account_state(self):
        for response in [httpx.Response(200, content=b"x" * 131073, headers={"Content-Type": "application/json"}),
                         httpx.Response(200, json=[]), httpx.Response(200, content=b"not-json", headers={"Content-Type": "application/json"}),
                         httpx.Response(307, headers={"Location": "https://invalid.example"})]:
            self.cloud.respond = lambda request, value=response: value
            with self.subTest(status=response.status_code), self.assertRaises(account.AccountError):
                self.manager.request_api("GET", "/v1/activity", expected_epoch=self.epoch)
            self.assertEqual(self.manager.status()["state"], "connected")
            self.assertNotIn("error", self.manager.status())


if __name__ == "__main__":
    unittest.main()
