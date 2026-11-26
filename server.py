"""Local stdio MCP entry point for Codex Language Memory."""

import os
import base64
from pathlib import Path
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import Icon, ToolAnnotations
from pydantic import Field

from store import (CaptureMode, Kind, Language, LearnerPreferences, Limit, Patch, RecordId, RequestId, Review, SceneName,
                   Revision, SettingsPatch, Status, Store, StrictModel, Title, Text)
from dashboard import Dashboard
from study import StudySessions
from exports import ExportError, ExportRequest, save_export
from mcp_app import register_app

ConnectionEpoch = Annotated[int, Field(ge=0, description="Current _connection.epoch from get_settings; required for cloud writes.")]


class LearningObservation(StrictModel):
    kind: Kind
    language: Language
    title: Title
    context: Text | None = None
    corrected_sentence: Text | None = None


def create_server(store: Store) -> FastMCP:
    # The client cannot read a local filesystem path from MCP metadata. Embed
    # the small existing brand mark in serverInfo once, outside tool schemas.
    mark = (Path(__file__).parent / "web/assets/sayrove-mark.svg").read_bytes()
    server = FastMCP("language_memory", icons=[Icon(
        src="data:image/svg+xml;base64," + base64.b64encode(mark).decode("ascii"),
        mimeType="image/svg+xml", sizes=["64x64"],
    )])
    cloud_capable = getattr(store, "account", None) is not None
    read_only = ToolAnnotations(readOnlyHint=True, openWorldHint=cloud_capable)
    local_write = ToolAnnotations(destructiveHint=False, openWorldHint=cloud_capable)
    dashboard = Dashboard(store)
    study = StudySessions(store)
    register_app(server, store)

    # An implicit first capture must belong to the account that exposed these
    # tools, never whichever account happens to be active at invocation time.
    # This reads safe local routing metadata only, without OAuth/cloud access.
    # Reconnect after a sign-in/account change to establish a new binding.
    capture_binding = store.connection_status() if cloud_capable else None

    def local_tool(**options):
        # Cloud has no session/history/profile/export endpoints. Advertising
        # them adds schemas and invites unsupported calls in every question.
        if capture_binding is None or capture_binding["mode"] == "local":
            return server.tool(**options)
        return lambda function: function

    def write_at_epoch(expected_epoch, operation):
        binder = getattr(store, "expect_epoch", None)
        if binder is None:
            return operation()
        with binder(expected_epoch, require_cloud=True):
            return operation()

    @server.tool(annotations=read_only)
    def open_memory_page() -> dict[str, Any]:
        """Open the language learning records and settings page.
        Show the returned local URL in the Codex browser side panel when available.
        The page shares this server's database and lasts until this process exits.
        """
        return {"url": dashboard.start(), "title": "Sayrove"}

    @server.tool(annotations=read_only)
    def get_settings(for_capture: bool = False) -> dict[str, Any]:
        """Read recording, interface language, confirmed first_language and default explanation override.

        A null first_language means the user has not confirmed it. Never infer it from the UI or learning language.
        A null explanation_language uses first_language unless a target-language preference overrides it.
        Set for_capture=true for short-timeout cloud preferences and capture capabilities.
        Reuse that context during the short learning exchange; do not fetch an unsupported cloud profile.
        """
        return store.capture_context() if for_capture and hasattr(store, "capture_context") else store.settings()

    @server.tool(annotations=local_write)
    def update_settings(patch: SettingsPatch, expected_connection_epoch: ConnectionEpoch | None = None) -> dict[str, Any]:
        """Update supplied settings immediately. ui_language is en/zh/ja/ko/fr/es.
        Set first_language only from the user's confirmation. explanation_language is a global override;
        null resets it to first_language. These do not change the target language or translate old records.
        Capture automatically covers every language while recording is enabled.
        english_learning_instructions adds user teaching preferences for English;
        an empty string clears them and leaves the built-in learning workflow active.
        """
        return write_at_epoch(expected_connection_epoch, lambda: store.settings(patch))

    @server.tool(annotations=read_only)
    def list_languages() -> dict[str, Any]:
        """List languages with saved records and counts grouped by base language. No empty language notebooks are created."""
        return store.languages()

    @server.tool(annotations=read_only)
    def list_scenes(language: Language | None = None, kind: Kind | None = None,
                    include_variants: bool = False) -> dict[str, Any]:
        """List overlapping real-world scene labels and distinct point counts.
        Scenes can contain words, expressions, grammar and corrections together.
        Filter language/kind when requested. Reuse an existing scene name when
        classifying a matching point; create a short new label for a new context.
        """
        return store.scenes(language=language, kind=kind, include_variants=include_variants)

    @server.tool(annotations=read_only)
    def get_recording() -> dict[str, Any]:
        """Read the persistent recording switch. Enabled by default."""
        return store.recording()

    @server.tool(annotations=local_write)
    def set_recording(enabled: bool, expected_connection_epoch: ConnectionEpoch | None = None) -> dict[str, Any]:
        """Enable or pause new saves. Existing entries remain available."""
        return write_at_epoch(expected_connection_epoch, lambda: store.recording(enabled))

    @server.tool(annotations=local_write)
    def capture_points(
        request_id: RequestId,
        items: Annotated[list[LearningObservation], Field(min_length=1, max_length=20)],
        source: CaptureMode = "automatic",
        expected_connection_epoch: ConnectionEpoch | None = None,
    ) -> dict[str, Any]:
        """Legacy minimal capture with an explicit current epoch; backend enriches asynchronously.
        Requires get_settings capability lightweight_capture. Prefer capture_and_context for one-call learning.
        Send only kind/language/title/context/correction, no generated notes/scenes or pre-save search.
        Reuse request_id and exact items on retry; pending content is not complete.
        Automatic captures are silent: no announcement or saved/pending confirmation in the answer.
        """
        if not hasattr(store, "capture"):
            return {"status": "failed", "error": "lightweight_capture_unavailable"}
        payload = [item.model_dump(exclude_none=True) for item in items]
        return write_at_epoch(expected_connection_epoch, lambda: store.capture(request_id, payload, source))

    @server.tool(annotations=local_write)
    def capture_and_context(
        request_id: RequestId,
        items: Annotated[list[LearningObservation], Field(min_length=1, max_length=20)],
        source: CaptureMode = "automatic",
    ) -> dict[str, Any]:
        """Submit real learning targets once and return confirmed answer-language preferences.

        No preliminary settings/search call is needed. Send only kind, language,
        title and necessary original context/correction. The backend enforces
        recording/types, deduplicates and enriches later. Use returned _context
        for the answer language and any supplemental english_learning_instructions
        when teaching English. Reuse request_id and exact items on uncertain
        retries. Account changes require reconnecting Sayrove; never rebind an
        old request automatically. Pending enrichment is not a finished note.
        Automatic captures are silent: do not announce the tool or append saved,
        pending or error notices. Explain record outcomes only when explicitly asked.
        For ordinary learning, first give useful teaching: the meaning and a
        usable pattern/example, or a correction and its key reason. Do not call
        immediately after a one-line gloss or an opening sentence. Submit at a
        natural break or after a short answer, without recording narration.
        Use current requests and confirmed same-account preferences initially;
        missing supplemental guidance alone must not delay useful teaching.
        Apply fresh _context to the remaining explanation. Never infer a first
        language; resolve context first only if a missing explanation preference
        genuinely prevents a useful answer.
        """
        if capture_binding is None or capture_binding["mode"] != "cloud" or not hasattr(store, "capture_with_context"):
            return {"status": "failed", "error": "single_call_unavailable"}
        payload = [item.model_dump(exclude_none=True) for item in items]
        return write_at_epoch(capture_binding["epoch"], lambda: store.capture_with_context(request_id, payload, source))

    @server.tool(annotations=local_write)
    def save_points(
        request_id: RequestId,
        items: Annotated[list[dict[str, Any]], Field(min_length=1, max_length=20)],
        source: CaptureMode = "automatic",
        expected_connection_epoch: ConnectionEpoch | None = None,
    ) -> dict[str, Any]:
        """Save rich notes with kind/language/title/sense_key/meaning/explanation and 2–5 examples.
        Prefer capture_and_context for ordinary learning. Optional context/correction/scenes.
        Reuse request_id and exact items on retry; skipped items are excluded by settings.
        Reading/review is not a new encounter. Rich-content guidance is in the legacy-capture reference.
        Automatic captures are silent: no announcement or saved/pending confirmation in the answer.
        """
        return write_at_epoch(expected_connection_epoch, lambda: store.save(request_id, items, source))

    @server.tool(annotations=read_only)
    def find_points(
        keyword: Title | None = None,
        kind: Kind | None = None,
        scene: SceneName | None = None,
        language: Language | None = None,
        status: Status | None = None,
        limit: Limit = 10,
        offset: Annotated[int, Field(ge=0)] = 0,
        include_variants: bool = False,
        cursor: Annotated[str, Field(max_length=300)] | None = None,
        needs_enrichment: bool = False,
    ) -> dict[str, Any]:
        """Find points by keyword and filters. Title exact/prefix matches rank first;
        without a keyword, list most recently seen first.
        Set language to isolate a learning language and include_variants=true to include regional forms.
        Set scene to a list_scenes name; scene, kind, language and keyword filters combine.
        Use needs_enrichment=true for noncustom records missing an explanation or two distinct examples.
        Pass next_cursor to continue reading; omit offset when using a cursor.
        """
        return store.query(
            keyword=keyword, kind=kind, scene=scene, language=language, status=status,
            limit=limit, offset=offset, include_variants=include_variants,
            cursor=cursor, needs_enrichment=needs_enrichment,
        )

    @local_tool(annotations=local_write)
    def export_points(request: ExportRequest) -> dict[str, Any]:
        """Export matching records to PDF/XLSX/DOCX/Notion-import ZIP/JSON; local-only.
        Request schema defines filters/sections/date bounds. notes uses current edits; sections uses
        captured fields. Returns a local path/count; Notion ZIP does not publish anything.
        """
        try:
            return save_export(store, request)
        except ExportError as error:
            return {"status": "failed", "error": str(error)}

    @server.tool(annotations=read_only)
    def review_queue(
        language: Language | None = None, kind: Kind | None = None, scene: SceneName | None = None, limit: Limit = 5,
        include_variants: bool = False, include_upcoming: bool = False,
        exclude_ids: Annotated[list[RecordId], Field(max_length=100)] | None = None,
    ) -> dict[str, Any]:
        """Select saved notes by repeat priority, then due/unassessed reviews; reading records no practice.
        Excludes mastered/empty notes. Pass completed/skipped IDs in exclude_ids; counts cover the full
        filtered scope. include_upcoming is only for requested early practice. Estimates are not proficiency.
        """
        return store.review(language=language, kind=kind, scene=scene, limit=limit, include_variants=include_variants,
                            include_upcoming=include_upcoming, exclude_ids=exclude_ids)

    @server.tool(annotations=local_write)
    def record_review(record_id: RecordId, request_id: RequestId, review: Review,
                      expected_connection_epoch: ConnectionEpoch | None = None) -> dict[str, Any]:
        """Record a real quiz answer once; reuse request_id and exact arguments on retry.
        Mark assisted for hints, answer exposure or immediately preceding teaching. Assisted/skipped
        attempts do not train FSRS. effort applies only to explicitly reported independent correct recall.
        Reading or marking mastery is not a quiz. This never changes mastery or encounter counts.
        """
        return write_at_epoch(expected_connection_epoch, lambda: store.record_review(record_id, request_id, review))

    @local_tool(annotations=local_write)
    def start_study(
        request_id: RequestId, language: Language, kind: Kind | None = None,
        limit: Annotated[int, Field(ge=1, le=20)] = 3,
        include_variants: bool = True, include_upcoming: bool = False,
    ) -> dict[str, Any]:
        """Start a local-only persistent round from saved notes; read profile first.
        Reuse request_id/options on retry. For continuation call get_study. Returns only the current
        point; no quiz attempt or new encounter. include_upcoming is requested early practice.
        """
        return study.start(request_id, language=language, kind=kind, limit=limit,
                           include_variants=include_variants, include_upcoming=include_upcoming)

    @local_tool(annotations=read_only)
    def get_study(session_id: RequestId | None = None, language: Language | None = None) -> dict[str, Any]:
        """Resume a local-only round, pending question and assistance flag. Do not expose answers.
        choose_session requires selecting a round; question_stale requires a fresh question from current notes.
        """
        return study.get(session_id, language)

    @local_tool(annotations=local_write)
    def prepare_study_question(
        session_id: RequestId, expected_version: Annotated[int, Field(ge=0)],
        record_id: RecordId, expected_revision: Revision, prompt: Text, assisted: bool = False,
    ) -> dict[str, Any]:
        """Persist a local-only question before showing it using current version/revision.
        Persist assisted=true before a hint or answer; recent teaching is assistance. On conflict reread
        get_study. Never reset assistance or overwrite another chat's progress.
        """
        return study.prepare(session_id, expected_version, record_id, expected_revision, prompt, assisted)

    @local_tool(annotations=local_write)
    def submit_study_answer(
        session_id: RequestId, expected_version: Annotated[int, Field(ge=0)],
        request_id: RequestId, review: Review,
    ) -> dict[str, Any]:
        """Save the actual learner answer and advance a local-only round atomically.
        Reuse request_id/version/review on retry; never invent an answer or also call record_review.
        Persisted assistance prevails; assisted/skipped attempts do not train FSRS. Mastery/encounters stay unchanged.
        """
        return study.answer(session_id, expected_version, request_id, review)

    @local_tool(annotations=local_write)
    def set_study_state(
        session_id: RequestId, expected_version: Annotated[int, Field(ge=0)],
        state: Literal["active", "paused", "completed"],
    ) -> dict[str, Any]:
        """Pause/resume/finish a local-only round using its current version.
        Pause preserves question/assistance; stopping records no quiz answer. Completed rounds cannot reopen.
        """
        return study.set_state(session_id, expected_version, state)

    @local_tool(annotations=read_only)
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

    @local_tool(annotations=read_only)
    def get_learning_profile(language: Language | None = None, include_variants: bool = False) -> dict[str, Any]:
        """Read observed practice counts, recurring points and explicit learning preferences.
        Use before personalized teaching/review or when asked about learning progress.
        Counts cover saved learning interactions, not all activity or overall proficiency.
        Keep languages separate. No personal FSRS parameter fitting has been performed.
        """
        return store.learning_profile(language=language, include_variants=include_variants)

    @local_tool(annotations=local_write)
    def update_learning_preferences(patch: LearnerPreferences, language: Language | None = None) -> dict[str, Any]:
        """Remember explicitly stated explanation_language, explanation_style (concise/detailed),
        learning_goal or interests. Omit language for global preferences; otherwise scope to
        that learning language. Null clears a field. Never infer these from identity or UI locale.
        """
        return store.learning_preferences(language, patch)

    @server.tool(annotations=ToolAnnotations(openWorldHint=cloud_capable))
    def update_point(record_id: RecordId, patch: Patch, expected_revision: Revision | None = None,
                     expected_connection_epoch: ConnectionEpoch | None = None) -> dict[str, Any]:
        """Edit supplied fields with current epoch and expected_revision; reread/reconcile edit_conflict.
        For custom notes edit note verbatim (including empty); null restores generated content.
        scenes replaces labels ([] clears); status changes only when supplied. Record actual quiz results
        with record_review, never review_result patches. Respect manual edits.
        """
        return write_at_epoch(expected_connection_epoch, lambda: store.update(record_id, patch, expected_revision))

    @server.tool(annotations=ToolAnnotations(destructiveHint=True, openWorldHint=cloud_capable))
    def delete_point(record_id: RecordId, expected_connection_epoch: ConnectionEpoch | None = None) -> dict[str, Any]:
        """Delete a specific knowledge point by ID."""
        return write_at_epoch(expected_connection_epoch, lambda: store.delete(record_id))

    return server


def create_desktop_server(path: Path) -> FastMCP:
    from desktop_account import AccountManager
    from desktop_migration import DesktopMigration
    from desktop_store import RoutingStore

    # Existing SQLite is a one-time migration source/backup. Never open a new
    # local learning database in the production cloud client.
    account = AccountManager(state_path=path.with_name("desktop-account.json"))
    return create_server(RoutingStore(None, account, migration=DesktopMigration(path)))


if __name__ == "__main__":
    default = Path.home() / ".local" / "share" / "codex-language-memory" / "memory.sqlite3"
    path = Path(os.environ.get("LANGUAGE_MEMORY_DB", str(default))).expanduser().resolve()
    create_desktop_server(path).run(transport="stdio")
