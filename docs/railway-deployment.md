# Deploy the Node backend to Railway

This guide deploys `backend-node/` and a separate PostgreSQL service. The Python
backend and desktop plugin remain available. The selected public service root is
`https://language-memory-api.up.railway.app`; the remote package targets its `/mcp`
endpoint. Public configuration below does not establish that the client OAuth
login/consent/callback flow has passed acceptance testing.

Deployment `787bbb7e-409e-4083-bd2d-019028639421` from commit `21a63bd`
succeeded. Its migration reported `0001_remote_storage`. Public `/healthz`,
`/readyz` and protected-resource metadata checks returned 200; unauthenticated
`/mcp` and `/v1/settings` returned 401 with the expected metadata challenge.
Invalid bearer authentication returned 401 and a foreign Origin returned 403.
These are deployment and access-control checks; the real Codex browser OAuth
flow remains pending.

## Account steps

1. Sign in to Railway and choose the workspace that should own the service and
   its usage charges. If Codex is doing the deployment, connect the Railway plugin
   to that account. Complete any Railway/GitHub consent in the account interface;
   do not paste access tokens, database passwords or provider secrets into chat.
2. Authorize Railway's GitHub integration to read this repository when deploying
   from GitHub. Choose the intended branch/commit, rather than the desktop ZIP.
3. Have an actual external OAuth provider configured for this API. Required
   issuer, audience, signing-key URL, access-token scopes and client login details
   are described below. The [Auth0 setup guide](auth0-setup.md) gives a concrete
   provider configuration path. Without them, prepare the infrastructure and leave the
   authenticated application deployment pending.

## Project and service settings

