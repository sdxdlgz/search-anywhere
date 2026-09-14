import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayError } from '../server/providers.js';
import { fixture, caller, upstream } from './helpers.js';

test('C1: AnySearch uses Bearer REST envelope and Keenable uses MCP overrides plus billing metadata', async () => {
  const seen: { url: string; headers: Headers; body: any }[] = [];
  const f = fixture(async (url, init) => {
    if (init?.body) seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return upstream(url, init);
  });
  try {
    const [a] = f.add('anysearch'), [k] = f.add('keenable');
    for (const mode of ['realtime', 'pro']) {
      const data = await f.engine.providers.search(f.store.key(k.id)!, mode, { query: 'vendor contract', include_domains: ['example.com'] }, 50, AbortSignal.timeout(5000));
      assert.equal(data.credits, 3); assert.equal(data.cost_usd, null); assert.equal(data.paid, false); assert.equal(data.results[0].snippet, 'Keenable excerpt');
    }
    await f.engine.providers.search(f.store.key(a.id)!, 'auto', { query: 'vendor contract' }, 50, AbortSignal.timeout(5000));
    const any = seen.find(s => s.url.includes('anysearch'))!;
    assert.match(any.headers.get('authorization')!, /^Bearer /); assert.deepEqual(any.body, { query: 'vendor contract', max_results: 20, format: 'json' });
    const calls = seen.filter(s => s.body.method === 'tools/call');
    assert.deepEqual(calls.map(s => s.body.params._meta['keenable/overrides']), [{ mode: 'realtime', skip_cache: true }, { mode: 'pro', skip_cache: true }]);
    assert.equal(calls[0].body.params.arguments.site, 'example.com');
    assert.equal(calls[0].body.params.arguments.max_results, 50); assert.equal(calls[0].body.params.arguments.snippet_max_length, 10000);
    assert.match(calls[0].headers.get('x-api-key')!, /^keenable-/);
  } finally { await f.cleanup(); }
});

test('C1: business errors, oversized bodies and MCP auth errors are explicit and sanitized', async () => {
  for (const provider of ['anysearch', 'keenable'] as const) {
    const f = fixture(async (url, init) => {
      if (provider === 'anysearch') return Response.json({ code: -1, message: 'SECRET_ACCOUNT_KEY', data: { api_key: 'SECRET_ACCOUNT_KEY' } });
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      return new Response('SECRET_ACCOUNT_KEY', { status: 401 });
    });
    try {
      const [k] = f.add(provider);
      await assert.rejects(f.engine.providers.search(f.store.key(k.id)!, provider === 'anysearch' ? 'auto' : 'pro', { query: 'failure' }, 5, AbortSignal.timeout(3000)), e => {
        assert.ok(e instanceof GatewayError); assert.ok(!e.message.includes('SECRET_ACCOUNT_KEY'));
        assert.equal(e.code, provider === 'anysearch' ? 'upstream_error' : 'invalid_key'); return true;
      });
    } finally { await f.cleanup(); }
  }
  const huge = fixture(async () => new Response('x'.repeat(4000001)));
  try { const [k] = huge.add('exa'); await assert.rejects(huge.engine.providers.search(huge.store.key(k.id)!, 'auto', { query: 'large' }, 1, AbortSignal.timeout(3000)), e => e instanceof GatewayError && e.code === 'response_too_large'); }
  finally { await huge.cleanup(); }
});

test('C1/C6: new suppliers rotate after authentication failure; MCP text format errors never become empty success', async () => {
  let rejected = false;
  const f = fixture(async (url, init) => {
    const rpc = init?.body ? JSON.parse(String(init.body)) : {};
    if (rpc.method === 'tools/call' && !rejected) { rejected = true; return new Response('private key detail', { status: 401 }); }
    return upstream(url, init);
  }, 'coverage');
  try {
    f.add('keenable', 'one account', ['keen-first-12345678', 'keen-second-12345678']);
    f.store.saveProfile({ ...f.store.profile()!, modes: { keenable: 'pro' } });
    const result = await f.engine.search({ query: 'rotate keen' }, caller);
    assert.equal(result.partial, false); assert.equal(f.store.todayCalls(), 2); assert.equal(f.store.keys().filter(k => k.state === 'invalid').length, 1);
    assert.equal(f.store.inflight.size, 0);
  } finally { await f.cleanup(); }
  const malformed = fixture(async (url, init) => {
    const rpc = init?.body ? JSON.parse(String(init.body)) : {};
    if (rpc.method === 'tools/call') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'unstructured unknown response' }] } });
    return upstream(url, init);
  });
  try { const [k] = malformed.add('keenable'); await assert.rejects(malformed.engine.providers.search(malformed.store.key(k.id)!, 'pro', { query: 'bad format' }, 1, AbortSignal.timeout(3000)), /搜索结果格式无法识别/); }
  finally { await malformed.cleanup(); }
});
