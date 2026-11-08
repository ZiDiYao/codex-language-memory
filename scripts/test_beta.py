"""Acceptance test the extracted, frozen release without a Python executable on PATH."""

import argparse
import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import urlopen

import tomlkit
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from installer import Locations, inventory


async def exercise(archive):
    checks = []
    with tempfile.TemporaryDirectory(prefix="Language Memory Beta QA ") as temporary:
        root = Path(temporary)
        extracted = root / "Downloaded Release"
        subprocess.run(["/usr/bin/ditto", "-x", "-k", str(archive), str(extracted)], check=True)
        package = next(extracted.glob("language-memory-*"))
        metadata = json.loads((package / "release.json").read_text())
        sandbox = root / "New User With Spaces"
        locations = Locations.default(sandbox)
        locations.config.parent.mkdir(parents=True)
        locations.config.write_text('# Existing preferences\nmodel = "keep-existing-model"\n[mcp_servers.unrelated]\ncommand = "keep-existing-tool"\n')
        environment = {key: value for key, value in os.environ.items() if key not in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "LANGUAGE_MEMORY_DB", "LANGUAGE_MEMORY_PDF_FONT")}
        environment["PATH"] = "/usr/bin:/bin"

        def command(folder, name):
            result = subprocess.run([str(folder / name), "--sandbox-root", str(sandbox), "--json"],
                                    env=environment, capture_output=True, text=True, timeout=180, cwd=root)
            if result.returncode:
                raise AssertionError(result.stderr + result.stdout)
            return json.loads(result.stdout)

        def configuration():
            return tomlkit.parse(locations.config.read_text())["mcp_servers"]["language_memory"].unwrap()

        def parameters():
            config = configuration()
            return StdioServerParameters(command=config["command"], args=config["args"],
                                         env={**environment, **config["env"]}, cwd=config["cwd"])

        async def call(session, name, arguments=None):
            result = await session.call_tool(name, arguments)
            assert not result.isError, result.content
            return result.structuredContent

        def snapshot():
            with sqlite3.connect(locations.database) as db:
                return {name: db.execute(f"SELECT * FROM {name} ORDER BY 1").fetchall() for name in (
                    "knowledge", "settings", "capture_preferences", "encounters", "review_events", "memory_states", "learner_preferences")}

        # The fixture uses the same executable with an earlier package version. It tests
        # release switching, not compatibility with an unreleased historical executable.
        previous = root / "Earlier Beta Fixture"
        shutil.copytree(package, previous, symlinks=True)
        old_version = "0.1.0-beta.1"
        plugin = json.loads((previous / "plugin.json").read_text())
        plugin["version"] = old_version
        (previous / "plugin.json").write_text(json.dumps(plugin, indent=2))
        (previous / "release.json").write_text(json.dumps({**metadata, "version": old_version, **inventory(previous)}))
        assert command(previous, "Install.command")["status"] == "installed"
        checks.append("Extracted command installs a bundled runtime into an empty profile with spaces in its path")
        assert command(previous, "Install.command")["status"] == "already_installed"
        checks.append("Repeated installation is idempotent")

        error_log = (root / "runtime-stderr.log").open("w+")
        async with stdio_client(parameters(), errlog=error_log) as streams, ClientSession(*streams) as session:
            await session.initialize()
            assert len((await session.list_tools()).tools) == 16
            points = [{"kind": "word", "language": "en", "title": "approach", "sense_key": "method",
                       "meaning": "A way of doing something.", "explanation": "A countable noun describing a method.",
                       "context": "We need a fresh approach.", "examples": [{"text": "Try a different approach."}]},
                      {"kind": "expression", "language": "ja", "title": "ありがとうございます", "sense_key": "polite thanks",
                       "meaning": "Thank you, politely.", "explanation": "Use this to express polite gratitude.",
                       "examples": [{"text": "ありがとうございます。", "translation": "Thank you."}]}]
            saved = await call(session, "save_points", {"request_id": "beta-save-once", "items": points})
            record_id = saved["results"][0]["id"]
            assert (await call(session, "save_points", {"request_id": "beta-save-once", "items": points}))["replayed"]
            await call(session, "update_settings", {"patch": {"ui_language": "fr"}})
            await call(session, "update_learning_preferences", {"language": "en", "patch": {"explanation_language": "zh"}})
            review = {"record_id": record_id, "request_id": "beta-review-once", "review": {"result": "incorrect"}}
            assert (await call(session, "record_review", review))["scheduled"]
            assert (await call(session, "record_review", review))["replayed"]
            page = await call(session, "open_memory_page")
            with urlopen(page["url"]) as response:
                assert "Language memory" in response.read().decode()
            for asset in ("entry-editor.js", "history-model.js"):
                with urlopen(page["url"] + asset) as response:
                    assert response.status == 200 and response.read()
            point = (await call(session, "find_points"))["records"][0]
            changed = await call(session, "update_point", {"record_id": point["id"],
                "patch": {"explanation": "Edited in a document page."}, "expected_revision": point["revision"]})
            assert changed["status"] == "updated"
            stale = await call(session, "update_point", {"record_id": point["id"],
                "patch": {"explanation": "Stale edit."}, "expected_revision": point["revision"]})
            assert stale["error"] == "edit_conflict"
            scoped = await call(session, "export_points", {"request": {"format": "json", "record_ids": [point["id"]]}})
            assert scoped["count"] == 1
            for kind in ("pdf", "docx", "xlsx", "notion", "json"):
                export = await call(session, "export_points", {"request": {"format": kind}})
                assert export["count"] == 2 and export["format"] == kind, export
                assert Path(export["path"]).is_file()
            checks.append("Frozen MCP exposes 16 tools and saves multilingual data, reviews, preferences, page assets and all five exports")
            before = snapshot()
            updated = command(package, "Install.command")
            assert updated["status"] == "updated" and updated["version"] == metadata["version"]
            assert snapshot() == before
            assert Path(updated["database_backup"]).is_file()
            assert len((await call(session, "find_points"))["records"]) == 2
            with urlopen(page["url"] + "app.js") as response:
                assert response.status == 200
            checks.append("Upgrade backs up and preserves records, encounters, FSRS state and preferences while the previous process remains readable")

        async with stdio_client(parameters(), errlog=error_log) as streams, ClientSession(*streams) as session:
            await session.initialize()
            assert (await call(session, "get_settings"))["ui_language"] == "fr"
            assert (await call(session, "get_learning_profile", {"language": "en"}))["rated_reviews"] == 1
            assert len((await call(session, "get_point_history", {"record_id": record_id}))["reviews"]) == 1
        error_log.flush()
        error_log.seek(0)
        assert "Traceback" not in error_log.read(), "The frozen MCP emitted a traceback during operation or shutdown"
        error_log.close()
        checks.append("Restarted upgraded MCP reads the same persistent state")
        assert command(package, "Roll Back.command")["version"] == old_version
        assert snapshot() == before
        checks.append("Explicit binary rollback preserves current learning data")
        assert command(package, "Install.command")["version"] == metadata["version"]
        assert command(package, "Uninstall.command")["status"] == "uninstalled"
        assert snapshot() == before
        assert not command(package, "Check Installation.command")["mcp_registered"]
        assert command(package, "Install.command")["status"] == "updated"
        assert snapshot() == before
        checks.append("Uninstall disconnects only this integration; reinstall reconnects retained data")
        config = tomlkit.parse(locations.config.read_text())
        assert config["model"] == "keep-existing-model"
        assert config["mcp_servers"]["unrelated"]["command"] == "keep-existing-tool"
        assert "# Existing preferences" in locations.config.read_text()
        checks.append("Unrelated Codex configuration and comments survive the entire lifecycle")
    return {"status": "passed", "release": metadata["version"], "checks": checks,
            "limits": "Isolated profile on the build Mac; not a separate clean Mac or a notarized download test. Upgrade fixture shares the current executable."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = asyncio.run(exercise(args.archive.resolve()))
    content = json.dumps(result, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(content + "\n")
    print(content)


if __name__ == "__main__":
    main()
