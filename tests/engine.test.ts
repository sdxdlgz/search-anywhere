import test from 'node:test';
import assert from 'node:assert/strict';
import { caller, fixture, result, upstream } from './helpers.js';
import { LEGACY_PROVIDERS as PROVIDERS } from './helpers.js';

test('R4: fan-out is concurrent, URL duplicates fuse with provenance and count limit', async () => {
  let active = 0, peak = 0;
  const f = fixture(async (url, init) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 30)); active--;
    const p = url.includes('tavily') ? 'tavily' : url.includes('parallel') ? 'parallel' : 'exa';
    return Response.json({ results: [result(p, `https://example.com/shared?utm_source=${p}`), result(p)] });
  });
  try {
    for (const p of PROVIDERS) f.add(p);
    const data = await f.engine.search({ query: 'a useful query', max_results: 2 }, caller);
    assert.equal(peak, 3); assert.equal(data.results.length, 2); assert.equal(data.partial, false);
    assert.equal(data.results[0].url, 'https://example.com/shared');
    assert.deepEqual(data.results[0].sources, PROVIDERS);
    assert.equal(f.store.dashboard().requests, 1); assert.equal(f.store.dashboard().calls, 3);
  } finally { await f.cleanup(); }
});
test('R5: invalid key is isolated and retried with another key; every attempt is metered', async () => {
  let requestCount = 0;
  const f = fixture(async url => { requestCount++; return requestCount === 1 ? new Response('invalid sensitive key', { status: 401 }) : upstream(url); });
  try {
    f.add('exa', 'same-account', ['first-secret-11111111', 'second-secret-22222222']);
    const p = f.store.profile()!; f.store.saveProfile({ ...p, modes: { exa: 'auto', tavily: null, parallel: null } });
    const data = await f.engine.search({ query: 'retry query' }, caller);
    assert.equal(data.partial, false); assert.equal(requestCount, 2);
    assert.equal(f.store.keys().filter(k => k.state === 'invalid').length, 1);
    const calls = f.store.logs()[0].calls;
    assert.equal(calls.length, 2); assert.equal(calls[0].error_code, 'invalid_key'); assert.equal(calls[1].status, 'success');
    assert.equal(calls[0].cost_usd, null);
  } finally { await f.cleanup(); }
});
test('R4/R5: total deadline preserves completed results and always releases key reservations', async () => {
  const f = fixture(async (url, init) => {
    if (url.includes('parallel')) return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return upstream(url, init);
  });
  try {
    for (const p of PROVIDERS) f.add(p);
    f.store.saveProfile({ ...f.store.profile()!, timeout_ms: 40 });
    const keepAlive = setTimeout(() => {}, 1000);
    const response = await f.engine.search({ query: 'timeout query' }, caller);
    clearTimeout(keepAlive);
    assert.equal(response.partial, true); assert.equal(response.results.length, 2);
    assert.equal(response.providers.find(p => p.provider === 'parallel')!.status, 'error');
    assert.equal(f.store.inflight.size, 0);
    assert.equal(f.store.logs()[0].status, 'partial');
  } finally { await f.cleanup(); }
});
test('R4: empty results are a success; absent or failed providers are an explicit error', async () => {
  const f = fixture(async () => Response.json({ results: [] }));
  try {
    await assert.rejects(f.engine.search({ query: 'no credentials' }, caller), /没有可用/);
    f.add('exa');
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const response = await f.engine.search({ query: 'zero matches' }, caller);
    assert.deepEqual(response.results, []); assert.equal(response.partial, false);
  } finally { await f.cleanup(); }
});
test('R7: cache and in-flight coalescing avoid charges, isolate callers, and invalidate after mode/key changes', async () => {
  let count = 0;
  const f = fixture(async url => { count++; await new Promise(resolve => setTimeout(resolve, 20)); return upstream(url); });
  try {
    f.add('exa'); f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const [a, b] = await Promise.all([f.engine.search({ query: 'cached' }, caller), f.engine.search({ query: 'cached' }, caller)]);
    assert.equal(count, 1); assert.equal(a.cache_hit, false); assert.equal(b.cache_hit, true); assert.notEqual(a.request_id, b.request_id);
    const cached = await f.engine.search({ query: 'cached' }, caller); assert.equal(cached.cache_hit, true); assert.equal(count, 1);
    await f.engine.search({ query: 'cached' }, { ...caller, id: 'other' }); assert.equal(count, 2);
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'fast', parallel: null, tavily: null } });
    await f.engine.search({ query: 'cached' }, caller); assert.equal(count, 3);
    const key = f.store.keys()[0]; f.store.updateKey(key.id, { label: 'changed', account: key.account, enabled: true, max_concurrency: 2, exa_key_id: '' });
    await f.engine.search({ query: 'cached' }, caller); assert.equal(count, 4);
    assert.equal(f.store.dashboard().cache_hits, 2);
  } finally { await f.cleanup(); }
});
test('R5/R7: retries stop at two and daily limit gates calls', async () => {
  let count = 0;
  const f = fixture(async () => { count++; return new Response('unavailable', { status: 500 }); });
  try {
    f.add('exa', 'account', ['one-secret-123456', 'two-secret-123456', 'three-secret-123456']);
    await assert.rejects(f.engine.search({ query: 'error' }, caller)); assert.equal(count, 2);
    f.store.saveSettings({ ...f.store.settings(), daily_call_limit: 2 });
    await assert.rejects(f.engine.search({ query: 'error' }, caller), /上限/);
    assert.equal(count, 2); assert.equal(f.store.todayCalls(), 2); assert.equal(f.store.inflight.size, 0);
  } finally { await f.cleanup(); }
});

