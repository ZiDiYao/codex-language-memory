"""Isolated OAuth/Keychain tests: no Auth0, real listener, user files or Keychain."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import timedelta
import json
import logging
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
from mcp.shared.auth import OAuthToken

import desktop_account as account


class MemoryKeyring:
    def __init__(self):
        self.items = {}

    def get_password(self, service, username):
        return self.items.get((service, username))

    def set_password(self, service, username, password):
        self.items[service, username] = password

    def delete_password(self, service, username):
        self.items.pop((service, username), None)


def access_token(subject="learner", expiry=None):
    payload = {"iss": account.ISSUER, "sub": subject, "aud": account.RESOURCE,
               "exp": time.time() + 3600 if expiry is None else expiry,
               "scope": account.SCOPES}
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return encode({"alg": "RS256", "kid": "test"}) + "." + encode(payload) + ".mock-signature"


class FakeCallback:
    def __init__(self, timeout):
        self.expected_state = None
        self.issuer_required = True
        self.closed = False

    async def start(self):
        return "http://127.0.0.1:49123/oauth/callback"

    async def wait(self):
        return "mock-code", self.expected_state

    async def close(self):
        self.closed = True


class MockCloud:
    def __init__(self):
        self.registrations = []
        self.exchanges = []
        self.calls = []
        self.refresh_failure = False
        self.tool_error = False
        self.metadata_override = {}
        self.tool_entered = None
        self.tool_release = None
        self.subject = "learner"
        self.subjects = []
        self.revocations = []
        self.revoke_failure = False
        self.revoke_redirect = False
        self.unexpected_urls = []
        self.imports = []
        self.import_status = 200

    async def __call__(self, request):
        url = str(request.url)
        if url == account.PRM:
            return httpx.Response(200, json={"resource": account.RESOURCE, "authorization_servers": [account.ISSUER],
                                              "scopes_supported": ["memory:read", "memory:write"]})
        if url in (account.DISCOVERY, account.ISSUER + ".well-known/oauth-authorization-server"):
            return httpx.Response(200, json={"issuer": account.ISSUER, "authorization_endpoint": account.AUTHORIZE,
                "token_endpoint": account.TOKEN, "registration_endpoint": account.REGISTER,
                "revocation_endpoint": account.REVOKE,
                "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"],
                "authorization_response_iss_parameter_supported": True, **self.metadata_override})
        if url == account.REGISTER:
            metadata = json.loads(request.content)
            self.registrations.append(metadata)
            return httpx.Response(201, json={**metadata, "client_id": f"mock-public-client-{len(self.registrations)}"})
        if url == account.TOKEN:
            form = parse_qs(request.content.decode())
            self.exchanges.append(form)
            if self.refresh_failure:
                return httpx.Response(400, json={"error": "invalid_grant", "private": "never-log-this-token-body"})
            return httpx.Response(200, json={"access_token": access_token(self.subject), "expires_in": 3600,
                "refresh_token": "mock-refresh-secret-" + self.subject, "token_type": "Bearer", "scope": account.SCOPES})
        if url == account.REVOKE:
            self.revocations.append({"url": url, "body": parse_qs(request.content.decode()),
                                     "authorization": request.headers.get("authorization")})
            if self.revoke_failure:
                raise httpx.ConnectError("mock offline", request=request)
            if self.revoke_redirect:
                return httpx.Response(307, headers={"Location": "https://evil.example/revoke"})
            return httpx.Response(200)
        if request.url.host == urlsplit(account.API_ORIGIN).hostname:
            if not request.headers.get("authorization"):
                return httpx.Response(401, headers={"WWW-Authenticate": 'Bearer resource_metadata="' + account.PRM + '"'})
            if request.url.path.startswith("/v1/"):
                if request.url.path == "/v1/desktop-imports":
                    self.imports.append({"method": request.method, "body": json.loads(request.content)})
                    return httpx.Response(self.import_status, json={"status": "imported" if self.import_status == 200 else "failed",
                        "error": None if self.import_status == 200 else "import_source_conflict"})
                if request.url.path == "/v1/points/999":
                    return httpx.Response(404, json={"status": "not_found"})
                return httpx.Response(200, json={"content": 3, "preferences": 2})
            message = json.loads(request.content)
            if "id" not in message:
                return httpx.Response(202)
            method = message["method"]
            if method == "initialize":
                result = {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}},
                          "serverInfo": {"name": "Sayrove Test", "version": "1"}}
            elif method == "tools/call":
                self.calls.append(message["params"])
                payload = request.headers["authorization"].split(".")[1]
                self.subjects.append(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])
                if self.tool_entered:
                    self.tool_entered.set()
                    while not self.tool_release.is_set():
                        await asyncio.sleep(0.01)
                result = {"content": [], "structuredContent": {"enabled": True}, "isError": self.tool_error}
            elif method == "tools/list":
                result = {"tools": [{"name": "get_settings", "inputSchema": {"type": "object"}}]}
            else:
                raise AssertionError("unexpected MCP method")
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": message["id"], "result": result},
                                  headers={"Content-Type": "application/json"})
        self.unexpected_urls.append(url)
        raise AssertionError("network destination outside fixture")


class DesktopAccountTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sayrove-account-test-")
        self.addCleanup(self.temporary.cleanup)
        self.state_path = Path(self.temporary.name) / "account.json"
        self.keyring = MemoryKeyring()
        self.credentials = account.KeychainCredentials(self.keyring)
        self.cloud = MockCloud()
        self.transport = httpx.MockTransport(self.cloud)
        self.manager = self.new_manager()

    def new_manager(self):
        manager = account.AccountManager(state_path=self.state_path, credentials=self.credentials,
                                         http_transport=self.transport, request_timeout=3, login_timeout=3,
                                         cloud_only=False)
        self.addCleanup(manager.close)
        return manager

    def wait_revocations(self, manager=None):
        manager = manager or self.manager
        for future in list(manager._revocations):
            future.result(timeout=6)

    def login(self):
        with patch.object(account, "_Loopback", FakeCallback):
            self.manager.begin_login()
            self.manager._login_future.result(timeout=5)
        self.assertEqual(self.manager.status()["state"], "connected", self.manager.status())

    def expire(self):
        value = self.credentials.read()
        value["expires_at"] = time.time() - 20
        self.credentials.write(value)

    def test_interactive_mcp_session_uses_login_deadline_and_rpc_uses_request_deadline(self):
        self.manager.login_timeout, self.manager.request_timeout = 300, 30
        deadlines, calls = [], []
        client, read, write = object(), object(), object()

        @asynccontextmanager
        async def fake_client(provider):
            yield client

        @asynccontextmanager
        async def fake_transport(url, *, http_client):
            self.assertEqual(url, account.RESOURCE)
            self.assertIs(http_client, client)
            yield read, write, lambda: None

        class Session:
            def __init__(self, receive, send, *, read_timeout_seconds):
                if receive is not read or send is not write:
                    raise AssertionError("incorrect transport streams")
                deadlines.append(read_timeout_seconds)
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def initialize(self): calls.append("initialize")
            async def call_tool(self, name, arguments):
                calls.append((name, arguments))
                return SimpleNamespace(isError=False, structuredContent={"enabled": True})

        async def check():
            self.assertEqual(await self.manager._mcp(SimpleNamespace(interactive=True)), {})
            self.assertEqual(await self.manager._mcp(SimpleNamespace(interactive=False), "get_settings", {}),
                             {"enabled": True})

        with patch.object(self.manager, "_client", fake_client), \
             patch.object(account, "streamable_http_client", fake_transport), \
             patch.object(account, "ClientSession", Session):
            asyncio.run(check())
        self.assertEqual(deadlines, [timedelta(seconds=300), timedelta(seconds=30)])
        self.assertEqual(calls, ["initialize", "initialize", ("get_settings", {})])

    def test_default_local_login_exact_resource_dcr_scopes_and_no_secret_file(self):
        self.assertEqual(self.manager.status()["mode"], "local")
        self.assertEqual(self.keyring.items, {})
        self.login()
        self.assertEqual(len(self.cloud.registrations), 1)
        registration = self.cloud.registrations[0]
        self.assertEqual(registration["redirect_uris"], ["http://127.0.0.1:49123/oauth/callback"])
        self.assertEqual(registration["token_endpoint_auth_method"], "none")
        self.assertEqual(registration["application_type"], "native")
        self.assertEqual(registration["scope"], account.SCOPES)
        self.assertNotIn("openid", registration["scope"])
        exchange = self.cloud.exchanges[0]
        self.assertEqual(exchange["resource"], [account.RESOURCE])
        self.assertIn("code_verifier", exchange)
        self.assertNotIn("client_secret", exchange)
        self.assertEqual(self.manager.call_tool("get_settings", {}), {"enabled": True})
        public = self.manager.status()
        self.assertNotIn("authorization_url", public)
        for file in Path(self.temporary.name).iterdir():
            text = file.read_text()
            self.assertNotIn("mock-refresh-secret", text)
            self.assertNotIn("mock-public-client", text)
            self.assertNotIn("access_token", text)
            self.assertEqual(file.stat().st_mode & 0o077, 0)

    def test_production_defaults_to_cloud_signed_out_and_migrates_legacy_local_once(self):
        fresh = account.AccountManager(state_path=Path(self.temporary.name) / "fresh.json", credentials=self.credentials)
        self.addCleanup(fresh.close)
        self.assertEqual((fresh.status()["mode"], fresh.status()["state"], fresh.status()["epoch"]),
                         ("cloud", "signed_out", 0))
        legacy_epoch = self.manager.status()["epoch"]
        upgraded = account.AccountManager(state_path=self.state_path, credentials=self.credentials)
        self.addCleanup(upgraded.close)
        self.assertEqual((upgraded.status()["mode"], upgraded.status()["state"], upgraded.status()["epoch"]),
                         ("cloud", "signed_out", legacy_epoch + 1))
        with self.assertRaises(account.AccountError) as raised:
            upgraded.use_local()
        self.assertEqual(raised.exception.code, "unsupported_cloud_operation")
        self.assertEqual(upgraded.status()["epoch"], legacy_epoch + 1)
        again = account.AccountManager(state_path=self.state_path, credentials=self.credentials)
        self.addCleanup(again.close)
        self.assertEqual(again.status()["epoch"], legacy_epoch + 1)
        self.assertFalse(again.status()["capabilities"]["export"])
        self.assertEqual(self.keyring.items, {}, "mode conversion must not access or create credentials")

    def test_account_fingerprint_is_internal_stable_and_bound_to_expected_epoch(self):
        self.login()
        epoch = self.manager.status()["epoch"]
        fingerprint = self.manager.account_fingerprint(expected_epoch=epoch)
        self.assertRegex(fingerprint, r"^[0-9a-f]{64}$")
        self.assertNotIn(fingerprint, json.dumps(self.manager.status()))
        upgraded = account.AccountManager(state_path=self.state_path, credentials=self.credentials,
                                         http_transport=self.transport, request_timeout=3)
        self.addCleanup(upgraded.close)
        self.assertEqual(upgraded.status()["state"], "connected", "existing cloud login must survive upgrade")
        self.assertEqual(upgraded.account_fingerprint(expected_epoch=epoch), fingerprint)
        self.expire()
        self.manager.call_tool("get_settings")
        self.assertEqual(self.manager.account_fingerprint(expected_epoch=epoch), fingerprint)
        self.manager.disconnect()
        with self.assertRaises(account.AccountError) as raised:
            self.manager.account_fingerprint(expected_epoch=epoch)
        self.assertEqual(raised.exception.code, "account_changed")
        self.cloud.subject = "second-account"
        self.login()
        self.assertNotEqual(self.manager.account_fingerprint(), fingerprint)

    def test_desktop_import_is_authenticated_exact_post_and_conflicts_remain_business_results(self):
        payload = {"schema_version": 1, "source_id": "c60abe6f-7dd4-4b39-9ebf-08262dd0a2a5", "tables": {
            name: [] for name in ("knowledge", "settings", "capture_preferences", "encounters", "review_events",
                                  "memory_states", "learner_preferences", "export_receipts", "study_sessions",
                                  "study_items", "study_answers")}}
        with self.assertRaises(account.AccountError):
            self.manager.request_api("POST", "/v1/desktop-imports", json=payload)
        self.login()
        epoch = self.manager.status()["epoch"]
        result = self.manager.request_api("POST", "/v1/desktop-imports", json=payload, expected_epoch=epoch)
        self.assertEqual(result["status"], "imported")
        self.assertEqual(self.cloud.imports, [{"method": "POST", "body": payload}])
        self.cloud.import_status = 409
        self.assertEqual(self.manager.request_api("POST", "/v1/desktop-imports", json=payload)["error"], "import_source_conflict")
        for method, path, body in [("GET", "/v1/desktop-imports", None), ("POST", "/v1/settings", payload),
                                   ("POST", "/v1/desktop-imports?user_id=x", payload),
                                   ("POST", "/v1/desktop-imports", {**payload, "user_id": "x"}),
                                   ("POST", "/v1/desktop-imports", {**payload, "source_id": "not-a-uuid"})]:
            with self.assertRaises(account.AccountError):
                self.manager.request_api(method, path, json=body)
        self.manager.disconnect()
        with self.assertRaises(account.AccountError) as raised:
            self.manager.request_api("POST", "/v1/desktop-imports", json=payload, expected_epoch=epoch)
        self.assertEqual(raised.exception.code, "account_changed")
        self.assertEqual(len(self.cloud.imports), 2)

    def test_refresh_after_process_restart_uses_absolute_expiry_and_existing_dcr_client(self):
        self.login()
        self.expire()
        other = self.new_manager()
        self.assertEqual(other.call_tool("get_settings"), {"enabled": True})
        self.assertEqual(len(self.cloud.registrations), 1)
        self.assertEqual(self.cloud.exchanges[-1]["grant_type"], ["refresh_token"])
        self.assertEqual(self.cloud.exchanges[-1]["resource"], [account.RESOURCE])

    def test_invalid_refresh_requires_explicit_reconnect_and_never_local_fallback(self):
        self.login()
        self.expire()
        self.cloud.refresh_failure = True
        with self.assertRaises(account.AccountError) as raised:
            self.manager.call_tool("get_settings")
        self.assertEqual(raised.exception.code, "authentication_required")
        state = self.manager.status()
        self.assertEqual((state["mode"], state["state"]), ("cloud", "signed_out"))
        self.assertNotIn("authorization_url", state)
        self.assertEqual(self.credentials.read(), {})
        self.assertEqual(len(self.cloud.registrations), 1)

    def test_disconnect_and_use_local_invalidate_other_process_and_old_storage(self):
        self.login()
        other = self.new_manager()
        epoch = other.status()["epoch"]
        storage = account.KeychainTokenStorage(self.credentials, self.manager.state, epoch)
        self.manager.disconnect()
        self.assertEqual(other.status()["mode"], "cloud")
        with self.assertRaises(account.AccountError):
            other.call_tool("get_settings", expected_epoch=epoch)
        with self.assertRaises(account.AccountError):
            asyncio.run(storage.set_tokens(OAuthToken(access_token=access_token(), expires_in=300)))
        self.assertEqual(self.credentials.read(), {})
        self.manager.use_local()
        self.assertEqual(other.status()["mode"], "local")
        self.assertGreater(other.status()["epoch"], epoch)

    def test_stale_inflight_response_is_discarded_after_mode_change(self):
        self.login()
        self.cloud.tool_entered, self.cloud.tool_release = threading.Event(), threading.Event()
        with ThreadPoolExecutor() as workers:
            pending = workers.submit(self.manager.call_tool, "get_settings")
            self.assertTrue(self.cloud.tool_entered.wait(3))
            self.new_manager().use_local()
            self.cloud.tool_release.set()
            with self.assertRaises(account.AccountError) as raised:
                pending.result(timeout=5)
        self.assertEqual(raised.exception.code, "account_changed")

    def test_rest_boundary_404_and_expected_epoch_reject_before_any_write(self):
        self.login()
        self.assertEqual(self.manager.request_api("GET", "/v1/changes"), {"content": 3, "preferences": 2})
        self.assertEqual(self.manager.request_api("GET", "/v1/points/999"), {"status": "not_found"})
        for method, path in [("POST", "/v1/changes"), ("GET", "https://evil.example/v1/changes"),
                             ("GET", "/v1/points/0"), ("GET", "/v1/points/9007199254740992"),
                             ("GET", "/v1/points/1?user_id=x"), ("GET", "/mcp")]:
            with self.assertRaises(account.AccountError):
                self.manager.request_api(method, path)
        old = self.manager.status()["epoch"]
        self.manager.disconnect()
        with self.assertRaises(account.AccountError) as raised:
            self.manager.call_tool("save_points", {"items": []}, expected_epoch=old)
        self.assertEqual(raised.exception.code, "account_changed")
        self.assertEqual(self.cloud.calls, [])

    def test_untrusted_discovery_endpoint_cannot_receive_registration_or_tokens(self):
        self.cloud.metadata_override["token_endpoint"] = "https://evil.example/token"
        with patch.object(account, "_Loopback", FakeCallback):
            self.manager.begin_login()
            self.manager._login_future.result(timeout=5)
        self.assertEqual(self.manager.status()["state"], "error")
        self.assertEqual(self.cloud.registrations, [])
        self.assertEqual(self.cloud.exchanges, [])

    def test_tool_error_is_explicit_and_contains_no_cloud_private_text(self):
        self.login()
        self.cloud.tool_error = True
        with self.assertRaises(account.AccountError) as raised:
            self.manager.call_tool("unsupported")
        self.assertEqual(str(raised.exception), "cloud_tool_failed")
        self.assertEqual(self.manager.status()["mode"], "cloud")
        self.assertEqual(self.manager.status()["state"], "connected")
        self.cloud.tool_error = False
        self.assertEqual(self.manager.call_tool("get_settings"), {"enabled": True})
        self.assertNotIn("error", self.manager.status())

    def test_login_timeout_clears_callback_url_and_is_explicitly_retryable(self):
        class NeverCallback(FakeCallback):
            async def wait(self):
                await asyncio.sleep(10)
        self.manager.login_timeout = 0.05
        with patch.object(account, "_Loopback", NeverCallback):
            self.manager.begin_login()
            self.manager._login_future.result(timeout=3)
        self.assertEqual(self.manager.status()["state"], "error")
        self.assertEqual(self.manager.status()["error"], "login_timeout")
        self.assertNotIn("authorization_url", self.manager.status())
        self.manager.login_timeout = 3
        self.login()
        self.assertEqual(len(self.cloud.registrations), 2, "a new login must register its own loopback redirect")

    def test_refresh_rotation_is_serialized_across_process_managers(self):
        self.login()
        self.expire()
        other = self.new_manager()
        with ThreadPoolExecutor() as workers:
            pending = [workers.submit(manager.call_tool, "get_settings") for manager in (self.manager, other)]
            self.assertEqual([future.result(timeout=5) for future in pending], [{"enabled": True}, {"enabled": True}])
        self.assertEqual(sum(form["grant_type"] == ["refresh_token"] for form in self.cloud.exchanges), 1)

    def test_refresh_cannot_switch_account_identity(self):
        self.login()
        value = self.credentials.read()
        storage = account.KeychainTokenStorage(self.credentials, self.manager.state, self.manager.status()["epoch"])
        with self.assertRaises(account.AccountError) as raised:
            asyncio.run(storage.set_tokens(OAuthToken(access_token=access_token("another-account"), expires_in=300)))
        self.assertEqual(raised.exception.code, "account_changed")
        self.assertEqual(self.credentials.read(), value)

    def test_keychain_failure_does_not_select_local_or_write_credentials_to_state(self):
        class Unavailable:
            def get_password(self, *args): raise RuntimeError("private operating system error")
        manager = account.AccountManager(state_path=Path(self.temporary.name) / "unavailable.json",
                                        credentials=account.KeychainCredentials(Unavailable()), http_transport=self.transport)
        self.addCleanup(manager.close)
        with patch.object(account, "_Loopback", FakeCallback):
            manager.begin_login()
            manager._login_future.result(timeout=3)
        self.assertEqual(manager.status()["mode"], "cloud")
        self.assertEqual(manager.status()["error"], "credential_store_unavailable")
        self.assertNotIn("private operating", json.dumps(manager.status()))

    def test_initial_token_error_body_never_reaches_sdk_or_transport_logs(self):
        messages = []
        class Capture(logging.Handler):
            def emit(self, record):
                messages.append(self.format(record))
        handler = Capture()
        root_logger = logging.getLogger()
        root_logger.addHandler(handler)
        self.addCleanup(lambda: root_logger.removeHandler(handler))
        self.cloud.refresh_failure = True
        with patch.object(account, "_Loopback", FakeCallback):
            self.manager.begin_login()
            self.manager._login_future.result(timeout=5)
        self.assertEqual(self.manager.status()["state"], "error")
        self.assertNotIn("never-log-this-token-body", "\n".join(messages))
        self.assertNotIn("mock-code", "\n".join(messages))
        self.assertNotIn("mock-refresh-secret", "\n".join(messages))
        # The filter is scoped to account tasks, not unrelated local SDK use.
        logging.getLogger("mcp.client.streamable_http").warning("unrelated-local-diagnostic")
        self.assertIn("unrelated-local-diagnostic", "\n".join(messages))

    def test_different_profiles_with_equal_epochs_never_share_or_delete_keychain_items(self):
        with patch.object(account.KeychainCredentials, "_keyring", return_value=self.keyring):
            def manager(path):
                result = account.AccountManager(state_path=path, http_transport=self.transport, request_timeout=3)
                self.addCleanup(result.close)
                return result
            first = manager(Path(self.temporary.name) / "first" / "account.json")
            second = manager(Path(self.temporary.name) / "second" / "account.json")
            def login(target):
                with patch.object(account, "_Loopback", FakeCallback):
                    target.begin_login()
                    target._login_future.result(timeout=5)
                self.assertEqual(target.status()["state"], "connected")
            self.cloud.subject = "first-account"
            login(first)
            self.cloud.subject = "second-account"
            login(second)
            self.assertEqual(first.status()["epoch"], second.status()["epoch"])
            self.assertNotEqual(first.credentials.account, second.credentials.account)
            self.assertEqual(len(self.keyring.items), 2)
            first.call_tool("get_settings")
            self.assertEqual(self.cloud.subjects[-1], "first-account")
            second.disconnect()
            self.wait_revocations(second)
            self.assertEqual(len(self.keyring.items), 1)
            self.assertEqual(self.cloud.revocations[-1]["body"]["client_id"], ["mock-public-client-2"])
            self.assertNotEqual(self.cloud.revocations[-1]["body"]["client_id"], ["mock-public-client-1"])
            first.call_tool("get_settings")
            self.assertEqual(self.cloud.subjects[-1], "first-account")
            self.assertEqual(first.status()["state"], "connected")

    def test_disconnect_revokes_only_old_client_after_local_invalidation_even_if_offline(self):
        self.login()
        old = self.credentials.read()
        self.cloud.revoke_failure = True
        result = self.manager.disconnect()
        self.assertEqual((result["mode"], result["state"]), ("cloud", "signed_out"))
        self.assertEqual(self.credentials.read(), {})
        self.wait_revocations()
        self.assertEqual(self.manager.status()["state"], "signed_out")
        request = self.cloud.revocations[-1]
        self.assertEqual(request["url"], account.REVOKE)
        self.assertIsNone(request["authorization"])
        self.assertEqual(request["body"], {"token": [old["tokens"]["refresh_token"]],
            "client_id": [old["client"]["client_id"]], "token_type_hint": ["refresh_token"]})

    def test_revocation_rejects_unverified_metadata(self):
        self.login()
        self.cloud.metadata_override["revocation_endpoint"] = "https://evil.example/revoke"
        self.manager.disconnect()
        self.wait_revocations()
        self.assertEqual(self.cloud.revocations, [])
        self.assertEqual(self.manager.status()["state"], "signed_out")

    def test_revocation_never_follows_a_token_bearing_307_redirect(self):
        self.login()
        self.cloud.revoke_redirect = True
        self.manager.disconnect()
        self.wait_revocations()
        self.assertEqual(len(self.cloud.revocations), 1)
        self.assertEqual(self.cloud.unexpected_urls, [])
        self.assertEqual(self.manager.status()["state"], "signed_out")


class LoopbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_callback_rejects_wrong_host_state_issuer_duplicates_and_accepts_once(self):
        callback = account._Loopback(1)
        callback.port = 49123
        callback.expected_state = "random-state"
        callback.future = asyncio.get_running_loop().create_future()

        class Writer:
            def __init__(self): self.data = b""
            def write(self, value): self.data += value
            async def drain(self): pass
            def close(self): pass
            async def wait_closed(self): pass

        async def send(query, host="127.0.0.1:49123", path="/oauth/callback"):
            reader, writer = asyncio.StreamReader(), Writer()
            reader.feed_data(f"GET {path}?{query} HTTP/1.1\r\nHost: {host}\r\n\r\n".encode())
            reader.feed_eof()
            await callback._handle(reader, writer)
            return writer.data

        valid = "code=private-code&state=random-state&iss=https%3A%2F%2Flanguage-memory.ca.auth0.com%2F"
        for query, host, path in [(valid, "evil.example", "/oauth/callback"),
                                 (valid.replace("random-state", "wrong"), "127.0.0.1:49123", "/oauth/callback"),
                                 (valid.replace("language-memory.ca.auth0.com", "evil.example"), "127.0.0.1:49123", "/oauth/callback"),
                                 (valid + "&state=random-state", "127.0.0.1:49123", "/oauth/callback"),
                                 (valid, "127.0.0.1:49123", "/other")]:
            self.assertIn(b"400 Bad Request", await send(query, host, path))
            self.assertFalse(callback.future.done())
        response = await send(valid)
        self.assertIn(b"200 OK", response)
        self.assertNotIn(b"private-code", response)
        self.assertEqual(await callback.wait(), ("private-code", "random-state"))
        self.assertIn(b"400 Bad Request", await send(valid))


if __name__ == "__main__":
    unittest.main()
