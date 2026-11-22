# Auth0 setup for the Node MCP backend

Prepared on 2026-11-22 from current official documentation. This is a configuration
plan, not evidence that an Auth0 tenant or a production OAuth connection exists.
The backend remains an authenticated resource server. Auth0 will provide login,
consent, OAuth authorization-code exchange and tokens; no authorization server or
authentication bypass is added to this repository.

The user only needs to complete Auth0 account signup/login and any account terms.
Once that session is available, tenant configuration can be performed through the
observed Dashboard or an authenticated Auth0 CLI session. Do not ask the user to
invent client IDs, copy tokens into chat or manually configure every field.

## Values to collect from the real deployment

Let **P** be the actual public HTTPS service root, without a trailing slash. Let
**R = P + `/mcp`**. Use the same R everywhere below; `/mcp` is significant.

| Setting | Required value |
| --- | --- |
| Railway `PUBLIC_URL` | P, the real Railway/custom-domain root. |
| Auth0 API Identifier | R. |
| Railway `AUTH_AUDIENCE` | R, not an OAuth client ID or the Auth0 Management API. |
| Railway `AUTH_ISSUER` | The exact `issuer` returned by the chosen tenant's discovery document, including its trailing slash. |
| Railway `AUTH_JWKS_URL` | That document's actual `jwks_uri`. |
| Railway `AUTH_REQUIRED_SCOPES` | `memory:read memory:write`. |
| Railway `CLOUD_ALLOW_INSECURE_LOCAL` | `false`. |
| Remote plugin URL | R. Its OAuth `baseScopes` must contain both memory scopes. |

The existing Node verifier requires a signed access token with matching issuer,
audience, unexpired `exp`, a stable nonempty `sub`, a signing-key `kid`, and both
memory scopes in `scope`/`scp`. It does not use an ID token or accept only a
`permissions` array. Its resource metadata already advertises R and the issuer.

## Prepare the Auth0 API and protocol settings

Create the API representing this MCP server with identifier R, **RS256** signing,
and precisely `memory:read` and `memory:write` permissions. If RBAC is enabled,
assign both permissions to the actual learner's role; otherwise the requested
scopes can be reduced before the token reaches our verifier. Do not create an M2M
grant as a substitute for an end-user login. Auth0's
[MCP authorization quickstart](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server)
documents API creation, signing and role configuration.

In **Settings → Advanced → Settings**, enable **Resource Parameter Compatibility
Profile** and **Include Issuer in Authorization Responses**. The first maps a
client's standard `resource` to Auth0's audience; an explicitly supplied `audience`
takes precedence, so it must also equal R. The second enables issuer identification
in the authorization response. Use the actual metadata afterward rather than
assuming the switches succeeded. Do not introduce a tenant-wide Default Audience
to hide a resource mismatch. See
[Auth0's resource compatibility guide](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile).

## Register the actual Codex/OpenAI OAuth client

Prefer **manually imported CIMD**. Obtain the exact client metadata URL and
redirect URI from the real MCP connection management flow. Do not guess the
callback or assume that a ChatGPT example is the current Codex client's identity.
OpenAI requires PKCE **S256**, supports CIMD token authentication with `none` or
`private_key_jwt`, and supports DCR when configured. The actual connection decides
the callback mode. See
[official OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth).

Enable **Client ID Metadata Document Registration**, then use **Applications →
Applications → Create Application → Import from URL**. Preview the actual CIMD
URL, inspect its callbacks and authentication method, and create it. Auth0
supports public CIMD clients with `none` plus PKCE. Its `private_key_jwt` CIMD
authentication requires Enterprise entitlement; do not assume a new account has
it. If the preview selects an unavailable method, verify a supported public-client
registration path before proceeding. **CIMD with Dynamic Registration** is a
separate capability and can be unavailable for a tenant; manual import does not
require enabling it. See
[Auth0 CIMD registration](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd).

For the imported client, configure a per-application **user-delegated** grant:
`client_id` is the real Auth0 ID returned by registration, `audience` is R,
`subject_type` is `user`, and `scope` contains the two memory permissions. Select
those permissions explicitly, rather than granting every future scope. The
[client-grant documentation](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants)
describes the current Dashboard controls and Management API representation.

If this particular Codex connection requires **DCR**, enable Dynamic Client
Registration and retain **Strict** security mode. Configure the API's default
third-party grant with `default_for=third_party_clients`, `subject_type=user`,
`audience=R` and only the two memory scopes. Such defaults are necessary for newly
registered clients to obtain the API permissions. DCR is not needed merely
because CIMD manual import was used. See
[Auth0's DCR guide](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application/dynamic-client-registration).

## Allow login and any requested OIDC scopes

Promote the chosen login connection to domain level so third-party clients can
use it. Inspect the client's actual requested OIDC scopes: OpenAI may request
advertised OIDC scopes in addition to the memory scopes. Current Auth0 docs allow
enabling `oidc_support.is_allowed` for the registered client and selecting
`profile`/`email` under `allowed_scopes`; **do not put `openid` in that allowlist**.
Keep the backend's required scopes unchanged. Current guidance supersedes older
articles claiming that strict clients cannot use OIDC at all. See
[Configure Third-Party Applications](https://auth0.com/docs/get-started/applications/third-party-applications/configure-third-party-applications).

For an existing permissive DCR client, changing the tenant mode does not upgrade
that client; a new strict registration is needed. Check the actual client's
creation mode rather than weakening token checks to compensate. See
[Auth0's legacy strict-mode guidance](https://support.auth0.com/center/s/article/enable-strict-dcr-mode-for-tenant).

## Verify before reporting OAuth as live

1. Retrieve the real tenant's discovery metadata. Check exact `issuer`, reachable
   authorization/token endpoints, `jwks_uri`, `S256`, and the selected client
   registration and token authentication method. Auth0's public JWKS normally
   lives at the tenant's `/.well-known/jwks.json`; use discovery to confirm it.
   [Auth0 JWKS documentation](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets)
   explains signing keys and rotation.
2. Retrieve P + `/.well-known/oauth-protected-resource/mcp`. Confirm resource R,
   the real issuer and both scopes. An unauthenticated protected request must
   continue to return 401 with its resource-metadata challenge.
3. Complete the actual Codex browser authorization and consent flow with PKCE.
   Confirm that the access token—not an ID token or opaque userinfo token—has
   audience R and both scopes, without logging or committing the token.
4. Exercise a read-only MCP call such as `get_settings`. Separately retain
   rejection checks for missing/expired tokens, wrong audience and missing scopes.
5. Verify refresh/reconnection in the actual client. A healthy Railway process,
   reachable JWKS or successful synthetic JWT test alone does not prove the
   browser authorization/callback flow works.

Record only real public URLs, registered client identifiers and observed results
after setup. Keep credentials in their provider/secret manager. Auth0 management
tokens and OAuth client secrets are not required by this JWT-verifying backend
and must not be placed in either plugin manifest.
