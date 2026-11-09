"""Connect an installed Beta to the user's native Codex plugin directory."""

import json
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

import tomlkit

from installer import (InstallError, atomic_write, check_ownership, parse_config,
                       read_json, read_optional, uninstall, verify_package)

MARKETPLACE = "language-memory-local"
PLUGIN = "language-memory@" + MARKETPLACE


def run_codex(arguments):
    executable = shutil.which("codex") or next((str(path) for path in (
        Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
        Path("/opt/homebrew/bin/codex"), Path("/usr/local/bin/codex"),
        Path.home() / ".local/bin/codex",
    ) if path.is_file()), None)
    if not executable:
        raise InstallError("Codex CLI is needed to add the native extension. The direct MCP installation remains usable.")
    result = subprocess.run([executable, "plugin", *arguments, "--json"],
                            capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise InstallError("Codex could not connect the local extension: " + (result.stderr.strip() or "command failed"))
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise InstallError("Codex returned an unexpected extension result.") from None


def extension_status(locations):
    marker = read_json(locations.base / "extension.json")
    document, _ = parse_config(read_optional(locations.config))
    installed = bool(marker.get("plugin_id") == PLUGIN)
    enabled = document.get("plugins", {}).get(PLUGIN, {}).get("enabled", False)
    return {"installed": installed, "enabled": installed and bool(enabled), "plugin_id": PLUGIN}


def disable_extension(locations):
    before = read_optional(locations.config)
    document, _ = parse_config(before)
    entry = document.get("plugins", {}).get(PLUGIN)
    if entry is not None:
        entry["enabled"] = False
        atomic_write(locations.config, tomlkit.dumps(document).encode(), expected=before, compare=True)


def connect_extension(locations, *, runner=run_codex):
    if locations != type(locations).default():
        # Native CLI registration always uses its own real profile; never point it at test data.
        raise InstallError("Native extension connection is unavailable in a sandbox profile.")
    verify_package(locations.current)
    document, existing = parse_config(read_optional(locations.config))
    check_ownership(locations, existing)
    state = read_json(locations.base / "installation.json")
    database = state.get("database")
    if not database or not Path(database).is_absolute():
        raise InstallError("Install the Beta before connecting its extension.")
    source = locations.base / "extension"
    catalog = locations.base / ".agents/plugins/marketplace.json"
    if source.exists() and read_json(source / "plugin.json").get("name") != "language-memory":
        raise InstallError("An unrelated extension directory already exists.")
    if catalog.exists() and read_json(catalog).get("name") != MARKETPLACE:
        raise InstallError("An unrelated marketplace already exists.")
    before = read_optional(locations.config)
    if before:
        atomic_write(locations.base / "backups/before-extension.toml", before)
    manifest = read_json(locations.current / "plugin.json")
    atomic_write(source / "plugin.json", json.dumps(manifest, indent=2).encode())
    skill = source / "skills/language-memory"
    skill.parent.mkdir(parents=True, exist_ok=True)
    # Publish the whole managed Skill, including references, and remove stale
    # resources on rollback. Stage the copy before replacing the working tree.
    with tempfile.TemporaryDirectory(prefix=".skill-", dir=source) as temporary:
        staged, previous = Path(temporary) / "new", Path(temporary) / "previous"
        shutil.copytree(locations.current / "skills/language-memory", staged)
        if skill.exists() or skill.is_symlink():
            skill.rename(previous)
        try:
            staged.rename(skill)
        except OSError:
            if previous.exists() or previous.is_symlink():
                previous.rename(skill)
            raise
    # Portable manifests require a contained executable. The generated launcher
    # follows the managed release link and keeps custom database paths intact.
    launcher = source / "launch"
    atomic_write(launcher, ("#!/bin/sh\nexec " + shlex.quote(str(locations.executable)) +
                           " serve --db " + shlex.quote(database) + "\n").encode())
    launcher.chmod(0o755)
    mcp = {"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": {"language_memory": {
        "type": "stdio", "command": "./launch", "args": [],
    }}}
    atomic_write(source / "mcp.json", json.dumps(mcp, indent=2).encode())
    atomic_write(catalog, json.dumps({
        "name": MARKETPLACE, "interface": {"displayName": "Language Memory Beta"},
        "plugins": [{"name": "language-memory", "source": {"source": "local", "path": "./extension"},
                     "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                     "category": "Productivity"}],
    }, indent=2).encode())
    try:
        runner(["marketplace", "add", str(locations.base)])
        runner(["add", PLUGIN])
        if existing and not extension_status(locations)["installed"]:
            policy = {key: existing[key] for key in ("enabled", "enabled_tools", "disabled_tools",
                      "default_tools_enabled", "default_tools_approval_mode", "tools") if key in existing}
            if policy:
                content = read_optional(locations.config)
                config, _ = parse_config(content)
                entry = config["plugins"][PLUGIN]
                entry.setdefault("mcp_servers", {})["language_memory"] = policy
                atomic_write(locations.config, tomlkit.dumps(config).encode(), expected=content, compare=True)
        matches = [item for item in runner(["list"])["installed"] if item.get("pluginId") == PLUGIN]
        if len(matches) != 1 or not matches[0].get("enabled"):
            raise InstallError("Codex did not confirm that the native extension is enabled.")
        atomic_write(locations.base / "extension.json", json.dumps({
            "plugin_id": PLUGIN, "version": state["version"],
        }, indent=2).encode())
        # Only remove the direct registration after the native plugin has been verified.
        uninstall(locations)
        return {"status": "connected", "plugin_id": PLUGIN, "version": state["version"],
                "database": database, "next_step": "Restart Codex and start a new conversation."}
    except Exception:
        # The caller's freshly installed direct connection remains the fallback.
        # If there is no direct connection, keep the previous native entry usable.
        _, direct = parse_config(read_optional(locations.config))
        if direct:
            disable_extension(locations)
        raise


def remove_extension(locations, *, runner=run_codex):
    if extension_status(locations)["installed"]:
        runner(["remove", PLUGIN])
        (locations.base / "extension.json").unlink(missing_ok=True)
