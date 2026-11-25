"""Desktop routing integration without real OAuth, Keychain, sockets, or user files."""

import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from mcp.server.fastmcp.exceptions import ToolError

from dashboard import DashboardHandler
from dashboard_actions import dispatch
from desktop_actions import account_action
from desktop_store import RoutingStore
from mcp_app import AppTransport
from server import create_desktop_server, create_server
from store import Store


POINT = {
    "kind": "word", "language": "en", "title": "rinse", "sense_key": "wash with water",
    "meaning": "Wash something with clean water.", "explanation": "Rinse removes soap or dirt with water.",
    "examples": [{"text": "Rinse the cup."}, {"text": "Rinse your hands."}], "scenes": ["Cleaning & hygiene"],
}


class NoSQLite:
    def __getattr__(self, _name):
        raise AssertionError("cloud integration accessed SQLite")


class IntegrationAccount:
    def __init__(self, mode="cloud", state="connected"):
        self.mode, self.state, self.epoch = mode, state, 7
        self.calls, self.controls = [], []
        self.settings = {"enabled": True, "ui_language": "en", "first_language": None,
                         "explanation_language": None, "enabled_types": ["word", "expression", "grammar", "correction"]}
        self.record = {**copy.deepcopy(POINT), "id": 900, "note_title": "Cloud title", "note": "Cloud note",
                       "revision": "a" * 64, "status": "new"}

    def status(self):
        return {"mode": self.mode, "state": self.state, "epoch": self.epoch,
                "capabilities": {"export": self.mode == "local", "speech": True, "study": self.mode == "local"},
                "authorization_url": "https://issuer.example/authorize?state=public-callback-state",
                "access_token": "private-access-canary", "refresh_token": "private-refresh-canary",
                "client_secret": "private-client-canary", "verifier": "private-verifier-canary"}

    def begin_login(self):
        self.controls.append("connect")
        self.mode, self.state, self.epoch = "cloud", "connecting", self.epoch + 1
        return self.status()

    def disconnect(self):
        self.controls.append("disconnect")
        self.mode, self.state, self.epoch = "cloud", "signed_out", self.epoch + 1
        return self.status()

    def use_local(self):
        self.controls.append("use-local")
        self.mode, self.state, self.epoch = "local", "connected", self.epoch + 1
        return self.status()

    def _check(self, expected_epoch):
        if expected_epoch != self.epoch:
            raise ValueError("unexpected integration binding")

    def call_tool(self, name, arguments, *, expected_epoch=None):
        self._check(expected_epoch)
        self.calls.append((name, copy.deepcopy(arguments), expected_epoch))
        if name == "update_settings":
            self.settings.update(arguments["patch"])
        elif name == "set_recording":
            self.settings["enabled"] = arguments["enabled"]
        elif name == "update_point":
            self.record.update(arguments["patch"])
            return {"status": "updated", "record": copy.deepcopy(self.record)}
        elif name == "delete_point":
            return {"status": "deleted", "id": arguments["record_id"]}
        elif name == "capture_and_context":
            return {"status": "processed", "replayed": False, "results": [{"status": "added", "id": 900,
                    "enrichment_state": "pending"}], "_context": {key: copy.deepcopy(self.settings[key]) for key in (
                    "enabled", "enabled_types", "first_language", "explanation_language")}}
        elif name in ("save_points", "capture_points"):
            return {"status": "processed", "replayed": False, "results": [{"status": "added", "id": 900}]}
        elif name == "record_review":
            return {"status": "reviewed", "scheduled": False, "replayed": False}
        elif name in ("find_points", "review_queue"):
            return {"records": [copy.deepcopy(self.record)], "has_more": False, "next_cursor": None}
        elif name == "list_scenes":
            return {"scenes": [{"name": "Cleaning & hygiene", "count": 1}], "total": 1}
        elif name == "list_languages":
            return {"languages": ["en"], "counts": {"en": 1}, "kinds": {"word": 1}, "by_language": {"en": {"word": 1}}}
        if name in ("get_recording", "set_recording"):
            return {"enabled": self.settings["enabled"]}
        if name in ("get_settings", "update_settings"):
            return copy.deepcopy(self.settings)
        raise AssertionError("unexpected remote tool")

    def request_api(self, method, path, params=None, json=None, *, expected_epoch=None):
        self._check(expected_epoch)
        self.calls.append((method, path, expected_epoch))
        if method != "GET" or params or json is not None:
            raise AssertionError("unexpected remote REST operation")
        if path == "/v1/changes":
            return {"content": 5, "preferences": 2}
        if path == "/v1/points/900":
            return {"status": "found", "record": copy.deepcopy(self.record)}
        return {"status": "not_found"}


