import json
import shlex
import unittest
from unittest.mock import patch

import tomlkit

from extension import PLUGIN, connect_extension, extension_status, remove_extension
from installer import InstallError, Locations
import test_installer


class ExtensionTests(unittest.TestCase):
    def setUp(self):
        fixture = test_installer.InstallerTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.locations = fixture.locations
        (fixture.package / "plugin.json").write_text(json.dumps({"name": "language-memory", "version": "0.2.0-beta.1"}))
        fixture.seal(fixture.package, "0.2.0-beta.1")
        fixture.install()
        fixture.seed()
        self.snapshot = fixture.snapshot()
        self.addCleanup(patch.stopall)
        patch.object(Locations, "default", return_value=self.locations).start()

    def runner(self, arguments):
        document = tomlkit.parse(self.locations.config.read_text())
        if arguments[0] == "add":
            document.setdefault("plugins", {})[PLUGIN] = {"enabled": True}
            self.locations.config.write_text(tomlkit.dumps(document))
            return {"pluginId": PLUGIN, "enabled": True}
        if arguments[0] == "list":
            return {"installed": [{"pluginId": PLUGIN, "enabled": document["plugins"][PLUGIN]["enabled"]}]}
        if arguments[0] == "remove":
            del document["plugins"][PLUGIN]
            self.locations.config.write_text(tomlkit.dumps(document))
        return {}

    def test_native_connection_upgrade_and_removal_keep_learning_data(self):
        connect_extension(self.locations, runner=self.runner)
        self.assertTrue(extension_status(self.locations)["enabled"])
        self.assertFalse(self.locations.skill.is_symlink())
        self.assertNotIn("language_memory", tomlkit.parse(self.locations.config.read_text()).get("mcp_servers", {}))
        manifest = json.loads((self.locations.base / "extension/mcp.json").read_text())
        self.assertEqual(manifest["$schema"], "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json")
        mcp = manifest["mcpServers"]["language_memory"]
        self.assertEqual(mcp["command"], "./launch")
        launcher = self.locations.base / "extension/launch"
        self.assertTrue(launcher.stat().st_mode & 0o111)
        self.assertEqual(shlex.split(launcher.read_text().splitlines()[1]),
                         ["exec", str(self.locations.executable), "serve", "--db", str(self.locations.database)])
        self.fixture.install()
        connect_extension(self.locations, runner=self.runner)
        self.assertEqual(self.fixture.snapshot(), self.snapshot)
        remove_extension(self.locations, runner=self.runner)
        self.assertFalse(extension_status(self.locations)["installed"])
        self.assertEqual(self.fixture.snapshot(), self.snapshot)

    def test_failed_native_confirmation_keeps_direct_fallback(self):
        def failure(arguments):
            if arguments == ["list"]:
                return {"installed": []}
            return self.runner(arguments)
        with self.assertRaises(InstallError):
            connect_extension(self.locations, runner=failure)
        document = tomlkit.parse(self.locations.config.read_text())
        self.assertIn("language_memory", document["mcp_servers"])
        self.assertFalse(document["plugins"][PLUGIN]["enabled"])
        self.assertTrue(self.locations.skill.is_symlink())
        self.assertEqual(self.fixture.snapshot(), self.snapshot)

    def test_unrelated_extension_is_not_overwritten(self):
        directory = self.locations.base / "extension"
        directory.mkdir()
        (directory / "plugin.json").write_text('{"name":"unrelated"}')
        with self.assertRaises(InstallError):
            connect_extension(self.locations, runner=self.runner)
        self.assertEqual((directory / "plugin.json").read_text(), '{"name":"unrelated"}')
