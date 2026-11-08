import hashlib
import json
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

Kind = Literal["word", "expression", "grammar", "correction"]
Status = Literal["new", "learning", "mastered"]
ReviewResult = Literal["correct", "partial", "incorrect", "skipped"]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=350)]
SenseKey = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=150)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
Language = Annotated[str, StringConstraints(
    strip_whitespace=True, to_lower=True, pattern=r"^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$",
    max_length=35,
)]
RequestId = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_-]{8,100}$")]
Limit = Annotated[int, Field(ge=1, le=50)]
RecordId = Annotated[int, Field(gt=0)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Example(StrictModel):
    text: Text
    translation: Text | None = None


class Content(StrictModel):
    meaning: Text | None = None
    context: Text | None = None
    corrected_sentence: Text | None = None
    explanation: Text | None = None
    examples: Annotated[list[Example], Field(max_length=5)] | None = None


class KnowledgePoint(Content):
    kind: Kind
    language: Language
    title: Title
    sense_key: SenseKey
    meaning: Text


class Patch(Content):
    title: Title | None = None
    sense_key: SenseKey | None = None
    meaning: Text | None = None
    status: Status | None = None
    review_result: ReviewResult | None = None


CaptureMode = Literal["automatic", "explicit"]
CaptureTypes = Annotated[list[Kind], Field(max_length=4)]
UILanguage = Literal["en", "zh", "ja", "ko", "fr", "es"]


class LearningSettings(StrictModel):
    enabled: bool = True
    ui_language: UILanguage = "en"
    enabled_types: CaptureTypes = ["word", "expression", "grammar", "correction"]

    @model_validator(mode="before")
    @classmethod
    def discard_retired_preferences(cls, values):
        values = dict(values)
        for key in ("capture_mode", "target_language", "target_languages"):
            values.pop(key, None)
        return values


class SettingsPatch(StrictModel):
    enabled: bool | None = None
    ui_language: UILanguage | None = None
    enabled_types: CaptureTypes | None = None


SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    recording INTEGER NOT NULL CHECK (recording IN (0, 1))
);
INSERT OR IGNORE INTO settings VALUES (1, 1);

CREATE TABLE IF NOT EXISTS capture_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
);
INSERT OR IGNORE INTO capture_preferences VALUES (1, '{}');

CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    language TEXT NOT NULL,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    sense_key TEXT NOT NULL,
    meaning TEXT NOT NULL,
    context TEXT,
    corrected_sentence TEXT,
    explanation TEXT,
    examples TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    encounter_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'learning', 'mastered')),
    last_reviewed_at TEXT,
    last_review_result TEXT,
    UNIQUE (kind, language, title_key, sense_key)
);

