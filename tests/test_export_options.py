import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader
from pydantic import ValidationError

from dashboard import dispatch
from exports import ExportRequest, ExportSelection, build_export, preview_export
from store import Patch, Store
from test_memory import APPROACH


class ExportOptionsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "memory.sqlite3")
        point = dict(APPROACH, title="approach", meaning="DEFINITION_MARKER", explanation="EXPLANATION_MARKER",
                     context="CONTEXT_MARKER", corrected_sentence="CORRECTION_MARKER",
                     examples=[{"text": "EXAMPLE_ONE", "translation": "TRANSLATION_ONE"},
                               {"text": "EXAMPLE_TWO", "translation": "TRANSLATION_TWO"}])
        self.identifier = self.store.save("export-options-point", [point])["results"][0]["id"]

    def text(self, format, **options):
        result = build_export(self.store, ExportRequest(format=format, **options))
        if format == "json":
            return result.data.decode()
        if format == "xlsx":
            sheet = load_workbook(io.BytesIO(result.data)).active
            return "\n".join(str(cell.value) for row in sheet for cell in row)
        if format == "docx":
            return "\n".join(p.text for p in Document(io.BytesIO(result.data)).paragraphs)
        if format == "pdf":
            return "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(result.data)).pages)
        with ZipFile(io.BytesIO(result.data)) as archive:
            return "\n".join(archive.read(name).decode("utf-8-sig") for name in archive.namelist())

    def test_terms_only_has_no_hidden_answers_or_metadata_in_any_format(self):
        for format in ("json", "xlsx", "docx", "pdf", "notion"):
            with self.subTest(format=format):
                text = self.text(format, content="terms")
                self.assertIn("approach", text)
                for marker in ("DEFINITION", "EXPLANATION", "CONTEXT", "CORRECTION", "EXAMPLE", "TRANSLATION", "Encounters:", "Last seen"):
                    self.assertNotIn(marker, text)
        result = build_export(self.store, ExportRequest(format="json", content="terms"))
        self.assertEqual(json.loads(result.data)["records"], [{"title": "approach"}])
        book = load_workbook(io.BytesIO(build_export(self.store, ExportRequest(format="xlsx", content="terms")).data))
        self.assertEqual(book.active.max_column, 1)

    def test_selected_sections_and_translations_are_projected_before_rendering(self):
        for format in ("json", "xlsx", "docx", "pdf", "notion"):
            with self.subTest(format=format):
                text = self.text(format, content="sections", fields=["meaning", "examples"])
                for marker in ("DEFINITION", "EXAMPLE"):
                    self.assertIn(marker, text)
                for marker in ("EXPLANATION", "TRANSLATION", "CONTEXT", "CORRECTION"):
                    self.assertNotIn(marker, text)
                translated = self.text(format, content="sections", fields=["examples", "translations"])
                self.assertIn("TRANSLATION", translated)
                self.assertNotIn("DEFINITION", translated)

    def test_current_notes_and_explicit_captured_sections_are_distinct(self):
        self.store.update(self.identifier, Patch(note="My edited title\n\nOnly my current explanation."))
        notes = json.loads(self.text("json"))["records"][0]
        self.assertEqual(notes["title"], "My edited title")
        self.assertIn("Only my current explanation.", notes["note"])
        self.assertNotIn("meaning", notes)
        terms = json.loads(self.text("json", content="terms"))["records"][0]
        self.assertEqual(terms, {"title": "My edited title"})
        captured = json.loads(self.text("json", content="sections", fields=["meaning"]))["records"][0]
        self.assertEqual(captured, {"title": "approach", "meaning": "DEFINITION_MARKER"})
        self.assertEqual(preview_export(self.store, ExportSelection(content="sections", fields=["meaning"]))["custom_note_count"], 1)

    def test_metadata_is_optional_and_does_not_restore_excluded_content(self):
        row = json.loads(self.text("json", content="terms", include_metadata=True))["records"][0]
        self.assertEqual(row["id"], self.identifier)
        self.assertEqual(row["encounter_count"], 1)
        self.assertNotIn("note", row)
        self.assertNotIn("meaning", row)

    def test_date_range_uses_inclusive_start_exclusive_end_with_offsets(self):
        other = self.store.save("export-other-point", [dict(APPROACH, title="other")])["results"][0]["id"]
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET created_at = ?, last_seen_at = ? WHERE id = ?", (
                "2026-11-08T05:00:00.000000+00:00", "2026-11-10T04:59:59.000000+00:00", self.identifier))
            db.execute("UPDATE knowledge SET created_at = ?, last_seen_at = ? WHERE id = ?", (
                "2026-11-09T05:00:00.000000+00:00", "2026-11-08T05:00:00.000000+00:00", other))
        args = dict(start_at="2026-11-08T00:00:00-05:00", end_at="2026-11-09T00:00:00-05:00")
        for basis, expected in (("created_at", self.identifier), ("last_seen_at", other)):
            request = ExportRequest(format="json", date_field=basis, **args)
            rows = json.loads(build_export(self.store, request).data)["records"]
            self.assertEqual([row["id"] for row in rows], [expected])
        self.assertEqual(preview_export(self.store, ExportSelection(start_at=args["start_at"]))["count"], 2)

    def test_preview_and_export_share_filters_beyond_ui_pagination(self):
        for index in range(52):
            self.store.save(f"preview-extra-{index}", [dict(APPROACH, title=f"phrase {index}", kind="expression")])
        self.store.save("preview-grammar", [dict(APPROACH, kind="grammar")])
        args = dict(kinds=["word", "expression"], language="en", status="new")
        preview = dispatch(self.store, {"action": "exports/preview", "arguments": args})
        self.assertEqual(preview["count"], 53)
        self.assertEqual(len(preview["titles"]), 3)
        self.assertEqual(build_export(self.store, ExportRequest(format="json", **args)).count, 53)
        self.assertEqual(preview_export(self.store, ExportSelection(language="fr"))["count"], 0)

    def test_invalid_dates_and_contradictory_content_are_rejected(self):
        invalid = [
            dict(start_at="2026-11-08"), dict(start_at="2026-11-08T00:00:00"),
            dict(start_at="2026-11-09T00:00:00Z", end_at="2026-11-08T00:00:00Z"),
            dict(date_field="note"), dict(kind="word", kinds=["grammar"]),
            dict(kinds=[]), dict(content="sections"), dict(content="notes", fields=["meaning"]),
            dict(content="sections", fields=["translations"]), dict(content="sections", fields=["meaning", "meaning"]),
        ]
        for arguments in invalid:
            with self.subTest(arguments=arguments), self.assertRaises(ValidationError):
                ExportSelection(**arguments)


if __name__ == "__main__":
    unittest.main()
