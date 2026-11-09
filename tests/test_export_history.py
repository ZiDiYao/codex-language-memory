import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from dashboard import dispatch
from exports import (ExportError, ExportRequest, ExportSelection, build_export,
                     export_history, export_scope, preview_export, save_export)
from store import Store
from test_memory import APPROACH


class ExportHistoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "memory.sqlite3")
        self.store.save("export-history-fixture", [APPROACH])
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET created_at = '2026-11-01T12:00:00+00:00'")

    def test_only_completed_file_exports_update_persistent_history(self):
        selection = ExportSelection(language="en")
        request = ExportRequest(format="json", language="en", end_at="2026-11-03T05:00:00Z")
        preview_export(self.store, selection)
        build_export(self.store, request)
        self.assertIsNone(export_history(self.store, selection)["last_export"])
        result = save_export(self.store, request)
        self.assertEqual(len(json.loads(Path(result["path"]).read_text())["records"]), 1)
        history = dispatch(Store(self.store.path), {"action":"exports/history", "arguments":{"language":"en"}})["last_export"]
        self.assertEqual(history["through_at"], "2026-11-03T05:00:00+00:00")
        self.assertEqual((history["count"], history["format"]), (1, "json"))
        with patch("exports.Path.open", side_effect=OSError("No space")):
            with self.assertRaises(OSError):
                save_export(self.store, ExportRequest(format="json", language="en"))
        with patch("exports.pdf_document", side_effect=ExportError("pdfFontMissing")):
            with self.assertRaises(ExportError):
                save_export(self.store, ExportRequest(format="pdf", language="en"))
        self.assertEqual(export_history(self.store, selection)["last_export"], history)

    def test_filter_scopes_do_not_claim_coverage_for_other_languages_or_content(self):
        request = ExportRequest(format="json", language="en", kinds=["word", "expression"])
        save_export(self.store, request)
        self.assertIsNotNone(export_history(self.store, ExportSelection(language="en", kinds=["expression", "word"]))["last_export"])
        for selection in [ExportSelection(), ExportSelection(language="ja"),
                          ExportSelection(language="en", status="mastered"),
                          ExportSelection(language="en", content="terms"),
                          ExportSelection(language="en", keyword="approach")]:
            self.assertIsNone(export_history(self.store, selection)["last_export"])
        self.assertEqual(export_scope(ExportSelection(kind="word")), export_scope(ExportSelection(kinds=["word"])))

    def test_future_end_is_capped_at_snapshot_and_older_ranges_do_not_claim_contiguous_coverage(self):
        fixed = datetime(2026, 11, 8, 19, tzinfo=timezone.utc)
        with patch("exports.datetime") as clock:
            clock.now.return_value = fixed
            save_export(self.store, ExportRequest(format="json", end_at="2027-01-01T00:00:00Z"))
        self.assertEqual(export_history(self.store, ExportSelection())["last_export"]["through_at"], fixed.isoformat())
        save_export(self.store, ExportRequest(format="json", start_at="2026-11-01T00:00:00Z", end_at="2026-11-02T00:00:00Z"))
        history = export_history(self.store, ExportSelection())["last_export"]
        self.assertEqual(history["start_at"], "2026-11-01T00:00:00+00:00")
        self.assertEqual(history["through_at"], "2026-11-02T00:00:00+00:00")

    def test_empty_exports_never_advance_history(self):
        with self.assertRaises(ExportError):
            save_export(self.store, ExportRequest(format="json", language="ja"))
        self.assertIsNone(export_history(self.store, ExportSelection(language="ja"))["last_export"])
