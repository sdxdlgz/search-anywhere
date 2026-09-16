import test from 'node:test';
import assert from 'node:assert/strict';
import { caller, fixture, result, upstream } from './helpers.js';
import { FREE_MCP, mcpResult, parallelMock } from './parallel-fixtures.js';

test('P6: public API modes cap wire requests at 20 without reducing smaller requests or changing saved profiles', async () => {
  const cases = ['turbo', 'fast', 'basic', 'advanced'].flatMap(mode =>
    [[1, 1], [20, 20], [40, 20], [100, 20]].map(([requested, expected]) => ({ mode, requested, expected })));
  const requests: { mode: string; count: number }[] = [];
  const f = fixture(async (url, init) => {
    assert.equal(url, 'https://api.parallel.ai/v1/search');
    const body = JSON.parse(String(init?.body));
    requests.push({ mode: body.mode, count: body.advanced_settings.max_results });
    return Response.json({ results: Array.from({ length: body.advanced_settings.max_results }, (_, i) => result('parallel', `https://example.com/${i}`)) });
  });
  try {
    f.add('parallel');
    for (const { mode, requested, expected } of cases) {
      f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: mode }, per_provider_results: 100, cache_ttl_seconds: 0 });
      const response = await f.engine.search({ query: `${mode} ${requested}`, per_provider_results: requested, max_results: 1 }, caller);
      assert.deepEqual(requests.at(-1), { mode, count: expected });
      assert.equal(response.providers[0].mode, mode);
      assert.equal(response.providers[0].requested_results, requested);
      assert.equal(response.providers[0].effective_limit, expected);
      assert.equal(response.providers[0].limit_reached, true);
      assert.equal(response.total_results, expected);
      assert.equal(response.results.length, 1);
      assert.deepEqual(response.providers[0].warnings, []);
      assert.equal(f.store.profile()!.per_provider_results, 100);
    }
  } finally { await f.cleanup(); }
});

test('P1/P3: default ordinary routing needs no key, retains all results and reports actual fast mode and unknown result limit', async () => {
  const f = fixture(parallelMock(rpc => mcpResult(rpc, { results: Array.from({ length: 45 }, (_, i) => result('parallel', `https://example.com/${i}`)) })), 'balanced', 'free_first');
  try {
    const profile = { ...f.store.profile()!, modes: { parallel: 'basic' } };
    delete profile.parallel_transport;
    f.store.saveProfile(profile);
    assert.equal(f.store.profile()!.parallel_transport, 'free_first');
    const response = await f.engine.search({ query: 'broad ordinary search', per_provider_results: 2, max_results: 1 }, caller);
    assert.equal(response.partial, false); assert.equal(response.results.length, 1); assert.equal(response.total_results, 45);
    const outcome = response.providers[0];
    assert.equal(outcome.mode, 'fast'); assert.equal(outcome.requested_mode, 'basic'); assert.equal(outcome.transport, 'free_mcp');
    assert.equal(outcome.effective_limit, null); assert.equal(outcome.limit_reached, undefined); assert.equal(outcome.requested_results, 2);
    assert.equal(response.results[0].evidence[0].transport, 'free_mcp'); assert.equal(response.results[0].evidence[0].mode, 'fast');
    assert.equal(f.store.keys().length, 0); assert.equal(f.store.dashboard().calls, 1);
    const log = f.store.logs()[0].calls[0];
    assert.equal(log.key_id, null); assert.equal(log.transport, 'free_mcp'); assert.equal(log.cost_usd, 0); assert.equal(log.billing_source, 'free');
    const next = f.engine.results({ collection_id: response.collection_id, offset: 1, limit: 30 }, caller); assert.equal(next.results.length, 30);
    assert.equal((await f.engine.search({ query: 'broad ordinary search', per_provider_results: 2, max_results: 1 }, caller)).cache_hit, true);
    assert.equal(f.store.todayCalls(), 1);
  } finally { await f.cleanup(); }
});

