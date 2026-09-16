import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { request, gatewayUrl } = require('../plugins/pi-desktop/client.cjs');
const connection = { gateway: 'https://gateway.example', token: 'sa_unit_test_credential_12345678', timeoutSeconds: 200 };

test('PI P1: all four HTTP operations preserve gateway evidence, partial outcomes and pagination', async () => {
  const payload = { collection_id: '123', partial: true, next_offset: 10, results: [{ evidence: [{ provider: 'exa', content: '正文', truncated: true }] }], warnings: ['source blocked'] };
  for (const endpoint of ['/v1/search', '/v1/results', '/v1/evidence', '/v1/fetch']) {
    const args = { query: '交叉求证', offset: 0 };
    const actual = await request(connection, endpoint, args, undefined, { fetch: async (url: string, init: RequestInit) => {
      assert.equal(url, connection.gateway + endpoint);
      assert.equal(init.redirect, 'manual');
      assert.equal((init.headers as any).Authorization, `Bearer ${connection.token}`);
      assert.deepEqual(JSON.parse(init.body as string), args);
      assert.equal(init.method, 'POST');
      return Response.json(payload);
    } });
    assert.deepEqual(actual, payload);
  }
});

test('PI P1: URL boundaries refuse credentials, redirects, insecure remote hosts and undeclared egress', async () => {
  assert.equal(gatewayUrl('https://gateway.example/base/', ['gateway.example']), 'https://gateway.example/base');
  assert.equal(gatewayUrl('http://localhost:8765', ['localhost']), 'http://localhost:8765');
  for (const value of ['http://gateway.example', 'https://evil.example', 'https://u:p@gateway.example', 'https://gateway.example?token=x', 'https://gateway.example#x', 'https://gateway.example/mcp', 'https://gateway.example/v1/search', 'file:///tmp/file']) {
    assert.throws(() => gatewayUrl(value, ['gateway.example']), { code: 'configuration' });
  }
  let calls = 0;
  await assert.rejects(request(connection, '/v1/search', {}, undefined, { fetch: async () => {
    calls++; return new Response('', { status: 307, headers: { Location: 'https://evil.example' } });
  } }), { code: 'redirect_refused' });
  assert.equal(calls, 1);
});

test('PI P1: authentication, validation, network and malformed/oversized responses remain actionable without secrets', async () => {
  for (const status of [401, 422, 429, 502]) {
    await assert.rejects(request(connection, '/v1/search', {}, undefined, { fetch: async () => Response.json({ error: { code: 'upstream_error', message: `Failure ${connection.token}` } }, { status }) }), (error: any) => {
      assert.equal(error.status, status); assert.equal(error.code, 'upstream_error');
      assert.ok(!error.message.includes(connection.token)); return true;
    });
  }
  for (const body of ['<html>Bad Gateway</html>', '', 'null', '[]', 'true']) {
    await assert.rejects(request(connection, '/v1/results', {}, undefined, { fetch: async () => new Response(body) }), { code: 'invalid_response' });
  }
  for (const headers of [{}, { 'Content-Length': '2000' }]) {
    await assert.rejects(request(connection, '/v1/evidence', {}, undefined, { maxBytes: 20, fetch: async () => new Response(JSON.stringify({ text: 'x'.repeat(80) }), { headers }) }), { code: 'response_too_large' });
  }
  await assert.rejects(request(connection, '/v1/search', {}, undefined, { fetch: async () => { throw new Error(connection.token); } }), (error: any) => error.code === 'network_error' && !error.message.includes(connection.token));
});

test('PI P2: real HTTP cancellation and deadline close requests, and the next request recovers', async () => {
  let disconnected = 0;
  const server = createServer((req, res) => {
    if (req.url === '/ready') { res.end('{"ok":true}'); return; }
    res.on('close', () => { disconnected++; });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = { ...connection, gateway: `http://127.0.0.1:${(server.address() as any).port}` };
  try {
    await assert.rejects(request(config, '/slow', {}, undefined, { timeoutMs: 150 }), { code: 'timeout' });
    const controller = new AbortController();
    const work = request(config, '/slow', {}, controller.signal);
    const timer = setTimeout(() => controller.abort(), 150);
    await assert.rejects(work, { code: 'cancelled' }); clearTimeout(timer);
    assert.deepEqual(await request(config, '/ready', {}), { ok: true });
    assert.ok(disconnected >= 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
