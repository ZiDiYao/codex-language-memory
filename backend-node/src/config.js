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

export function loadConfig(environment = process.env) {
  const required = ["DATABASE_URL", "PUBLIC_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL"];
  const missing = required.filter((key) => !environment[key]);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  const insecure = (environment.CLOUD_ALLOW_INSECURE_LOCAL ?? "false").toLowerCase();
  if (!["true", "false"].includes(insecure)) throw new Error("CLOUD_ALLOW_INSECURE_LOCAL must be true or false");
  const allowInsecureLocal = insecure === "true";
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
  return Object.freeze({ databaseUrl, publicUrl, authIssuer, authAudience, authJwksUrl,
    requiredScopes: Object.freeze(requiredScopes), allowInsecureLocal,
    host: environment.HOST ?? "0.0.0.0", port: Number(rawPort), resourceUrl: publicUrl + "/mcp" });
}
