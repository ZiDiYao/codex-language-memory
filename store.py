import base64
import hashlib
import json
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

from learning import ALGORITHM, advance, memory_snapshot, recall_rating

Kind = Literal["word", "expression", "grammar", "correction"]
Status = Literal["new", "mastered"]
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
    explanation: Text
    examples: Annotated[list[Example], Field(min_length=1, max_length=5)]


class Patch(Content):
    title: Title | None = None
    sense_key: SenseKey | None = None
    meaning: Text | None = None
    status: Status | None = None
    review_result: ReviewResult | None = None


class Review(StrictModel):
    result: ReviewResult
    assisted: bool = False
    effort: Literal["standard", "hard", "easy"] = "standard"
    prompt: Text | None = None
    answer: Text | None = None

    @model_validator(mode="after")
    def effort_requires_success(self):
        if self.effort != "standard" and (self.result != "correct" or self.assisted):
            raise ValueError("Recall effort applies only to an unassisted correct answer")
        return self


class LearnerPreferences(StrictModel):
    explanation_language: Language | None = None
    explanation_style: Literal["concise", "detailed"] | None = None
    learning_goal: Text | None = None
    interests: Annotated[list[Title], Field(max_length=8)] | None = None


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
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'mastered')),
    last_reviewed_at TEXT,
    last_review_result TEXT,
    UNIQUE (kind, language, title_key, sense_key)
);

CREATE TABLE IF NOT EXISTS save_requests (
    request_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    results TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encounters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    context TEXT,
    source TEXT NOT NULL,
    UNIQUE (request_id, record_id)
);
CREATE INDEX IF NOT EXISTS encounters_by_point ON encounters(record_id, id DESC);

CREATE TABLE IF NOT EXISTS memory_states (
    record_id INTEGER PRIMARY KEY REFERENCES knowledge(id) ON DELETE CASCADE,
    card TEXT NOT NULL,
    due_at TEXT NOT NULL,
    rated_reviews INTEGER NOT NULL,
    algorithm TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_due ON memory_states(due_at);

CREATE TABLE IF NOT EXISTS review_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL,
    result TEXT NOT NULL,
    assisted INTEGER NOT NULL,
    effort TEXT NOT NULL,
    prompt TEXT,
    answer TEXT,
    rating INTEGER,
    predicted_recall REAL,
    fsrs_log TEXT,
    algorithm TEXT
);
CREATE INDEX IF NOT EXISTS reviews_by_point ON review_events(record_id, id DESC);

