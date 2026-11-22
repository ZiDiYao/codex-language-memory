import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import test from 'node:test';
import { start } from '../src/main.js';

test('an open event stream cannot keep the Node service alive indefinitely during shutdown', { timeout: 10000 }, async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const service = await start({
    DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    AUTH_ISSUER: 'https://issuer.example/', AUTH_AUDIENCE: 'memory',
    AUTH_JWKS_URL: 'https://issuer.example/jwks',
    CLOUD_ALLOW_INSECURE_LOCAL: 'true', HOST: '127.0.0.1', PORT: String(port),
  });
  t.after(() => service.close());
  // Keep a real HTTP response open as a client listening for server events does.
  service.server.removeAllListeners('request');
  service.server.on('request', (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': connected\n\n');
  });
  const response = await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}`, { agent: false }, resolve);
    request.on('error', reject);
  });
  response.on('error', () => {});
  response.resume();
  const started = performance.now();
  const firstClose = service.close();
  assert.equal(service.close(), firstClose);
  await firstClose;
  assert.ok(performance.now() - started < 7500, 'shutdown must have a bounded grace period');
  assert.equal(service.server.listening, false);
});
