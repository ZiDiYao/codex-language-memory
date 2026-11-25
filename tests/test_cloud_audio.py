"""Isolated cloud pronunciation bridge tests: no real accounts, network or voices."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import httpx
from pydantic import ValidationError

import desktop_account as account
from cloud_audio import audio_response
from dashboard import Dashboard
from desktop_store import CloudAccountUnavailable, CloudFeatureUnavailable, RoutingStore
from mcp_app import AppTransport
from test_desktop_account import FakeCallback, MemoryKeyring, MockCloud


AUDIO = b"RIFF\x00\x80\xff\x2aWAVE"
MAXIMUM = 2 * 1024 * 1024


class ForbiddenLocal:
    def __getattr__(self, name):
        raise AssertionError("cloud pronunciation accessed local storage or voices: " + name)


class AudioAccount:
    def __init__(self, *, mode="cloud", state="connected"):
        self.mode, self.state, self.epoch = mode, state, 7
        self.calls = []
        self.after_call = None
        self.failure = None
        self.result = {"status": "ok", "audio": AUDIO, "mime_type": "audio/wav"}

    def status(self):
        return {"mode": self.mode, "state": self.state, "epoch": self.epoch}

    def request_audio(self, record_id, *, expected_epoch=None):
        self.calls.append((record_id, expected_epoch))
        if self.failure:
            raise self.failure
        if self.after_call:
            self.after_call()
        return self.result


class CloudAudioBridgeTests(unittest.TestCase):
    def setUp(self):
        self.account = AudioAccount()
        self.store = RoutingStore(ForbiddenLocal(), self.account)

    def test_audio_payload_is_strict_and_never_accepts_text_urls_voices_or_paths(self):
        for payload in [None, [], "7", {}, {"record_id": True}, {"record_id": "7"},
                        {"record_id": 7.0}, {"record_id": 0}, {"record_id": -1},
                        {"record_id": 7, "expected_epoch": True},
                        {"record_id": 7, "expected_epoch": "7"},
                        {"record_id": 7, "expected_epoch": -1},
                        *({"record_id": 7, key: "private text"} for key in ("text", "url", "voice", "path", "language"))]:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                audio_response(self.store, payload)
        self.assertEqual(self.account.calls, [])

    def test_cloud_audio_requires_the_observed_epoch_and_rejects_stale_point_ids(self):
        for payload, code in [({"record_id": 7}, "connection_epoch_required"),
                              ({"record_id": 7, "expected_epoch": None}, "connection_epoch_required"),
                              ({"record_id": 7, "expected_epoch": 6}, "account_changed")]:
            with self.subTest(payload=payload), self.assertRaises(CloudAccountUnavailable) as raised:
                audio_response(self.store, payload)
            self.assertEqual(raised.exception.code, code)
        self.assertEqual(self.account.calls, [])

    def test_success_preserves_binary_mime_and_epoch_without_triggering_migration(self):
        class ForbiddenMigration:
            def ensure(self, *args, **kwargs):
                raise AssertionError("pronunciation must not import historical notes")
        routed = RoutingStore(ForbiddenLocal(), self.account, migration=ForbiddenMigration())
        for mime in ("audio/wav", "audio/mpeg"):
            self.account.result = {"status": "ok", "audio": AUDIO, "mime_type": mime}
            self.assertEqual(audio_response(routed, {"record_id": 900, "expected_epoch": 7}), (200, AUDIO, mime))
        self.assertEqual(self.account.calls, [(900, 7), (900, 7)])

    def test_audio_never_falls_back_to_sqlite_or_operating_system_speech(self):
        with patch("speech.play", side_effect=AssertionError("OS speech fallback")):
            for cloud_only in (True, False):
                local = RoutingStore(ForbiddenLocal(), AudioAccount(mode="local"), cloud_only=cloud_only)
                with self.subTest(cloud_only=cloud_only), self.assertRaises((CloudFeatureUnavailable, CloudAccountUnavailable)):
                    audio_response(local, {"record_id": 7, "expected_epoch": 7})
            self.account.state = "signed_out"
            with self.assertRaises(CloudAccountUnavailable):
                audio_response(self.store, {"record_id": 7, "expected_epoch": 7})
            self.assertEqual(self.account.calls, [])

    def test_legacy_store_without_cloud_audio_or_epoch_binding_is_unavailable(self):
        class LegacyStore:
            def audio(self, record_id):
                raise AssertionError("missing epoch binder must prevent access")
        for store in (object(), LegacyStore()):
            with self.assertRaises(CloudFeatureUnavailable) as raised:
                audio_response(store, {"record_id": 7, "expected_epoch": 7})
            self.assertEqual(raised.exception.feature, "cloud_speech")

    def test_routing_drops_audio_bytes_if_account_or_state_changes_during_request(self):
        for mode, state in [("cloud", "connected"), ("cloud", "signed_out"), ("local", "connected")]:
            self.account = AudioAccount()
            self.store = RoutingStore(ForbiddenLocal(), self.account)
            def change():
                self.account.epoch += 1
                self.account.mode, self.account.state = mode, state
            self.account.after_call = change
            with self.subTest(mode=mode, state=state), self.assertRaises(CloudAccountUnavailable):
                audio_response(self.store, {"record_id": 7, "expected_epoch": 7})
            self.assertEqual(self.account.calls, [(7, 7)])

    def test_remote_record_identifiers_are_bounded_before_network_access(self):
        with self.assertRaises(ValueError):
            audio_response(self.store, {"record_id": 9007199254740992, "expected_epoch": 7})
        self.assertEqual(self.account.calls, [])

    def test_invalid_cloud_results_cannot_be_returned_as_playable_audio(self):
        for result in [None, [], {"status": "ok", "audio": "private", "mime_type": "audio/wav"},
                       {"status": "ok", "audio": bytearray(AUDIO), "mime_type": "audio/wav"},
                       {"status": "ok", "audio": b"", "mime_type": "audio/wav"},
                       {"status": "ok", "audio": AUDIO, "mime_type": "text/html"},
                       {"status": "ok", "audio": AUDIO, "mime_type": "audio/wav; charset=utf-8"},
                       {"status": "ok", "audio": b"x" * (MAXIMUM + 1), "mime_type": "audio/mpeg"}]:
            self.account.result = result
            with self.subTest(result_type=type(result)), self.assertRaises((ValueError, CloudAccountUnavailable)):
                audio_response(self.store, {"record_id": 7, "expected_epoch": 7})

    def test_known_backend_failures_have_http_status_and_unknown_details_are_redacted(self):
        for result, expected in [
            ({"status": "not_found"}, (404, "not_found")),
            ({"status": "failed", "error": "speech_busy"}, (429, "speech_busy")),
            ({"status": "failed", "error": "speech_language_unavailable"}, (422, "speech_language_unavailable")),
            ({"status": "failed", "error": "speech_unavailable"}, (503, "speech_unavailable")),
            ({"status": "failed", "error": "secret provider credentials"}, (503, "speech_unavailable")),
        ]:
            self.account.result = result
            status, body, mime = audio_response(self.store, {"record_id": 7, "expected_epoch": 7})
            self.assertEqual((status, body, mime), (expected[0], {"error": expected[1]}, "application/json"))

    def test_app_transport_uses_base64_audio_without_download_or_export_receipt(self):
        bridge = AppTransport(self.store)
        result = bridge.request("audio", {"record_id": 7, "expected_epoch": 7})
        self.assertEqual(set(result), {"status", "audio"})
        self.assertEqual(result["status"], 200)
        self.assertEqual(set(result["audio"]), {"blob", "mime_type"})
        self.assertEqual(base64.b64decode(result["audio"]["blob"], validate=True), AUDIO)
        self.assertEqual(result["audio"]["mime_type"], "audio/wav")
        self.assertEqual(bridge.pending_exports, {})

    def test_app_transport_returns_safe_validation_auth_and_account_errors_without_bytes(self):
        bridge = AppTransport(self.store)
        for payload, expected in [({"record_id": "7"}, (400, "invalid_request")),
                                  ({"record_id": 7}, (409, "connection_epoch_required")),
                                  ({"record_id": 7, "expected_epoch": 6}, (409, "account_changed"))]:
            result = bridge.request("audio", payload)
            self.assertEqual(result, {"status": expected[0], "data": {"error": expected[1]}})
        self.account.failure = account.AccountError("cloud_unavailable")
        self.assertEqual(bridge.request("audio", {"record_id": 7, "expected_epoch": 7}),
                         {"status": 503, "data": {"error": "cloud_unavailable"}})
        self.account.failure = ValueError("private provider credentials")
        self.assertEqual(bridge.request("audio", {"record_id": 7, "expected_epoch": 7}),
                         {"status": 400, "data": {"error": "invalid_request"}})
        self.account.failure = None
        self.account.state = "signed_out"
        self.assertEqual(bridge.request("audio", {"record_id": 7, "expected_epoch": 7}),
                         {"status": 401, "data": {"error": "cloud_not_connected"}})
        self.assertEqual(bridge.pending_exports, {})

    def test_app_transport_preserves_audio_failure_status_without_base64_or_private_details(self):
        bridge = AppTransport(self.store)
        for result, status, code in [
            ({"status": "not_found"}, 404, "not_found"),
            ({"status": "failed", "error": "speech_busy"}, 429, "speech_busy"),
            ({"status": "failed", "error": "speech_language_unavailable"}, 422, "speech_language_unavailable"),
            ({"status": "failed", "error": "private upstream credentials"}, 503, "speech_unavailable"),
        ]:
            self.account.result = result
            self.assertEqual(bridge.request("audio", {"record_id": 7, "expected_epoch": 7}),
                             {"status": status, "data": {"error": code}})
        self.assertEqual(bridge.pending_exports, {})


class AudioCloud(MockCloud):
    """Reuse OAuth fixture plumbing while intercepting only the new audio route."""
    def __init__(self):
        super().__init__()
        self.audio_requests = []
        self.respond = lambda request: httpx.Response(200, content=AUDIO, headers={"Content-Type": "audio/wav"})

    async def __call__(self, request):
        if request.url.path.endswith("/audio"):
            self.audio_requests.append(request)
            return self.respond(request)
        return await super().__call__(request)


class ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks, *, entered=None, release=None):
        self.chunks, self.entered, self.release = chunks, entered, release
        self.closed = False

    async def __aiter__(self):
        if self.entered:
            self.entered.set()
            while not self.release.is_set():
                await asyncio.sleep(0.002)
        for chunk in self.chunks:
            yield chunk

    async def aclose(self):
        self.closed = True


class AccountAudioHttpTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="sayrove-audio-test-")
        self.addCleanup(temporary.cleanup)
        self.cloud = AudioCloud()
        self.manager = account.AccountManager(
            state_path=Path(temporary.name) / "account.json",
            credentials=account.KeychainCredentials(MemoryKeyring()),
            http_transport=httpx.MockTransport(self.cloud), request_timeout=3, login_timeout=3,
        )
        self.addCleanup(self.manager.close)
        with patch.object(account, "_Loopback", FakeCallback):
            self.manager.begin_login()
            self.manager._login_future.result(timeout=5)
        self.assertEqual(self.manager.status()["state"], "connected")
        self.epoch = self.manager.status()["epoch"]

    def test_http_audio_is_authenticated_record_get_with_no_client_text_or_provider_url(self):
        self.cloud.respond = lambda request: httpx.Response(200, content=AUDIO, headers={"Content-Type": "Audio/MPEG; codec=mp3"})
        self.assertEqual(self.manager.request_audio(900, expected_epoch=self.epoch),
                         {"status": "ok", "audio": AUDIO, "mime_type": "audio/mpeg"})
        self.assertEqual(len(self.cloud.audio_requests), 1)
        request = self.cloud.audio_requests[0]
        self.assertEqual(str(request.url), account.API_ORIGIN + "/v1/points/900/audio")
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.content, b"")
        self.assertEqual(request.headers["Accept"], "audio/wav, audio/mpeg")
        self.assertTrue(request.headers["Authorization"].startswith("Bearer "))
        self.assertNotIn("cookie", request.headers)
        self.assertEqual(self.cloud.unexpected_urls, [])

    def test_http_audio_rejects_invalid_record_ids_and_stale_epoch_before_request(self):
        for identifier in (True, "7", 7.0, 0, -1, 9007199254740992):
            with self.subTest(identifier=identifier), self.assertRaises(account.AccountError) as raised:
                self.manager.request_audio(identifier, expected_epoch=self.epoch)
            self.assertEqual(raised.exception.code, "unsupported_cloud_operation")
        with self.assertRaises(account.AccountError) as raised:
            self.manager.request_audio(7, expected_epoch=self.epoch - 1)
        self.assertEqual(raised.exception.code, "account_changed")
        self.assertEqual(self.cloud.audio_requests, [])

    def test_http_audio_maps_backend_failures_and_does_not_expose_private_error_bodies(self):
        for status, body, expected in [
            (404, {}, {"status": "not_found", "error": "not_found"}),
            (429, {"error": "private provider text"}, {"status": "failed", "error": "speech_busy"}),
            (422, {"error": "speech_language_unavailable"}, {"status": "failed", "error": "speech_language_unavailable"}),
            (422, {"error": "private provider text"}, {"status": "failed", "error": "speech_unavailable"}),
            (503, {"error": "private provider text"}, {"status": "failed", "error": "speech_unavailable"}),
        ]:
            self.cloud.respond = lambda request: httpx.Response(status, json=body, headers={"Location": "https://evil.example/private"})
            with self.subTest(status=status):
                self.assertEqual(self.manager.request_audio(7, expected_epoch=self.epoch), expected)
        self.assertEqual(len(self.cloud.audio_requests), 5, "errors do not retry or fall back")
        self.assertEqual(self.cloud.unexpected_urls, [])

    def test_http_audio_never_follows_a_provider_redirect_or_returns_its_private_body(self):
        self.cloud.respond = lambda request: httpx.Response(302, content=b"private provider details", headers={
            "Location": "https://evil.example/private",
        })
        result = self.manager.request_audio(7, expected_epoch=self.epoch)
        self.assertEqual(result, {"status": "failed", "error": "speech_unavailable"})
        self.assertEqual(len(self.cloud.audio_requests), 1)
        self.assertEqual(self.cloud.unexpected_urls, [])

    def test_http_audio_rejects_invalid_mime_length_empty_and_streamed_oversize(self):
        cases = [
            ({"Content-Type": "text/html"}, [b"private page"]),
            ({"Content-Type": "audio/wav", "Content-Length": "-1"}, [AUDIO]),
            ({"Content-Type": "audio/wav", "Content-Length": "not-a-number"}, [AUDIO]),
            ({"Content-Type": "audio/wav", "Content-Length": str(MAXIMUM + 1)}, [AUDIO]),
            ({"Content-Type": "audio/wav", "Content-Length": "50"}, [AUDIO]),
            ({"Content-Type": "audio/wav"}, []),
            ({"Content-Type": "audio/mpeg"}, [b"x" * MAXIMUM, b"x"]),
        ]
        for headers, chunks in cases:
            stream = ChunkStream(chunks)
            self.cloud.respond = lambda request: httpx.Response(200, headers=headers, stream=stream)
            with self.subTest(headers=headers), self.assertRaises(account.AccountError) as raised:
                self.manager.request_audio(7, expected_epoch=self.epoch)
            self.assertEqual(raised.exception.code, "invalid_cloud_response")
            self.assertTrue(stream.closed)

    def test_http_audio_discards_streamed_bytes_after_account_epoch_changes(self):
        entered, release = threading.Event(), threading.Event()
        stream = ChunkStream([AUDIO], entered=entered, release=release)
        self.cloud.respond = lambda request: httpx.Response(200, headers={"Content-Type": "audio/wav"}, stream=stream)
        with ThreadPoolExecutor(max_workers=1) as workers:
            pending = workers.submit(self.manager.request_audio, 7, expected_epoch=self.epoch)
            try:
                self.assertTrue(entered.wait(3))
                with self.manager.state.locked() as state:
                    state["epoch"] += 1
                    state["state"] = "signed_out"
            finally:
                release.set()
            with self.assertRaises(account.AccountError) as raised:
                pending.result(timeout=5)
        self.assertEqual(raised.exception.code, "account_changed")
        self.assertTrue(stream.closed)
        self.assertEqual(len(self.cloud.audio_requests), 1)

    def test_http_authentication_failure_contains_no_audio_and_requires_sign_in(self):
        self.cloud.respond = lambda request: httpx.Response(403, json={"error": "private provider details"})
        with self.assertRaises(account.AccountError) as raised:
            self.manager.request_audio(7, expected_epoch=self.epoch)
        self.assertEqual(raised.exception.code, "authentication_required")
        self.assertEqual(self.manager.status()["state"], "signed_out")
        self.assertEqual(len(self.cloud.audio_requests), 1)


class DashboardAudioTests(unittest.TestCase):
    def setUp(self):
        self.account = AudioAccount()
        self.dashboard = Dashboard(RoutingStore(ForbiddenLocal(), self.account))
        self.addCleanup(self.dashboard.close)
        self.url = self.dashboard.start()
        parsed = urlsplit(self.url)
        self.origin = parsed.scheme + "://" + parsed.netloc

    def post(self, *, url=None, payload=None, headers=None):
        return urlopen(Request(url or self.url + "audio", data=json.dumps(payload or {
            "record_id": 7, "expected_epoch": 7,
        }).encode(), headers=headers if headers is not None else {
            "Content-Type": "application/json", "X-Language-Memory": "1", "Origin": self.origin,
        }), timeout=3)

    def test_protected_audio_route_delivers_bytes_with_audio_csp_and_no_download_receipt(self):
        with self.post() as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), AUDIO)
            self.assertEqual(response.headers["Content-Type"], "audio/wav")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertIn("media-src 'self' blob:", response.headers["Content-Security-Policy"])
            self.assertIsNone(response.headers.get("Content-Disposition"))
            self.assertIsNone(response.headers.get("X-Export-Receipt"))
        self.assertEqual(self.account.calls, [(7, 7)])

    def test_invalid_route_token_origin_and_request_guards_never_reach_provider(self):
        for url, headers, status in [
            (self.origin + "/wrong-token/audio", None, 404),
            (self.origin + "/audio", None, 404),
            (None, {"Content-Type": "application/json", "Origin": self.origin}, 403),
            (None, {"Content-Type": "application/json", "X-Language-Memory": "wrong", "Origin": self.origin}, 403),
            (None, {"Content-Type": "application/json", "X-Language-Memory": "1", "Origin": "https://unrelated.example"}, 403),
            (None, {"Content-Type": "text/plain", "X-Language-Memory": "1", "Origin": self.origin}, 403),
        ]:
            with self.subTest(url=url, headers=headers), self.assertRaises(HTTPError) as raised:
                self.post(url=url, headers=headers)
            self.assertEqual(raised.exception.code, status)
            raised.exception.close()
        self.assertEqual(self.account.calls, [])

    def test_invalid_payload_and_stale_epoch_return_safe_json_without_audio(self):
        for payload, status, code in [
            ({"record_id": 7, "expected_epoch": 6}, 409, "account_changed"),
            ({"record_id": 7}, 409, "connection_epoch_required"),
            ({"record_id": 7, "expected_epoch": 7, "text": "private"}, 400, "invalid_request"),
        ]:
            with self.subTest(payload=payload), self.assertRaises(HTTPError) as raised:
                self.post(payload=payload)
            self.assertEqual(raised.exception.code, status)
            self.assertEqual(json.load(raised.exception), {"error": code})
            raised.exception.close()
        self.assertEqual(self.account.calls, [])


if __name__ == "__main__":
    unittest.main()
