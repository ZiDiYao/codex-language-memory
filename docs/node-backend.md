# Node.js remote backend

`backend-node/` is an independent Node.js implementation of the PostgreSQL,
REST and Streamable HTTP MCP backend. It runs native JavaScript ES modules on
Node.js 24 or later. Production startup, migrations and requests do not invoke
Python. The Python implementation in `cloud/`, its requirements, Alembic migration,
Dockerfile and original Compose setup are retained.

Both implementations use the same nine PostgreSQL tables and the
`0001_remote_storage` revision in `alembic_version`. Tenant identities derive from
the same verified issuer/subject pair. Normalization, capture/review receipts,
note revisions, structured word senses, scenes and FSRS-6 card serialization are
compatible so changing the backend does not create a new account or reset notes.
Keep the external issuer, subject identifiers and database unchanged when switching.
Local desktop SQLite data is still separate and is not uploaded automatically.

## Run directly

From the repository root:

```sh
cd backend-node
npm ci --ignore-scripts
```

Supply these environment variables through your process environment or secret
manager. The settings match the Python backend:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL, such as `postgresql://user:password@host:5432/memory`. |
| `PUBLIC_URL` | External HTTPS service root without a path, query or fragment. |
| `AUTH_ISSUER` | Exact external issuer, including any trailing slash. |
| `AUTH_AUDIENCE` | Audience identifying this API in the access token. |
| `AUTH_JWKS_URL` | Configured provider's HTTPS signing-key endpoint. |
| `AUTH_REQUIRED_SCOPES` | Space-separated scopes; defaults to `memory:read memory:write`. |
| `HOST` / `PORT` | Bind address and port; defaults to `0.0.0.0` / `8080`. |
| `CLOUD_ALLOW_INSECURE_LOCAL` | Defaults to `false`; explicit local development permits HTTP loopback URLs, while authentication stays required. |

```sh
npm run migrate
npm start
```

Migration runs separately from startup. On an empty database the Node migration
creates the shared schema; on a compatible Python/Alembic database it leaves the
data intact. It rejects unknown revisions and unversioned partial schemas. Run
one migration process per deployment and do not run an Alembic migration and a
Node migration concurrently. Future schema changes must update both migration
paths before they can share a database safely.

The Node service does not read `.env` automatically. To load the repository's
configured `.env` explicitly from `backend-node/`, use Node's built-in loader:

```sh
node --env-file=../.env src/migration.js
node --env-file=../.env src/main.js
```

Set a real `DATABASE_URL` in that file when running directly. `.env.example`'s
Compose password and provider placeholders do not supply a working database or
authorization provider by themselves.

## Docker

For a Railway deployment with a separate PostgreSQL service, follow the
[Railway setup and account steps](railway-deployment.md). The guide covers the
`/backend-node` source root, explicit pre-deploy migration, private database
reference and real OAuth configuration.

The original `compose.yaml` continues to select Python. Add the Node override to
select the independent Node image, migration command and PostgreSQL driver URL:

```sh
cp .env.example .env
# Set the database password and the real public/provider configuration in .env.
docker compose -f compose.yaml -f compose.node.yaml build backend
docker compose -f compose.yaml -f compose.node.yaml up -d postgres
docker compose -f compose.yaml -f compose.node.yaml run --rm migrate
docker compose -f compose.yaml -f compose.node.yaml up -d backend
```

This uses the same PostgreSQL volume as the original Compose project. To switch
an existing deployment, back up its database, stop only its backend service,
run the selected migration and recreate that backend with the chosen Compose
configuration. Do not remove the database volume. Switching back uses the
original `docker compose` commands and Python image.

The Node runtime image contains no Python runtime. It runs as the `node` user;
the Compose deployment retains a read-only filesystem, dropped capabilities and
loopback-only published backend port. PostgreSQL has no published host port.

## API and authentication

The service uses `/mcp` for stateless Streamable HTTP and the same `/v1/settings`,
`/v1/points`, `/v1/captures`, `/v1/scenes`, `/v1/review-queue` and `/v1/reviews`
REST endpoints as Python. `/healthz` checks liveness; `/readyz` checks database
connectivity and the expected schema revision. Missing or invalid bearer tokens
are rejected. Discovery is public at
`/.well-known/oauth-protected-resource/mcp`.

Configure an external OAuth 2.1 provider that issues signed access tokens with
the required issuer, subject, audience, expiry and scopes. The Node service is a
resource server; it does not replace the provider's login, callback registration,
PKCE or token issuance. Requests cannot select a tenant with a `user_id` field.
The SDK receives a fresh MCP server and transport per request. Account-scoped
database transactions preserve the same capture and review idempotency rules.

The configured remote package uses the public name **Sayrove**, targets
`https://language-memory-api.up.railway.app/mcp` and selects DCR with the Auth0
tenant `language-memory.ca.auth0.com`. Its minimal OAuth request contains only
`memory:read memory:write offline_access`; extra OIDC identity defaults are disabled.
The backend itself still requires only the two memory scopes. See
[Auth0 setup](auth0-setup.md) for provider grants, public discovery values and the
browser login checks still required before claiming end-to-end authorization.

Place the backend behind an HTTPS ingress, set `PUBLIC_URL` to its actual public
root and preserve the public `Host` header. Origin and host validation must remain
consistent with that URL. Request bodies are limited to 1 MiB. Error responses
and application logs omit tokens, database URLs, SQL parameters and learning text.

There is no new cloud UI, pronunciation, document export, local-data import or
public plugin listing in this change. Those remain later features. See the
[shared provider, backup and publication requirements](remote-backend.md).

## Verification

```sh
cd backend-node
npm test
```

For database tests, set `TEST_DATABASE_URL` to a dedicated disposable PostgreSQL
database. Tests create and remove isolated schemas inside that database. To also
run cross-runtime compatibility checks, install `requirements-cloud-dev.txt` in a
Python environment and set `PYTHON_EXECUTABLE` to that environment's Python.

The interop tests exercise Node-created and Python-created schemas, save/review
receipt replays in both directions, Unicode identity, revisions, custom notes,
word senses, scenes and reading each other's FSRS cards. Python is used only by
those compatibility tests. GitHub CI runs Node and PostgreSQL tests alongside the
retained Python and desktop checks, and builds both independent runtime images.
