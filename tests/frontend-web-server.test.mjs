import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createWebHandler, loadWebConfig } from '../frontend-web/server.mjs';

const environment = {
  PUBLIC_URL: 'https://sayrove.example', APP_NAME: 'Sayrove',
  AUTH0_DOMAIN: 'language-memory.ca.auth0.com', AUTH0_CLIENT_ID: 'publicClient123',
  API_BASE_URL: 'https://api.example', AUTH0_AUDIENCE: 'https://api.example/mcp',
  DATABASE_URL: 'must-not-be-exposed', AUTH0_CLIENT_SECRET: 'must-not-be-exposed',
};

test('Web public configuration contains only the five public settings', () => {
  const config = loadWebConfig(environment);
  assert.deepEqual(Object.keys(config.publicConfig).sort(),
    ['appName', 'auth0Domain', 'auth0ClientId', 'apiBaseUrl', 'audience'].sort());
  assert.equal(config.publicConfig.auth0Domain, 'language-memory.ca.auth0.com');
  assert.equal(JSON.stringify(config.publicConfig).includes('must-not-be-exposed'), false);
});

test('Web URL configuration rejects credentials, insecure nonlocal hosts and path roots', () => {
  for (const patch of [
    { PUBLIC_URL: 'http://sayrove.example' }, { PUBLIC_URL: 'https://sayrove.example/path' },
    { AUTH0_DOMAIN: 'https://user:password@example.test' },
    { API_BASE_URL: 'https://api.example/?token=secret' },
    { WEB_ALLOW_INSECURE_LOCAL: 'true', PUBLIC_URL: 'http://remote.example' },
    { AUTH0_CLIENT_ID: 'not a public id' },
  ]) assert.throws(() => loadWebConfig({ ...environment, ...patch }));
  assert.equal(loadWebConfig({ ...environment, PUBLIC_URL: 'http://127.0.0.1:8000',
    WEB_ALLOW_INSECURE_LOCAL: 'true' }).publicUrl, 'http://127.0.0.1:8000');
});

test('Web server serves the callback and bundled files without exposing unrelated paths', async (t) => {
  const config = loadWebConfig(environment);
  const html = '<!doctype html><title>Sayrove</title>';
  const files = new Map([
    ['/index.html', { bytes: Buffer.from(html), type: 'text/html; charset=utf-8' }],
    ['/assets/app.js', { bytes: Buffer.from('console.log("public asset")'), type: 'text/javascript' }],
  ]);
  const server = createServer(createWebHandler({ config, files }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, options = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { ...options,
      headers: { Host: 'sayrove.example', ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers,
      })));
    });
    request.on('error', reject); request.end();
  });

  const callback = await get('/auth/callback?code=private-code&state=private-state');
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), html);
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  const csp = callback.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/language-memory.ca.auth0.com https:\/\/api.example/);
  assert.equal((await get('/assets/app.js')).status, 200);
  for (const path of ['/.env', '/frontend-web/server.mjs', '/package.json', '/missing', '/assets/%2e%2e/.env'])
    assert.equal((await get(path)).status, 404, path);

  const publicConfig = await get('/config.json');
  assert.equal(publicConfig.status, 200);
  assert.equal(publicConfig.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await publicConfig.json(), config.publicConfig);
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await get('/', { method: 'POST' })).status, 405);
  assert.equal((await get('/', { headers: { Host: 'other.example' } })).status, 403);
  assert.equal((await get('/healthz', { headers: { Host: 'healthcheck.railway.app' } })).status, 200);
  assert.equal((await get('/config.json', { headers: { Host: 'healthcheck.railway.app' } })).status, 403);
});
