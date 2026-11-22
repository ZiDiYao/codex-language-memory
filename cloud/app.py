"""Starlette HTTP API sharing authentication and repository logic with MCP."""

import json
import logging
from typing import Annotated, Any, Callable

from pydantic import Field, ValidationError
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse

from cloud.auth import AuthenticationError, JWTVerifier, current_principal
from cloud.config import CloudSettings
from cloud.mcp import create_mcp
from store import (CaptureMode, Kind, Language, Limit, Patch, RecordId, RequestId,
                   Review, Revision, SceneName, SettingsPatch, Status, StrictModel, Title)


log = logging.getLogger(__name__)
MAX_BODY = 1024 * 1024


def database_readiness(engine):
    """A reachable but unmigrated/stale database must not receive application traffic."""
    from cloud.database import SCHEMA_REVISION

    with engine.connect() as connection:
        revisions = list(connection.execute(text("SELECT version_num FROM alembic_version")).scalars())
    return revisions == [SCHEMA_REVISION]


class Query(StrictModel):
    keyword: Title | None = None
    kind: Kind | None = None
    scene: SceneName | None = None
    language: Language | None = None
    status: Status | None = None
    limit: Limit = 20
    offset: Annotated[int, Field(ge=0)] = 0
    include_variants: bool = False
    cursor: Annotated[str, Field(max_length=300)] | None = None
    needs_enrichment: bool = False


class SceneQuery(StrictModel):
    language: Language | None = None
    kind: Kind | None = None
    include_variants: bool = False


class ReviewQuery(SceneQuery):
    scene: SceneName | None = None
    limit: Limit = 5
    include_upcoming: bool = False


class Capture(StrictModel):
    request_id: RequestId
    items: Annotated[list[dict[str, Any]], Field(min_length=1, max_length=20)]
    source: CaptureMode = "automatic"


class PointUpdate(StrictModel):
    patch: Patch
    expected_revision: Revision | None = None


class ReviewAttempt(StrictModel):
    record_id: RecordId
    request_id: RequestId
    review: Review


class APIError(Exception):
    def __init__(self, status_code, code):
        self.status_code = status_code
        self.code = code
        super().__init__(code)


async def read_json(request: Request):
    if request.headers.get("content-type", "").split(";", 1)[0].lower().strip() != "application/json":
        raise APIError(415, "json_required")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY:
            raise APIError(413, "request_too_large")
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        raise APIError(422, "invalid_request") from None
    if not isinstance(value, dict):
        raise APIError(422, "invalid_request")
    return value


def query_arguments(request: Request, model):
    pairs = list(request.query_params.multi_items())
    values = dict(pairs)
    if len(pairs) != len(values):
        raise APIError(422, "invalid_request")
    for name in ("limit", "offset"):
        if name in values:
            try:
                values[name] = int(values[name])
            except ValueError:
                raise APIError(422, "invalid_request") from None
    for name in ("include_variants", "needs_enrichment", "include_upcoming"):
        if name in values:
            if values[name] not in ("true", "false", "1", "0"):
                raise APIError(422, "invalid_request")
            values[name] = values[name] in ("true", "1")
    return model.model_validate(values).model_dump()


def response(result):
    status = result.get("status") if isinstance(result, dict) else None
    code = 404 if status == "not_found" else 200
    if status == "failed":
        code = 409 if result.get("error") in ("edit_conflict", "identity_conflict", "request_id_conflict") else 400
    return JSONResponse(result, status_code=code, headers={"Cache-Control": "no-store"})


