import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

function checkedUrl(value, name, allowLocal, rootOnly = true) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:')) ||
      (rootOnly && url.pathname !== '/')) throw new Error(`Invalid ${name}`);
  return url;
}

export function loadWebConfig(env = process.env) {
  const allowLocal = env.WEB_ALLOW_INSECURE_LOCAL === 'true';
  if (env.WEB_ALLOW_INSECURE_LOCAL && !['true', 'false'].includes(env.WEB_ALLOW_INSECURE_LOCAL))
    throw new Error('Invalid WEB_ALLOW_INSECURE_LOCAL');
  for (const key of ['PUBLIC_URL', 'AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'API_BASE_URL', 'AUTH0_AUDIENCE'])
    if (!env[key]) throw new Error(`Missing ${key}`);
  const publicUrl = checkedUrl(env.PUBLIC_URL, 'PUBLIC_URL', allowLocal);
  const api = checkedUrl(env.API_BASE_URL, 'API_BASE_URL', allowLocal);
  const auth = checkedUrl(env.AUTH0_DOMAIN.includes('://') ? env.AUTH0_DOMAIN : `https://${env.AUTH0_DOMAIN}`,
    'AUTH0_DOMAIN', allowLocal);
  const audience = checkedUrl(env.AUTH0_AUDIENCE, 'AUTH0_AUDIENCE', allowLocal, false);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(env.AUTH0_CLIENT_ID)) throw new Error('Invalid AUTH0_CLIENT_ID');
  const appName = (env.APP_NAME || 'Sayrove').trim();
  if (!appName || appName.length > 80 || /[\x00-\x1f\x7f]/.test(appName)) throw new Error('Invalid APP_NAME');
  const port = env.PORT || '8080';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PORT');
  return Object.freeze({
    publicUrl: publicUrl.origin, authOrigin: auth.origin, apiOrigin: api.origin,
    port: Number(port), host: env.HOST || '0.0.0.0',
    publicConfig: Object.freeze({ appName, auth0Domain: auth.host,
      auth0ClientId: env.AUTH0_CLIENT_ID, apiBaseUrl: api.origin, audience: audience.href }),
  });
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webp': 'image/webp' };

export async function readPublicFiles(root) {
  const files = new Map();
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, path);
      else if (entry.isFile() && types[extname(entry.name)]) files.set(path, {
        bytes: await readFile(child), type: types[extname(entry.name)],
      });
    }
  }
  await walk(root);
  if (!files.has('/index.html')) throw new Error('Missing built Web entry');
  return files;
}

export function createWebHandler({ config, files }) {
  const publicHost = new URL(config.publicUrl).host;
  const csp = ["default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "worker-src 'self'",
    `connect-src 'self' ${config.authOrigin} ${config.apiOrigin}`,
    `frame-src ${config.authOrigin}`, "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'"].join('; ');
  return (request, response) => {
    const headers = { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Strict-Transport-Security': 'max-age=31536000', 'Cache-Control': 'no-store' };
    const reply = (status, body, type = 'application/json', extra = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      response.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': bytes.length, ...extra });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\'))
        return reply(400, '{"error":"invalid_request"}');
      const url = new URL(request.url, config.publicUrl);
      const health = url.pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method);
      const host = request.headers.host;
      const probe = health && ['healthcheck.railway.app', '127.0.0.1', 'localhost', '[::1]'].includes(host);
      if (host !== publicHost && !probe) return reply(403, '{"error":"invalid_host"}');
      if (!['GET', 'HEAD'].includes(request.method)) {
        request.resume();
        return reply(405, '{"error":"method_not_allowed"}', 'application/json', { Allow: 'GET, HEAD' });
      }
      if (health) return reply(200, '{"status":"ok"}');
      if (url.pathname === '/config.json') return reply(200, JSON.stringify(config.publicConfig));
      const path = ['/', '/auth/callback'].includes(url.pathname) ? '/index.html' : url.pathname;
      const file = files.get(path);
      if (!file) return reply(404, '{"error":"not_found"}');
      return reply(200, file.bytes, file.type, { 'Cache-Control': path.endsWith('.html')
        ? 'no-store' : 'public, max-age=0, must-revalidate' });
    } catch { return reply(400, '{"error":"invalid_request"}'); }
  };
}

export async function startWebServer(env = process.env) {
  const config = loadWebConfig(env);
  const root = new URL('../public/', import.meta.url);
  const files = await readPublicFiles(root);
  const server = createServer(createWebHandler({ config, files }));
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const stop = () => {
    const timer = setTimeout(() => server.closeAllConnections(), 5000);
    timer.unref();
    server.close(() => clearTimeout(timer));
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWebServer().catch(() => { console.error('web_start_failed'); process.exitCode = 1; });
}
