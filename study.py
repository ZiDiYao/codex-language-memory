"""Small, persistent study rounds. Content and assessment remain Codex's responsibility."""

import hashlib
import json


STUDY_SCHEMA = """
CREATE TABLE IF NOT EXISTS study_sessions (
    id TEXT PRIMARY KEY,
    options TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS study_items (
    session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    record_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    prompt TEXT,
    source_revision TEXT,
    assisted INTEGER NOT NULL DEFAULT 0,
    review_event_id INTEGER REFERENCES review_events(id) ON DELETE SET NULL,
    PRIMARY KEY(session_id, ordinal)
);
CREATE TABLE IF NOT EXISTS study_answers (
    request_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
    applied_version INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS study_evidence_deleted AFTER DELETE ON knowledge
BEGIN DELETE FROM study_items WHERE record_id = OLD.id; END;
"""


class StudySessions:
    def __init__(self, store):
        self.store = store

    def _view(self, db, session_id):
        from store import now, record, normalized
        row = db.execute("SELECT * FROM study_sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return {"status": "not_found"}
        session = dict(row)
        session["options"] = json.loads(session["options"])
        items = db.execute("SELECT * FROM study_items WHERE session_id = ? ORDER BY ordinal", (session_id,)).fetchall()
        completed, pending = [], []
        for item in items:
            point = db.execute("SELECT * FROM knowledge WHERE id = ?", (item["record_id"],)).fetchone()
            if not point:
                continue
            point = record(point)
            if item["review_event_id"] is not None:
                event = db.execute("SELECT result, assisted FROM review_events WHERE id = ?", (item["review_event_id"],)).fetchone()
                completed.append({"record_id": item["record_id"], **dict(event)})
            elif point["status"] == "new" and normalized(point["note"]):
                pending.append((item, point))
        current = None
        if pending and session["state"] != "completed":
            item, point = pending[0]
            current = {"ordinal": item["ordinal"], "record": point,
                       "selection_reason": item["reason"], "prompt": item["prompt"],
                       "assisted": bool(item["assisted"]),
                       "question_stale": item["prompt"] is not None and item["source_revision"] != point["revision"]}
        session.update(current=current, completed=completed, remaining=len(pending),
                       omitted=len(items) - len(pending) - len(completed), as_of=now())
        return {"status": "found", "session": session}

    def start(self, request_id, *, language, kind=None, limit=3, include_variants=True, include_upcoming=False):
        from store import encode, now
        options = dict(language=language, kind=kind, limit=limit,
                       include_variants=include_variants, include_upcoming=include_upcoming)
        with self.store.connection(write=True) as db:
            previous = db.execute("SELECT options FROM study_sessions WHERE id = ?", (request_id,)).fetchone()
            if previous:
                if previous["options"] != encode(options):
                    return {"status": "failed", "error": "request_id_conflict"}
                return {**self._view(db, request_id), "replayed": True}
            queue = self.store.review(**options, _db=db)
            if not queue["records"]:
                return {"status": "empty", "counts": queue["counts"], "next_due_at": queue["next_due_at"]}
            timestamp = now()
            db.execute("INSERT INTO study_sessions (id, options, created_at, updated_at) VALUES (?, ?, ?, ?)",
                       (request_id, encode(options), timestamp, timestamp))
            for index, point in enumerate(queue["records"]):
                db.execute("INSERT INTO study_items (session_id, ordinal, record_id, reason) VALUES (?, ?, ?, ?)",
                           (request_id, index + 1, point["id"], point["review_reason"]))
            return {**self._view(db, request_id), "replayed": False}

    def get(self, session_id=None, language=None):
        with self.store.connection() as db:
            db.execute("BEGIN")
            if session_id:
                return self._view(db, session_id)
            rows = db.execute("SELECT * FROM study_sessions WHERE state != 'completed' ORDER BY updated_at DESC").fetchall()
            matches = [row for row in rows if language is None or json.loads(row["options"])["language"] == language]
            if not matches:
                return {"status": "not_found"}
            if len(matches) > 1:
                return {"status": "choose_session", "sessions": [
                    {"id": row["id"], "state": row["state"], "options": json.loads(row["options"]),
                     "updated_at": row["updated_at"]} for row in matches]}
            return self._view(db, matches[0]["id"])

    def _check(self, db, session_id, expected_version, active=True):
        view = self._view(db, session_id)
        if view["status"] != "found":
            return view, None
        session = view["session"]
        if session["version"] != expected_version:
            return {**view, "status": "failed", "error": "version_conflict"}, None
        if active and session["state"] != "active":
            return {"status": "failed", "error": "session_not_active"}, None
        return view, session

    def _touch(self, db, session_id):
        from store import now
        db.execute("UPDATE study_sessions SET version = version + 1, updated_at = ? WHERE id = ?", (now(), session_id))

    def prepare(self, session_id, expected_version, record_id, expected_revision, prompt, assisted=False):
        with self.store.connection(write=True) as db:
            view, session = self._check(db, session_id, expected_version)
            if session is None:
                return view
            current = session["current"]
            if not current or current["record"]["id"] != record_id:
                return {"status": "failed", "error": "not_current_point"}
            if current["record"]["revision"] != expected_revision:
                return {"status": "failed", "error": "content_changed"}
            db.execute("""UPDATE study_items SET prompt = ?, source_revision = ?, assisted = ?
                       WHERE session_id = ? AND ordinal = ?""",
                       (prompt, expected_revision, assisted or current["assisted"], session_id, current["ordinal"]))
            self._touch(db, session_id)
            return self._view(db, session_id)

    def answer(self, session_id, expected_version, request_id, review):
        from store import encode, Review
        fingerprint = hashlib.sha256(encode([session_id, expected_version, review.model_dump()]).encode()).hexdigest()
        with self.store.connection(write=True) as db:
            previous = db.execute("SELECT * FROM study_answers WHERE request_id = ?", (request_id,)).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    return {"status": "failed", "error": "request_id_conflict"}
                return {**self._view(db, session_id), "replayed": True, "applied_version": previous["applied_version"]}
            view, session = self._check(db, session_id, expected_version)
            if session is None:
                return view
            current = session["current"]
            if not current or not current["prompt"]:
                return {"status": "failed", "error": "no_pending_question"}
            if current["question_stale"]:
                return {"status": "failed", "error": "content_changed"}
            if review.result != "skipped" and not review.answer:
                return {"status": "failed", "error": "answer_required"}
            if review.prompt is not None and review.prompt != current["prompt"]:
                return {"status": "failed", "error": "prompt_mismatch"}
            assisted = current["assisted"] or review.assisted
            evidence = Review(**{**review.model_dump(), "prompt": current["prompt"], "assisted": assisted,
                                "effort": "standard" if assisted else review.effort})
            # A namespaced deterministic key prevents collisions with standalone reviews.
            review_key = "study_" + hashlib.sha256(request_id.encode()).hexdigest()
            result = self.store._record_review(db, current["record"]["id"], review_key, evidence)
            if result["status"] != "reviewed":
                return result
            db.execute("UPDATE study_items SET review_event_id = ? WHERE session_id = ? AND ordinal = ?",
                       (result["event_id"], session_id, current["ordinal"]))
            self._touch(db, session_id)
            if self._view(db, session_id)["session"]["remaining"] == 0:
                db.execute("UPDATE study_sessions SET state = 'completed' WHERE id = ?", (session_id,))
            applied = expected_version + 1
            db.execute("INSERT INTO study_answers VALUES (?, ?, ?, ?)", (request_id, fingerprint, session_id, applied))
            return {**self._view(db, session_id), "replayed": False, "applied_version": applied, "review": result}

    def set_state(self, session_id, expected_version, state):
        with self.store.connection(write=True) as db:
            view, session = self._check(db, session_id, expected_version, active=False)
            if session is None:
                return view
            if session["state"] == "completed":
                return {"status": "failed", "error": "session_completed"}
            db.execute("UPDATE study_sessions SET state = ? WHERE id = ?", (state, session_id))
            self._touch(db, session_id)
            return self._view(db, session_id)
