"""Per-user local installation with immutable releases and data-preserving upgrades."""

import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import tomlkit


APP_NAME = "Codex Language Memory"
SERVER_NAME = "language_memory"
RELEASE_FORMAT = 1


class InstallError(Exception):
    pass


@dataclass(frozen=True)
class Locations:
    home: Path
    codex: Path

    @classmethod
    def default(cls, sandbox_root=None):
        # A dedicated test root redirects every install/config/data path, never HOME.
        if sandbox_root:
            root = Path(sandbox_root).expanduser().resolve()
            return cls(root, root / ".codex")
        return cls(Path.home(), Path(os.getenv("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve())

    @property
    def base(self):
        return self.home / "Library" / "Application Support" / APP_NAME

    @property
    def config(self):
        return (self.codex / "config.toml").resolve()

    @property
    def skill(self):
        return self.home / ".agents" / "skills" / "language-memory"

    @property
    def database(self):
        return self.home / ".local" / "share" / "codex-language-memory" / "memory.sqlite3"

    @property
    def current(self):
        return self.base / "current"

    @property
    def executable(self):
        return self.current / "runtime" / "language-memory"


def atomic_write(path, content, *, expected=None, compare=False):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".language-memory-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if compare and read_optional(path) != expected:
            raise InstallError("Codex configuration changed during installation. Close its settings and retry.")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_optional(path):
    return path.read_bytes() if path.exists() else None


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def link_value(path):
    if path.is_symlink():
        return os.readlink(path)
    if path.exists():
        raise InstallError(f"An unmanaged directory or file already exists at {path}. Nothing was replaced.")
    return None


def set_link(path, target):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target is None:
        path.unlink(missing_ok=True)
        return
    temporary = path.with_name(".language-memory-link-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target, target_is_directory=True)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def install_lock(locations):
    locations.base.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (locations.base / ".install.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError("Another installation is running. Wait for it to finish and retry.") from None
        yield


def version_key(value):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-beta\.(\d+)", value)
    if not match:
        raise InstallError("Unsupported Beta version.")
    return tuple(map(int, match.groups()))


def inventory(root):
    files, links = {}, {}
    root = root.resolve()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == "release.json" or any(part == ".DS_Store" or part == "__MACOSX" or part.startswith("._") for part in path.relative_to(root).parts):
            continue
        if path.is_symlink():
            if not path.resolve().is_relative_to(root) or not path.exists():
                raise InstallError("Package contains a broken or external symbolic link.")
            links[relative] = os.readlink(path)
        elif path.is_file():
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {"files": files, "symlinks": links}


def release_id(metadata):
    return hashlib.sha256(json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_package(root):
    root = root.resolve()
    metadata = read_json(root / "release.json")
    if metadata.get("format") != RELEASE_FORMAT or metadata.get("name") != "codex-language-memory":
        raise InstallError("This is not a supported Language Memory release package.")
    version_key(metadata.get("version", ""))
    if metadata.get("platform") != "darwin-arm64" or platform.system() != "Darwin" or platform.machine() != "arm64":
        raise InstallError("This Beta package requires an Apple Silicon Mac.")
    actual = inventory(root)
    if any(actual[key] != metadata.get(key) for key in ("files", "symlinks")):
        raise InstallError("Package integrity check failed. Download and extract a fresh release.")
    for name in ("runtime/language-memory", "skills/language-memory/SKILL.md", "plugin.json", "mcp.json"):
        if not (root / name).is_file():
            raise InstallError(f"Incomplete release: {name}")
    if not os.access(root / "runtime/language-memory", os.X_OK):
        raise InstallError("The bundled runtime is not executable. Extract the release with macOS Archive Utility.")
    return metadata


def parse_config(content):
    try:
        document = tomlkit.parse((content or b"").decode())
        servers = document.get("mcp_servers", {})
        existing = servers.get(SERVER_NAME)
        if existing is not None and not hasattr(existing, "items"):
            raise ValueError("Invalid server table")
        return document, existing
    except Exception:
        raise InstallError("Codex config.toml could not be parsed. It has not been changed.") from None


def legacy_project(existing):
    if not existing or existing.get("url"):
        return None
    args = existing.get("args", [])
    if not args:
        return None
    entry = Path(args[0]).expanduser()
    if entry.name != "server.py" or not entry.is_file():
        return None
    if 'Local stdio MCP entry point for Codex Language Memory.' not in entry.read_text()[:200]:
        return None
    return entry.resolve().parent


def check_ownership(locations, existing):
    legacy = legacy_project(existing)
    if existing and (existing.get("command") != str(locations.executable) or existing.get("url")) and not legacy:
        raise InstallError("An unrelated MCP server already uses language_memory. Nothing was replaced.")
    current_link = link_value(locations.current)
    if current_link and not locations.current.resolve().is_relative_to(locations.base / "releases"):
        raise InstallError("The current release link is not managed by this installer.")
    skill_link = link_value(locations.skill)
    expected = locations.current / "skills" / "language-memory"
    legacy_skill = legacy / ".agents/skills/language-memory" if legacy else None
    if skill_link and Path(os.path.abspath(locations.skill.parent / skill_link)) != expected:
        if not legacy_skill or locations.skill.resolve() != legacy_skill.resolve():
            raise InstallError("An unrelated language-memory skill is already installed. Nothing was replaced.")
    return current_link, skill_link


def database_path(locations, existing, state):
    value = (existing or {}).get("env", {}).get("LANGUAGE_MEMORY_DB") or state.get("database") or str(locations.database)
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise InstallError("The existing LANGUAGE_MEMORY_DB is relative. Resolve this custom setting before upgrading.")
    return candidate.resolve()


def backup_database(source, target):
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.touch(mode=0o600, exist_ok=False)
    try:
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=10) as original:
            with sqlite3.connect(target) as destination:
                original.backup(destination)
                if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise InstallError("Database integrity check failed; the current installation was kept.")
    except Exception:
        target.unlink(missing_ok=True)
        raise


def run_runtime(executable, action, database):
    completed = subprocess.run([str(executable), action, "--db", str(database)],
                               capture_output=True, text=True, timeout=120, cwd=executable.parent)
    if completed.returncode:
        # Do not include captured configuration, learning records, or environment values.
        raise InstallError(f"The new runtime failed its {action} check. The active installation was kept.")


def install(package, locations, *, allow_downgrade=False, runner=run_runtime):
    package = Path(package).resolve()
    metadata = verify_package(package)
    digest = release_id(metadata)
    key = metadata["version"] + "-" + digest[:12]
    with install_lock(locations):
        state_path = locations.base / "installation.json"
        state = read_json(state_path)
        previous_state_bytes = read_optional(state_path)
        before = read_optional(locations.config)
        document, existing = parse_config(before)
        current_link, skill_link = check_ownership(locations, existing)
        database = database_path(locations, existing, state)
        if state.get("version") and not allow_downgrade and version_key(metadata["version"]) < version_key(state["version"]):
            raise InstallError("A newer Beta is installed. Use Roll Back.command for an intentional rollback.")
        destination = locations.base / "releases" / key
        expected_skill = str(locations.current / "skills" / "language-memory")
        active = locations.current.resolve()
        same_package = state.get("package_id") == digest or state.get("release") == key
        if (same_package and current_link == str(locations.base / "releases" / state.get("release", ""))
                and active.is_dir() and skill_link == expected_skill
                and existing and existing.get("command") == str(locations.executable)
                and existing.get("args") == ["serve"] and existing.get("cwd") == str(locations.current)
                and database == Path(state["database"])):
            try:
                verify_package(active)
            except InstallError:
                pass  # A fresh verified download can repair a damaged installed copy.
            else:
                return {"status": "already_installed", "version": metadata["version"], "database": str(database)}

        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            try:
                verify_package(destination)
            except InstallError:
                key += "-repair-" + uuid.uuid4().hex[:8]
                destination = destination.with_name(key)
        if not destination.exists():
            stage = destination.with_name(".staging-" + uuid.uuid4().hex)
            try:
                shutil.copytree(package, stage, symlinks=True)
                verify_package(stage)
                os.replace(stage, destination)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        else:
            verify_package(destination)
        runtime = destination / "runtime" / "language-memory"
        # Test imports, exports and migration against a copy before touching active state.
        with tempfile.TemporaryDirectory(prefix="preflight-", dir=locations.base) as temporary:
            trial = Path(temporary) / "memory.sqlite3"
            if database.exists():
                backup_database(database, trial)
            runner(runtime, "healthcheck", trial)

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
        backup = None
        if database.exists():
            backup = database.parent / "backups" / f"before-{metadata['version']}-{stamp}.sqlite3"
            backup_database(database, backup)
        if before is not None:
            atomic_write(locations.base / "backups" / ("config-" + stamp + ".toml"), before)
        runner(runtime, "migrate", database)

        if "mcp_servers" not in document:
            document["mcp_servers"] = tomlkit.table()
        if SERVER_NAME not in document["mcp_servers"]:
            document["mcp_servers"][SERVER_NAME] = tomlkit.table()
        settings = document["mcp_servers"][SERVER_NAME]
        settings["command"] = str(locations.executable)
        settings["args"] = ["serve"]
        settings["cwd"] = str(locations.current)
        if "env" not in settings:
            settings["env"] = tomlkit.table()
        settings["env"]["LANGUAGE_MEMORY_DB"] = str(database)
        after = tomlkit.dumps(document).encode()
        new_state = {"version": metadata["version"], "release": key, "package_id": digest,
                     "previous_release": state.get("previous_release") if same_package else state.get("release"),
                     "database": str(database),
                     "database_backup": str(backup) if backup else None}
        switched = wrote_config = linked_skill = False
        try:
            set_link(locations.current, str(destination))
            switched = True
            atomic_write(locations.config, after, expected=before, compare=True)
            wrote_config = True
            set_link(locations.skill, expected_skill)
            linked_skill = True
            atomic_write(state_path, json.dumps(new_state, indent=2).encode())
        except Exception:
            if linked_skill and link_value(locations.skill) == expected_skill:
                set_link(locations.skill, skill_link)
            if wrote_config and read_optional(locations.config) == after:
                if before is None:
                    locations.config.unlink()
                else:
                    atomic_write(locations.config, before, expected=after, compare=True)
            if switched and link_value(locations.current) == str(destination):
                set_link(locations.current, current_link)
            if previous_state_bytes is None:
                state_path.unlink(missing_ok=True)
            else:
                atomic_write(state_path, previous_state_bytes)
            # Never restore the data backup automatically: another session may have written new records.
            raise
        return {"status": "updated" if state or existing else "installed", **new_state,
                "next_step": "Restart Codex or reconnect its MCP server, then start a new conversation."}


def rollback(locations, *, runner=run_runtime):
    state = read_json(locations.base / "installation.json")
    previous = state.get("previous_release")
    if not previous or Path(previous).name != previous:
        raise InstallError("There is no previous packaged release to roll back to.")
    return install(locations.base / "releases" / previous, locations, allow_downgrade=True, runner=runner)


def uninstall(locations):
    with install_lock(locations):
        before = read_optional(locations.config)
        document, existing = parse_config(before)
        removed = []
        if existing and existing.get("command") == str(locations.executable):
            del document["mcp_servers"][SERVER_NAME]
            atomic_write(locations.config, tomlkit.dumps(document).encode(), expected=before, compare=True)
            removed.append("MCP registration")
        if locations.skill.is_symlink() and os.readlink(locations.skill) == str(locations.current / "skills" / "language-memory"):
            locations.skill.unlink()
            removed.append("Skill link")
        return {"status": "uninstalled", "removed": removed,
                "retained": "Learning data, backups and installed releases are retained. Reinstall to reconnect.",
                "next_step": "Restart Codex or reconnect MCP to stop an already running server."}


def status(locations):
    state = read_json(locations.base / "installation.json")
    _, existing = parse_config(read_optional(locations.config))
    return {"version": state.get("version"), "runtime_available": locations.executable.is_file(),
            "mcp_registered": bool(existing and existing.get("command") == str(locations.executable)),
            "mcp_enabled": bool(existing and existing.get("enabled", True)),
            "skill_registered": locations.skill.is_symlink() and os.readlink(locations.skill) == str(locations.current / "skills" / "language-memory"),
            "database": state.get("database", str(locations.database)),
            "database_backup": state.get("database_backup")}
