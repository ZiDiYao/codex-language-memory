import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile

from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader
from pydantic import ValidationError

from dashboard import Dashboard, dispatch
from exports import ExportRequest, build_export
from store import Patch, Store
from test_memory import APPROACH


class NoteTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "notes.sqlite3"
        self.store = Store(self.path)
        self.identifier = self.store.save("note-original", [APPROACH])["results"][0]["id"]

    def point(self):
        return self.store.get_point(self.identifier)["record"]

    def test_legacy_upgrade_preserves_every_source_field(self):
        before = self.point()
        with sqlite3.connect(self.path) as db:
            db.execute("ALTER TABLE knowledge DROP COLUMN note")
        self.store = Store(self.path)
        self.assertEqual(self.point(), before)
        for key in ("title", "meaning", "explanation", "context"):
            if before.get(key):
                self.assertIn(before[key], before["note"])
        for example in before["examples"]:
            self.assertIn(example["text"], before["note"])
            if example.get("translation"):
                self.assertIn(example["translation"], before["note"])
        self.assertFalse(before["note_is_custom"])

    def test_note_edit_is_verbatim_persistent_searchable_and_conflict_protected(self):
        before = self.point()
        note = "  My own title\n\n  Personal mnemonic: café, 日本語\n\n  "
        result = dispatch(self.store, {"action": "points/update", "arguments": {
            "record_id": self.identifier, "patch": {"note": note}, "expected_revision": before["revision"],
        }})
        self.assertEqual(result["status"], "updated")
        self.store = Store(self.path)
        after = self.point()
        self.assertEqual(after["note"], note)
        self.assertEqual(after["note_title"], "My own title")
        self.assertTrue(after["note_is_custom"])
        for key in ("title", "sense_key", "encounter_count", "last_seen_at", "last_reviewed_at", "status"):
            self.assertEqual(after[key], before[key])
        self.assertEqual(self.store.query(keyword="mnemonic")["records"], [after])
        self.assertEqual(self.store.review()["records"][0]["note"], note)
        self.assertEqual(self.store.update(self.identifier, Patch(note="Stale"), before["revision"])["error"], "edit_conflict")
        self.assertEqual(self.point()["note"], note)
        self.store.delete(self.identifier)
        self.assertEqual(self.store.query(keyword="mnemonic")["records"], [])

    def test_empty_and_custom_notes_survive_repeat_capture_and_retries(self):
        for note in ("Custom lesson", ""):
            self.store.update(self.identifier, Patch(note=note))
            self.assertEqual(self.point()["note"], note)
            request_id = "repeat-" + ("custom" if note else "empty")
            result = self.store.save(request_id, [APPROACH])
            self.assertEqual(result["results"][0]["status"], "merged")
            count = self.point()["encounter_count"]
            self.assertTrue(self.store.save(request_id, [APPROACH])["replayed"])
            self.assertEqual(self.point()["encounter_count"], count)
            self.assertEqual(self.point()["note"], note)
            self.store.update(self.identifier, Patch(explanation=None, examples=[]))
            self.assertTrue(self.point()["content_ready"])
            self.assertEqual(self.store.query(needs_enrichment=True)["records"], [])
        self.assertEqual(self.point()["note_title"], "")
        self.store.update(self.identifier, Patch(note=None))
        self.assertFalse(self.point()["note_is_custom"])
        self.assertIn(APPROACH["meaning"], self.point()["note"])
        with self.assertRaises(ValidationError):
            Patch(note="a" * 30001)

    def test_all_exports_use_current_note_not_superseded_explanations(self):
        note = "My note\n\nA personal mnemonic.\nAnother line."
        self.store.update(self.identifier, Patch(note=note))
        def export(format):
            return build_export(self.store, ExportRequest(format=format)).data
        rows = json.loads(export("json"))["records"]
        self.assertEqual(rows[0]["note"], note)
        sheet = load_workbook(io.BytesIO(export("xlsx"))).active
        self.assertEqual(sheet.cell(2, 1).value, "My note")
        self.assertEqual(sheet.cell(2, 4).value, note)
        doc = Document(io.BytesIO(export("docx")))
        word_text = "\n".join(p.text for p in doc.paragraphs)
        pdf_text = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(export("pdf"))).pages)
        with ZipFile(io.BytesIO(export("notion"))) as archive:
            notion_text = archive.read(f"pages/point-{self.identifier}.md").decode()
        for text in (word_text, pdf_text, notion_text):
            self.assertIn("personal mnemonic", text)
            self.assertNotIn(APPROACH["meaning"], text)
            self.assertNotIn(APPROACH["explanation"], text)

    def test_note_payload_is_not_executed_as_spreadsheet_formula(self):
        self.store.update(self.identifier, Patch(note="=1+1\n<script>alert('x')</script>"))
        sheet = load_workbook(io.BytesIO(build_export(self.store, ExportRequest(format="xlsx")).data)).active
        for column in (1, 4):
            self.assertEqual(sheet.cell(2, column).data_type, "s")

    def test_http_accepts_full_length_unicode_notes(self):
        page = Dashboard(self.store)
        self.addCleanup(page.close)
        url = page.start()
        note = "\U0001f30d" * 30000
        body = json.dumps({"action": "points/update", "arguments": {
            "record_id": self.identifier, "patch": {"note": note},
        }}).encode()
        with urlopen(Request(url + "api", data=body, headers={
            "Content-Type": "application/json", "X-Language-Memory": "1",
        })) as response:
            self.assertEqual(json.load(response)["record"]["note"], note)
