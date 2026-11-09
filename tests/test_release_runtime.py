import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import release_runtime as runtime
from store import Store


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.database = self.root / "memory.sqlite3"

    def run_command(self, *arguments):
        output, errors = io.StringIO(), io.StringIO()
        argv = ["language-memory", *arguments, "--sandbox-root", str(self.root), "--db", str(self.database)]
        with patch("sys.argv", argv), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            runtime.main()
        return output.getvalue(), errors.getvalue()

    def test_migrate_initializes_the_requested_database_and_reports_json(self):
        output, errors = self.run_command("migrate", "--json")
        self.assertEqual(json.loads(output), {"status": "ready"})
        self.assertEqual(errors, "")
        self.assertTrue(self.database.is_file())
        self.assertEqual(Store(self.database).query()["records"], [])

    def test_real_healthcheck_loads_tools_assets_and_all_export_dependencies(self):
        output, errors = self.run_command("healthcheck", "--json")
        self.assertEqual(json.loads(output), {"status": "healthy"})
        self.assertEqual(errors, "")
        self.assertEqual(Store(self.database).query()["records"], [])

    def test_healthcheck_reports_success_and_passes_the_selected_database(self):
        with patch.object(runtime, "healthcheck") as check:
            output, errors = self.run_command("healthcheck")
        check.assert_called_once_with(self.database.resolve())
        self.assertEqual((output, errors), ("healthy\n", ""))

    def test_serve_does_not_print_a_cli_summary_on_the_mcp_stream(self):
        with patch.object(runtime, "serve", return_value=None) as serve:
            output, errors = self.run_command("serve", "--json")
        serve.assert_called_once_with(self.database)
        self.assertEqual((output, errors), ("", ""))

    def test_install_requires_a_package_before_touching_installation(self):
        with patch.object(runtime, "install") as install, self.assertRaises(SystemExit) as error:
            self.run_command("install", "--json")
        self.assertEqual(error.exception.code, 1)
        install.assert_not_called()

    def test_extension_refresh_failure_preserves_successful_install_result(self):
        with patch.object(runtime, "install", return_value={"status": "installed", "version": "test"}), \
             patch.object(runtime, "extension_status", return_value={"installed": True}), \
             patch.object(runtime, "connect_extension", side_effect=runtime.InstallError("refresh failed")):
            output, errors = self.run_command("install", "--package", str(self.root), "--json")
        result = json.loads(output)
        self.assertEqual(result["status"], "installed")
        self.assertEqual(result["extension_warning"], "refresh failed")
        self.assertIn("Connect Extension.command", errors)

    def test_uninstall_disconnects_extension_before_removing_registration(self):
        calls = []
        def uninstall(_):
            calls.append("registration")
            return {"status": "uninstalled", "next_step": "Records kept."}
        with patch.object(runtime, "remove_extension", side_effect=lambda _: calls.append("extension")), \
             patch.object(runtime, "uninstall", side_effect=uninstall):
            output, _ = self.run_command("uninstall")
        self.assertEqual(calls, ["extension", "registration"])
        self.assertIn("Records kept.", output)

    def test_storage_errors_exit_without_a_success_result(self):
        with patch.object(runtime, "Store", side_effect=sqlite3.OperationalError("locked")), \
             self.assertRaises(SystemExit) as error:
            self.run_command("migrate", "--json")
        self.assertEqual(error.exception.code, 1)
