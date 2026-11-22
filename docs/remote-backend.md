# Experimental remote backend

This page documents the retained Python implementation in `cloud/`. The separate
[Node.js implementation](node-backend.md) uses the same PostgreSQL schema and HTTP
contract and can be deployed without installing Python.

The cloud service is separate from the desktop Beta. It stores learning records
in PostgreSQL and exposes authenticated REST and Streamable HTTP MCP endpoints.
An account is identified by the verified JWT issuer and subject; a client cannot
choose another account by supplying a user ID. Scene membership can overlap and
combine with the existing type and language filters.

This milestone does not serve the desktop page or native sidebar App, export
documents, or play pronunciation. It does not upload the local SQLite database,
register a public plugin, or provide an OAuth authorization server. Existing
desktop records and settings stay local unless a future explicit import is added.

## External authorization provider

Provision a provider that can complete the target client's OAuth 2.1
authorization-code flow with PKCE S256. Configure its authorization and token
endpoints, discovery metadata, allowed callbacks, and client registration for the
actual Codex/ChatGPT client. Depending on the provider and client, that means
supported Client ID Metadata Documents, dynamic registration, or a preregistered
client. Those facilities belong to the provider; this repository only implements
the protected resource server and JWT verification.

The provider must issue a signed **access token**, not an ID token, containing:

- `iss`: exactly `AUTH_ISSUER`, including any trailing slash.
- `sub`: the stable, nonempty account identifier at that issuer.
- `aud`: `AUTH_AUDIENCE`, identifying this API.
- `exp`: an expiration time; expired tokens are rejected.
- `scope` or `scp`: the configured required scopes. By default every protected
  REST and MCP operation requires both `memory:read` and `memory:write`.
- A signature whose key is available at the configured HTTPS JWKS endpoint.

Accepted signing algorithms are RS256/384/512, ES256/384/512 and EdDSA. Configure
issuer, audience and JWKS independently; an arbitrary JWT from the same identity
provider must not grant access if its audience or scopes differ. The service does
not implement provider login, token issuance, opaque-token introspection or refresh
tokens. The provider controls token lifetime, key rotation and authorization.

The MCP protected-resource metadata is available at
`/.well-known/oauth-protected-resource/mcp`. Its resource is `PUBLIC_URL/mcp` and
its authorization server is the configured issuer. This metadata advertises the
external provider; it does not implement that provider's endpoints.

## Configuration

Python 3.12 is used by the container and CI. These process environment variables
configure `python -m cloud.main`:

| Variable | Required/default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | Required | PostgreSQL URL, preferably `postgresql+psycopg://user:password@host:5432/database`. |
| `PUBLIC_URL` | Required | External HTTPS root, such as `https://memory.example.com`; no path, query or fragment. |
| `AUTH_ISSUER` | Required | Exact HTTPS issuer expected in access-token `iss`. |
| `AUTH_AUDIENCE` | Required | API audience expected in `aud`. |
| `AUTH_JWKS_URL` | Required | Provider's HTTPS signing-key endpoint. |
| `AUTH_REQUIRED_SCOPES` | `memory:read memory:write` | Space-separated nonempty scope list. Keep the plugin manifest's scopes consistent. |
| `HOST` | `0.0.0.0` | Container/process bind address. |
| `PORT` | `8080` | Container/process port. |
| `CLOUD_ALLOW_INSECURE_LOCAL` | `false` | Explicit development option for HTTP loopback URLs and test SQLite; JWT authentication still applies. |

Missing authentication configuration prevents startup. There is no anonymous
production mode, shared access token, default identity, or OpenAI API key to set.
Python does not read `.env` automatically; Compose reads it for interpolation.

For direct Python execution with an already configured PostgreSQL database:

```sh
python -m venv .venv-cloud
.venv-cloud/bin/python -m pip install -r requirements-cloud.txt
# Supply the required variables through your environment or deployment secret manager.
.venv-cloud/bin/python -m alembic upgrade head
.venv-cloud/bin/python -m cloud.main
```

`uvicorn cloud.main:app --host 0.0.0.0 --port 8080 --no-access-log` is an alternative
ASGI entry. Keep access logging disabled so user search queries are not logged.
Neither entry applies migrations on startup. Run migrations once per deployment
before accepting traffic; do not have concurrent workers race to migrate.

## Docker Compose

Compose includes PostgreSQL 17, a persistent named volume, a nonroot backend and
an explicit migration command. The database has no published host port. The
backend is published only on `127.0.0.1:8080` by default, and waits for PostgreSQL
to report healthy. The runtime filesystem is read-only with a temporary `/tmp`.

```sh
cp .env.example .env
```

Edit `.env`: set `POSTGRES_PASSWORD` to your own random hexadecimal password and
replace all example service/provider URLs and the audience. A hexadecimal password
can be generated with `python -c 'import secrets; print(secrets.token_hex(32))'`.
Compose interpolates the password into a database URL, so use hexadecimal here;
URL-encode any special characters when supplying a different URL directly.
The example contains no working credential or OAuth provider.

