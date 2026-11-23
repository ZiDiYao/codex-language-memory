import { AuthenticationError, authenticate, createTokenVerifier } from "./auth.js";
import { handleMcpRequest } from "./mcp.js";
import { parse, ValidationError } from "./schemas.js";
import { MAX_DESKTOP_IMPORT_BODY } from "./desktop-import.js";

export const MAX_BODY = 1024 * 1024;
const REST_METHODS = Object.freeze({
  "/v1/settings": ["GET", "PATCH"], "/v1/points": ["GET"], "/v1/captures": ["POST"], "/v1/observations": ["POST"],
  "/v1/scenes": ["GET"], "/v1/review-queue": ["GET"], "/v1/reviews": ["POST"],
  "/v1/languages": ["GET"], "/v1/changes": ["GET"],
  "/v1/desktop-imports": ["POST"],
});
const restMethods = (path) => REST_METHODS[path] ?? (/^\/v1\/points\/\d+$/.test(path) ? ["GET", "PATCH", "DELETE"] : null);

export class APIError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function send(response, status, body, headers = {}) {
  if (response.headersSent || response.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length,
    "Cache-Control": "no-store", ...headers });
  response.end(bytes);
}

function validateAuthority(request, config, path) {
  const publicUrl = new URL(config.publicUrl);
  const host = request.headers.host;
  if (typeof host !== "string" || !host || /[\s,/@\\]/.test(host)) throw new APIError(403, "invalid_host");
  let received;
  try { received = new URL(`${publicUrl.protocol}//${host}`); } catch { throw new APIError(403, "invalid_host"); }
  const health = ["/healthz", "/readyz"].includes(path);
  const loopbackHealth = health && (["127.0.0.1", "localhost", "[::1]"].includes(received.hostname));
  // Railway probes use this Host instead of the service's public domain. This
  // exception is limited to existing read-only health routes, never data/MCP.
  const railwayHealth = health && request.method === "GET" && received.hostname === "healthcheck.railway.app";
  if (received.host !== publicUrl.host && !loopbackHealth && !railwayHealth) throw new APIError(403, "invalid_host");
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== publicUrl.origin
      && !(restMethods(path) && (config.webAllowedOrigins ?? []).includes(origin)))
    throw new APIError(403, "invalid_origin");
}

function preflight(request, response, path) {
  if (typeof request.headers.origin !== "string") throw new APIError(403, "invalid_origin");
  const methods = restMethods(path);
  if (!methods) throw new APIError(404, "not_found");
  const requestedMethod = request.headers["access-control-request-method"];
  if (typeof requestedMethod !== "string" || !methods.includes(requestedMethod))
    throw new APIError(405, "method_not_allowed");
  const rawHeaders = request.headers["access-control-request-headers"];
  const headers = rawHeaders === undefined ? [] : typeof rawHeaders === "string"
    ? rawHeaders.split(",").map((header) => header.trim().toLowerCase()) : [""];
  if (new Set(headers).size !== headers.length || headers.some((header) => !["authorization", "content-type"].includes(header)))
    throw new APIError(400, "invalid_preflight_headers");
  response.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  response.writeHead(204, { "Content-Length": "0", "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": methods.join(", "),
    "Access-Control-Allow-Headers": "Authorization, Content-Type" });
  response.end();
}

async function readJson(request, maxBody = MAX_BODY) {
  if ((request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw new APIError(415, "json_required");
  const declared = request.headers["content-length"];
  if (declared && Number(declared) > maxBody) throw new APIError(413, "request_too_large");
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBody) { request.resume(); throw new APIError(413, "request_too_large"); }
      chunks.push(chunk);
    }
  } catch (error) { if (error instanceof APIError) throw error; throw new APIError(400, "invalid_request"); }
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new APIError(422, "invalid_request"); }
}

function queryArguments(search, model) {
  const values = Object.create(null);
  for (const [key, value] of search) {
    if (Object.hasOwn(values, key)) throw new APIError(422, "invalid_request");
    values[key] = value;
  }
  for (const key of ["limit", "offset"]) if (Object.hasOwn(values, key)) {
    if (!/^[+-]?\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key]))) throw new APIError(422, "invalid_request");
    values[key] = Number(values[key]);
  }
  for (const key of ["include_variants", "needs_enrichment", "include_upcoming"]) if (Object.hasOwn(values, key)) {
    if (!["true", "false", "1", "0"].includes(values[key])) throw new APIError(422, "invalid_request");
    values[key] = ["true", "1"].includes(values[key]);
  }
  return parse(model, values);
}

function resultStatus(result) {
  if (result?.status === "not_found") return 404;
  if (result?.status === "failed") return ["edit_conflict", "identity_conflict", "request_id_conflict", "import_source_conflict"].includes(result.error) ? 409 : 400;
  return 200;
}