Create an empty project, add PostgreSQL, and add an empty application service named
`language-memory-api`. Keep the application and database in the same project,
environment and region. Set the application settings before triggering its first
deployment. The deployment source is the repository; the isolated build directory
is `/backend-node`. Railway's monorepo guide distinguishes that source root from
the configuration-file path. [Railway monorepos](https://docs.railway.com/deployments/monorepo)

| Application setting | Value |
| --- | --- |
| Root Directory | `/backend-node` |
| Builder | Dockerfile |
| Dockerfile Path in the Railway dashboard | `/backend-node/Dockerfile` |
| Docker build context | `backend-node` |
| Pre-deploy command | `node src/migration.js` |
| Pre-deploy timeout | 300 seconds |
| Start command | `node src/main.js` |
| Healthcheck path | `/readyz` |
| Healthcheck timeout | 300 seconds |
| Restart policy | On failure, maximum 3 retries |
| Replicas | 1 initially |

The dashboard's Dockerfile Path is repository-relative even though Root Directory
is `/backend-node`; the Docker build context remains `backend-node`.
The Node Dockerfile uses only that subdirectory. Do not select the repository's
root Python Dockerfile or start the desktop stdio server. No filesystem volume is
needed on the API service; durable learning records live in PostgreSQL.

Apply the table through the service settings or Railway API, then verify the
effective deployment configuration before accepting traffic. **As checked on
2026-11-22, Railway marks legacy `railway.json` Config as Code deprecated, with
legacy-service support ending 2026-12-01.** New project automation should use its
current Infrastructure as Code workflow; this guide uses explicit service settings.
[Config reference](https://docs.railway.com/config-as-code/reference),
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)

When the current Railway CLI is available, link it to the intended project and
environment, then set the source root using Railway's documented service-config
command:

```sh
railway link
railway environment edit --service-config language-memory-api source.rootDirectory /backend-node
```

Confirm the target service and apply the remaining table values in its settings
before deploying. When setting them through an agent/API, use the same source,
build and deploy settings and read them back to verify the selected service.
Keep runtime/provider values in the service's Variables tab rather than the source
repository.

## PostgreSQL and application variables

Use the PostgreSQL service's private `DATABASE_URL` through a reference variable.
For a database service named exactly `Postgres`, set this on the API service:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Substitute the actual database service name if it differs. Keep the database
private; `DATABASE_PUBLIC_URL` is unnecessary for API-to-database traffic inside
the project. [Railway PostgreSQL](https://docs.railway.com/databases/postgresql),
[reference variables](https://docs.railway.com/variables/reference)

Configure these variables on the **API service**:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Private service reference above. |
| `PUBLIC_URL` | `https://language-memory-api.up.railway.app` |
| `AUTH_ISSUER` | `https://language-memory.ca.auth0.com/`; confirm exact agreement with tenant discovery. |
| `AUTH_AUDIENCE` | `https://language-memory-api.up.railway.app/mcp` |
| `AUTH_JWKS_URL` | `https://language-memory.ca.auth0.com/.well-known/jwks.json`; confirm the tenant's `jwks_uri`. |
| `AUTH_REQUIRED_SCOPES` | `memory:read memory:write` unless deliberately changed everywhere. |
| `SAYROVE_ENRICHMENT_PROVIDER` | `deepseek` by default; explicit `openai` or `openai-compatible` supported. |
| `SAYROVE_ENRICHMENT_MODEL` | `deepseek-flash` by default for DeepSeek; configure the selected vendor's model. |
| `DEEPSEEK_API_KEY` | Backend secret for DeepSeek; never expose in the web app or desktop plugin. |
| `CLOUD_ALLOW_INSECURE_LOCAL` | `false`. |
| `HOST` | `0.0.0.0`. |
| `PORT` | Use Railway's injected port, or explicitly set `8080` and match the public target port. |

Generate a Railway public domain in the API service's networking settings, or
configure your own domain. Then set `PUBLIC_URL` to its actual HTTPS root. When
using Railway's provided domain, `https://${{RAILWAY_PUBLIC_DOMAIN}}` can reference
the bare domain variable; ensure that the public domain exists before relying on
that reference. Use the same final public address in the remote plugin manifest.
[Railway domain variables](https://docs.railway.com/variables/reference)

The application requires every authentication variable at startup. An invented
issuer/JWKS URL may satisfy syntax validation but does not provide working login.
Do not use placeholder domains or a shared bearer token to claim completion.

For other suppliers, endpoint/key selection and extension contracts are documented in
[backend enrichment](../backend-node/ENRICHMENT.md). Missing credentials leave raw
captures pending; configure the API service before enabling note generation.

## Deploy and verify

Deploy the configured commit after the database is running and real provider
configuration is available. The pre-deploy migration initializes an empty
database, or verifies the existing shared schema. It must succeed before the API
starts; it does not need an application process or local volume. A failed
pre-deploy command stops the deployment.
[Pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)

The API binds to `HOST` and `PORT`. Its `/readyz` response checks the database and
expected schema revision. Railway health probes use `healthcheck.railway.app` as
the Host header; compatibility is limited to the unauthenticated health routes,
while MCP/REST host and origin validation remain tied to `PUBLIC_URL`. Railway's
deployment healthcheck does not provide continuous uptime monitoring.
[Railway healthchecks](https://docs.railway.com/deployments/healthchecks)

Read-only checks for the selected public domain:

```sh
curl -fsS https://language-memory-api.up.railway.app/healthz
curl -fsS https://language-memory-api.up.railway.app/readyz
curl -fsS https://language-memory-api.up.railway.app/.well-known/oauth-protected-resource/mcp
curl -i https://language-memory-api.up.railway.app/v1/points
```

Expect healthy checks to return 200, discovery to advertise the actual resource
and issuer, and the unauthenticated points request to return 401. The service is
an API; a browser request to `/` is not a learning dashboard.

Then complete the target client's OAuth login and test an authenticated MCP
initialization, a save/query/retry, and account isolation. A green deployment or
public discovery response alone is not proof that login or plugin access works.

## OAuth completion and operating the service

The backend validates signed access tokens; it does not supply a login page,
authorization endpoint or token issuer. The external provider must support the
target client's authorization-code flow with PKCE S256 and an appropriate client
registration mechanism, and issue this API's audience and required scopes.
Configure callbacks/client registration with the actual host before marking the
plugin usable. The remote package selects DCR and requests the two memory
scopes plus `offline_access`; it does not depend on an unknown CIMD URL or Enterprise-only client-key
authentication. Configure Auth0's DCR Strict and default user-delegated grant as
described in [Auth0 setup](auth0-setup.md). See also
[the provider contract](remote-backend.md#external-authorization-provider).

Keep credentials in service variables, enable suitable database backups and test
recovery, and monitor usage and failures. Changing the application image does not
roll back database contents. The current migrations are additive/shared with
Python; do not run Node and Python migrators concurrently or delete the database
service/volume when redeploying the API. Local desktop SQLite records are not
uploaded by this setup. See [backup and upgrade guidance](remote-backend.md#backups-and-upgrades).

This deployment does not add a cloud UI, audio playback, document exports or a
public plugin-directory listing.
