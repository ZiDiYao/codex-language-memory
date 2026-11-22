# Remote plugin template

This directory is an authoring template, not an installed or published plugin.
Set the service URL in `mcp.json` to your own reachable HTTPS `/mcp` endpoint.
Configure its OAuth provider and client registration before testing a host login;
no credential, shared token or client secret belongs in either manifest.

The backend is an OAuth resource server. Your external authorization server must
complete the OAuth 2.1 authorization-code flow with PKCE and issue the configured
audience and both `memory:read` and `memory:write` scopes. It must support the client
registration/discovery mechanism required by the target host, or have that host's
client registered beforehand. `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL`
configure server validation; they do not create an authorization server.

The desktop Skill is not bundled here: it assumes local-only tools, exports and
UI that this cloud milestone does not expose. Adapt its workflow to the actual
cloud tools before distributing a complete plugin.

See [remote deployment and remaining release work](../../docs/remote-backend.md).
The manifest structure follows [official plugin packaging](https://developers.openai.com/plugins/build/plugins).