test('R4: domain constraints apply after merging, including excluded subdomains', async () => {
  const f = fixture(async () => Response.json({ results: [result('allowed', 'https://docs.example.com/a'), result('excluded', 'https://private.example.com/b'), result('outside', 'https://example.net/c')] }));
  try {
    for (const p of PROVIDERS) f.add(p);
    const response = await f.engine.search({ query: 'filtered', include_domains: ['example.com'], exclude_domains: ['private.example.com'] }, caller);
    assert.deepEqual(response.results.map(r => r.url), ['https://docs.example.com/a']);
    assert.deepEqual(response.results[0].sources, PROVIDERS);
  } finally { await f.cleanup(); }
});

test('R7: partial results and disabled cache trigger fresh successful upstream calls', async () => {
  let count = 0;
  const f = fixture(async url => { count++; return upstream(url); });
  try {
    f.add('exa');
    const first = await f.engine.search({ query: 'partial' }, caller);
    const second = await f.engine.search({ query: 'partial' }, caller);
    assert.equal(first.partial, true); assert.equal(second.cache_hit, false); assert.equal(count, 2);
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null }, cache_ttl_seconds: 0 });
    const third = await f.engine.search({ query: 'uncached' }, caller);
    const fourth = await f.engine.search({ query: 'uncached' }, caller);
    assert.equal(third.partial, false); assert.equal(fourth.cache_hit, false); assert.equal(count, 4);
  } finally { await f.cleanup(); }
});
test('R10: fetch uses a single successful provider and meters operation', async () => {
  let count = 0;
  const f = fixture(async url => { count++; return upstream(url); });
  try {
    for (const p of PROVIDERS) f.add(p);
    const page = await f.engine.fetch('https://example.com/page', caller);
    assert.equal(count, 1); assert.equal(page.provider, 'exa');
    assert.equal(f.store.logs()[0].calls[0].operation, 'fetch');
    await assert.rejects(f.engine.fetch('http://localhost/admin', caller)); assert.equal(count, 1);
  } finally { await f.cleanup(); }
});

test('R7: expired cache entries are searched again', async t => {
  let count = 0, time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const f = fixture(async url => { count++; return upstream(url); });
  try {
    f.add('exa');
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null }, cache_ttl_seconds: 1 });
    await f.engine.search({ query: 'expires' }, caller);
    time += 1001;
    const response = await f.engine.search({ query: 'expires' }, caller);
    assert.equal(response.cache_hit, false); assert.equal(count, 2);
  } finally { await f.cleanup(); }
});

test('R10: empty or failed extraction falls back to another provider and preserves full text', async () => {
  const f = fixture(async url => url.includes('exa') ? new Response('unavailable', { status: 500 }) : upstream(url));
  try {
    f.add('exa'); f.add('parallel');
    const response = await f.engine.fetch('https://example.com/page', caller);
    assert.equal(response.provider, 'parallel'); assert.equal(response.results[0].snippet, 'Full page text');
    assert.deepEqual(f.store.logs()[0].calls.map(c => c.status), ['error', 'success']);
  } finally { await f.cleanup(); }
});
