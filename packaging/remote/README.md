# Language Memory remote plugin

This package targets the Node service at
`https://language-memory-api.up.railway.app/mcp` with the public display name
**Language Memory**. Its package ID remains `language-memory-cloud`, separate
from the desktop plugin. A configured manifest is not evidence of installation,
publication or a completed browser OAuth flow.

OAuth uses Dynamic Client Registration (DCR) with PKCE. The client registers
through the actual Auth0 discovery endpoint; the package contains no client ID,
client secret or shared token. `memory:read`, `memory:write` and `offline_access`
are requested. `defaultScopes: []` and `oidcEnabled: false` omit extra OIDC identity defaults;
they do not disable OAuth, PKCE, access-token validation or user consent. This
scope set requests refresh support without requesting an ID token. Actual refresh
token issuance and use still require provider configuration and browser-flow testing.

The selected authorization server is the Auth0 tenant
`language-memory.ca.auth0.com`. Configure DCR Strict, domain-level login and the
API's default third-party user-delegated grant before testing the actual Codex
connection. The API audience is exactly the MCP URL above. See the
[concrete Auth0 configuration and pending acceptance checks](../../docs/auth0-setup.md).
`AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL` configure backend validation;
they do not configure the provider's authorization server themselves.

The desktop Skill is not bundled here: it assumes local-only tools, exports and
UI that this cloud milestone does not expose. Adapt its workflow to the actual
cloud tools before distributing a complete plugin.

See [remote deployment and remaining release work](../../docs/remote-backend.md).
The DCR, `defaultScopes` and `oidcEnabled` fields follow
[official plugin packaging](https://developers.openai.com/plugins/build/plugins).