test('P2/P3: 429 records both attempts, honors shared cooldown, rotates paid keys, then returns to free', async t => {
  let time = Date.now(), freeCalls = 0;
  t.mock.method(Date, 'now', () => time);
  const paidKeys: string[] = [], paidModes: string[] = [], sessions: unknown[] = [];
  const mock = parallelMock(rpc => {
    freeCalls++; sessions.push(rpc.params!.arguments.session_id);
    return freeCalls === 1 ? new Response('not exposed', { status: 429, headers: { 'Retry-After': '2' } }) : mcpResult(rpc, { results: [result('parallel')] });
  });
  const f = fixture(async (url, init) => {
    if (url === FREE_MCP) return mock(url, init);
    paidKeys.push(new Headers(init?.headers).get('x-api-key')!); paidModes.push(JSON.parse(String(init?.body)).mode);
    return upstream(url, init);
  }, 'balanced', 'free_first');
  try {
    f.add('parallel', 'paid account', ['paid-one-123456789', 'paid-two-123456789']);
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'basic' }, cache_ttl_seconds: 0 });
    const first = await f.engine.search({ query: 'first' }, caller);
    assert.equal(first.providers[0].mode, 'basic'); assert.equal(first.providers[0].transport, 'api'); assert.equal(first.providers[0].fallback_reason, 'free_rate_limited');
    const attempts = f.store.logs().find(l => l.id === first.request_id)!.calls;
    assert.deepEqual(attempts.map(c => [c.transport, c.status]), [['free_mcp', 'error'], ['api', 'success']]);
    assert.equal(attempts[0].error_code, 'rate_limited'); assert.equal(attempts[1].fallback_reason, 'free_rate_limited');
    time += 1999;
    await f.engine.search({ query: 'second' }, { id: 'other-client', name: 'other' });
    assert.equal(freeCalls, 1); assert.deepEqual([...paidKeys].sort(), ['paid-one-123456789', 'paid-two-123456789']); assert.deepEqual(paidModes, ['basic', 'basic']);
    time += 2;
    const third = await f.engine.search({ query: 'third' }, caller);
    assert.equal(third.providers[0].transport, 'free_mcp'); assert.equal(freeCalls, 2); assert.equal(paidKeys.length, 2);
    assert.equal(sessions[0], sessions[1]); assert.match(String(sessions[0]), /^[a-f0-9]{64}$/);
    assert.ok(f.store.keys().every(k => k.state === 'ready')); assert.equal(f.store.todayCalls(), 4); assert.equal(f.store.inflight.size, 0);
  } finally { await f.cleanup(); }
});

test('P2: non-rate errors, empty search and local domain filtering do not cause paid fallback', async () => {
  for (const status of [401, 403, 500, 200]) {
    let paid = 0;
    const mock = parallelMock(rpc => status === 200 ? mcpResult(rpc, { results: [result('parallel', 'https://outside.example.com/a')] }) : new Response('private upstream details', { status }));
    const f = fixture(async (url, init) => { if (url !== FREE_MCP) paid++; return mock(url, init); }, 'balanced', 'free_first');
    try {
      f.add('parallel'); f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'fast' } });
      const search = f.engine.search({ query: 'no paid on failure', include_domains: ['sqlite.org'] }, caller);
      if (status === 200) {
        const data = await search; assert.equal(data.results.length, 0); assert.equal(data.scope.filtered_results, 1);
        assert.match(data.providers[0].warnings!.join(' '), /域名条件/);
      } else await assert.rejects(search, /免费 MCP 请求失败/);
      assert.equal(paid, 0); assert.equal(f.store.keys()[0].state, 'ready'); assert.equal(f.store.inflight.size, 0);
    } finally { await f.cleanup(); }
  }
  const f = fixture(parallelMock(rpc => mcpResult(rpc, { results: [] })), 'balanced', 'free_first');
  try {
    f.add('parallel'); f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'fast' } });
    assert.equal((await f.engine.search({ query: 'empty' }, caller)).total_results, 0);
    assert.equal(f.store.logs()[0].calls.length, 1);
  } finally { await f.cleanup(); }
});

test('P2: no fallback key, daily budget and cancellation fail cleanly without extra requests', async () => {
  for (const budget of [0, 1]) {
    const f = fixture(parallelMock(() => new Response(null, { status: 429 })), 'balanced', 'free_first');
    try {
      if (budget) f.add('parallel');
      f.store.saveSettings({ ...f.store.settings(), daily_call_limit: budget });
      f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'fast' } });
      await assert.rejects(f.engine.search({ query: 'limited' }, caller), budget ? /每日上游调用上限/ : /没有可用的密钥/);
      assert.equal(f.store.todayCalls(), 1); assert.equal(f.store.inflight.size, 0);
      if (budget) await assert.rejects(f.engine.search({ query: 'still limited' }, caller), /每日上游调用上限/);
      assert.equal(f.store.todayCalls(), 1);
    } finally { await f.cleanup(); }
  }
  const controller = new AbortController();
  let paid = 0;
  const mock = parallelMock(() => { controller.abort(); throw new Error('request aborted'); });
  const f = fixture(async (url, init) => { if (url !== FREE_MCP) paid++; return mock(url, init); }, 'balanced', 'free_first');
  try {
    f.add('parallel'); f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'basic' } });
    await assert.rejects(f.engine.search({ query: 'cancel' }, caller, { signal: controller.signal }), { code: 'cancelled', status: 499 });
    assert.equal(paid, 0); assert.equal(f.store.logs()[0].calls[0].error_code, 'cancelled'); assert.equal(f.store.inflight.size, 0);
  } finally { await f.cleanup(); }
});

