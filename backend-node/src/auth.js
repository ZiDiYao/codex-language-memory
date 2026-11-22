import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

export const ASYMMETRIC_ALGORITHMS = Object.freeze(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA"]);

export class AuthenticationError extends Error {
  constructor(status = 401, code = "invalid_token") {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function createTokenVerifier(config, { jwks } = {}) {
  // A token-supplied jku/x5u is never used to select the signing-key endpoint.
  const trustedKeys = jwks ?? createRemoteJWKSet(new URL(config.authJwksUrl), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
  });
  return async (token) => {
    if (typeof token !== "string" || !token || token.length > 16384) throw new AuthenticationError();
    try {
      const header = decodeProtectedHeader(token);
      if (!ASYMMETRIC_ALGORITHMS.includes(header.alg) || typeof header.kid !== "string" || !header.kid || header.kid.length > 256)
        throw new AuthenticationError();
      const { payload } = await jwtVerify(token, trustedKeys, {
        issuer: config.authIssuer, audience: config.authAudience,
        algorithms: [...ASYMMETRIC_ALGORITHMS], requiredClaims: ["iss", "sub", "aud", "exp"],
      });
      if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 512 ||
          !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) throw new AuthenticationError();
      const rawScope = payload.scope ?? payload.scp ?? [];
      let scopes;
      if (typeof rawScope === "string") scopes = rawScope.split(/\s+/).filter(Boolean);
      else if (Array.isArray(rawScope) && rawScope.every((scope) => typeof scope === "string" && scope)) scopes = rawScope;
      else throw new AuthenticationError();
      if (config.requiredScopes.some((scope) => !scopes.includes(scope))) throw new AuthenticationError(403, "insufficient_scope");
      return Object.freeze({ issuer: config.authIssuer, subject: payload.sub, scopes: Object.freeze([...new Set(scopes)]) });
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      // Do not return/log the JWT, claims, key URL, or provider's response body.
      throw new AuthenticationError();
    }
  };
}

export async function authenticate(request, config, verify) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !/^Bearer /i.test(authorization)) throw new AuthenticationError();
  let principal;
  try { principal = await verify(authorization.slice(7)); }
  catch (error) { if (error instanceof AuthenticationError) throw error; throw new AuthenticationError(); }
  // Even an injected verifier cannot introduce a caller-selected tenant identity.
  if (!principal || principal.issuer !== config.authIssuer || typeof principal.subject !== "string" || !principal.subject)
    throw new AuthenticationError();
  if (!Array.isArray(principal.scopes) || config.requiredScopes.some((scope) => !principal.scopes.includes(scope)))
    throw new AuthenticationError(403, "insufficient_scope");
  return principal;
}