def create_app(
    settings: CloudSettings, repository_factory: Callable, *, verifier=None, readiness: Callable | None = None,
):
    """Construct an authenticated app. Tests may inject a verifier and isolated DB factory."""
    verifier = verifier or JWTVerifier(settings)
    server = create_mcp(settings, repository_factory, verifier)

    async def call(request, method, *args, **kwargs):
        principal = current_principal(settings)
        try:
            return await run_in_threadpool(lambda: getattr(repository_factory(principal), method)(*args, **kwargs))
        except ValueError:
            raise APIError(422, "invalid_request") from None
        except Exception:
            # Handle this inside ExceptionMiddleware: an unhandled DB exception can
            # otherwise be re-raised to Uvicorn and log SQL parameters or note text.
            log.error("cloud_repository_failed")
            raise APIError(503, "unavailable") from None

    @server.custom_route("/healthz", methods=["GET"])
    async def health(request):
        return JSONResponse({"status": "ok"})

    @server.custom_route("/readyz", methods=["GET"])
    async def ready(request):
        try:
            if readiness is None or not await run_in_threadpool(readiness):
                return JSONResponse({"status": "unavailable"}, status_code=503)
        except Exception:
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return JSONResponse({"status": "ok"})

    @server.custom_route("/v1/settings", methods=["GET", "PATCH"])
    async def settings_route(request):
        current_principal(settings)
        patch = SettingsPatch.model_validate(await read_json(request)) if request.method == "PATCH" else None
        return response(await call(request, "settings", patch) if patch is not None else await call(request, "settings"))

    @server.custom_route("/v1/points", methods=["GET"])
    async def points(request):
        current_principal(settings)
        return response(await call(request, "query", **query_arguments(request, Query)))

    @server.custom_route("/v1/captures", methods=["POST"])
    async def capture(request):
        current_principal(settings)
        arguments = Capture.model_validate(await read_json(request))
        return response(await call(request, "save", arguments.request_id, arguments.items, arguments.source))

    @server.custom_route("/v1/points/{record_id:int}", methods=["GET", "PATCH", "DELETE"])
    async def point(request):
        current_principal(settings)
        record_id = request.path_params["record_id"]
        if record_id < 1:
            raise APIError(422, "invalid_request")
        if request.method == "GET":
            return response(await call(request, "get_point", record_id))
        if request.method == "DELETE":
            return response(await call(request, "delete", record_id))
        update = PointUpdate.model_validate(await read_json(request))
        return response(await call(request, "update", record_id, update.patch, update.expected_revision))

    @server.custom_route("/v1/scenes", methods=["GET"])
    async def scenes(request):
        current_principal(settings)
        return response(await call(request, "scenes", **query_arguments(request, SceneQuery)))

    @server.custom_route("/v1/review-queue", methods=["GET"])
    async def review_queue(request):
        current_principal(settings)
        return response(await call(request, "review", **query_arguments(request, ReviewQuery)))

    @server.custom_route("/v1/reviews", methods=["POST"])
    async def review(request):
        current_principal(settings)
        attempt = ReviewAttempt.model_validate(await read_json(request))
        return response(await call(request, "record_review", attempt.record_id, attempt.request_id, attempt.review))

    app = server.streamable_http_app()

    async def auth_error(request, error):
        metadata = settings.public_url + "/.well-known/oauth-protected-resource/mcp"
        return JSONResponse({"error": error.code}, status_code=error.status_code, headers={
            "WWW-Authenticate": f'Bearer error="{error.code}", resource_metadata="{metadata}"',
            "Cache-Control": "no-store",
        })

    async def invalid(request, error):
        return JSONResponse({"error": "invalid_request"}, status_code=422, headers={"Cache-Control": "no-store"})

    async def api_error(request, error):
        return JSONResponse({"error": error.code}, status_code=error.status_code, headers={"Cache-Control": "no-store"})

    async def unexpected(request, error):
        log.error("cloud_request_failed")
        return JSONResponse({"error": "unavailable"}, status_code=500, headers={"Cache-Control": "no-store"})

    app.add_exception_handler(AuthenticationError, auth_error)
    app.add_exception_handler(ValidationError, invalid)
    app.add_exception_handler(ValueError, invalid)
    app.add_exception_handler(APIError, api_error)
    app.add_exception_handler(Exception, unexpected)
    app.state.mcp_server = server
    app.state.cloud_settings = settings
    return app
