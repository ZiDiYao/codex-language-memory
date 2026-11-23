# Sayrove Web deployment

Sayrove (拾语 in Chinese) reuses the existing learning-library UI as a separate
authenticated Web app. The Node.js API and private PostgreSQL service continue
to hold account-scoped records; the Web service never receives database
credentials or an OAuth client secret. The Python backend remains available.

## Services and public endpoints

- Web: `https://sayrove.up.railway.app` (Railway service `sayrove-web`).
- API: `https://language-memory-api.up.railway.app`.
- MCP resource and Auth0 audience: `https://language-memory-api.up.railway.app/mcp`.
- Auth0 issuer: `https://language-memory.ca.auth0.com/`.

These domains are configured deployment targets. Confirm the actual rollout and
browser checks below before treating a deployment as usable. The underlying
repository, plugin machine identifiers, issuer, audience and existing local data
paths retain their compatibility names.

## Dedicated Auth0 Web application

Use a public **Single Page Application**, named **Sayrove Web**, in the existing
tenant. Its public Client ID is supplied through `AUTH0_CLIENT_ID`; no client
secret belongs in Web configuration or browser bundles.

Set these exact application URLs:

| Setting | Value |
| --- | --- |
| Allowed Callback URLs | `https://sayrove.up.railway.app/auth/callback` |
| Allowed Logout URLs | `https://sayrove.up.railway.app` |
| Allowed Web Origins | `https://sayrove.up.railway.app` |

Enable authorization-code and refresh-token grants, RS256 and OIDC authentication.
The client requests `openid memory:read memory:write offline_access`. Profile and
email scopes are not requested. Authorize this client's user-delegated access to
the API with precisely the two memory permissions; leave machine-to-machine
access disabled. Keep API offline access enabled and user consent required.
The existing email/password connection must be available to the Web application.

The Auth0 SDK uses S256 PKCE, its default memory token cache and a separately
served same-origin worker. Tokens are not put in URLs or persistent browser
storage. Rotating refresh tokens preserve the signed-in session while the page
is active. After a reload, Auth0 may restore its existing login session; otherwise
the page presents an explicit sign-in action.

## Build and Railway configuration

```sh
npm ci --ignore-scripts
npm run build:web
docker build -f frontend-web/Dockerfile -t sayrove-web .
```

The build produces `build/cloud-web/` with external JavaScript, CSS and the Auth0
worker. Docker uses the repository root as context and the dedicated
`frontend-web/Dockerfile.dockerignore`; its runtime contains only built public
assets and the nonroot static Node server.

| Railway Web setting | Value |
| --- | --- |
| Root Directory | `/` |
| Dockerfile Path | `/frontend-web/Dockerfile` |
| Start Command | `node frontend-web/server.mjs` |
| Healthcheck | `/healthz` |
| Replicas | `1` initially |
| Restart policy | On failure, maximum `3` retries |

Set Web variables from [the public configuration example](../frontend-web/.env.example):
`PUBLIC_URL`, `APP_NAME`, `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`,
`API_BASE_URL`, `HOST` and `PORT`. Keep `WEB_ALLOW_INSECURE_LOCAL=false` in hosted
environments. Only the five public UI configuration values are returned by
`/config.json`; they can be changed without rebuilding static assets.

On the **API service**, set
`WEB_ALLOWED_ORIGINS=https://sayrove.up.railway.app`, with no trailing slash.
REST CORS uses an exact origin allowlist; actual requests still require the same
JWT and memory scopes. MCP and other API origin rules stay separate. See
[the Web API contract](web-api.md).

## Browser acceptance

Verify the public landing page, external assets, `/config.json` and `/healthz`.
Sign in through the dedicated Web application and confirm the callback returns
to a clean `/` URL. Confirm `/v1/settings`, `/v1/languages`, `/v1/changes`, scenes
and paginated points load with bearer authorization and the exact Web Origin.
Check refresh/reconnection and that unrelated Origins and unauthenticated
requests remain rejected.

An expired token or a different account pauses old requests; failed drafts block
sign-out and are not silently saved under a different account. Logout and
re-authentication use a new document, and a browser-back cache restore reloads
the page. Verify the narrow mobile layout as well as the normal desktop layout.

The Web milestone is the learning-record library. It does not include a standalone
AI tutor, new quizzes, cloud document export or server pronunciation. Unsupported
desktop-only controls are hidden. Existing local records are not automatically
uploaded; an empty cloud account remains empty until real records are saved
through its connected assistant.

## Own domain later

The user selected a Railway-provided address for this first rollout. A registered
brand domain can later map its main hostname to Web; configure the DNS records
returned by Railway and wait for certificate verification. Update the Web public
URL, Auth0 callback/logout/origin entries and API CORS allowlist together. Keep
the existing API resource/audience stable unless a coordinated API migration is
also intended. No domain purchase or DNS ownership change is part of this rollout.