/** Native Node HTTP handler; authentication is shared by every data operation. */
export function createApp({ config, repositoryFactory, verifyToken, readiness, logger = console }) {
  const verify = verifyToken ?? createTokenVerifier(config);
  const importConfig = { ...config, requiredScopes: ["memory:write"] };
  const verifyImport = verifyToken ?? createTokenVerifier(importConfig);
  const metadata = { resource: config.resourceUrl, authorization_servers: [config.authIssuer],
    scopes_supported: [...config.requiredScopes], bearer_methods_supported: ["header"] };
  return async function handler(request, response) {
    try {
      if (typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//"))
        throw new APIError(400, "invalid_request");
      const url = new URL(request.url, config.publicUrl);
      const path = url.pathname;
      if (path.startsWith("/v1/")) response.setHeader("Vary", "Origin");
      validateAuthority(request, config, path);
      if (restMethods(path)) {
        // Set these before authentication and validation so trusted browser
        // callers can read safe errors too. Bearer requests need no cookies.
        if (request.headers.origin !== undefined) response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
        if (request.method === "OPTIONS") return preflight(request, response, path);
      }
      else if (path.startsWith("/v1/") && request.method === "OPTIONS") return preflight(request, response, path);
      if (request.method === "GET" && path === "/healthz") return send(response, 200, { status: "ok" });
      if (request.method === "GET" && path === "/readyz") {
        let ready = false;
        try { ready = !!(readiness && await readiness()); } catch { /* No database details in health responses. */ }
        return send(response, ready ? 200 : 503, { status: ready ? "ok" : "unavailable" });
      }
      if (request.method === "GET" && path === "/.well-known/oauth-protected-resource/mcp") return send(response, 200, metadata);
      if (path !== "/mcp" && !path.startsWith("/v1/")) throw new APIError(404, "not_found");
      const principal = path === "/v1/desktop-imports"
        ? await authenticate(request, importConfig, verifyImport) : await authenticate(request, config, verify);
      if (path === "/mcp") {
        // No shared MCP server, session map, global principal or user-controlled user_id.
        const body = request.method === "POST" ? await readJson(request) : undefined;
        return await handleMcpRequest(request, response, body, { config, repositoryFactory, principal, logger });
      }
      async function call(method, ...arguments_) {
        try { return await repositoryFactory(principal)[method](...arguments_); }
        catch (error) {
          if (error instanceof ValidationError || error?.code === "invalid_request") throw new APIError(422, "invalid_request");
          logger.error("cloud_repository_failed");
          throw new APIError(503, "unavailable");
        }
      }
      let result;
      if (path === "/v1/desktop-imports" && request.method === "POST") {
        if (url.search) throw new APIError(422, "invalid_request");
        result = await call("import_desktop", await readJson(request, MAX_DESKTOP_IMPORT_BODY));
      }
      else if (path === "/v1/settings" && request.method === "GET") result = { ...await call("settings"), _capabilities: { lightweight_capture: true } };
      else if (path === "/v1/settings" && request.method === "PATCH") result = await call("settings", parse("settingsPatch", await readJson(request)));
      else if (["/v1/languages", "/v1/changes"].includes(path) && request.method === "GET") {
        if (url.search) throw new APIError(422, "invalid_request");
        result = await call(path === "/v1/languages" ? "languages" : "versions");
      }
      else if (path === "/v1/points" && request.method === "GET") result = await call("query", queryArguments(url.searchParams, "query"));
      else if (path === "/v1/observations" && request.method === "POST") {
        const args = parse("observations", await readJson(request));
        result = await call("observe", args.request_id, args.items, args.source);
      }
      else if (path === "/v1/captures" && request.method === "POST") {
        const args = parse("capture", await readJson(request));
        result = await call("save", args.request_id, args.items, args.source);
      } else if (/^\/v1\/points\/\d+$/.test(path)) {
        const id = Number(path.split("/").at(-1));
        if (!Number.isSafeInteger(id) || id < 1) throw new APIError(422, "invalid_request");
        if (request.method === "GET") result = await call("get_point", id);
        else if (request.method === "DELETE") result = await call("delete", id);
        else if (request.method === "PATCH") {
          const args = parse("pointUpdate", await readJson(request));
          result = await call("update", id, args.patch, args.expected_revision);
        } else throw new APIError(405, "method_not_allowed");
      } else if (path === "/v1/scenes" && request.method === "GET") result = await call("scenes", queryArguments(url.searchParams, "sceneQuery"));
      else if (path === "/v1/review-queue" && request.method === "GET") result = await call("review", queryArguments(url.searchParams, "reviewQuery"));
      else if (path === "/v1/reviews" && request.method === "POST") {
        const args = parse("reviewAttempt", await readJson(request));
        result = await call("record_review", args.record_id, args.request_id, args.review);
      } else if (restMethods(path))
        throw new APIError(405, "method_not_allowed");
      else throw new APIError(404, "not_found");
      return send(response, resultStatus(result), result);
    } catch (error) {
      if (error instanceof AuthenticationError) return send(response, error.status, { error: error.code }, {
        "WWW-Authenticate": `Bearer error="${error.code}", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
      });
      if (error instanceof APIError) return send(response, error.status, { error: error.code });
      if (error instanceof ValidationError || error?.code === "invalid_request") return send(response, 422, { error: "invalid_request" });
      logger.error("cloud_request_failed");
      return send(response, 503, { error: "unavailable" });
    }
  };
}
