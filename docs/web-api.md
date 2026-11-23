# Browser access to the Node REST API

The Web frontend uses its own Auth0 public SPA client and calls the existing Node API directly with `Authorization: Bearer <access token>`. The API verifies the same issuer, API audience, required memory scopes, and tenant principal as MCP. Keep access tokens in memory and send requests with `credentials: "omit"`. No client secret or database credential belongs in the frontend.

Set `WEB_ALLOWED_ORIGINS` on the API to a comma-separated list of exact serialized HTTPS origins, for example `https://learn.example.com,https://preview.example.com`. Omit it or leave it empty to permit no external Web origin. Entries cannot include wildcards, `null`, credentials, query strings, fragments, paths, or trailing slashes. HTTP loopback origins are accepted only when the existing `CLOUD_ALLOW_INSECURE_LOCAL=true` development option is explicitly enabled. Origin matching is exact, including scheme and port.

Configured Web origins apply only to supported `/v1` REST routes. MCP, OAuth resource metadata, and health endpoints retain their original same-origin checks. Host validation remains unchanged. Unknown routes do not gain cross-origin access. Requests without an Origin header, such as authenticated native MCP clients, retain their existing behavior.

Browser preflight is unauthenticated but must specify an allowed Origin, a supported REST path and method, and only `Authorization` or `Content-Type` requested headers. Successful preflight returns `204`; actual data requests always require JWT authentication. Trusted origins receive `Access-Control-Allow-Origin` and `Vary: Origin` on REST success and safe error responses. The API never sends `Access-Control-Allow-Credentials`.

| Method | Route | Response / purpose |
| --- | --- | --- |
| GET / PATCH | `/v1/settings` | Read preferences / apply a direct settings patch |
| GET | `/v1/languages` | Existing tenant language catalog: `languages`, `counts`, `kinds`, `by_language` |
| GET | `/v1/changes` | Existing tenant version counters: `content`, `preferences` |
| GET | `/v1/points` | Query with the existing language, kind, scene, keyword, status and pagination filters |
| GET / PATCH / DELETE | `/v1/points/{id}` | Read, edit with `{patch, expected_revision}`, or delete a point |
| GET | `/v1/scenes` | Scene counts with language/kind filters |
| POST | `/v1/captures` | Existing idempotent capture envelope |
| GET | `/v1/review-queue` | Existing review filters |
| POST | `/v1/reviews` | Existing idempotent review envelope |

`/v1/languages` and `/v1/changes` accept no query parameters. Every result is scoped to the verified token's issuer and subject; clients cannot select a tenant with `user_id`. This addition does not change the Python backend or the existing Node MCP transport.
