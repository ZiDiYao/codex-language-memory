"""One word per language, with multiple captured meanings inside its note."""

import json


CONTENT_FIELDS = ("sense_key", "meaning", "explanation", "context", "corrected_sentence", "examples")


def captured_sense(point):
    result = {key: point.get(key) for key in CONTENT_FIELDS}
    if isinstance(result["examples"], str):
        result["examples"] = json.loads(result["examples"])
    return result


def all_senses(point):
    extras = point.get("additional_senses") or []
    if isinstance(extras, str):
        extras = json.loads(extras)
    return [captured_sense(point), *extras]


def sense_text(sense):
    parts = [sense.get(key) for key in ("meaning", "explanation", "context", "corrected_sentence")]
    parts.extend("\n".join(filter(None, (example["text"], example.get("translation"))))
                 for example in sense.get("examples") or [])
    return "\n\n".join(part for part in parts if part)


def generated_note(point):
    return "\n\n".join(filter(None, [point["title"], *(sense_text(s) for s in all_senses(point))]))


def merge_sense(point, incoming):
    """Keep captured content; a new meaning extends the same word, not its identity."""
    from store import normalized
    senses = all_senses(point)
    candidate = captured_sense(incoming)
    for sense in senses:
        if (normalized(sense["sense_key"]) == normalized(candidate["sense_key"])
                or normalized(sense["meaning"]) == normalized(candidate["meaning"])):
            return senses[1:]
    return [*senses[1:], candidate]


def resolve_id(db, identifier):
    row = db.execute("SELECT record_id FROM merged_words WHERE old_id = ?", (identifier,)).fetchone()
    return row[0] if row else identifier


def migrate_words(db):
    """Consolidate old sense cards transactionally; keep source snapshots for recovery."""
    columns = {row["name"] for row in db.execute("PRAGMA table_info(knowledge)")}
    for name, definition in (("additional_senses", "TEXT NOT NULL DEFAULT '[]'"),
                             ("repeat_priority", "INTEGER NOT NULL DEFAULT 0")):
        if name not in columns:
            db.execute(f"ALTER TABLE knowledge ADD COLUMN {name} {definition}")
    db.execute("""CREATE TABLE IF NOT EXISTS merged_words (
        old_id INTEGER PRIMARY KEY,
        record_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        original TEXT NOT NULL
    )""")
    db.execute("""CREATE TRIGGER IF NOT EXISTS merged_word_deleted AFTER DELETE ON knowledge
        BEGIN DELETE FROM merged_words WHERE record_id = OLD.id; END""")
    if db.execute("SELECT 1 FROM sqlite_master WHERE name = 'one_word_per_language'").fetchone():
        return
    groups = db.execute("""SELECT language, title_key FROM knowledge WHERE kind = 'word'
        GROUP BY language, title_key HAVING COUNT(*) > 1""").fetchall()
    for group in groups:
        rows = db.execute("""SELECT * FROM knowledge WHERE kind = 'word' AND language = ?
            AND title_key = ? ORDER BY id""", tuple(group)).fetchall()
        primary = dict(rows[0])
        for duplicate in rows[1:]:
            _merge_legacy_word(db, primary, dict(duplicate))
            primary = dict(db.execute("SELECT * FROM knowledge WHERE id = ?", (primary["id"],)).fetchone())
    # Also protects against a stale process inserting another sense as a new card.
    db.execute("CREATE UNIQUE INDEX one_word_per_language ON knowledge(language, title_key) WHERE kind = 'word'")


def _merge_legacy_word(db, primary, duplicate):
    from store import encode
    identifier, old_id = primary["id"], duplicate["id"]
    state = db.execute("SELECT * FROM memory_states WHERE record_id = ?", (old_id,)).fetchone()
    primary_state = db.execute("SELECT * FROM memory_states WHERE record_id = ?", (identifier,)).fetchone()
    db.execute("INSERT INTO merged_words VALUES (?, ?, ?)",
               (old_id, identifier, encode({"record": duplicate, "memory": dict(state) if state else None,
                                           "previous_memory": dict(primary_state) if primary_state else None})))
    extras = primary["additional_senses"]
    for sense in all_senses(duplicate):
        extras = encode(merge_sense({**primary, "additional_senses": extras}, sense))
    # Custom notes stay verbatim as sections; never reconstruct them from captured fields.
    note = primary["note"]
    if note is not None or duplicate["note"] is not None:
        left = note if note is not None else generated_note(primary)
        right = duplicate["note"] if duplicate["note"] is not None else generated_note(duplicate)
        note = left if left == right else "\n\n".join(filter(None, (left, right)))
    overlap = _merge_encounters(db, identifier, old_id)
    latest = max((primary, duplicate), key=lambda p: p["last_reviewed_at"] or "")
    if state and (not primary_state or json.loads(state["card"])["last_review"] > json.loads(primary_state["card"])["last_review"]):
        card = json.loads(state["card"])
        card["card_id"] = identifier
        db.execute("""INSERT OR REPLACE INTO memory_states VALUES (?, ?, ?, ?, ?)""",
                   (identifier, encode(card), state["due_at"], state["rated_reviews"], state["algorithm"]))
    db.execute("UPDATE review_events SET record_id = ? WHERE record_id = ?", (identifier, old_id))
    db.execute("UPDATE study_items SET record_id = ? WHERE record_id = ?", (identifier, old_id))
    # Keep completed evidence, but a pending round should not ask the merged word twice.
    db.execute("""DELETE FROM study_items AS pending WHERE record_id = ? AND review_event_id IS NULL
        AND EXISTS (SELECT 1 FROM study_items AS other WHERE other.session_id = pending.session_id
            AND other.record_id = pending.record_id
            AND (other.review_event_id IS NOT NULL OR other.ordinal < pending.ordinal))""", (identifier,))
    db.execute("""UPDATE knowledge SET additional_senses = ?, note = ?, encounter_count = ?,
        created_at = ?, last_seen_at = ?, last_reviewed_at = ?, last_review_result = ?, status = ?,
        repeat_priority = ? WHERE id = ?""",
        (extras, note, primary["encounter_count"] + duplicate["encounter_count"] - overlap,
         min(primary["created_at"], duplicate["created_at"]), max(primary["last_seen_at"], duplicate["last_seen_at"]),
         latest["last_reviewed_at"], latest["last_review_result"],
         "mastered" if primary["status"] == duplicate["status"] == "mastered" else "new",
         max(primary["repeat_priority"], duplicate["repeat_priority"]), identifier))
    db.execute("DELETE FROM knowledge WHERE id = ?", (old_id,))


def _merge_encounters(db, identifier, old_id):
    overlap = 0
    for entry in db.execute("SELECT * FROM encounters WHERE record_id = ?", (old_id,)).fetchall():
        existing = db.execute("SELECT id, context FROM encounters WHERE record_id = ? AND request_id = ?",
                              (identifier, entry["request_id"])).fetchone()
        if existing:
            overlap += 1
            contexts = list(dict.fromkeys(filter(None, (existing["context"], entry["context"]))))
            db.execute("UPDATE encounters SET context = ? WHERE id = ?",
                       ("\n\n".join(contexts) or None, existing["id"]))
        else:
            db.execute("UPDATE encounters SET record_id = ? WHERE id = ?", (identifier, entry["id"]))
    return overlap
