import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, upstream } from './helpers.js';
import { tokenUsage } from '../server/token-usage.js';
import type { Provider } from '../shared/types.js';
import { parallelMock, mcpResult } from './parallel-fixtures.js';

test('T2/T3: currency and provider credits stay separate; zero, free, unknown and running have distinct meanings', async () => {
  const f = fixture();
  try {
    const a = f.store.createToken('same name'), b = f.store.createToken('same name'), unused = f.store.createToken('unused');
    const id = f.store.beginRequest(a.name, 'search', 'fixture', 'balanced', a.id);
    const call = (provider: Provider, data: Parameters<typeof f.store.finishCall>[1]) => {
      const callId = f.store.beginCall(id, { id: null, provider, label: 'fixture', account: '', masked: '' }, 'auto', 'search')!;
      f.store.finishCall(callId, data);
    };
    call('exa', { status: 'success', duration_ms: 1, cost_usd: .007, billing_source: 'reported' });
    call('exa', { status: 'success', duration_ms: 1, cost_usd: .011, billing_source: 'estimated' });
    call('tavily', { status: 'success', duration_ms: 1, credits: 1, billing_source: 'reported' });
    call('tavily', { status: 'success', duration_ms: 1, credits: 2, billing_source: 'estimated' });
    call('keenable', { status: 'success', duration_ms: 1, credits: 3, paid: false, billing_source: 'reported' });
    call('parallel', { status: 'success', duration_ms: 1, cost_usd: 0, billing_source: 'free' });
    call('anysearch', { status: 'error', duration_ms: 1 });
    const running = f.store.beginCall(id, { id: null, provider: 'exa', label: '', account: '', masked: '' }, 'auto', 'search')!;
    let usage = f.store.tokens().find(t => t.id === a.id)!.usage!.lifetime;
    assert.equal(usage.requests, 1); assert.equal(usage.upstream_calls, 8); assert.equal(usage.running, 1); assert.equal(usage.running_calls, 1);
    assert.equal(usage.free_calls, 1); assert.equal(usage.unpriced_calls, 1);
    assert.equal(usage.reported_cost_usd, .007); assert.equal(usage.estimated_cost_usd, .011);
    assert.deepEqual(usage.credits_by_provider, [{ provider: 'keenable', reported: 3, estimated: null }, { provider: 'tavily', reported: 1, estimated: 2 }]);
    f.store.finishCall(running, { status: 'success', duration_ms: 1, cost_usd: 0, billing_source: 'reported' });
    f.store.finishRequest(id, 'partial', 8); f.store.revokeToken(a.id);
    usage = f.store.tokens().find(t => t.id === a.id)!.usage!.lifetime;
    assert.equal(usage.running, 0); assert.equal(usage.running_calls, 0); assert.equal(usage.partial, 1); assert.equal(usage.reported_cost_usd, .007);
    for (const token of [b, unused]) {
      const empty = f.store.tokens().find(t => t.id === token.id)!.usage!.lifetime;
      assert.equal(empty.requests, 0); assert.equal(empty.upstream_calls, 0); assert.equal(empty.reported_cost_usd, null); assert.deepEqual(empty.credits_by_provider, []);
    }
    const zero = f.store.beginRequest(b.name, 'fetch', 'fixture', 'balanced', b.id);
    const zeroCall = f.store.beginCall(zero, { id: null, provider: 'exa', label: '', account: '', masked: '' }, 'auto', 'fetch')!;
    f.store.finishCall(zeroCall, { status: 'success', duration_ms: 1, cost_usd: 0, billing_source: 'reported' }); f.store.finishRequest(zero, 'success', 1);
    assert.equal(f.store.tokens().find(t => t.id === b.id)!.usage!.lifetime.reported_cost_usd, 0);
  } finally { await f.cleanup(); }
});

