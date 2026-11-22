"""Authenticated, stateless Streamable HTTP MCP transport for the shared repository."""

from typing import Annotated, Any, Callable
import logging
from urllib.parse import urlsplit

from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field
from starlette.concurrency import run_in_threadpool

from cloud.auth import current_principal
from store import (CaptureMode, Kind, Language, Limit, Patch, RecordId, RequestId,
                   Review, Revision, SceneName, SettingsPatch, Status, Title)

log = logging.getLogger(__name__)


def create_mcp(settings, repository_factory: Callable, verifier):
    host = urlsplit(settings.public_url).netloc
    server = FastMCP(
        "language_memory_cloud",
        instructions="Authenticated cloud language memory. Every operation is isolated to the authenticated learner. "
        "Supported features are captures, records, scenes, settings and actual review attempts. "
        "This server does not provide a desktop UI, local speech, exports or persistent guided-study sessions.",
        token_verifier=verifier,
        auth=AuthSettings(
            issuer_url=settings.auth_issuer, resource_server_url=settings.resource_url,
            required_scopes=list(settings.required_scopes), validate_token_resource=True,
        ),
        streamable_http_path="/mcp", stateless_http=True, json_response=True,
        max_request_body_size=1024 * 1024, debug=False,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True, allowed_hosts=[host], allowed_origins=[settings.public_url],
        ),
    )
    read = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
    write = ToolAnnotations(destructiveHint=False, openWorldHint=False)

    async def call(method, *args, **kwargs):
        principal = current_principal(settings)
        try:
            return await run_in_threadpool(lambda: getattr(repository_factory(principal), method)(*args, **kwargs))
        except ValueError:
            return {"status": "failed", "error": "invalid_request"}
        except Exception:
            log.error("cloud_repository_failed")
            return {"status": "failed", "error": "unavailable"}

    @server.tool(annotations=read)
    async def get_settings() -> dict[str, Any]:
        """Read the authenticated learner's recording and language preferences."""
        return await call("settings")

    @server.tool(annotations=write)
    async def update_settings(patch: SettingsPatch) -> dict[str, Any]:
        """Update only supplied preferences for the authenticated learner."""
        return await call("settings", patch)

    @server.tool(annotations=read)
    async def get_recording() -> dict[str, Any]:
        """Read whether new language-learning captures are enabled."""
        result = await call("settings")
        return {"enabled": result["enabled"]} if "enabled" in result else result

    @server.tool(annotations=write)
    async def set_recording(enabled: bool) -> dict[str, Any]:
        """Enable or pause new captures; existing notes remain available."""
        result = await call("settings", SettingsPatch(enabled=enabled))
        return {"enabled": result["enabled"]} if "enabled" in result else result

    @server.tool(annotations=write)
    async def save_points(
        request_id: RequestId,
        items: Annotated[list[dict[str, Any]], Field(min_length=1, max_length=20)],
        source: CaptureMode = "automatic",
    ) -> dict[str, Any]:
        """Save a learning encounter with idempotency scoped to this learner.
        Supply kind, language, title, sense_key, meaning, explanation and two distinct examples.
        Infer relevant scenes from the learning context, reusing list_scenes names where appropriate.
        A point can belong to several scenes, independent of word/expression/grammar type.
        Do not fabricate encounters, and retry uncertain requests with the same ID and exact items.
        """
        return await call("save", request_id, items, source)

    @server.tool(annotations=read)
    async def find_points(
        keyword: Title | None = None, kind: Kind | None = None, scene: SceneName | None = None,
        language: Language | None = None, status: Status | None = None,
        limit: Limit = 10, offset: Annotated[int, Field(ge=0)] = 0,
        include_variants: bool = False,
        cursor: Annotated[str, Field(max_length=300)] | None = None,
        needs_enrichment: bool = False,
    ) -> dict[str, Any]:
        """Search this learner's notes; combine scene, type and language filters.
        Follow next_cursor to continue. Read current notes without creating encounters.
        """
        return await call("query", keyword=keyword, kind=kind, scene=scene, language=language,
                          status=status, limit=limit, offset=offset, include_variants=include_variants,
                          cursor=cursor, needs_enrichment=needs_enrichment)

    @server.tool(annotations=read)
    async def list_scenes(
        language: Language | None = None, kind: Kind | None = None, include_variants: bool = False,
    ) -> dict[str, Any]:
        """List this learner's scene names and counts, optionally restricted by language or type."""
        return await call("scenes", language=language, kind=kind, include_variants=include_variants)

    @server.tool(annotations=read)
    async def list_languages() -> dict[str, Any]:
        """List only languages observed in this learner's saved notes."""
        return await call("languages")

    @server.tool(annotations=write)
    async def update_point(
        record_id: RecordId, patch: Patch, expected_revision: Revision | None = None,
    ) -> dict[str, Any]:
        """Edit this learner's note, scenes or user-controlled mastery.
        Pass the current expected_revision to protect concurrent edits. Do not record quizzes here.
        """
        return await call("update", record_id, patch, expected_revision)

    @server.tool(annotations=ToolAnnotations(destructiveHint=True, openWorldHint=False))
    async def delete_point(record_id: RecordId) -> dict[str, Any]:
        """Delete only a specified note belonging to this learner."""
        return await call("delete", record_id)

    @server.tool(annotations=read)
    async def review_queue(
        language: Language | None = None, kind: Kind | None = None, scene: SceneName | None = None,
        limit: Limit = 5, include_variants: bool = False, include_upcoming: bool = False,
        exclude_ids: Annotated[list[RecordId], Field(max_length=100)] | None = None,
    ) -> dict[str, Any]:
        """Retrieve this learner's due or explicitly requested early practice, without recording a result."""
        return await call("review", language=language, kind=kind, scene=scene, limit=limit,
                          include_variants=include_variants, include_upcoming=include_upcoming, exclude_ids=exclude_ids)

    @server.tool(annotations=write)
    async def record_review(record_id: RecordId, request_id: RequestId, review: Review) -> dict[str, Any]:
        """Record one actual quiz answer idempotently for this learner.
        Mark assisted=true after hints or recent answer exposure. Reading is not a quiz result.
        """
        return await call("record_review", record_id, request_id, review)

    return server