CREATE TABLE IF NOT EXISTS save_requests (
    request_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    results TEXT NOT NULL
);
"""


def normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def record(row: sqlite3.Row) -> dict:
    result = dict(row)
    result.pop("title_key")
    result["examples"] = json.loads(result["examples"]) if result["examples"] else []
    return result


def content_fields(value: dict) -> dict:
    if "title" in value:
        value["title_key"] = normalized(value["title"])
    if "sense_key" in value:
        value["sense_key"] = normalized(value["sense_key"])
    if value.get("examples") is not None:
        value["examples"] = encode(value["examples"])
    return value


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path.touch(mode=0o600, exist_ok=True)
        with self.connection() as db:
            db.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + "\nCOMMIT;")

    @contextmanager
    def connection(self, *, write=False):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.create_function("normalize", 1, normalized, deterministic=True)
        try:
            with db:
                if write:
                    db.execute("BEGIN IMMEDIATE")
                yield db
        finally:
            db.close()

    def recording(self, enabled: bool | None = None) -> dict:
        with self.connection(write=enabled is not None) as db:
            if enabled is not None:
                db.execute("UPDATE settings SET recording = ? WHERE id = 1", (enabled,))
            return {"enabled": bool(db.execute("SELECT recording FROM settings").fetchone()[0])}

    def _settings(self, db) -> dict:
        preferences = json.loads(db.execute("SELECT data FROM capture_preferences").fetchone()[0])
        preferences["enabled"] = bool(db.execute("SELECT recording FROM settings").fetchone()[0])
        return LearningSettings.model_validate(preferences).model_dump()

    def settings(self, patch: SettingsPatch | None = None) -> dict:
        with self.connection(write=patch is not None) as db:
            current = self._settings(db)
            if patch is not None:
                changes = patch.model_dump(exclude_unset=True)
                current.update(changes)
                current = LearningSettings.model_validate(current).model_dump()
                db.execute("UPDATE settings SET recording = ? WHERE id = 1", (current["enabled"],))
                preferences = {key: value for key, value in current.items() if key != "enabled"}
                db.execute("UPDATE capture_preferences SET data = ? WHERE id = 1", (encode(preferences),))
            return current

    def save(self, request_id: str, items: list, source: CaptureMode = "automatic") -> dict:
        # Preserve fingerprints for automatic requests made by the original version.
        payload = items if source == "automatic" else {"source": source, "items": items}
        fingerprint = hashlib.sha256(encode(payload).encode("utf-8")).hexdigest()
        with self.connection(write=True) as db:
            receipt = db.execute(
                "SELECT fingerprint, results FROM save_requests WHERE request_id = ?", (request_id,)
            ).fetchone()
            if receipt:
                if receipt["fingerprint"] != fingerprint:
                    return {"status": "failed", "error": "request_id_conflict"}
                results = json.loads(receipt["results"])
                for result in results:
                    if "id" in result and not db.execute(
                        "SELECT 1 FROM knowledge WHERE id = ?", (result["id"],)
                    ).fetchone():
                        result["deleted"] = True
                return {"status": "processed", "replayed": True, "results": results}
            settings = self._settings(db)
            if not settings["enabled"]:
                return {"status": "paused", "results": []}

            timestamp = now()
            seen = set()
            results = []
            for index, item in enumerate(items):
                try:
                    point = KnowledgePoint.model_validate(item)
                except ValidationError as exc:
                    errors = [
                        {"field": ".".join(map(str, err["loc"])), "message": err["msg"]}
                        for err in exc.errors()
                    ]
                    results.append({"index": index, "status": "failed", "errors": errors})
                    continue
                if point.kind not in settings["enabled_types"]:
                    results.append({"index": index, "status": "skipped", "reason": "type_disabled"})
                    continue
                data = content_fields(point.model_dump(exclude_none=True))
                key = tuple(data[field] for field in ("kind", "language", "title_key", "sense_key"))
                if key in seen:
                    results.append({"index": index, "status": "failed", "error": "duplicate_in_batch"})
                    continue
                seen.add(key)
                existing = db.execute(
                    """SELECT id, encounter_count FROM knowledge
                       WHERE kind = ? AND language = ? AND title_key = ? AND sense_key = ?""",
                    key,
                ).fetchone()
                if existing:
                    # Keep curated content. Refresh the latest supplied learning context.
                    db.execute(
                        """UPDATE knowledge SET encounter_count = encounter_count + 1,
                           last_seen_at = ?, context = COALESCE(?, context) WHERE id = ?""",
                        (timestamp, point.context, existing["id"]),
                    )
                    result = {"status": "merged", "id": existing["id"],
                              "encounter_count": existing["encounter_count"] + 1}
                else:
                    data.update(created_at=timestamp, last_seen_at=timestamp)
                    columns = ", ".join(data)
                    placeholders = ", ".join("?" for _ in data)
                    cursor = db.execute(
                        f"INSERT INTO knowledge ({columns}) VALUES ({placeholders})",
                        tuple(data.values()),
                    )
                    result = {"status": "added", "id": cursor.lastrowid, "encounter_count": 1}
                results.append({"index": index, **result})
            db.execute(
                "INSERT INTO save_requests VALUES (?, ?, ?)",
                (request_id, fingerprint, encode(results)),
            )
            return {"status": "processed", "replayed": False, "results": results}

    def query(self, *, keyword=None, kind=None, language=None, status=None, limit=10, offset=0,
              include_variants=False):
        filters = []
        params = []
        for column, value in (("kind", kind), ("status", status)):
            if value is not None:
                filters.append(f"{column} = ?")
                params.append(value)
        if language is not None:
            filters.append("(language = ? OR (? AND language LIKE ?))")
            params.extend((language, include_variants, language + "-%"))
        if keyword is not None:
            columns = ("title", "sense_key", "meaning", "context", "corrected_sentence", "explanation")
            clauses = [f"instr(normalize(coalesce({column}, '')), ?) > 0" for column in columns]
            filters.append("(" + " OR ".join(clauses) + ")")
            params.extend([normalized(keyword)] * len(columns))
        where = " AND ".join(filters) or "1"
        with self.connection() as db:
            rows = db.execute(
                f"""SELECT * FROM knowledge WHERE {where}
                    ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?""",
                (*params, limit + 1, offset),
            )
            records = [record(row) for row in rows]
            return {"records": records[:limit], "has_more": len(records) > limit}

    def review(self, *, language=None, kind=None, limit=5, include_variants=False):
        with self.connection() as db:
            rows = db.execute(
                """SELECT * FROM knowledge WHERE status != 'mastered'
                   AND (? IS NULL OR language = ? OR (? AND language LIKE ?))
                   AND (? IS NULL OR kind = ?)
                   ORDER BY last_reviewed_at ASC, last_seen_at ASC, id ASC LIMIT ?""",
                (language, language, include_variants, (language or "") + "-%", kind, kind, limit),
            )
            return {"records": [record(row) for row in rows]}

    def languages(self) -> dict:
        with self.connection() as db:
            codes = {"en", "zh", "ja", "ko", "fr", "de", "es", "it", "pt", "ru"}
            counts = {}
            for row in db.execute("SELECT language, COUNT(*) AS total FROM knowledge GROUP BY language"):
                codes.add(row["language"])
                base = row["language"].split("-")[0]
                counts[base] = counts.get(base, 0) + row["total"]
            codes.update(counts)
            return {"languages": sorted(codes), "counts": counts}

    def update(self, record_id: int, patch: Patch) -> dict:
        changes = patch.model_dump(exclude_unset=True)
        if not changes:
            return {"status": "failed", "error": "empty_patch"}
        for required in ("title", "sense_key", "meaning", "status", "review_result"):
            if required in changes and changes[required] is None:
                return {"status": "failed", "error": f"{required}_cannot_be_null"}
        if "review_result" in changes:
            changes["last_review_result"] = changes.pop("review_result")
            changes["last_reviewed_at"] = now()
        data = content_fields(changes)
        assignments = ", ".join(f"{column} = ?" for column in data)
        with self.connection(write=True) as db:
            try:
                cursor = db.execute(
                    f"UPDATE knowledge SET {assignments} WHERE id = ?",
                    (*data.values(), record_id),
                )
            except sqlite3.IntegrityError:
                return {"status": "failed", "error": "identity_conflict"}
            if not cursor.rowcount:
                return {"status": "not_found"}
            row = db.execute("SELECT * FROM knowledge WHERE id = ?", (record_id,)).fetchone()
            return {"status": "updated", "record": record(row)}

    def delete(self, record_id: int) -> dict:
        with self.connection(write=True) as db:
            result = db.execute("DELETE FROM knowledge WHERE id = ?", (record_id,))
            return {"status": "deleted" if result.rowcount else "not_found", "id": record_id}
