import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import tomlkit

import installer
from installer import (InstallError, Locations, install, install_lock, inventory,
                       rollback, status, uninstall)
from store import LearnerPreferences, Review, SettingsPatch, Store
from test_memory import APPROACH


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="language memory install ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.locations = Locations.default(self.root / "Test User")
        self.addCleanup(patch.stopall)
        patch("installer.platform.system", return_value="Darwin").start()
        patch("installer.platform.machine", return_value="arm64").start()
        self.package = self.make_package("0.2.0-beta.1")

    def make_package(self, version):
        package = self.root / ("Download " + version)
        (package / "runtime").mkdir(parents=True)
        runtime = package / "runtime/language-memory"
        runtime.write_text("#!/bin/sh\nexit 0\n")
        runtime.chmod(0o755)
        skill = package / "skills/language-memory/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: language-memory\ndescription: Learn languages\n---\n")
        for filename in ("plugin.json", "mcp.json"):
            (package / filename).write_text("{}\n")
        self.seal(package, version)
        return package

    def seal(self, package, version):
        (package / "release.json").write_text(json.dumps({"format": 1, "name": "codex-language-memory",
            "version": version, "platform": "darwin-arm64", **inventory(package)}))

    def runner(self, executable, action, database):
        self.assertTrue(executable.is_file())
        Store(database)

    def install(self, package=None, **kwargs):
        return install(package or self.package, self.locations, runner=self.runner, **kwargs)

    def seed(self, path=None):
        store = Store(path or self.locations.database)
        identifier = store.save("installer-fixture", [APPROACH])["results"][0]["id"]
        store.record_review(identifier, "installer-review", Review(result="incorrect"))
        store.settings(SettingsPatch(enabled=False, ui_language="fr"))
        store.learning_preferences("en", LearnerPreferences(explanation_language="zh"))
        return store

    def snapshot(self, path=None):
        with sqlite3.connect(path or self.locations.database) as db:
            return {name: db.execute(f"SELECT * FROM {name} ORDER BY 1").fetchall() for name in (
                "knowledge", "settings", "capture_preferences", "encounters", "review_events",
                "memory_states", "learner_preferences", "save_requests", "review_requests")}

    def test_fresh_install_handles_spaces_and_preserves_other_configuration(self):
        self.locations.config.parent.mkdir(parents=True)
        original = '# Keep this comment\nmodel = "existing-model"\n[mcp_servers.other]\ncommand = "keep-me"\n'
        self.locations.config.write_text(original)
        result = self.install()
        self.assertEqual(result["status"], "installed")
        config = tomlkit.parse(self.locations.config.read_text())
        self.assertEqual(config["model"], "existing-model")
        self.assertEqual(config["mcp_servers"]["other"]["command"], "keep-me")
        self.assertIn("# Keep this comment", self.locations.config.read_text())
        self.assertEqual(config["mcp_servers"]["language_memory"]["command"], str(self.locations.executable))
        self.assertEqual(config["mcp_servers"]["language_memory"]["env"]["LANGUAGE_MEMORY_DB"], str(self.locations.database))
        self.assertTrue(status(self.locations)["skill_registered"])
        self.assertTrue(self.locations.database.is_file())

    def test_repeat_install_is_idempotent_and_does_not_add_backups(self):
        self.install()
        self.seed()
        before = self.snapshot()
        state = (self.locations.base / "installation.json").read_bytes()
        config = self.locations.config.read_bytes()
        result = self.install()
        self.assertEqual(result["status"], "already_installed")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.locations.config.read_bytes(), config)
        self.assertEqual((self.locations.base / "installation.json").read_bytes(), state)
        self.assertFalse((self.locations.database.parent / "backups").exists())

    def test_repackaging_same_version_keeps_previous_version_for_rollback(self):
        first = self.install()
        upgrade = self.make_package("0.2.0-beta.2")
        self.install(upgrade)
        (upgrade / "runtime/language-memory").write_text("#!/bin/sh\n# Repaired build\nexit 0\n")
        self.seal(upgrade, "0.2.0-beta.2")
        repaired = self.install(upgrade)
        self.assertEqual(repaired["previous_release"], first["release"])

    def test_upgrade_preserves_full_history_and_creates_consistent_database_backup(self):
        self.install()
        self.seed()
        before = self.snapshot()
        old_release = self.locations.current.resolve()
        upgraded = self.install(self.make_package("0.2.0-beta.2"))
        self.assertEqual(upgraded["status"], "updated")
        self.assertNotEqual(self.locations.current.resolve(), old_release)
        self.assertTrue(old_release.is_dir())
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.snapshot(Path(upgraded["database_backup"])), before)
        self.assertEqual(Path(upgraded["database_backup"]).stat().st_mode & 0o777, 0o600)

    def test_failed_runtime_healthcheck_keeps_active_install_and_data(self):
        self.install()
        self.seed()
        before, current, config = self.snapshot(), os.readlink(self.locations.current), self.locations.config.read_bytes()
        def fail(*_):
            raise InstallError("Injected startup failure")
        with self.assertRaises(InstallError):
            install(self.make_package("0.2.0-beta.2"), self.locations, runner=fail)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(os.readlink(self.locations.current), current)
        self.assertEqual(self.locations.config.read_bytes(), config)

    def test_configuration_write_failure_rolls_back_release_and_registration(self):
        self.install()
        self.seed()
        current = os.readlink(self.locations.current)
        config = self.locations.config.read_bytes()
        before = self.snapshot()
        atomic_write = installer.atomic_write
        def fail_config(path, *args, **kwargs):
            if path == self.locations.config:
                raise OSError("Injected config write failure")
            return atomic_write(path, *args, **kwargs)
        with patch("installer.atomic_write", side_effect=fail_config), self.assertRaises(OSError):
            self.install(self.make_package("0.2.0-beta.2"))
        self.assertEqual(os.readlink(self.locations.current), current)
        self.assertEqual(self.locations.config.read_bytes(), config)
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_config_edit_is_not_overwritten(self):
        self.install()
        current = os.readlink(self.locations.current)
        changed = self.locations.config.read_text() + "\n# Concurrent user change\n"
        def concurrent_edit(executable, action, database):
            self.runner(executable, action, database)
            if action == "migrate":
                self.locations.config.write_text(changed)
        with self.assertRaises(InstallError):
            install(self.make_package("0.2.0-beta.2"), self.locations, runner=concurrent_edit)
        self.assertEqual(self.locations.config.read_text(), changed)
        self.assertEqual(os.readlink(self.locations.current), current)

    def test_legacy_install_migrates_custom_database_and_keeps_disabled_setting(self):
        project = self.root / "Old Project"
        skill = project / ".agents/skills/language-memory"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("Legacy instructions")
        entry = project / "server.py"
        entry.write_text('"""Local stdio MCP entry point for Codex Language Memory."""')
        custom_database = self.root / "Private Records" / "custom.sqlite3"
        self.seed(custom_database)
        before = self.snapshot(custom_database)
        document = {"mcp_servers": {"language_memory": {"command": "/old/python", "args": [str(entry)],
            "enabled": False, "startup_timeout_sec": 35,
            "env": {"LANGUAGE_MEMORY_DB": str(custom_database), "LANGUAGE_MEMORY_PDF_FONT": "/custom/font.ttf"}}}}
        self.locations.config.parent.mkdir(parents=True)
        self.locations.config.write_text(tomlkit.dumps(document))
        self.locations.skill.parent.mkdir(parents=True)
        self.locations.skill.symlink_to(skill)
        self.install()
        config = tomlkit.parse(self.locations.config.read_text())["mcp_servers"]["language_memory"]
        self.assertFalse(config["enabled"])
        self.assertEqual(config["startup_timeout_sec"], 35)
        self.assertEqual(config["env"]["LANGUAGE_MEMORY_PDF_FONT"], "/custom/font.ttf")
        self.assertEqual(self.snapshot(custom_database), before)
        self.assertFalse(self.locations.database.exists())

    def test_unrelated_server_and_skill_are_not_overwritten(self):
        self.locations.config.parent.mkdir(parents=True)
        original = '[mcp_servers.language_memory]\ncommand = "some-other-tool"\n'
        self.locations.config.write_text(original)
        with self.assertRaises(InstallError):
            self.install()
        self.assertEqual(self.locations.config.read_text(), original)
        self.locations.config.unlink()
        self.locations.skill.mkdir(parents=True)
        (self.locations.skill / "SKILL.md").write_text("User-owned skill")
        with self.assertRaises(InstallError):
            self.install()
        self.assertEqual((self.locations.skill / "SKILL.md").read_text(), "User-owned skill")

    def test_corrupt_package_and_external_links_fail_before_registration(self):
        (self.package / "runtime/language-memory").write_text("corrupted")
        with self.assertRaises(InstallError):
            self.install()
        self.assertFalse(self.locations.config.exists())
        (self.package / "external").symlink_to(self.root)
        with self.assertRaises(InstallError):
            self.seal(self.package, "0.2.0-beta.1")

    def test_uninstall_preserves_data_and_reinstall_reconnects(self):
        self.install()
        self.seed()
        before = self.snapshot()
        self.assertEqual(uninstall(self.locations)["status"], "uninstalled")
        self.assertFalse(status(self.locations)["mcp_registered"])
        self.assertFalse(self.locations.skill.exists())
        self.assertEqual(self.snapshot(), before)
        self.install()
        self.assertTrue(status(self.locations)["mcp_registered"])
        self.assertEqual(self.snapshot(), before)

    def test_rollback_keeps_learning_written_after_upgrade(self):
        self.install()
        self.install(self.make_package("0.2.0-beta.2"))
        self.seed()
        before = self.snapshot()
        result = rollback(self.locations, runner=self.runner)
        self.assertEqual(result["version"], "0.2.0-beta.1")
        self.assertEqual(self.snapshot(), before)

    def test_older_download_is_rejected_and_lock_prevents_concurrent_install(self):
        self.install(self.make_package("0.2.0-beta.2"))
        with self.assertRaises(InstallError):
            self.install()
        with install_lock(self.locations), self.assertRaises(InstallError):
            self.install(self.package)

    def test_finder_metadata_does_not_break_integrity_check(self):
        (self.package / ".DS_Store").write_bytes(b"Finder metadata")
        self.assertEqual(self.install()["status"], "installed")

    def test_reinstall_repairs_damaged_runtime_without_changing_data(self):
        self.install()
        self.seed()
        before = self.snapshot()
        self.locations.executable.write_text("damaged")
        self.assertEqual(self.install()["status"], "updated")
        self.assertIn("exit 0", self.locations.executable.read_text())
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.install()["status"], "already_installed")


if __name__ == "__main__":
    unittest.main()