test('T2: UTC month boundaries use each request/call timestamp without request join fanout', async () => {
  const f = fixture();
  try {
    const token = f.store.createToken('monthly');
    for (const [at, count] of [['2026-01-31T23:59:59.999Z', 1], ['2026-02-01T00:00:00.000Z', 2], ['2026-02-28T23:59:59.999Z', 3], ['2026-03-01T00:00:00.000Z', 4]] as const) {
      const id = f.store.beginRequest(token.name, 'search', 'boundary', 'balanced', token.id);
      f.store.run('UPDATE requests SET created_at=? WHERE id=?', at, id); f.store.finishRequest(id, 'success', 1, true);
      for (let n = 0; n < count; n++) {
        const call = f.store.beginCall(id, { id: null, provider: 'tavily', label: '', account: '', masked: '' }, 'basic', 'search')!;
        f.store.run('UPDATE calls SET created_at=? WHERE id=?', at, call);
        f.store.finishCall(call, { status: 'success', duration_ms: 1, credits: 1, billing_source: 'reported' });
      }
    }
    const stats = tokenUsage(f.store, new Date('2026-02-15T12:00:00Z')).get(token.id)!;
    assert.equal(stats.month_start, '2026-02-01T00:00:00.000Z'); assert.equal(stats.month.requests, 2); assert.equal(stats.month.cache_hits, 2);
    assert.equal(stats.month.upstream_calls, 5); assert.equal(stats.month.credits_by_provider[0].reported, 5);
    assert.equal(stats.lifetime.requests, 4); assert.equal(stats.lifetime.upstream_calls, 10);
  } finally { await f.cleanup(); }
});

test('T1/T2: concurrent identical queries are two owned requests but only one upstream attempt', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (url, init) => { entered(); await gate; return upstream(url, init); });
  try {
    f.add('exa'); f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const token = f.store.createToken('coalesced');
    const first = f.engine.search({ query: 'same query' }, token); await ready;
    const second = f.engine.search({ query: 'same query' }, token); release();
    const results = await Promise.all([first, second]); assert.equal(results.filter(r => r.cache_hit).length, 1);
    const usage = f.store.tokens()[0].usage!.lifetime;
    assert.equal(usage.requests, 2); assert.equal(usage.cache_hits, 1); assert.equal(usage.upstream_calls, 1); assert.equal(usage.reported_cost_usd, .007);
  } finally { release(); await f.cleanup(); }
});

test('T1/T2: retry, partial success, all-provider failure and free-to-paid fallback keep the same client owner', async () => {
  let attempts = 0;
  const f = fixture(async (url, init) => url.includes('exa') && attempts++ === 0 ? new Response(null, { status: 401 }) : upstream(url, init));
  const free = fixture(parallelMock(rpc => String(rpc.params?.arguments.objective).includes('limited') ? new Response(null, { status: 429 }) : mcpResult(rpc, { results: [] })), 'balanced', 'free_first');
  try {
    f.add('exa', 'fixture', ['fixture-exa-key-one-1234', 'fixture-exa-key-two-1234']);
    const token = f.store.createToken('retry');
    const result = await f.engine.search({ query: 'partial with missing providers' }, token); assert.equal(result.partial, true);
    const usage = f.store.tokens()[0].usage!.lifetime;
    assert.equal(usage.requests, 1); assert.equal(usage.partial, 1); assert.equal(usage.upstream_calls, 2); assert.equal(usage.unpriced_calls, 1); assert.equal(usage.reported_cost_usd, .007);
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: null, parallel: null, tavily: 'basic' } });
    await assert.rejects(f.engine.search({ query: 'all failed' }, token));
    assert.equal(f.store.tokens()[0].usage!.lifetime.errors, 1); assert.equal(f.store.tokens()[0].usage!.lifetime.upstream_calls, 2);
    free.add('parallel'); free.store.saveProfile({ ...free.store.profile()!, modes: { exa: null, parallel: 'basic', tavily: null } });
    const client = free.store.createToken('free-first');
    await free.engine.search({ query: 'free request' }, client); await free.engine.search({ query: 'limited request' }, client);
    const mixed = free.store.tokens()[0].usage!.lifetime;
    assert.equal(mixed.requests, 2); assert.equal(mixed.upstream_calls, 3); assert.equal(mixed.free_calls, 2); assert.equal(mixed.unpriced_calls, 1); assert.equal(mixed.reported_cost_usd, null);
  } finally { await f.cleanup(); await free.cleanup(); }
});
