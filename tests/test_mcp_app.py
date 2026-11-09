import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from exports import ExportSelection, export_history
from mcp_app import APP_FILE, APP_URI, AppTransport
from store import Store
from test_memory import APPROACH, APP


class AppTransportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "app.sqlite3")
        point = dict(APPROACH, examples=[{"text": "Try a different approach."},
                                         {"text": "This approach saves time."}])
        self.record_id = self.store.save("sidebar-fixture", [point])["results"][0]["id"]
        self.bridge = AppTransport(self.store)

    def call(self, action, arguments=None):
        result = self.bridge.request("api", {"action": action, "arguments": arguments or {}})
        self.assertEqual(result["status"], 200, result)
        return result["data"]

    def test_native_ui_shares_data_settings_revisions_and_search(self):
        self.call("settings/update", {"ui_language": "fr", "first_language": "zh"})
        record = self.call("points/query", {"keyword": "app", "language": "en"})["records"][0]
        self.call("points/update", {"record_id": record["id"], "expected_revision": record["revision"],
                                   "patch": {"note": "approach\n\nMy edited note.", "status": "mastered"}})
        reopened = Store(self.store.path)
        self.assertEqual(reopened.settings()["ui_language"], "fr")
        current = reopened.query()["records"][0]
        self.assertEqual(current["note"], "approach\n\nMy edited note.")
        self.assertEqual(current["encounter_count"], 1)
        self.assertEqual(current["status"], "mastered")
        stale = self.call("points/update", {"record_id": record["id"], "expected_revision": record["revision"],
                                          "patch": {"note": "Old edit"}})
        self.assertEqual(stale["error"], "edit_conflict")
        self.assertIn("content", self.call("changes/read"))

    def test_export_is_binary_safe_and_receipt_only_changes_after_delivery(self):
        selection = ExportSelection(language="en")
        for format_name in ("json", "xlsx", "docx", "notion", "pdf"):
            response = self.bridge.request("export", {"format": format_name, "language": "en"})
            self.assertEqual(response["status"], 200, response)
            file = response["file"]
            content = base64.b64decode(file["blob"], validate=True)
            self.assertGreater(len(content), 50)
            if format_name == "json":
                self.assertEqual(json.loads(content)["records"][0]["id"], self.record_id)
        self.assertIsNone(export_history(self.store, selection)["last_export"])
        self.bridge.request("export_complete", {"receipt": file["receipt"]})
        history = export_history(self.store, selection)["last_export"]
        self.assertEqual((history["count"], history["format"]), (1, "pdf"))
        self.bridge.request("export_complete", {"receipt": file["receipt"]})
        self.assertEqual(export_history(self.store, selection)["last_export"], history)

    def test_bridge_rejects_unrecognized_actions_and_invalid_payloads(self):
        for route, payload in [
            ("api", {"action": "shell", "arguments": {"command": "anything"}}),
            ("api", {"action": "points/delete", "arguments": {"record_id": self.record_id}}),
            ("api", {"action": "settings/update", "arguments": {"ui_language": "invalid"}}),
            ("api", {"action": "points/query", "arguments": {}, "url": "https://example.com"}),
            ("api", {"action": "points/query", "arguments": {"keyword": "x" * 524288}}),
            ("export", {"format": "exe"}), ("export_complete", {"receipt": []}),
            ("unknown", {}),
        ]:
            self.assertEqual(self.bridge.request(route, payload)["status"], 400)
        self.assertEqual(len(self.store.query()["records"]), 1)


class AppProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_discovers_global_entry_resource_and_app_only_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            params = StdioServerParameters(command=sys.executable, args=[str(APP / "server.py")],
                cwd=directory, env={**os.environ, "LANGUAGE_MEMORY_DB": str(Path(directory) / "app.sqlite3")})
            async with stdio_client(params) as streams, ClientSession(*streams) as session:
                await session.initialize()
                tools = {tool.name: tool for tool in (await session.list_tools()).tools}
                self.assertEqual(tools["open_memory_app"].meta["openai/ui"]["entrypoints"], [{"type": "global"}])
                self.assertEqual(tools["memory_app_request"].meta["ui"]["visibility"], ["app"])
                resource = (await session.read_resource(APP_URI)).contents[0]
                self.assertEqual(resource.mimeType, "text/html;profile=mcp-app")
                self.assertEqual(resource.meta["ui"]["csp"]["connectDomains"], [])
                self.assertEqual(resource.text, APP_FILE.read_text())
                original = (APP / "web/index.html").read_text().split("<body>", 1)[1]
                self.assertEqual(resource.text.split("<body>", 1)[1], original)
                self.assertIn((APP / "web/style.css").read_text(), resource.text)
                opened = await session.call_tool("open_memory_app")
                self.assertFalse(opened.isError)
                reply = await session.call_tool("memory_app_request", {"route": "api", "payload": {
                    "action": "settings/read", "arguments": {}}})
                self.assertEqual(reply.structuredContent["status"], 200)
                self.assertTrue(reply.structuredContent["data"]["enabled"])