def dashboard_post(store, payload, *, origin=None):
    """Drive the real HTTP handler with in-memory streams, without binding a port."""
    handler = DashboardHandler.__new__(DashboardHandler)
    body = json.dumps(payload).encode()
    handler.server = SimpleNamespace(store=store, prefix="/isolated-token/", server_port=49123)
    handler.path, handler.command = "/isolated-token/api", "POST"
    handler.request_version, handler.requestline = "HTTP/1.1", "POST /isolated-token/api HTTP/1.1"
    handler.headers = {"Host": "127.0.0.1:49123", "Content-Type": "application/json",
                       "Content-Length": str(len(body)), "X-Language-Memory": "1"}
    if origin is not None:
        handler.headers["Origin"] = origin
    handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
    handler.do_POST()
    headers, response = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
    return int(headers.split(b" ", 2)[1]), json.loads(response)


class DesktopProtocolIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.account = IntegrationAccount()
        self.store = RoutingStore(NoSQLite(), self.account)
        self.server = create_server(self.store)

    async def call(self, name, arguments=None):
        result = await self.server.call_tool(name, arguments or {})
        if isinstance(result, tuple):
            return result[1]
        if isinstance(result, dict):
            return result
        return json.loads(result[0].text)

    async def test_desktop_factory_wraps_store_and_keeps_existing_tool_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "memory.sqlite3"
            with patch("desktop_account.AccountManager", return_value=self.account) as factory:
                server = create_desktop_server(path)
            factory.assert_called_once_with(state_path=path.with_name("desktop-account.json"))
            self.assertFalse(path.exists(), "production cloud client must not create a local learning database")
            tools = {tool.name: tool for tool in await server.list_tools()}
            self.assertEqual(len(tools), 17)
            for name in ("save_points", "capture_points", "update_point", "delete_point", "update_settings", "set_recording", "record_review"):
                self.assertIn("expected_connection_epoch", tools[name].inputSchema["properties"])
            self.assertIn("memory_app_request", tools)
            self.assertNotIn("account_login", tools, "account controls stay in the local UI")

    async def test_all_cloud_mutations_require_current_connection_epoch(self):
        operations = {
            "save_points": {"request_id": "isolated-save", "items": [POINT]},
            "capture_points": {"request_id": "isolated-capture", "items": [{"kind": "word", "language": "en", "title": "celery"}]},
            "update_point": {"record_id": 900, "patch": {"note": "Cloud edit"}},
            "delete_point": {"record_id": 900}, "update_settings": {"patch": {"ui_language": "fr"}},
            "set_recording": {"enabled": False},
            "record_review": {"record_id": 900, "request_id": "isolated-review", "review": {"result": "skipped"}},
        }
        for name, arguments in operations.items():
            for expected, code in ((None, "connection_epoch_required"), (6, "account_changed")):
                with self.subTest(name=name, expected=expected), self.assertRaisesRegex(ToolError, code):
                    await self.call(name, {**arguments, **({} if expected is None else {"expected_connection_epoch": expected})})
            self.assertEqual(self.account.calls, [])
        for name, arguments in operations.items():
            await self.call(name, {**arguments, "expected_connection_epoch": 7})
        self.assertEqual(len(self.account.calls), 7)
        for _name, arguments, epoch in self.account.calls:
            self.assertEqual(epoch, 7)
            self.assertNotIn("expected_connection_epoch", arguments, "desktop guard is never sent as a remote MCP argument")

    async def test_lightweight_protocol_validates_minimal_observation_and_rejects_rich_fields(self):
        item = {"kind": "word", "language": "en", "title": "celery", "context": "芹菜的英文咋说"}
        result = await self.call("capture_points", {"request_id": "minimal-capture", "items": [item], "expected_connection_epoch": 7})
        self.assertEqual(result["status"], "processed")
        self.assertEqual(self.account.calls[-1], ("capture_points", {"request_id": "minimal-capture", "items": [item], "source": "automatic"}, 7))
        for invalid in ({**item, "meaning": "芹菜"}, {**item, "title": ""}, {**item, "language": "invalid language"}):
            with self.assertRaises(ToolError):
                await self.call("capture_points", {"request_id": "invalid-capture", "items": [invalid], "expected_connection_epoch": 7})
        self.assertEqual(len(self.account.calls), 1)

    async def test_single_call_capture_uses_startup_binding_without_reading_settings(self):
        self.account.settings.update(first_language="fr", explanation_language="ja")
        item = {"kind": "word", "language": "en", "title": "celery"}
        result = await self.call("capture_and_context", {"request_id": "single-call", "items": [item]})
        self.assertEqual(self.account.calls, [("capture_and_context", {
            "request_id": "single-call", "items": [item], "source": "automatic"}, 7)])
        self.assertEqual(result["_context"]["first_language"], "fr")
        self.assertEqual(result["_context"]["explanation_language"], "ja")
        self.assertEqual(result["_connection"], {"mode": "cloud", "state": "connected", "epoch": 7})
        self.assertNotIn("private-", json.dumps(result))

    async def test_single_call_capture_never_silently_rebinds_after_account_change(self):
        self.account.epoch += 1
        arguments = {"request_id": "stale-implicit", "items": [{"kind": "word", "language": "en", "title": "celery"}]}
        with self.assertRaisesRegex(ToolError, "account_changed"):
            await self.call("capture_and_context", arguments)
        self.assertEqual(self.account.calls, [])
        # Even a normal settings read for another workflow does not rebind old captures.
        await self.call("get_settings")
        with self.assertRaisesRegex(ToolError, "account_changed"):
            await self.call("capture_and_context", arguments)
        self.server = create_server(self.store)
        self.assertEqual((await self.call("capture_and_context", {**arguments, "request_id": "new-connection"}))["_connection"]["epoch"], 8)

    async def test_single_call_rejects_rich_content_and_unknown_epoch_override(self):
        item = {"kind": "word", "language": "en", "title": "celery"}
        for bad in ({**item, "meaning": "芹菜"}, {**item, "title": ""}):
            with self.assertRaises(ToolError):
                await self.call("capture_and_context", {"request_id": "invalid-single", "items": [bad]})
        tools = {tool.name: tool for tool in await self.server.list_tools()}
        self.assertNotIn("expected_connection_epoch", tools["capture_and_context"].inputSchema["properties"])
        self.assertEqual(self.account.calls, [])

    async def test_single_call_drops_reply_if_account_changes_during_remote_write(self):
        original = self.account.call_tool
        def change_account(*args, **kwargs):
            result = original(*args, **kwargs)
            self.account.epoch += 1
            return result
        with patch.object(self.account, "call_tool", side_effect=change_account), self.assertRaisesRegex(ToolError, "account_changed"):
            await self.call("capture_and_context", {"request_id": "changed-during-write", "items": [
                {"kind": "word", "language": "en", "title": "celery"}]})

    async def test_conversation_and_page_read_and_edit_the_same_cloud_record(self):
        self.assertEqual((await self.call("get_settings"))["_connection"]["epoch"], 7)
        await self.call("update_point", {"record_id": 900, "patch": {"note": "Edited in conversation"}, "expected_connection_epoch": 7})
        result = AppTransport(self.store).request("api", {"action": "points/read", "arguments": {"record_id": 900}, "expected_epoch": 7})
        self.assertEqual(result["data"]["record"]["note"], "Edited in conversation")
        result = AppTransport(self.store).request("api", {"action": "points/update", "arguments": {"record_id": 900,
            "patch": {"note": "Edited in page"}, "expected_revision": "a" * 64}, "expected_epoch": 7})
        self.assertEqual(result["status"], 200)
        self.assertEqual((await self.call("find_points"))["records"][0]["note"], "Edited in page")
        self.assertEqual(dispatch(self.store, {"action": "changes/read", "arguments": {}, "expected_epoch": 7}), {"content": 5, "preferences": 2})

    async def test_signed_out_cloud_read_and_write_never_touch_sqlite(self):
        self.account.state = "signed_out"
        for name in ("get_settings", "find_points", "list_scenes", "list_languages", "review_queue"):
            with self.subTest(name=name), self.assertRaisesRegex(ToolError, "cloud_not_connected"):
                await self.call(name)
        with self.assertRaisesRegex(ToolError, "cloud_not_connected"):
            await self.call("delete_point", {"record_id": 900, "expected_connection_epoch": 7})
        for action, arguments in (("points/query", {}), ("points/update", {"record_id": 900, "patch": {"note": "No local write"}})):
            result = AppTransport(self.store).request("api", {"action": action, "arguments": arguments, "expected_epoch": 7})
            self.assertEqual(result, {"status": 401, "data": {"error": "cloud_not_connected"}})
        self.assertEqual(self.account.calls, [])

    async def test_unsupported_conversational_features_stay_hidden_and_page_exports_require_an_epoch(self):
        tools = {tool.name for tool in await self.server.list_tools()}
        for name, arguments in (("get_study", {}), ("get_learning_profile", {}), ("get_point_history", {"record_id": 900}),
            ("update_learning_preferences", {"patch": {"learning_goal": "Everyday conversation"}}),
            ("export_points", {"request": {"format": "json"}})):
            self.assertNotIn(name, tools)
            with self.subTest(name=name), self.assertRaisesRegex(ToolError, "Unknown tool"):
                await self.call(name, arguments)
        bridge = AppTransport(self.store)
        self.assertEqual(bridge.request("export", {"format": "json"}), {"status": 409, "data": {"error": "connection_epoch_required"}})
        for action in ("exports/preview", "exports/history"):
            self.assertEqual(bridge.request("api", {"action": action, "arguments": {}}),
                             {"status": 409, "data": {"error": "connection_epoch_required"}})
        self.assertEqual(self.account.calls, [])

    async def test_local_legacy_mcp_writes_still_work_without_cloud_epoch(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Store(Path(directory) / "memory.sqlite3")
            self.server = create_server(RoutingStore(local, IntegrationAccount("local", "connected"), cloud_only=False))
            saved = await self.call("save_points", {"request_id": "legacy-local-save", "items": [POINT]})
            self.assertEqual(saved["results"][0]["status"], "added")
            await self.call("set_recording", {"enabled": False})
            self.assertFalse(local.recording()["enabled"])


class DesktopActionIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.account = IntegrationAccount()
        self.store = RoutingStore(NoSQLite(), self.account)

    def test_account_actions_are_ui_only_strict_and_strip_secret_fields(self):
        for action in ("account/status", "account/connect", "account/disconnect"):
            result = dispatch(self.store, {"action": action, "arguments": {}})
            self.assertTrue(result["can_connect"])
            rendered = json.dumps(result)
            self.assertNotIn("private-", rendered)
            self.assertTrue(set(result).issubset({"mode", "state", "epoch", "capabilities", "authorization_url", "can_connect", "error"}))
            for invalid in (None, [], {"url": "https://untrusted.example"}, {"token": "not-accepted"}):
                with self.assertRaises(ValueError):
                    account_action(self.store, action, invalid)
        self.assertEqual(self.account.controls, ["connect", "disconnect"])
        with self.assertRaises(ValueError):
            dispatch(self.store, {"action": "account/use-local", "arguments": {}})

    def test_plain_store_account_status_has_no_login_or_keychain_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Store(Path(directory) / "memory.sqlite3")
            result = dispatch(local, {"action": "account/status", "arguments": {}})
            self.assertEqual((result["mode"], result["can_connect"]), ("local", False))
            for action in ("account/connect", "account/disconnect", "account/use-local"):
                with self.assertRaises(ValueError):
                    dispatch(local, {"action": action, "arguments": {}})

    def test_stale_ui_envelope_rejected_by_dispatch_app_and_http_handler(self):
        payload = {"action": "points/update", "arguments": {"record_id": 900, "patch": {"note": "Stale card"}}, "expected_epoch": 6}
        with self.assertRaisesRegex(ValueError, "account_changed"):
            dispatch(self.store, payload)
        self.assertEqual(AppTransport(self.store).request("api", payload), {"status": 409, "data": {"error": "account_changed"}})
        self.assertEqual(dashboard_post(self.store, payload), (409, {"error": "account_changed"}))
        self.account.state = "signed_out"
        self.assertEqual(dashboard_post(self.store, {"action": "points/query", "arguments": {}, "expected_epoch": 7}),
                         (401, {"error": "cloud_not_connected"}))
        self.assertEqual(self.account.calls, [])

    def test_ui_cloud_mutations_without_epoch_are_rejected_before_any_remote_call(self):
        for action, arguments in (
            ("points/update", {"record_id": 900, "patch": {"note": "Unbound old request"}}),
            ("points/delete", {"record_id": 900}), ("settings/update", {"ui_language": "zh"}),
        ):
            payload = {"action": action, "arguments": arguments}
            with self.subTest(action=action):
                self.assertEqual(AppTransport(self.store).request("api", payload),
                                 {"status": 400, "data": {"error": "invalid_request"}} if action == "points/delete"
                                 else {"status": 409, "data": {"error": "connection_epoch_required"}})
                self.assertEqual(dashboard_post(self.store, payload), (409, {"error": "connection_epoch_required"}))
        self.assertEqual(self.account.calls, [])

    def test_local_speech_reads_current_cloud_point_without_running_real_speech(self):
        process = Mock()
        process.poll.return_value = None
        with (patch("speech.Path.is_file", return_value=True), patch("speech.subprocess.Popen", return_value=process) as spawn,
              patch("speech._process", None), patch("speech._record_id", None)):
            result = dispatch(self.store, {"action": "speech/play", "arguments": {"record_id": 900}, "expected_epoch": 7})
            self.assertEqual(result, {"playing": True, "record_id": 900})
            self.assertEqual(spawn.call_args.args[0], ["/usr/bin/say", "-v", "Samantha", "-r", "165"])
            process.stdin.write.assert_called_once_with(b"Cloud title")
        self.assertEqual(self.account.calls, [("GET", "/v1/points/900", 7)])


if __name__ == "__main__":
    unittest.main()