```sh
docker compose build backend
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d backend
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

`BACKEND_PORT` changes the host-side port without changing the backend's 8080
container port. The image health check follows the process's `PORT` setting.
`POSTGRES_PASSWORD` is required even for
local Compose. Changing it after a database volume has been initialized does not
rotate the existing PostgreSQL role's password; rotate that role explicitly.

The deployment is not publicly reachable just because the container is running.
Put an HTTPS reverse proxy or your hosting platform's TLS ingress in front of it,
forward the complete service paths, and set `PUBLIC_URL` to that actual external
root. The MCP route is `/mcp`. Preserve the original public `Host` header when
proxying MCP requests: transport protection allows the host configured in
`PUBLIC_URL` and will reject an upstream-only host such as `backend:8080`.
Keep the reverse proxy's allowed origins and trusted forwarding configuration
under your deployment's control. Avoid logging query strings at the ingress as
well; the backend disables its own access logs. Do not expose the
PostgreSQL port to clients.

For a direct loopback-only development process, HTTP URLs can be enabled with
`CLOUD_ALLOW_INSECURE_LOCAL=true`, for example `PUBLIC_URL=http://127.0.0.1:8080`
and an actual local test provider issuer/JWKS URL. It still needs valid signed
tokens with the right claims. Inside a container, `127.0.0.1` means that container,
not the host's test provider; the provided Compose deployment intentionally uses
HTTPS provider configuration and leaves this bypass disabled.

## Health and client checks

- `/healthz` checks process liveness and requires no token.
- `/readyz` checks database reachability and that the Alembic schema revision is
  exactly the revision expected by this application. An empty, older or newer
  schema returns 503; this check does not apply migrations or verify an external login.
- `/.well-known/oauth-protected-resource/mcp` is public discovery metadata.
- Protected REST and `/mcp` requests require `Authorization: Bearer <access token>`.
  Missing or invalid credentials must fail instead of falling back to an account.

The REST surface uses JSON bodies for writes and query parameters for listing:

| Endpoint | Methods | Purpose |
| --- | --- | --- |
| `/v1/settings` | GET, PATCH | Read or change the authenticated account's recording/preferences settings. |
| `/v1/points` | GET | List/search points; combine `language`, `kind`, `scene`, `status` and pagination. |
| `/v1/captures` | POST | Save a batch with a unique `request_id`, `items` and optional `source`. |
| `/v1/points/{record_id}` | GET, PATCH, DELETE | Read, edit with `patch`/`expected_revision`, or remove one account-owned point. |
| `/v1/scenes` | GET | List scene names/counts for an optional language/type scope. |
| `/v1/review-queue` | GET | Retrieve eligible review points without recording an answer. |
| `/v1/reviews` | POST | Record an actual answer with `record_id`, unique `request_id` and `review`. |

Retries of a capture/review reuse the same request ID and identical arguments;
new encounters/attempts need a fresh ID. Missing or other-account point IDs do not
grant access. Query flags use `true`/`false` (or `1`/`0`). Point kinds remain
`word`, `expression`, `grammar` and `correction`; scenes form a separate dimension.

A quick authentication smoke check uses no learning data:

```sh
curl -i -X POST http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' -d '{}'
curl -fsS http://127.0.0.1:8080/.well-known/oauth-protected-resource/mcp
```

The first call must be rejected as unauthenticated. For an authenticated
end-to-end test, obtain a real provider token and use an MCP client that supports
Streamable HTTP, or connect the remote manifest template to the intended host.
Token validation tests alone do not establish that the provider's browser login,
callback registration and client-registration flow work with that host.

## Tests

```sh
python -m pip install -r requirements-cloud-dev.txt
python -m unittest discover -s tests -p 'test_cloud*.py' -v
```

Repository unit tests can use isolated SQLite databases. Set `TEST_DATABASE_URL`
to a **dedicated disposable PostgreSQL database** to exercise the same repository
against PostgreSQL. These tests create and drop their tables; never point the
variable at a development library or production database.

```sh
TEST_DATABASE_URL=postgresql+psycopg://user:password@127.0.0.1:5432/disposable_tests \
  python -m unittest discover -s tests -p 'test_cloud*.py' -v
```

The cloud CI workflow supplies PostgreSQL 17, tests forward and reverse Alembic
migrations, runs cloud tests with that database and builds the runtime image.
The existing desktop checks continue to run separately. Authentication tests use
isolated signing keys and test verifiers; no production provider credential is
required or stored in the repository.

## Backups and upgrades

Keep backups outside the container volume and protect them as learning data.
For the supplied Compose database, a custom-format PostgreSQL backup is:

```sh
docker compose exec -T postgres \
  pg_dump -U language_memory -d language_memory -Fc > language-memory-backup.dump
```

Test restoration into a separate database with `pg_restore` before relying on the
backup. In production, use your database platform's scheduled backups and recovery
facilities. `docker compose down` retains the named volume; `down -v` deletes it.

Before upgrading, create a backup and review the migration. Build the new image,
run `docker compose run --rm migrate` once, then replace backend containers.
Choose a rollback using the compatibility of that migration and its matching
application version; do not automatically overwrite a live database with an old
backup or assume that rolling back the image reverses a schema migration.

## Remote template and publication boundary

[`packaging/remote`](../packaging/remote/README.md) contains a remote MCP plugin
manifest template. Set its HTTPS URL and ensure that its scope list matches the
resource server and authorization provider. It contains no client secret and
does not require a local desktop executable.

Before a public release, deploy an actual domain and TLS ingress; configure and
test the provider's full OAuth flow in the target client; adapt the learning Skill
to the cloud tool set; validate manifests and required listing assets; complete
host acceptance and security review; and provide the required privacy/support and
data-deletion information. Rate limits, monitoring and a tested backup/recovery
process also belong to an operated service. This implementation and its template
do not mean the plugin has been submitted, accepted or listed publicly.

Remote plugin configuration follows [official plugin packaging](https://developers.openai.com/plugins/build/plugins).
