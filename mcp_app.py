"""Native sidebar entry and app-only transport for the existing dashboard."""

import base64
import json
import secrets
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any, Literal

from mcp.types import Icon, ToolAnnotations
from pydantic import ValidationError

from dashboard import dispatch
from exports import ExportError, ExportRequest, build_export, export_scope

APP_URI = "ui://language-memory/sidebar-v1.html"
APP_FILE = Path(__file__).parent / "web" / "mcp-app.html"
ICON = "data:image/svg+xml;base64," + base64.b64encode(
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    b'stroke="#808080" stroke-width="1.6"><path d="M4 4h5c3 0 3 1 3 3v14c0-2-1-3-3-3H4z'
    b'M20 4h-5c-3 0-3 1-3 3v14c0-2 1-3 3-3h5z"/></svg>'
).decode()


class AppTransport:
    """Reuse validated dashboard actions; never accept paths, URLs or arbitrary tools."""

    def __init__(self, store):
        self.store = store
        self.pending_exports = {}
        self.lock = Lock()

    def request(self, route, payload):
        try:
            if len(json.dumps(payload).encode()) > 524288:
                raise ValueError("Request too large")
            if route == "api":
                # Deletion stays available through the explicit conversational tool.
                if payload.get("action") == "points/delete":
                    raise ValueError("Unsupported app action")
                data = dispatch(self.store, payload)
            elif route == "export":
                selection = ExportRequest.model_validate(payload)
                exported = build_export(self.store, selection)
                if len(exported.data) > 24 * 1024 * 1024:
                    return {"status": 400, "data": {"error": "Export too large; select a shorter date range."}}
                token = secrets.token_urlsafe(24)
                with self.lock:
                    # Keep only receipt metadata, not large files, awaiting acknowledgement.
                    while len(self.pending_exports) >= 16:
                        self.pending_exports.pop(next(iter(self.pending_exports)))
                    self.pending_exports[token] = (selection, exported.receipt)
                return {"status": 200, "file": {
                    "blob": base64.b64encode(exported.data).decode(), "mime_type": exported.mime_type,
                    "filename": exported.filename, "count": exported.count, "receipt": token,
                }}
            elif route == "export_complete":
                if set(payload) != {"receipt"} or not isinstance(payload["receipt"], str):
                    raise ValueError("Invalid receipt")
                with self.lock:
                    pending = self.pending_exports.get(payload["receipt"])
                    if pending:
                        selection, receipt = pending
                        self.store.export_receipt(export_scope(selection), receipt)
                        del self.pending_exports[payload["receipt"]]
                data = {"status": "ok"}
            else:
                raise ValueError("Unknown route")
            return {"status": 200, "data": data}
        except ExportError as error:
            return {"status": 400, "data": {"error": str(error)}}
        except (ValueError, TypeError, KeyError, ValidationError):
            return {"status": 400, "data": {"error": "invalid_request"}}
        except sqlite3.Error:
            return {"status": 503, "data": {"error": "database_unavailable"}}


def register_app(server, store):
    transport = AppTransport(store)

    @server.resource(APP_URI, name="Language memory", mime_type="text/html;profile=mcp-app", meta={
        "ui": {"prefersBorder": False, "csp": {"connectDomains": [], "resourceDomains": []}},
        "openai/ui": {"preferredDisplayMode": "fullscreen", "availableDisplayModes": ["fullscreen"]},
    })
    def app_resource() -> str:
        return APP_FILE.read_text(encoding="utf-8")

    @server.tool(name="open_memory_app", title="Language memory",
                 annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False),
                 icons=[Icon(src=ICON, mimeType="image/svg+xml", sizes=["any"])], meta={
                     "ui": {"resourceUri": APP_URI},
                     "openai/ui": {"entrypoints": [{"type": "global"}]},
                 })
    def open_memory_app() -> dict[str, Any]:
        """Open Language memory inside the host: browse notes, edit and change settings.
        Uses the same local database as conversational tools. Hosts without MCP Apps can
        use open_memory_page instead. Opening the app does not record a learning encounter.
        """
        return {"ready": True}

    @server.tool(name="memory_app_request", title="Language memory page actions",
                 annotations=ToolAnnotations(destructiveHint=False, openWorldHint=False),
                 meta={"ui": {"visibility": ["app"]}})
    def memory_app_request(route: Literal["api", "export", "export_complete"],
                           payload: dict[str, Any]) -> dict[str, Any]:
        """App-only bridge for validated dashboard actions and local export downloads."""
        return transport.request(route, payload)
