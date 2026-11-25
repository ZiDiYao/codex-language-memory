import { CloudAuthError } from "./cloud-auth.js";

function identifier(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid");
  return String(value);
}

function target(action, arguments_) {
  const get = (path) => ({ method: "GET", path });
  switch (action) {
    case "settings/read": return get("/v1/settings");
    case "settings/update": return { method: "PATCH", path: "/v1/settings", body: arguments_ };
    case "languages/list": return get("/v1/languages");
    case "changes/read": return get("/v1/changes");
    case "activity/read": {
      if (Object.keys(arguments_).some((key) => key !== "timezone") || typeof arguments_.timezone !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_+./-]{0,79}$/.test(arguments_.timezone)) throw new Error("invalid");
      return { ...get("/v1/activity"), query: { timezone: arguments_.timezone } };
    }
    case "activity/events": {
      if (Object.keys(arguments_).some((key) => key !== "events") || !Array.isArray(arguments_.events) ||
          !arguments_.events.length || arguments_.events.length > 20) throw new Error("invalid");
      const events = arguments_.events.map((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event) ||
            Object.keys(event).some((key) => !["event_id", "kind", "occurred_at"].includes(key)) ||
            typeof event.event_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.event_id) ||
            !["button", "pronunciation"].includes(event.kind) || typeof event.occurred_at !== "string" ||
            !Number.isFinite(Date.parse(event.occurred_at)) || new Date(event.occurred_at).toISOString() !== event.occurred_at)
          throw new Error("invalid");
        return { event_id: event.event_id, kind: event.kind, occurred_at: event.occurred_at };
      });
      return { method: "POST", path: "/v1/activity/events", body: { events } };
    }
    case "points/query": return { ...get("/v1/points"), query: arguments_ };
    case "scenes/list": return { ...get("/v1/scenes"), query: arguments_ };
    case "points/read": return get("/v1/points/" + identifier(arguments_.record_id));
    case "points/delete": return { method: "DELETE", path: "/v1/points/" + identifier(arguments_.record_id) };
    case "points/update": return {
      method: "PATCH", path: "/v1/points/" + identifier(arguments_.record_id),
      body: { patch: arguments_.patch, ...(arguments_.expected_revision !== undefined ? { expected_revision: arguments_.expected_revision } : {}) },
    };
    default: throw new Error("unavailable");
  }
}

export function createCloudTransport({ apiBaseUrl, session, fetchImpl = globalThis.fetch }) {
  const base = new URL(apiBaseUrl);
  return {
    capabilities: Object.freeze({ export: false, speech: true }),
    async request(route, payload) {
      // Unsupported local-only operations never fall back to loopback or MCP.
      let operation;
      if (route === "audio") {
        if (!payload || Object.keys(payload).some((key) => !["record_id", "expected_epoch"].includes(key)))
          throw new Error("invalid");
        operation = { method: "GET", path: "/v1/points/" + identifier(payload.record_id) + "/audio" };
      } else {
        if (route !== "api" || !payload || typeof payload.action !== "string") throw new Error("unavailable");
        operation = target(payload.action, payload.arguments || {});
      }
      const url = new URL(operation.path, base);
      for (const [key, value] of Object.entries(operation.query || {})) {
        if (value === null || value === undefined) continue;
        if (!["string", "boolean", "number"].includes(typeof value)) throw new Error("invalid");
        url.searchParams.set(key, String(value));
      }
      const token = await session.getToken();
      session.assertActive();
      const epoch = session.epoch;
      const headers = { Authorization: "Bearer " + token };
      if (operation.body !== undefined) headers["Content-Type"] = "application/json";
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: operation.method, headers, credentials: "omit", cache: "no-store", redirect: "error",
          signal: AbortSignal.timeout(15000),
          ...(operation.body !== undefined ? { body: JSON.stringify(operation.body) } : {}),
        });
      } catch {
        session.assertActive(epoch);
        throw new Error("disconnected");
      }
      session.assertActive(epoch);
      if (response.status === 401) {
        session.pause("authenticationRequired");
        throw new CloudAuthError();
      }
      return response;
    },
  };
}

export function validateCloudConfig(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unavailable");
  for (const key of ["appName", "auth0Domain", "auth0ClientId", "apiBaseUrl", "audience"])
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error("unavailable");
  if (value.appName.length > 80 || !/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(value.auth0Domain) || value.auth0Domain.includes(".."))
    throw new Error("unavailable");
  const api = new URL(value.apiBaseUrl);
  const page = new URL(origin);
  const local = (hostname) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (api.username || api.password || api.search || api.hash || api.pathname !== "/" ||
      (api.protocol !== "https:" && !(api.protocol === "http:" && local(api.hostname) && local(page.hostname)))) throw new Error("unavailable");
  const audience = new URL(value.audience);
  if (audience.username || audience.password || audience.hash || audience.search ||
      (audience.protocol !== "https:" && !(audience.protocol === "http:" && local(audience.hostname) && local(page.hostname)))) throw new Error("unavailable");
  return Object.freeze({ ...value, apiBaseUrl: api.origin });
}
