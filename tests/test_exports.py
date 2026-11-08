import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zipfile import ZipFile

from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader
from pydantic import ValidationError

from dashboard import Dashboard
from exports import ExportError, ExportRequest, build_export, save_export
from store import Patch, SettingsPatch, Store
from test_memory import APPROACH


class ExportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "memory.sqlite3"
        self.store = Store(self.path)

    def test_exports_contain_all_filtered_rows_beyond_first_page(self):
        for index in range(57):
            point = dict(APPROACH, title=f"expression {index}", language="en-us")
            self.store.save(f"export-row-{index}", [point])
        self.store.save("other-language", [dict(APPROACH, language="ja", title="大丈夫")])
        request = ExportRequest(format="json", language="en", include_variants=True)
        result = build_export(self.store, request)
        self.assertEqual(result.count, 57)
        records = json.loads(result.data)["records"]
        self.assertEqual(len({record["id"] for record in records}), 57)
        self.assertTrue(all(record["language"] == "en-us" for record in records))
        path = save_export(self.store, request)["path"]
        self.assertEqual(Path(path).parent, (self.path.parent / "exports").resolve())
        self.assertEqual(json.loads(Path(path).read_bytes())["records"], records)

    def test_office_and_notion_preserve_unicode_and_literal_formulas(self):
        points = [dict(APPROACH, title="=1+1", explanation="Literal <b>text</b> & punctuation."),
                  dict(APPROACH, language="ja", title="ありがとうございます"),
                  dict(APPROACH, language="ko", title="괜찮아요")]
        self.store.save("multilingual-export", points)
        book = load_workbook(io.BytesIO(build_export(self.store, ExportRequest(format="xlsx")).data))
        sheet = book.active
        self.assertEqual(sheet.max_row, 4)
        self.assertEqual(sheet.freeze_panes, "A2")
        titles = [sheet.cell(index, 1).value for index in range(2, 5)]
        self.assertEqual(set(titles), {point["title"] for point in points})
        formula = next(sheet.cell(index, 1) for index in range(2, 5) if sheet.cell(index, 1).value == "=1+1")
        self.assertEqual(formula.data_type, "s")
        document = Document(io.BytesIO(build_export(self.store, ExportRequest(format="docx")).data))
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        for point in points:
            self.assertIn(point["title"], text)
            self.assertIn(point["explanation"], text)
        with ZipFile(io.BytesIO(build_export(self.store, ExportRequest(format="notion")).data)) as archive:
            names = archive.namelist()
            self.assertEqual(len([name for name in names if name.endswith(".md")]), 3)
            rows = list(csv.reader(io.StringIO(archive.read("knowledge.csv").decode("utf-8-sig"))))
            self.assertEqual(len(rows), 4)
            self.assertIn("'=1+1", {row[0] for row in rows[1:]})
            self.assertIn("&lt;b&gt;text&lt;/b&gt; &amp;", archive.read("pages/point-1.md").decode())

    def test_pdf_is_readable_and_missing_fonts_fail_explicitly(self):
        self.store.save("pdf-english", [dict(APPROACH, examples=[{"text": "Try another approach."}, {"text": "This approach saves time."}])])
        result = build_export(self.store, ExportRequest(format="pdf"))
        reader = PdfReader(io.BytesIO(result.data))
        self.assertTrue(reader.pages)
        text = "\n".join(page.extract_text() for page in reader.pages)
        self.assertIn(APPROACH["meaning"], text)
        self.assertIn("Try another approach.", text)
        with patch("exports.Path.is_file", return_value=False):
            with self.assertRaisesRegex(ExportError, "pdfFontMissing"):
                build_export(self.store, ExportRequest(format="pdf"))

    def test_download_endpoint_is_filtered_and_protected(self):
        self.store.save("http-export", [APPROACH, dict(APPROACH, language="fr")])
        page = Dashboard(self.store)
        self.addCleanup(page.close)
        url = page.start()
        def download(arguments, **headers):
            return urlopen(Request(url + "export", data=json.dumps(arguments).encode(), headers={
                "Content-Type": "application/json", "X-Language-Memory": "1", **headers,
            }))
        with download({"format": "json", "language": "en"}) as response:
            self.assertEqual(response.headers["X-Record-Count"], "1")
            self.assertIn("attachment; filename=", response.headers["Content-Disposition"])
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(json.load(response)["records"][0]["language"], "en")
        with self.assertRaises(HTTPError) as error:
            download({"format": "json"}, Origin="https://unrelated.example")
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            download({"format": "json", "language": "ko"})
        self.assertEqual(json.load(error.exception)["error"], "exportEmpty")
        with self.assertRaises(HTTPError):
            download({"format": "exe"})


class LiveRecordTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "live.sqlite3"
        self.store = Store(self.path)

    def test_new_saves_require_generated_explanations_and_examples(self):
        for key in ["explanation", "examples"]:
            point = {name: value for name, value in APPROACH.items() if name != key}
            result = self.store.save(f"missing-{key}", [point])
            self.assertEqual(result["results"][0]["status"], "failed")
        self.assertEqual(self.store.query()["records"], [])
        result = self.store.save("complete-point", [APPROACH])
        self.assertEqual(result["results"][0]["status"], "added")
        self.assertTrue(self.store.query()["records"][0]["content_ready"])

    def test_legacy_enrichment_preserves_identity_and_encounter_count(self):
        record_id = self.store.save("legacy-point", [APPROACH])["results"][0]["id"]
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET explanation = NULL, examples = NULL WHERE id = ?", (record_id,))
        self.assertEqual(self.store.query(needs_enrichment=True)["records"][0]["id"], record_id)
        self.store.update(record_id, Patch(explanation=APPROACH["explanation"], examples=APPROACH["examples"]))
        self.assertEqual(self.store.query(needs_enrichment=True)["records"], [])
        self.assertEqual(self.store.query()["records"][0]["encounter_count"], 1)
        with self.store.connection(write=True) as db:
            db.execute("UPDATE knowledge SET explanation = NULL WHERE id = ?", (record_id,))
        self.store.save("new-real-encounter", [APPROACH])
        result = self.store.query()["records"][0]
        self.assertEqual(result["encounter_count"], 2)
        self.assertTrue(result["content_ready"])

    def test_versions_detect_writes_from_other_connections_and_ignore_replays(self):
        initial = self.store.versions()
        other = Store(self.path)
        row = other.save("external-record", [APPROACH])["results"][0]
        added = self.store.versions()
        self.assertGreater(added["content"], initial["content"])
        other.save("external-record", [APPROACH])
        self.assertEqual(self.store.versions(), added)
        other.update(row["id"], Patch(status="new"))
        self.assertGreater(self.store.versions()["content"], added["content"])
        other.settings(SettingsPatch(ui_language="fr"))
        self.assertGreater(self.store.versions()["preferences"], initial["preferences"])
        before_delete = self.store.versions()
        other.delete(row["id"])
        self.assertGreater(self.store.versions()["content"], before_delete["content"])

    def test_cursor_pages_do_not_duplicate_after_a_new_record_arrives(self):
        for index in range(65):
            self.store.save(f"scroll-item-{index}", [dict(APPROACH, title=f"entry {index}")])
        first = self.store.query(limit=20)
        ids = [row["id"] for row in first["records"]]
        self.store.save("arrives-between-pages", [dict(APPROACH, title="brand new")])
        cursor = first["next_cursor"]
        while cursor:
            page = self.store.query(limit=20, cursor=cursor)
            ids.extend(row["id"] for row in page["records"])
            cursor = page["next_cursor"]
        self.assertEqual(len(ids), 65)
        self.assertEqual(len(set(ids)), 65)
        for invalid in ["bad", "W10=", "WzEsIDJd"]:
            with self.assertRaises(ValueError):
                self.store.query(cursor=invalid)

    def test_legacy_learning_status_migrates_to_to_learn(self):
        identifier = self.store.save("legacy-learning-state", [APPROACH])["results"][0]["id"]
        with self.store.connection(write=True) as db:
            db.execute("PRAGMA ignore_check_constraints = ON")
            db.execute("UPDATE knowledge SET status = 'learning' WHERE id = ?", (identifier,))
        reopened = Store(self.path)
        record = reopened.query()["records"][0]
        self.assertEqual(record["status"], "new")
        self.assertEqual(record["encounter_count"], 1)
        with self.assertRaises(ValidationError):
            Patch(status="learning")
        reopened.update(identifier, Patch(status="mastered"))
        self.assertEqual(reopened.review()["records"], [])
        reopened.update(identifier, Patch(status="new"))
        self.assertEqual(reopened.review()["records"][0]["id"], identifier)