test('P3: advanced, API-only and forced key tests bypass free; advanced never downgrades when keys are absent', async () => {
  const requests: { secret: string | null; mode: string }[] = [];
  const f = fixture(async (url, init) => {
    assert.notEqual(url, FREE_MCP); requests.push({ secret: new Headers(init?.headers).get('x-api-key'), mode: JSON.parse(String(init?.body)).mode });
    return upstream(url, init);
  }, 'balanced', 'free_first');
  try {
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'advanced' } });
    await assert.rejects(f.engine.search({ query: 'advanced without key' }, caller), /没有可用/);
    const keys = f.add('parallel', 'source', ['paid-one-123456789', 'paid-two-123456789']);
    assert.equal((await f.engine.search({ query: 'advanced' }, caller)).providers[0].mode, 'advanced');
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'turbo' }, parallel_transport: 'api' });
    await f.engine.search({ query: 'API only' }, caller);
    f.store.saveProfile({ ...f.store.profile()!, parallel_transport: 'free_first' });
    await f.engine.search({ query: 'specific key probe' }, caller, { forcedKeyId: keys[1].id });
    assert.deepEqual(requests.map(r => r.mode), ['advanced', 'turbo', 'fast']); assert.equal(requests[2].secret, 'paid-two-123456789');
    assert.equal(f.store.logs().find(l => l.operation === 'probe')!.calls[0].key_id, keys[1].id);
  } finally { await f.cleanup(); }
});

test('P4: free full-content fetch shares identity, persists >25k text and preserves paging in both fetch strategies', async () => {
  const sessions: unknown[] = [], full = 'Source page details. '.repeat(2000);
  const f = fixture(parallelMock(rpc => {
    sessions.push(rpc.params!.arguments.session_id);
    return mcpResult(rpc, { results: [{ ...result('parallel'), full_content: rpc.params!.name === 'web_fetch' ? full : undefined }] });
  }), 'balanced', 'free_first');
  try {
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'basic' } });
    await f.engine.search({ query: 'related search' }, caller);
    for (const fetch_strategy of ['fallback', 'parallel'] as const) {
      f.store.saveProfile({ ...f.store.profile()!, fetch_strategy });
      const page = await f.engine.fetch('https://parallel.example.com/article', caller);
      const a = f.engine.evidence({ collection_id: page.collection_id, url: page.url, limit: 20000 }, caller);
      const b = f.engine.evidence({ collection_id: page.collection_id, url: page.url, offset: 20000, limit: 20000 }, caller);
      const c = f.engine.evidence({ collection_id: page.collection_id, url: page.url, offset: 40000, limit: 20000 }, caller);
      assert.equal(a.total_characters, full.length); assert.equal(c.next_offset, null);
      assert.equal(a.evidence[0].content! + b.evidence[0].content! + c.evidence[0].content!, full);
      assert.equal(a.evidence[0].transport, 'free_mcp'); assert.equal(a.evidence[0].truncated, false);
    }
    assert.equal(new Set(sessions).size, 1); assert.equal(f.store.todayCalls(), 3);
  } finally { await f.cleanup(); }
});

test('P4: rate-limited free fetch uses paid extract, while advanced fetch goes directly to the API', async () => {
  let paid = 0, free = 0;
  const mock = parallelMock(() => { free++; return new Response(null, { status: 429 }); });
  const f = fixture(async (url, init) => {
    if (url === FREE_MCP) return mock(url, init);
    paid++; assert.equal(url, 'https://api.parallel.ai/v1/extract');
    assert.equal(JSON.parse(String(init?.body)).advanced_settings.full_content, true);
    return upstream(url, init);
  }, 'balanced', 'free_first');
  try {
    f.add('parallel'); f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'basic' } });
    const page = await f.engine.fetch('https://example.com/article', caller);
    assert.equal(page.providers[0].fallback_reason, 'free_rate_limited'); assert.equal(paid, 1); assert.equal(free, 1);
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'advanced' } });
    await f.engine.fetch('https://example.com/advanced', caller);
    assert.equal(paid, 2); assert.equal(free, 1);
  } finally { await f.cleanup(); }
});
