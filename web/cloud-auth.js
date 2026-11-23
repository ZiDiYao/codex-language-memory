/** Account boundary for the Web UI. Tokens stay in the Auth0 SDK's memory cache. */
export class CloudAuthError extends Error {
  constructor(code = "authenticationRequired") { super(code); this.code = code; }
}

const interactiveErrors = new Set(["login_required", "consent_required", "interaction_required", "missing_refresh_token", "invalid_grant"]);

function claims(token) {
  try {
    const part = token.split(".")[1];
    const bytes = Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new CloudAuthError(); }
}

export function auth0Options(config, origin) {
  return {
    domain: config.auth0Domain, clientId: config.auth0ClientId,
    cacheLocation: "memory", useRefreshTokens: true, useRefreshTokensFallback: true,
    workerUrl: origin + "/assets/auth0-worker.js", authorizeTimeoutInSeconds: 12,
    authorizationParams: {
      redirect_uri: origin + "/auth/callback", audience: config.audience,
      scope: "openid memory:read memory:write offline_access",
    },
  };
}

export async function completeCloudCallback(client, location, history) {
  if (location.pathname !== "/auth/callback") return false;
  try { await client.handleRedirectCallback(); }
  finally {
    // Never retain authorization codes or provider errors in the visible app URL.
    history.replaceState({}, "", "/");
  }
  return true;
}

export class CloudSession {
  #identity;
  #epoch = 0;
  #blocked;

  constructor(client, { issuer, onRequired = () => {} } = {}) {
    this.client = client;
    this.issuer = issuer;
    this.onRequired = onRequired;
  }

  get epoch() { return this.#epoch; }
  get blocked() { return !!this.#blocked; }

  assertActive(epoch = this.#epoch) {
    if (this.#blocked || epoch !== this.#epoch) throw new CloudAuthError(this.#blocked || "accountChanged");
  }

  pause(reason = "authenticationRequired", notify = true) {
    if (this.#blocked) return;
    this.#blocked = reason;
    ++this.#epoch;
    if (notify) this.onRequired(reason);
  }

  async getToken() {
    this.assertActive();
    const epoch = this.#epoch;
    let token;
    try { token = await this.client.getTokenSilently(); }
    catch (error) {
      if (interactiveErrors.has(error?.error) || error instanceof CloudAuthError) {
        this.pause();
        throw new CloudAuthError();
      }
      throw new Error("disconnected");
    }
    this.assertActive(epoch);
    try {
      const user = await this.client.getUser();
      this.assertActive(epoch);
      const payload = claims(token);
      // This comparison only prevents stale UI drafts crossing accounts. The API
      // remains responsible for cryptographic JWT and permission verification.
      if (typeof user?.sub !== "string" || !user.sub || payload.sub !== user.sub || payload.iss !== this.issuer)
        throw new CloudAuthError("accountChanged");
      const identity = JSON.stringify([payload.iss, payload.sub]);
      if (this.#identity && identity !== this.#identity) throw new CloudAuthError("accountChanged");
      this.#identity = identity;
      return token;
    } catch (error) {
      const reason = error instanceof CloudAuthError ? error.code : "authenticationRequired";
      this.pause(reason);
      throw new CloudAuthError(reason);
    }
  }

  async signOut(beforeChange, returnTo) {
    if (!(await beforeChange())) return false;
    this.pause("authenticationRequired", false);
    await this.client.logout({ logoutParams: { returnTo } });
    return true;
  }
}
