"""Executable entry point for the self-contained macOS Beta."""

import argparse
import asyncio
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from installer import InstallError, Locations, install, rollback, status, uninstall
from extension import connect_extension, extension_status, remove_extension
from server import create_server
from store import Review, Store


def healthcheck(database):
    from dashboard import Dashboard
    from exports import ExportRequest, build_export

    store = Store(database)
    tools = asyncio.run(create_server(store).list_tools())
    if len(tools) != 16:
        raise InstallError("Unexpected MCP tool set")
    # Verify static assets and dynamically imported Office/PDF dependencies in the frozen build.
    if not (Path(__file__).parent / "web" / "app.js").is_file():
        raise InstallError("Missing dashboard assets")
    with tempfile.TemporaryDirectory(prefix="language-memory-check-") as directory:
        sample = Store(Path(directory) / "memory.sqlite3")
        saved = sample.save("runtime-healthcheck", [{
            "kind": "word", "language": "en", "title": "approach", "sense_key": "method",
            "meaning": "A way of doing something.", "explanation": "A countable noun describing a method.",
            "examples": [{"text": "Try a new approach."}],
        }])
        sample.record_review(saved["results"][0]["id"], "runtime-review-check", Review(result="correct"))
        for format_name in ("pdf", "docx", "xlsx", "notion", "json"):
            result = build_export(sample, ExportRequest(format=format_name))
            if result.count != 1 or not result.data:
                raise InstallError("Export health check failed")
    # Binding is checked as well; no user browser is opened.
    dashboard = Dashboard(store)
    try:
        dashboard.start()
    finally:
        dashboard.close()


def main():
    parser = argparse.ArgumentParser(description="Install, update or run Codex Language Memory.")
    parser.add_argument("action", choices=("install", "serve", "healthcheck", "migrate", "status", "rollback", "uninstall", "connect-extension"))
    parser.add_argument("--package", type=Path)
    parser.add_argument("--sandbox-root", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--json", action="store_true", help="Print machine-readable operation results.")
    args = parser.parse_args()
    locations = Locations.default(args.sandbox_root)
    database = args.db or Path(os.getenv("LANGUAGE_MEMORY_DB", str(locations.database))).expanduser()
    try:
        if args.action == "serve":
            # The SDK's UTF-8 wrapper can close shared stdout on shutdown. Keep a
            # duplicate for the frozen bootstrap's final flush, without logging to stdout.
            output_descriptor = os.dup(sys.stdout.fileno())
            try:
                create_server(Store(database.resolve())).run(transport="stdio")
            finally:
                if sys.stdout.closed:
                    sys.stdout = sys.__stdout__ = os.fdopen(output_descriptor, "w", encoding="utf-8")
                else:
                    os.close(output_descriptor)
            return
        if args.action == "healthcheck":
            healthcheck(database.resolve())
            result = {"status": "healthy"}
        elif args.action == "migrate":
            Store(database.resolve())
            result = {"status": "ready"}
        elif args.action == "install":
            if not args.package:
                raise InstallError("An extracted release package is required.")
            result = install(args.package, locations)
        elif args.action == "rollback":
            result = rollback(locations)
        elif args.action == "uninstall":
            remove_extension(locations)
            result = uninstall(locations)
        elif args.action == "connect-extension":
            result = connect_extension(locations)
        else:
            result = status(locations)
            result["extension"] = extension_status(locations)
        if args.action in ("install", "rollback") and extension_status(locations)["installed"]:
            try:
                result["extension"] = connect_extension(locations)
            except (InstallError, OSError, subprocess.TimeoutExpired) as error:
                result["extension_warning"] = str(error)
                print("The Beta is installed through MCP, but its native extension could not be refreshed. "
                      "Run Connect Extension.command to retry.", file=sys.stderr)
        if args.json:
            print(json.dumps(result, indent=2))
        elif args.action in ("install", "rollback", "connect-extension"):
            label = "Already installed" if result["status"] == "already_installed" else "Ready"
            print(f"{label}: Language Memory {result['version']}.")
            print("Your learning records and settings are preserved.")
            if result.get("database_backup"):
                print("A database backup was created before updating.")
            print("Restart Codex and start a new conversation.")
            print('Try: "Open the language learning page."')
        elif args.action == "uninstall":
            print("Language Memory disconnected. Your records, backups and release files were kept.")
            print(result["next_step"])
        elif args.action == "status":
            print(f"Language Memory: {result['version'] or 'not installed'}")
            if result["extension"]["enabled"]:
                print("Native Codex extension: connected")
            checks = (("runtime_available", "Runtime"),) if result["extension"]["enabled"] else (
                ("runtime_available", "Runtime"), ("mcp_registered", "MCP connection"),
                ("mcp_enabled", "MCP enabled"), ("skill_registered", "Skill"))
            for key, label in checks:
                print(f"{label}: {'ready' if result[key] else 'not active'}")
            print(f"Learning data: {result['database']}")
        else:
            print(result["status"])
    except (InstallError, OSError, ValueError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        print(f"Language Memory: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
