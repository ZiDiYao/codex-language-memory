import { PROVIDER_FACTORIES } from './providers/index.js';

/** Fail-closed configuration shared by the Node HTTP and MCP transports. */
function absoluteUrl(value, name, allowLocal) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const raw = value.trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} cannot contain credentials, query or fragment`);
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol !== "https:" && !(allowLocal && loopback && url.protocol === "http:"))
    throw new Error(`${name} requires HTTPS; HTTP is available only for explicit loopback development`);
  return raw;
}

function webOrigins(value, allowLocal) {
  if (typeof value !== "string") throw new Error("WEB_ALLOWED_ORIGINS must be a comma-separated list of origins");
  if (!value.trim()) return Object.freeze([]);
  const origins = value.split(",").map((part) => part.trim());
  for (const origin of origins) {
    let url;
    try { url = new URL(absoluteUrl(origin, "WEB_ALLOWED_ORIGINS", allowLocal)); }
    catch { throw new Error("WEB_ALLOWED_ORIGINS requires explicit HTTPS origins; loopback HTTP requires explicit development mode"); }
    // Store only serialized origins. Paths (including a trailing slash), wildcard
    // hosts, credentials and opaque origins must never broaden this allowlist.
    if (url.origin !== origin || url.pathname !== "/" || url.hostname.includes("*"))
      throw new Error("WEB_ALLOWED_ORIGINS entries must be exact origins without paths or wildcards");
  }
  return Object.freeze([...new Set(origins)]);
}

export function loadConfig(environment = process.env) {
  const required = ["DATABASE_URL", "PUBLIC_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL"];
  const missing = required.filter((key) => !environment[key]);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  const insecure = (environment.CLOUD_ALLOW_INSECURE_LOCAL ?? "false").toLowerCase();
  if (!["true", "false"].includes(insecure)) throw new Error("CLOUD_ALLOW_INSECURE_LOCAL must be true or false");
  const allowInsecureLocal = insecure === "true";
  const webAllowedOrigins = webOrigins(environment.WEB_ALLOWED_ORIGINS ?? "", allowInsecureLocal);
  const databaseUrl = environment.DATABASE_URL;
  if (typeof databaseUrl !== "string" || !/^(?:postgres|postgresql|postgresql\+psycopg):\/\//.test(databaseUrl))
    throw new Error("DATABASE_URL must use PostgreSQL");
  let publicUrl = absoluteUrl(environment.PUBLIC_URL, "PUBLIC_URL", allowInsecureLocal);
  if (new URL(publicUrl).pathname !== "/") throw new Error("PUBLIC_URL must be the service root URL");
  publicUrl = publicUrl.replace(/\/+$/, "");
  const authIssuer = absoluteUrl(environment.AUTH_ISSUER, "AUTH_ISSUER", allowInsecureLocal);
  const authJwksUrl = absoluteUrl(environment.AUTH_JWKS_URL, "AUTH_JWKS_URL", allowInsecureLocal);
  const authAudience = environment.AUTH_AUDIENCE;
  if (typeof authAudience !== "string" || !authAudience.trim()) throw new Error("AUTH_AUDIENCE is required");
  const requiredScopes = [...new Set((environment.AUTH_REQUIRED_SCOPES ?? "memory:read memory:write").split(/\s+/).filter(Boolean))];
  if (!requiredScopes.length) throw new Error("AUTH_REQUIRED_SCOPES must contain at least one scope");
  const rawPort = environment.PORT ?? "8080";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error("PORT must be between 1 and 65535");
  const enrichmentProvider = environment.SAYROVE_ENRICHMENT_PROVIDER ?? 'deepseek';
  if (typeof enrichmentProvider !== 'string' || !Object.hasOwn(PROVIDER_FACTORIES, enrichmentProvider))
    throw new Error('SAYROVE_ENRICHMENT_PROVIDER must name a registered provider');
  const keyName = enrichmentProvider === 'deepseek' ? 'DEEPSEEK_API_KEY'
    : enrichmentProvider === 'openai' ? 'OPENAI_API_KEY' : 'SAYROVE_ENRICHMENT_API_KEY';
  const rawApiKey = environment[keyName];
  if (rawApiKey != null && typeof rawApiKey !== 'string')
    throw new Error(`${keyName} must be a nonempty API key`);
  const enrichmentApiKey = rawApiKey?.trim() || null;
  const rawModel = environment.SAYROVE_ENRICHMENT_MODEL;
  if (rawModel != null && typeof rawModel !== 'string')
    throw new Error('SAYROVE_ENRICHMENT_MODEL must name a model');
  const enrichmentModel = rawModel?.trim() || (enrichmentProvider === 'deepseek' ? 'deepseek-flash' : null);
  const rawBaseUrl = environment.SAYROVE_ENRICHMENT_BASE_URL;
  if (rawBaseUrl != null && typeof rawBaseUrl !== 'string')
    throw new Error('SAYROVE_ENRICHMENT_BASE_URL must be an HTTPS API root');
  let enrichmentBaseUrl = rawBaseUrl?.trim() || null;
  if (enrichmentBaseUrl != null)
    enrichmentBaseUrl = absoluteUrl(enrichmentBaseUrl, 'SAYROVE_ENRICHMENT_BASE_URL', false).replace(/\/+$/, '');
  if (enrichmentProvider === 'openai-compatible' && !enrichmentBaseUrl)
    throw new Error('SAYROVE_ENRICHMENT_BASE_URL is required for openai-compatible');
  return Object.freeze({ enrichmentProvider, enrichmentApiKey, enrichmentModel, enrichmentBaseUrl,
    databaseUrl, publicUrl, authIssuer, authAudience, authJwksUrl,
    requiredScopes: Object.freeze(requiredScopes), allowInsecureLocal, webAllowedOrigins,
    host: environment.HOST ?? "0.0.0.0", port: Number(rawPort), resourceUrl: publicUrl + "/mcp" });
}
