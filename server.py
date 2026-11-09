"""Local stdio MCP entry point for Codex Language Memory."""

import os
from pathlib import Path
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from store import (CaptureMode, Kind, Language, LearnerPreferences, Limit, Patch, RecordId, RequestId, Review,
                   Revision, SettingsPatch, Status, Store, Title)
from dashboard import Dashboard
from exports import ExportError, ExportRequest, save_export


def create_server(store: Store) -> FastMCP:
    server = FastMCP("language_memory")
    read_only = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
    local_write = ToolAnnotations(destructiveHint=False, openWorldHint=False)
    dashboard = Dashboard(store)

    @server.tool(annotations=read_only)
    def open_memory_page() -> dict[str, Any]:
        """Open the language learning records and settings page.
        Show the returned local URL in the Codex browser side panel when available.
        The page shares this server's database and lasts until this process exits.
        """
        return {"url": dashboard.start(), "title": "Language memory"}

    @server.tool(annotations=read_only)
    def get_settings() -> dict[str, Any]:
        """Read recording, interface language, confirmed first_language and default explanation override.

        A null first_language means the user has not confirmed it. Never infer it from the UI or learning language.
        A null explanation_language uses first_language unless a target-language preference overrides it.
        """
        return store.settings()

    @server.tool(annotations=local_write)
    def update_settings(patch: SettingsPatch) -> dict[str, Any]:
        """Update supplied settings immediately. ui_language is en/zh/ja/ko/fr/es.
        Set first_language only from the user's confirmation. explanation_language is a global override;
        null resets it to first_language. These do not change the target language or translate old records.
        Capture automatically covers every language while recording is enabled.
        """
        return store.settings(patch)

    @server.tool(annotations=read_only)
    def list_languages() -> dict[str, Any]:
        """List languages with saved records and counts grouped by base language. No empty language notebooks are created."""
        return store.languages()

    @server.tool(annotations=read_only)
    def get_recording() -> dict[str, Any]:
        """Read the persistent recording switch. Enabled by default."""
        return store.recording()

    @server.tool(annotations=local_write)
    def set_recording(enabled: bool) -> dict[str, Any]:
        """Enable or pause new saves. Existing entries remain available."""
        return store.recording(enabled)

    @server.tool(annotations=local_write)
    def save_points(
        request_id: RequestId,
        items: Annotated[list[dict[str, Any]], Field(min_length=1, max_length=20)],
        source: CaptureMode = "automatic",
    ) -> dict[str, Any]:
        """Save one batch from a learning encounter. Reuse request_id and exact items on retry.

        Each item needs kind (word/expression/grammar/correction), language (e.g. en),
        title, sense_key (stable short meaning/use label) and meaning. Codex must also provide
        a useful explanation with natural usage/collocations and two to five distinct examples
        (text, translation in the preferred explanation language when useful).
        Optional fields are context and corrected_sentence. Generate content before saving; never ask the user to fill a form.
        Set source=explicit only when the user requested this save.
        Do not call this for reading, explaining or practicing already saved notes during
        study/review; those actions are not new encounters. Use queries and record_review.
        Returns one added/merged/skipped/failed outcome per item when processed.
        Skipped means the current capture settings exclude the item.
        """
        return store.save(request_id, items, source)

    @server.tool(annotations=read_only)
    def find_points(
        keyword: Title | None = None,
        kind: Kind | None = None,
        language: Language | None = None,
        status: Status | None = None,
        limit: Limit = 10,
        offset: Annotated[int, Field(ge=0)] = 0,
        include_variants: bool = False,
        cursor: Annotated[str, Field(max_length=300)] | None = None,
        needs_enrichment: bool = False,
    ) -> dict[str, Any]:
        """Find points by keyword and filters, most recently seen first.
        Set language to isolate a learning language and include_variants=true to include regional forms.
        Use needs_enrichment=true for noncustom records missing an explanation or two distinct examples.
        Pass next_cursor to continue reading; omit offset when using a cursor.
        """
        return store.query(
            keyword=keyword, kind=kind, language=language, status=status,
            limit=limit, offset=offset, include_variants=include_variants,
            cursor=cursor, needs_enrichment=needs_enrichment,
        )

    @server.tool(annotations=local_write)
    def export_points(request: ExportRequest) -> dict[str, Any]:
        """Export all matching points as PDF, XLSX, DOCX, a Notion import ZIP, or JSON.
        Filter by kind or kinds, language, status, keyword, and timezone-aware start_at
        (inclusive) / end_at (exclusive), using date_field created_at or last_seen_at.
        content=notes exports current editable notes; terms exports current titles only.
        content=sections requires fields (meaning, explanation, examples, translations,
        context, corrected_sentence) and uses original captured fields, not freeform edits.
        translations requires examples. include_metadata controls learning dates/history.
        Returns a local file path and count. Notion ZIP contains Markdown and CSV;
        it does not publish to Notion. Use find_points for direct conversational reading.
        """
        try:
            return save_export(store, request)
        except ExportError as error:
            return {"status": "failed", "error": str(error)}

    @server.tool(annotations=read_only)
    def review_queue(
        language: Language | None = None, kind: Kind | None = None, limit: Limit = 5,
        include_variants: bool = False, include_upcoming: bool = False,
        exclude_ids: Annotated[list[RecordId], Field(max_length=100)] | None = None,
    ) -> dict[str, Any]:
        """Choose material for guided study: due FSRS reviews first, then unassessed points.
        Excludes mastered and empty custom notes. Pass this round's completed/skipped IDs
        in exclude_ids to avoid repeating an assisted or skipped point with an unchanged schedule.
        Returns current notes, selection reasons, latest attempts and counts for the filtered
        scope after exclusions (before limit). limit must be 1 to 50; counts already cover
        the entire scope. Schedule-only questions can use counts and next_due_at without
        loading upcoming records. Use last_attempt to address a specific difficulty,
        but the current note remains authoritative after user edits. Reading never records practice.
        Future reviews are excluded unless include_upcoming=true for requested early practice.
        Memory estimates use population parameters and are not calibrated proficiency scores.
        Supply language to review one language. include_variants includes regional forms.
        """
        return store.review(language=language, kind=kind, limit=limit, include_variants=include_variants,
                            include_upcoming=include_upcoming, exclude_ids=exclude_ids)

    @server.tool(annotations=local_write)
    def record_review(record_id: RecordId, request_id: RequestId, review: Review) -> dict[str, Any]:
        """Record an actual answered quiz once; reuse request_id and exact arguments on retry.
        result is correct/partial/incorrect/skipped. Set assisted=true if hints or the answer
        were shown before the learner responded. A quiz immediately after you explained or
        displayed the same target is assisted even when you use a different example sentence.
        Check the preceding teaching context before choosing assisted. Assisted/skipped attempts
        do not train FSRS.
        Correct maps to Good; partial/incorrect to Again. effort=hard/easy applies only to
        an unassisted correct answer when the user explicitly reports recall effort.
        Include only the exercise prompt and relevant learner answer. Never infer a quiz
        result from asking a meaning, reading an explanation, or marking Mastered.
        This never changes user-controlled mastery or encounter counts.
        """
        return store.record_review(record_id, request_id, review)

    @server.tool(annotations=read_only)
    def get_point_history(
        record_id: RecordId, limit: Limit = 20,
        before_encounter_id: RecordId | None = None, before_review_id: RecordId | None = None,
    ) -> dict[str, Any]:
        """Read one point's encounter contexts, actual quiz attempts and memory estimate.
        Follow next_encounter_before_id/next_review_before_id to read older evidence.
        Older pre-upgrade encounters may lack history; never invent their contents.
        """
        return store.history(record_id, limit=limit, before_encounter_id=before_encounter_id,
                             before_review_id=before_review_id)

    @server.tool(annotations=read_only)
    def get_learning_profile(language: Language | None = None, include_variants: bool = False) -> dict[str, Any]:
        """Read observed practice counts, recurring points and explicit learning preferences.
        Use before personalized teaching/review or when asked about learning progress.
        Counts cover saved learning interactions, not all activity or overall proficiency.
        Keep languages separate. No personal FSRS parameter fitting has been performed.
        """
        return store.learning_profile(language=language, include_variants=include_variants)

    @server.tool(annotations=local_write)
    def update_learning_preferences(patch: LearnerPreferences, language: Language | None = None) -> dict[str, Any]:
        """Remember explicitly stated explanation_language, explanation_style (concise/detailed),
        learning_goal or interests. Omit language for global preferences; otherwise scope to
        that learning language. Null clears a field. Never infer these from identity or UI locale.
        """
        return store.learning_preferences(language, patch)

    @server.tool(annotations=ToolAnnotations(openWorldHint=False))
    def update_point(record_id: RecordId, patch: Patch, expected_revision: Revision | None = None) -> dict[str, Any]:
        """Edit supplied fields only. Use null to clear optional content.
        The returned note is the current editable study content. Set patch.note to replace
        it verbatim, including an empty string; null restores the generated source content.
        If note_is_custom is true, edit note rather than the historical structured fields.
        Status changes only when supplied. Record quiz results with record_review and its
        idempotent request_id; legacy review_result patches fail without changing data.
        Pass the record's revision to avoid overwriting a concurrent page edit. On edit_conflict,
        reread and reconcile the change; do not blindly retry without the revision.
        """
        return store.update(record_id, patch, expected_revision)

    @server.tool(annotations=ToolAnnotations(destructiveHint=True, openWorldHint=False))
    def delete_point(record_id: RecordId) -> dict[str, Any]:
        """Delete a specific knowledge point by ID."""
        return store.delete(record_id)

    return server


if __name__ == "__main__":
    default = Path.home() / ".local" / "share" / "codex-language-memory" / "memory.sqlite3"
    path = Path(os.environ.get("LANGUAGE_MEMORY_DB", str(default))).expanduser().resolve()
    create_server(Store(path)).run(transport="stdio")
