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
    if len(tools) != 23:
        raise InstallError("Unexpected MCP tool set")
    from mcp_app import APP_FILE
    if not APP_FILE.is_file():
        raise InstallError("Missing native sidebar app")
    # Verify static assets and dynamically imported Office/PDF dependencies in the frozen build.
    if not (Path(__file__).parent / "web" / "app.js").is_file():
        raise InstallError("Missing dashboard assets")
    with tempfile.TemporaryDirectory(prefix="language-memory-check-") as directory:
        sample = Store(Path(directory) / "memory.sqlite3")
        saved = sample.save("runtime-healthcheck", [{
            "kind": "word", "language": "en", "title": "approach", "sense_key": "method",
            "meaning": "A way of doing something.", "explanation": "A countable noun describing a method.",
            "examples": [{"text": "Try a new approach."}, {"text": "This approach saves time."}],
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


def serve(database):
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


def check_runtime(database):
    healthcheck(database.resolve())
    return {"status": "healthy"}


def migrate(database):
    Store(database.resolve())
    return {"status": "ready"}


def install_package(package, locations):
    if not package:
        raise InstallError("An extracted release package is required.")
    return install(package, locations)


def disconnect(locations):
    remove_extension(locations)
    return uninstall(locations)


def installation_status(locations):
    return {**status(locations), "extension": extension_status(locations)}


def refresh_extension(action, result, locations):
    if action not in ("install", "rollback") or not extension_status(locations)["installed"]:
        return
    try:
        result["extension"] = connect_extension(locations)
    except (InstallError, OSError, subprocess.TimeoutExpired) as error:
        result["extension_warning"] = str(error)
        print("The Beta is installed through MCP, but its native extension could not be refreshed. "
              "Run Connect Extension.command to retry.", file=sys.stderr)


def print_ready(result):
    label = "Already installed" if result["status"] == "already_installed" else "Ready"
    print(f"{label}: Language Memory {result['version']}.")
    print("Your learning records and settings are preserved.")
    if result.get("database_backup"):
        print("A database backup was created before updating.")
    print("Restart Codex and start a new conversation.")
    print('Try: "Open the language learning page."')


def print_disconnected(result):
    print("Language Memory disconnected. Your records, backups and release files were kept.")
    print(result["next_step"])


def print_status(result):
    print(f"Language Memory: {result['version'] or 'not installed'}")
    checks = [("runtime_available", "Runtime")]
    if result["extension"]["enabled"]:
        print("Native Codex extension: connected")
    else:
        checks += [("mcp_registered", "MCP connection"),
                   ("mcp_enabled", "MCP enabled"), ("skill_registered", "Skill")]
    for key, label in checks:
        print(f"{label}: {'ready' if result[key] else 'not active'}")
    print(f"Learning data: {result['database']}")


def print_result(action, result, as_json):
    if as_json:
        print(json.dumps(result, indent=2))
        return
    reporters = {
        "install": print_ready, "rollback": print_ready, "connect-extension": print_ready,
        "uninstall": print_disconnected, "status": print_status,
    }
    reporters.get(action, lambda data: print(data["status"]))(result)


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
    operations = {
        "serve": lambda: serve(database),
        "healthcheck": lambda: check_runtime(database),
        "migrate": lambda: migrate(database),
        "install": lambda: install_package(args.package, locations),
        "rollback": lambda: rollback(locations),
        "uninstall": lambda: disconnect(locations),
        "connect-extension": lambda: connect_extension(locations),
        "status": lambda: installation_status(locations),
    }
    try:
        result = operations[args.action]()
        if result is None:  # Stdio serve must never print operation summaries.
            return
        refresh_extension(args.action, result, locations)
        print_result(args.action, result, args.json)
    except (InstallError, OSError, ValueError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        print(f"Language Memory: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
