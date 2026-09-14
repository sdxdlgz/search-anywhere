import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, GatewayError, publicUrl } from '../server/providers.js';
import { fixture, result } from './helpers.js';
import { LEGACY_PROVIDERS as PROVIDERS } from './helpers.js';

test('R3/R6: each provider receives its real mode schema; reported usage retained', async () => {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const f = fixture(async (url, init) => { requests.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) }); return Response.json({ results: [result('source')], usage: { credits: 2 }, costDollars: { total: .007 } }); });
  try {
    for (const provider of PROVIDERS) {
      const [k] = f.add(provider);
      const response = await f.engine.providers.search(f.store.key(k.id)!, provider === 'exa' ? 'auto' : 'advanced', { query: 'test query' }, 10, AbortSignal.timeout(1000));
      assert.equal(response.billing_source, 'reported'); assert.equal(response.cost_usd, .007);
    }
    assert.equal(requests[0].body.type, 'auto');
    assert.equal(requests[1].body.mode, 'advanced');
    assert.deepEqual(requests[1].body.search_queries, ['test query']);
    assert.deepEqual(requests[1].body.advanced_settings, { max_results: 10 });
    assert.ok(requests[1].url.endsWith('/v1/search'));
    assert.equal(requests[2].body.search_depth, 'advanced');
    assert.equal(requests[2].body.auto_parameters, false);
    assert.equal(requests[2].body.include_usage, true);
    assert.match(requests[2].headers.get('authorization')!, /^Bearer /);
  } finally { await f.cleanup(); }
});
test('R5: status classification and Retry-After never disclose upstream errors or credentials', async () => {
  for (const [status, code] of [[401, 'invalid_key'], [402, 'exhausted'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'upstream_error'], [400, 'upstream_validation']] as const) {
    const f = fixture(async () => new Response('leaked-secret-must-never-appear', { status, headers: { 'Retry-After': '120' } }));
    try {
      const [k] = f.add('exa');
      await assert.rejects(f.engine.providers.search(f.store.key(k.id)!, 'auto', { query: 'q' }, 5, AbortSignal.timeout(1000)), error => {
        assert.ok(error instanceof GatewayError); assert.equal(error.code, code); assert.ok(!error.message.includes('leaked-secret')); if (status === 429) assert.equal(error.cooldownMs, 120000); return true;
      });
    } finally { await f.cleanup(); }
  }
});
test('R6: official Tavily usage separates key, account and paygo; failed sync preserves last data', async () => {
  let fail = false;
  const f = fixture(async () => fail ? new Response('denied', { status: 401 }) : Response.json({ key: { usage: 20, limit: 100 }, account: { current_plan: 'Basic', plan_usage: 50, plan_limit: 1000, paygo_usage: 3, paygo_limit: 100 } }));
  try {
    const [k] = f.add('tavily');
    await f.engine.syncUsage(k.id);
    const snapshot = f.store.keys()[0].usage!;
    assert.equal(snapshot.key?.used, 20); assert.equal(snapshot.account?.used, 50); assert.equal(snapshot.account?.paygo_used, 3);
    fail = true; await assert.rejects(f.engine.syncUsage(k.id));
    assert.deepEqual(f.store.keys()[0].usage, snapshot); assert.ok(f.store.keys()[0].usage_error);
  } finally { await f.cleanup(); }
});
test('R6: Exa management access is separate; Parallel unknown makes no invented balance request', async () => {
  const called: string[] = [];
  const f = fixture(async (url, init) => { called.push(url); assert.equal(new Headers(init?.headers).get('x-api-key'), 'service-key-secret-1234567'); return Response.json({ total_cost_usd: 12.5 }); });
  try {
    const [exa] = f.add('exa'), [parallel] = f.add('parallel');
    await f.engine.syncUsage(exa.id); await f.engine.syncUsage(parallel.id);
    assert.equal(f.store.keys().find(k => k.id === exa.id)?.usage?.status, 'needs_setup');
    assert.equal(f.store.keys().find(k => k.id === parallel.id)?.usage?.status, 'needs_setup');
    assert.equal(called.length, 0);
    f.store.updateKey(exa.id, { label: exa.label, account: exa.account, enabled: true, max_concurrency: 2, exa_key_id: 'external-key-id', service_key: 'service-key-secret-1234567' });
    await f.engine.syncUsage(exa.id);
    assert.match(called[0], /admin-api.exa.ai\/team-management\/api-keys\/external-key-id\/usage/);
    assert.equal(f.store.keys().find(k => k.id === exa.id)?.usage?.cost_usd, 12.5);
    assert.ok(!JSON.stringify(f.store.keys()).includes('service-key-secret'));
  } finally { await f.cleanup(); }
});
test('R10: provider source extraction and URL restrictions', async () => {
  const called: { url: string; body: Record<string, unknown> }[] = [];
  const f = fixture(async (url, init) => { called.push({ url, body: JSON.parse(String(init?.body)) }); return Response.json({ results: [result('page')] }); });
  try {
    for (const p of PROVIDERS) { const [k] = f.add(p); const data = await f.engine.providers.fetch(f.store.key(k.id)!, 'https://example.com/page', AbortSignal.timeout(1000)); assert.equal(data.results[0].snippet, p === 'tavily' ? 'A useful excerpt' : 'Full page text'); }
    assert.match(called[0].url, /\/contents$/); assert.deepEqual(called[0].body.ids, ['https://example.com/page']);
    assert.match(called[1].url, /\/v1\/extract$/); assert.deepEqual(called[2].body.urls, ['https://example.com/page']);
    assert.deepEqual(called[1].body.advanced_settings, { full_content: true });
    assert.equal(called[1].body.full_content, undefined);
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://a.local', 'https://user:password@example.com']) assert.throws(() => publicUrl(url));
    assert.equal(canonicalUrl('https://EXAMPLE.com/a?utm_source=x&b=2&a=1#section'), 'https://example.com/a?a=1&b=2');
    assert.notEqual(canonicalUrl('https://example.com/a?id=1'), canonicalUrl('https://example.com/a?id=2'));
  } finally { await f.cleanup(); }
});

test('R6: Parallel SKU units survive persistence without inventing a dollar cost', async () => {
  const f = fixture(async () => Response.json({ results: [result('parallel')], usage: [{ name: 'sku_search', count: 1 }] }));
  try {
    f.add('parallel');
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: null, parallel: 'fast', tavily: null } });
    await f.engine.search({ query: 'meter sku' }, { id: 'meter', name: 'meter' });
    const call = f.store.logs()[0].calls[0];
    assert.deepEqual(call.usage_items, [{ name: 'sku_search', count: 1 }]);
    assert.equal(call.cost_usd, null); assert.equal(call.credits, null); assert.equal(call.billing_source, 'reported');
  } finally { await f.cleanup(); }
});

test('R6: failed background usage checks are throttled and keep manual retry available', async () => {
  let count = 0;
  const f = fixture(async () => { count++; return new Response('unavailable', { status: 500 }); });
  try {
    const [key] = f.add('tavily');
    await f.engine.syncDueUsage(); await f.engine.syncDueUsage();
    assert.equal(count, 1); assert.ok(f.store.keys()[0].usage_error);
    await assert.rejects(f.engine.syncUsage(key.id)); assert.equal(count, 2);
  } finally { await f.cleanup(); }
});