CREATE TABLE IF NOT EXISTS review_requests (
    request_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learner_preferences (
    language TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- A pre-upgrade page may still hold a connection with foreign keys disabled.
CREATE TRIGGER IF NOT EXISTS learning_evidence_deleted AFTER DELETE ON knowledge
BEGIN
    DELETE FROM encounters WHERE record_id = OLD.id;
    DELETE FROM review_events WHERE record_id = OLD.id;
    DELETE FROM memory_states WHERE record_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS change_versions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content INTEGER NOT NULL DEFAULT 0,
    preferences INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO change_versions (id) VALUES (1);
CREATE TRIGGER IF NOT EXISTS knowledge_added AFTER INSERT ON knowledge
BEGIN UPDATE change_versions SET content = content + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS knowledge_updated AFTER UPDATE ON knowledge
BEGIN UPDATE change_versions SET content = content + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS knowledge_deleted AFTER DELETE ON knowledge
BEGIN UPDATE change_versions SET content = content + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS preferences_updated AFTER UPDATE ON capture_preferences
BEGIN UPDATE change_versions SET preferences = preferences + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS recording_updated AFTER UPDATE ON settings
BEGIN UPDATE change_versions SET preferences = preferences + 1 WHERE id = 1; END;

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
    result["content_ready"] = bool(result["explanation"] and result["examples"])
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
            db.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + "\nUPDATE knowledge SET status = 'new' WHERE status = 'learning';\nCOMMIT;")

    @contextmanager
    def connection(self, *, write=False):
        db = sqlite3.connect(self.path, timeout=10)
        db.execute("PRAGMA foreign_keys = ON")
        db.row_factory = sqlite3.Row
        db.create_function("normalize", 1, normalized, deterministic=True)
        try:
            with db:
                if write:
                    db.execute("BEGIN IMMEDIATE")
                yield db
        finally:
            db.close()

    def versions(self):
        with self.connection() as db:
            row = db.execute("SELECT content, preferences FROM change_versions WHERE id = 1").fetchone()
            return dict(row)

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
                           last_seen_at = ?, context = COALESCE(?, context),
                           explanation = COALESCE(NULLIF(explanation, ''), ?),
                           examples = CASE WHEN examples IS NULL OR examples = '[]' THEN ? ELSE examples END,
                           corrected_sentence = COALESCE(corrected_sentence, ?) WHERE id = ?""",
                        (timestamp, point.context, point.explanation, data["examples"], point.corrected_sentence, existing["id"]),
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
                db.execute(
                    "INSERT INTO encounters (record_id, request_id, occurred_at, context, source) VALUES (?, ?, ?, ?, ?)",
                    (result["id"], request_id, timestamp, point.context, source),
                )
                results.append({"index": index, **result})
            db.execute(
                "INSERT INTO save_requests VALUES (?, ?, ?)",
                (request_id, fingerprint, encode(results)),
            )
            return {"status": "processed", "replayed": False, "results": results}

    def _filters(self, *, keyword=None, kind=None, language=None, status=None,
                 include_variants=False, needs_enrichment=False):
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
        if needs_enrichment:
            filters.append("(explanation IS NULL OR trim(explanation) = '' OR examples IS NULL OR examples = '[]')")
        return filters, params

    def query(self, *, keyword=None, kind=None, language=None, status=None, limit=10, offset=0,
              include_variants=False, cursor=None, needs_enrichment=False):
        filters, params = self._filters(keyword=keyword, kind=kind, language=language,
                                        status=status, include_variants=include_variants,
                                        needs_enrichment=needs_enrichment)
        if cursor is not None:
            try:
                stamp, identifier = json.loads(base64.urlsafe_b64decode(cursor).decode())
                datetime.fromisoformat(stamp)
                if type(identifier) is not int or identifier < 1 or offset:
                    raise ValueError()
            except (ValueError, TypeError, UnicodeError):
                raise ValueError("Invalid query cursor") from None
            filters.append("(last_seen_at < ? OR (last_seen_at = ? AND id < ?))")
            params.extend((stamp, stamp, identifier))
        where = " AND ".join(filters) or "1"
        with self.connection() as db:
            rows = db.execute(
                f"""SELECT * FROM knowledge WHERE {where}
                    ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?""",
                (*params, limit + 1, offset),
            )
            records = [record(row) for row in rows]
        more = len(records) > limit
        records = records[:limit]
        next_cursor = None
        if more:
            last = records[-1]
            next_cursor = base64.urlsafe_b64encode(encode([last["last_seen_at"], last["id"]]).encode()).decode()
        return {"records": records, "has_more": more, "next_cursor": next_cursor}

    def export_records(self, **filters):
        clauses, params = self._filters(**filters)
        where = " AND ".join(clauses) or "1"
        # Read the full filtered result from one SQLite snapshot, independent of UI pagination.
        with self.connection() as db:
            return [record(row) for row in db.execute(
                f"SELECT * FROM knowledge WHERE {where} ORDER BY last_seen_at DESC, id DESC", params,
            )]

    def review(self, *, language=None, kind=None, limit=5, include_variants=False, include_upcoming=False):
        timestamp = now()
        clauses, params = self._filters(language=language, kind=kind, status="new", include_variants=include_variants)
        where = " AND ".join(clauses)
        with self.connection() as db:
            rows = db.execute(
                f"""SELECT knowledge.*, card, due_at, rated_reviews FROM knowledge
                    LEFT JOIN memory_states ON record_id = knowledge.id
                    WHERE {where} AND (? OR due_at IS NULL OR due_at <= ?)
                    ORDER BY CASE WHEN due_at <= ? THEN 0 WHEN due_at IS NULL THEN 1 ELSE 2 END,
                             due_at ASC, created_at ASC, id ASC LIMIT ?""",
                (*params, include_upcoming, timestamp, timestamp, limit),
            )
            records = []
            for row in rows:
                item = record(row)
                card = item.pop("card")
                due = item.pop("due_at")
                item["memory"] = memory_snapshot(card, timestamp, item.pop("rated_reviews") or 0)
                item["review_reason"] = "unassessed" if due is None else "due" if due <= timestamp else "upcoming"
                records.append(item)
            next_due = db.execute(
                f"""SELECT MIN(due_at) FROM knowledge JOIN memory_states ON record_id = knowledge.id
                    WHERE {where} AND due_at > ?""", (*params, timestamp),
            ).fetchone()[0]
            return {"records": records, "next_due_at": next_due, "algorithm": ALGORITHM}

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
            return {"status": "failed", "error": "use_record_review_with_request_id"}
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

    def record_review(self, record_id: int, request_id: str, review: Review) -> dict:
        fingerprint = hashlib.sha256(encode([record_id, review.model_dump()]).encode()).hexdigest()
        with self.connection(write=True) as db:
            previous = db.execute("SELECT * FROM review_requests WHERE request_id = ?", (request_id,)).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    return {"status": "failed", "error": "request_id_conflict"}
                result = json.loads(previous["result"])
                if not db.execute("SELECT 1 FROM knowledge WHERE id = ?", (record_id,)).fetchone():
                    result["deleted"] = True
                return {**result, "replayed": True}
            if not db.execute("SELECT 1 FROM knowledge WHERE id = ?", (record_id,)).fetchone():
                return {"status": "not_found"}
            timestamp = now()
            state = db.execute("SELECT * FROM memory_states WHERE record_id = ?", (record_id,)).fetchone()
            serialized = state["card"] if state else None
            rated_reviews = state["rated_reviews"] if state else 0
            rating = recall_rating(review.result, review.assisted, review.effort)
            log = prediction = None
            if rating is not None:
                try:
                    card, log, prediction = advance(record_id, serialized, rating, timestamp)
                except ValueError as error:
                    return {"status": "failed", "error": str(error)}
                serialized = card.to_json()
                rated_reviews += 1
                db.execute(
                    """INSERT INTO memory_states VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(record_id) DO UPDATE SET card = excluded.card, due_at = excluded.due_at,
                       rated_reviews = excluded.rated_reviews, algorithm = excluded.algorithm""",
                    (record_id, serialized, card.due.isoformat(timespec="microseconds"), rated_reviews, encode(ALGORITHM)),
                )
            event = db.execute(
                """INSERT INTO review_events (record_id, occurred_at, result, assisted, effort,
                   prompt, answer, rating, predicted_recall, fsrs_log, algorithm)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (record_id, timestamp, review.result, review.assisted, review.effort, review.prompt,
                 review.answer, int(rating) if rating else None, prediction,
                 log.to_json() if log else None, encode(ALGORITHM) if log else None),
            )
            db.execute("UPDATE knowledge SET last_reviewed_at = ?, last_review_result = ? WHERE id = ?",
                       (timestamp, review.result, record_id))
            result = {"status": "reviewed", "record_id": record_id, "event_id": event.lastrowid,
                      "scheduled": rating is not None, "rating": int(rating) if rating else None,
                      "memory": memory_snapshot(serialized, timestamp, rated_reviews)}
            db.execute("INSERT INTO review_requests VALUES (?, ?, ?)", (request_id, fingerprint, encode(result)))
            return {**result, "replayed": False}

    def history(self, record_id: int, *, limit=20, before_encounter_id=None, before_review_id=None):
        with self.connection() as db:
            db.execute("BEGIN")
            point = db.execute("SELECT * FROM knowledge WHERE id = ?", (record_id,)).fetchone()
            if not point:
                return {"status": "not_found"}
            encounters = [dict(row) for row in db.execute(
                """SELECT id, occurred_at, context, source FROM encounters WHERE record_id = ?
                   AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?""",
                (record_id, before_encounter_id, before_encounter_id, limit + 1),
            )]
            reviews = [dict(row) for row in db.execute(
                """SELECT id, occurred_at, result, assisted, effort, prompt, answer, rating,
                   predicted_recall FROM review_events WHERE record_id = ?
                   AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?""",
                (record_id, before_review_id, before_review_id, limit + 1),
            )]
            captured = db.execute("SELECT COUNT(*) FROM encounters WHERE record_id = ?", (record_id,)).fetchone()[0]
            state = db.execute("SELECT * FROM memory_states WHERE record_id = ?", (record_id,)).fetchone()
            return {
                "status": "found", "record": record(point),
                "encounters": encounters[:limit], "reviews": reviews[:limit],
                "next_encounter_before_id": encounters[limit - 1]["id"] if len(encounters) > limit else None,
                "next_review_before_id": reviews[limit - 1]["id"] if len(reviews) > limit else None,
                "encounters_without_history": max(0, point["encounter_count"] - captured),
                "memory": memory_snapshot(state["card"] if state else None, now(), state["rated_reviews"] if state else 0),
                "algorithm": ALGORITHM,
            }

    def learning_preferences(self, language=None, patch: LearnerPreferences | None = None):
        scope = language or "*"
        with self.connection(write=patch is not None) as db:
            row = db.execute("SELECT data, updated_at FROM learner_preferences WHERE language = ?", (scope,)).fetchone()
            current = json.loads(row["data"]) if row else {}
            timestamp = row["updated_at"] if row else None
            if patch is not None:
                current.update(patch.model_dump(exclude_unset=True))
                current = {key: value for key, value in current.items() if value is not None}
                timestamp = now()
                db.execute("INSERT INTO learner_preferences VALUES (?, ?, ?) ON CONFLICT(language) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                           (scope, encode(current), timestamp))
            return {"scope": scope, "preferences": current, "source": "user_stated", "updated_at": timestamp}

    def learning_profile(self, *, language=None, include_variants=False):
        clauses, params = self._filters(language=language, include_variants=include_variants)
        where = " AND ".join(clauses) or "1"
        with self.connection() as db:
            # Use one snapshot for all evidence counts. Summaries never invent a proficiency level.
            db.execute("BEGIN")
            groups = [dict(row) for row in db.execute(
                f"""SELECT language, kind, COUNT(*) AS points, SUM(encounter_count) AS encounters,
                    SUM(status = 'mastered') AS user_marked_mastered FROM knowledge
                    WHERE {where} GROUP BY language, kind ORDER BY language, kind""", params,
            )]
            outcomes = [dict(row) for row in db.execute(
                f"""SELECT language, kind, result, assisted, COUNT(*) AS attempts FROM review_events
                    JOIN knowledge ON knowledge.id = record_id WHERE {where}
                    GROUP BY language, kind, result, assisted ORDER BY language, kind, result, assisted""", params,
            )]
            recurring = [dict(row) for row in db.execute(
                f"""SELECT knowledge.id, title, language, kind, encounter_count, status,
                    (SELECT COUNT(*) FROM review_events e WHERE e.record_id = knowledge.id
                     AND e.rating = 1) AS unsuccessful_recalls FROM knowledge
                    WHERE {where} AND status = 'new' AND (encounter_count > 1 OR EXISTS
                        (SELECT 1 FROM review_events e WHERE e.record_id = knowledge.id AND e.rating = 1))
                    ORDER BY unsuccessful_recalls DESC, encounter_count DESC, last_seen_at DESC LIMIT 10""", params,
            )]
            evaluation = dict(db.execute(
                f"""SELECT COUNT(*) AS predictions, AVG((predicted_recall - (result = 'correct')) *
                    (predicted_recall - (result = 'correct'))) AS brier_score
                    FROM review_events JOIN knowledge ON knowledge.id = record_id
                    WHERE {where} AND rating IS NOT NULL AND predicted_recall IS NOT NULL""", params,
            ).fetchone())
            preferences = [dict(row) for row in db.execute(
                "SELECT language, data, updated_at FROM learner_preferences WHERE ? IS NULL OR language = ? OR language = '*' ORDER BY language",
                (language, language),
            )]
            for item in preferences:
                item["preferences"] = json.loads(item.pop("data"))
                item["source"] = "user_stated"
            rated = db.execute(
                f"""SELECT COUNT(*) FROM review_events JOIN knowledge ON knowledge.id = record_id
                    WHERE {where} AND rating IS NOT NULL""", params,
            ).fetchone()[0]
            return {
                "scope": "Observed learning interactions only; not an overall proficiency assessment",
                "language": language, "groups": groups, "review_outcomes": outcomes,
                "recurring_points": recurring, "preferences": preferences,
                "rated_reviews": rated, "evidence_status": "observed_practice" if rated else "not_assessed",
                "prediction_evaluation": evaluation, "algorithm": ALGORITHM,
            }

    def delete(self, record_id: int) -> dict:
        with self.connection(write=True) as db:
            result = db.execute("DELETE FROM knowledge WHERE id = ?", (record_id,))
            return {"status": "deleted" if result.rowcount else "not_found", "id": record_id}
