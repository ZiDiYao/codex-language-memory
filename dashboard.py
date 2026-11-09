"""Loopback-only page, served on demand inside the MCP process."""

import argparse
import json
import os
import secrets
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import Field, ValidationError

from exports import (ExportError, ExportRequest, ExportSelection, build_export, preview_export,
                     export_history, record_export)

from store import (Kind, Language, Limit, Patch, RecordId, Revision, SettingsPatch,
                   Status, Store, StrictModel, Title)


class Query(StrictModel):
    keyword: Title | None = None
    kind: Kind | None = None
    language: Language | None = None
    status: Status | None = None
    limit: Annotated[int, Field(ge=1)] = 20
    offset: Annotated[int, Field(ge=0)] = 0
    include_variants: bool = False
    cursor: Annotated[str, Field(max_length=300)] | None = None
    needs_enrichment: bool = False


class PointUpdate(StrictModel):
    record_id: RecordId
    patch: Patch
    expected_revision: Revision | None = None


class PointDelete(StrictModel):
    record_id: RecordId


ASSETS = {
    "": ("index.html", "text/html; charset=utf-8"),
    "app.js": ("app.js", "text/javascript; charset=utf-8"),
    "motion.js": ("motion.js", "text/javascript; charset=utf-8"),
    "entry-editor.js": ("entry-editor.js", "text/javascript; charset=utf-8"),
    "history-model.js": ("history-model.js", "text/javascript; charset=utf-8"),
    "export-dialog.js": ("export-dialog.js", "text/javascript; charset=utf-8"),
    "export-model.js": ("export-model.js", "text/javascript; charset=utf-8"),
    "date-range.js": ("date-range.js", "text/javascript; charset=utf-8"),
    "picker.js": ("picker.js", "text/javascript; charset=utf-8"),
    "i18n.js": ("i18n.js", "text/javascript; charset=utf-8"),
    "style.css": ("style.css", "text/css; charset=utf-8"),
}


class Dashboard:
    def __init__(self, store: Store):
        self.store = store
        self.lock = Lock()
        self.httpd = None
        self.url = None

    def start(self):
        with self.lock:
            if self.httpd is not None:
                return self.url
            prefix = "/" + secrets.token_urlsafe(32) + "/"
            store = self.store

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    # URLs contain a local access token and must stay out of logs.
                    pass

                def respond(self, status, body, content_type="application/json; charset=utf-8", filename=None, count=None):
                    data = body if isinstance(body, bytes) else json.dumps(body).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", content_type)
                    if filename:
                        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                        self.send_header("X-Record-Count", str(count))
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Content-Security-Policy",
                                     "default-src 'none'; script-src 'self'; style-src 'self'; "
                                     "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
                    self.end_headers()
                    self.wfile.write(data)

                def route(self):
                    host = f"127.0.0.1:{self.server.server_port}"
                    if self.headers.get("Host") != host:
                        return None
                    path = urlsplit(self.path).path
                    if not path.startswith(prefix):
                        return None
                    return path[len(prefix):]

                def do_GET(self):
                    route = self.route()
                    if route not in ASSETS:
                        self.respond(404, {"error": "not_found"})
                        return
                    name, mime_type = ASSETS[route]
                    self.respond(200, (Path(__file__).parent / "web" / name).read_bytes(), mime_type)

                def do_POST(self):
                    route = self.route()
                    if route not in {"api", "export"}:
                        self.respond(404, {"error": "not_found"})
                        return
                    origin = f"http://127.0.0.1:{self.server.server_port}"
                    if (self.headers.get("Origin") not in (None, origin)
                            or self.headers.get("X-Language-Memory") != "1"
                            or self.headers.get("Content-Type") != "application/json"):
                        self.respond(403, {"error": "forbidden"})
                        return
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                        if not 0 < length <= 524288:
                            raise ValueError("Invalid body size")
                        request = json.loads(self.rfile.read(length))
                        if route == "export":
                            selection = ExportRequest.model_validate(request)
                            exported = build_export(store, selection)
                            self.respond(200, exported.data, exported.mime_type, exported.filename, exported.count)
                            # Only remember a successfully written response. A browser may
                            # still cancel saving it; the server cannot inspect its disk.
                            try:
                                record_export(store, selection, exported)
                            except sqlite3.Error:
                                pass  # The delivered file remains valid if history is unavailable.
                            return
                        result = dispatch(store, request)
                    except ExportError as error:
                        self.respond(400, {"error": str(error)})
                        return
                    except (ValueError, TypeError, KeyError, ValidationError):
                        self.respond(400, {"error": "invalid_request"})
                        return
                    except sqlite3.Error:
                        self.respond(503, {"error": "database_unavailable"})
                        return
                    self.respond(200, result)

            self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            self.httpd.daemon_threads = True
            self.url = f"http://127.0.0.1:{self.httpd.server_port}{prefix}"
            Thread(target=self.httpd.serve_forever, daemon=True).start()
            return self.url

    def close(self):
        with self.lock:
            if self.httpd:
                self.httpd.shutdown()
                self.httpd.server_close()
                self.httpd = None
                self.url = None


def dispatch(store, request):
    if not isinstance(request, dict) or set(request) != {"action", "arguments"}:
        raise ValueError("Invalid envelope")
    action = request["action"]
    arguments = request["arguments"]
    if action == "changes/read":
        StrictModel.model_validate(arguments)
        return store.versions()
    if action == "settings/read":
        StrictModel.model_validate(arguments)
        return store.settings()
    if action == "settings/update":
        return store.settings(SettingsPatch.model_validate(arguments))
    if action == "languages/list":
        StrictModel.model_validate(arguments)
        return store.languages()
    if action == "exports/preview":
        return preview_export(store, ExportSelection.model_validate(arguments))
    if action == "exports/history":
        return export_history(store, ExportSelection.model_validate(arguments))
    if action == "points/query":
        return store.query(**Query.model_validate(arguments).model_dump())
    if action == "points/read":
        point = PointDelete.model_validate(arguments)
        return store.get_point(point.record_id)
    if action == "points/update":
        update = PointUpdate.model_validate(arguments)
        return store.update(update.record_id, update.patch, update.expected_revision)
    if action == "points/delete":
        delete = PointDelete.model_validate(arguments)
        return store.delete(delete.record_id)
    raise ValueError("Unknown action")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Open the local language memory page.")
    default = Path.home() / ".local" / "share" / "codex-language-memory" / "memory.sqlite3"
    parser.add_argument("--db", type=Path, default=Path(os.getenv("LANGUAGE_MEMORY_DB", str(default))))
    args = parser.parse_args()
    dashboard = Dashboard(Store(args.db.expanduser().resolve()))
    print(dashboard.start(), flush=True)
    try:
        # The main process keeps the on-demand server alive for standalone use.
        from threading import Event
        Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        dashboard.close()
