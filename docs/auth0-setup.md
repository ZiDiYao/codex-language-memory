# Auth0 setup for the Node MCP backend

Configuration updated on 2026-11-22 using the selected Railway endpoint and the
created Auth0 tenant `language-memory.ca.auth0.com`. This documents public
configuration, not a verified Codex browser login or completed OAuth connection.
The backend remains an authenticated resource server. Auth0 provides login,
consent, OAuth authorization-code exchange and tokens; no authorization server or
authentication bypass is added to this repository.

Tenant configuration can be performed through the owner's Dashboard session or
an authenticated Auth0 CLI session. DCR supplies the real OAuth client ID during
the actual connection flow; no invented client ID or shared token is needed.

## Selected public configuration

**P** is `https://language-memory-api.up.railway.app` and **R** is
`https://language-memory-api.up.railway.app/mcp`. Use the same R everywhere below;
`/mcp` is significant. The discovery checks below must confirm these settings.

| Setting | Required value |
| --- | --- |
| Railway `PUBLIC_URL` | `https://language-memory-api.up.railway.app` |
| Auth0 API Identifier | `https://language-memory-api.up.railway.app/mcp` |
| Railway `AUTH_AUDIENCE` | `https://language-memory-api.up.railway.app/mcp`, not an OAuth client ID or the Auth0 Management API. |
| Railway `AUTH_ISSUER` | `https://language-memory.ca.auth0.com/`, including the trailing slash; confirm against discovery. |
| Railway `AUTH_JWKS_URL` | `https://language-memory.ca.auth0.com/.well-known/jwks.json`; confirm against discovery's `jwks_uri`. |
| Railway `AUTH_REQUIRED_SCOPES` | `memory:read memory:write`. |
| Railway `CLOUD_ALLOW_INSECURE_LOCAL` | `false`. |
| Remote plugin URL | R. OAuth `baseScopes` contains both memory scopes and `offline_access`. |

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

The remote package explicitly selects **DCR**, which lets the real host register
its own client and callbacks. This avoids requiring an unknown CIMD URL. Keep
authorization-code flow with PKCE **S256** and end-user consent. See
[official OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth).

The `auth` object inside `extensions.com.openai` is:

```json
{
  "type": "oauth",
  "client": { "mode": "dcr" },
  "baseScopes": ["memory:read", "memory:write", "offline_access"],
  "defaultScopes": [],
  "oidcEnabled": false
}
```

The two memory scopes and `offline_access` are explicitly requested. Empty defaults
and the OIDC override omit unrelated `openid`/profile/email requests; OAuth
authentication remains required. Discovery supplies the registration,
authorization and token endpoints, so the manifest needs no endpoint overrides
or credentials. Offline access requests refresh support, without requesting an
ID token. These fields are documented
in [official plugin packaging](https://developers.openai.com/plugins/build/plugins).

In Auth0, enable **Dynamic Client Registration (DCR)** and retain **Strict** mode.
CIMD registration and dynamic CIMD are not needed for this selected path. Under
the API's **Default Permissions for Third-Party Applications**, authorize only
**User-Delegated Access** for the two memory permissions; keep default Client
Access unauthorized. Auth0 needs this baseline for automatically created clients.
An open DCR endpoint permits registrations by other clients, so monitor registration
activity; strict grants and user consent still limit API access. See
[Auth0's DCR guide](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application/dynamic-client-registration).

The corresponding default client-grant data is:

```json
{
  "default_for": "third_party_clients",
  "audience": "https://language-memory-api.up.railway.app/mcp",
  "subject_type": "user",
  "scope": ["memory:read", "memory:write"]
}
```

Inspect existing grants before creating another one. Select those two permissions
explicitly, rather than granting future scopes. If RBAC is enabled, the actual
learner must also have those permissions. The
[client-grant documentation](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants)
explains the grant ceiling and its intersection with user permissions and consent.

## Login connection and optional later features

Promote the chosen login connection to domain level so third-party clients can
use it. The selected manifest omits OIDC identity scopes, so it does not require
enabling them for each new DCR client. If the package later enables OIDC, inspect
the actual scope request and configure the registered client's
`oidc_support.is_allowed` and `profile`/`email` allowlist; do not put `openid` in
that allowlist. See
[Configure Third-Party Applications](https://auth0.com/docs/get-started/applications/third-party-applications/configure-third-party-applications).

Auth0's current [plan comparison](https://auth0.com/pricing) includes Auth for MCP
in Free. This route does not require dynamic CIMD or Enterprise-only CIMD
`private_key_jwt`. A later move to CIMD should import the actual host's metadata
URL and verify tenant entitlement and supported token authentication method.
[Auth0 CIMD registration](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd)
documents those distinctions.

For refresh, the API's **Allow Offline Access** setting must be enabled and the
actual DCR client must allow the `refresh_token` grant. The selected manifest
requests `offline_access`; provider configuration has enabled API offline access.
Verify refresh and revocation in the actual client before claiming persistent
authorization. An initial access-token exchange alone does not prove this.
[Auth0's PKCE API guide](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce/call-your-api-using-the-authorization-code-flow-with-pkce)
documents the offline-access and refresh-token prerequisites.

For an existing permissive DCR client, changing the tenant mode does not upgrade
that client; a new strict registration is needed. Check the actual client's
creation mode rather than weakening token checks to compensate. See
[Auth0's legacy strict-mode guidance](https://support.auth0.com/center/s/article/enable-strict-dcr-mode-for-tenant).

## Verify before reporting OAuth as live

1. Retrieve
   `https://language-memory.ca.auth0.com/.well-known/openid-configuration`.
   Check exact `issuer`, reachable
   authorization/token endpoints, `jwks_uri`, `S256`, and the selected client
   registration and token authentication method. Auth0's public JWKS normally
   lives at the tenant's `/.well-known/jwks.json`; use discovery to confirm it.
   [Auth0 JWKS documentation](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets)
   explains signing keys and rotation.
2. Retrieve
   `https://language-memory-api.up.railway.app/.well-known/oauth-protected-resource/mcp`.
   Confirm resource R,
   the real issuer and both scopes. An unauthenticated protected request must
   continue to return 401 with its resource-metadata challenge.
3. Complete the actual Codex browser authorization and consent flow with PKCE.
   Confirm that the access token—not an ID token or opaque userinfo token—has
   audience R and both scopes, without logging or committing the token.
4. Exercise a read-only MCP call such as `get_settings`. Separately retain
   rejection checks for missing/expired tokens, wrong audience and missing scopes.
5. Verify a refresh-token exchange and another read-only MCP request, followed by
   reauthorization/reconnection in the actual client. A healthy Railway process,
   reachable JWKS or successful synthetic JWT test alone does not prove the
   browser authorization/callback flow works.

Record only real public URLs, registered client identifiers and observed results
after setup. Keep credentials in their provider/secret manager. Auth0 management
tokens and OAuth client secrets are not required by this JWT-verifying backend
and must not be placed in either plugin manifest.
