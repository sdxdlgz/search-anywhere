import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller, upstream } from './helpers.js';
import { refreshSelectedUsage } from '../src/usage-refresh.js';
import type { UsageSnapshot } from '../shared/types.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Usage } from '../src/components.js';

const snapshot = (used = 0): UsageSnapshot => ({ status: 'ok', source: 'official', synced_at: new Date().toISOString(), key: { used, limit: null }, account: { plan: 'Researcher', used: 0, limit: 1000, paygo_used: 0, paygo_limit: null } });

test('U1: reported search consumption remains separate when official key and account both return zero', async () => {
  let accountUsed = 0;
  const f = fixture(async (url, init) => url.endsWith('/usage') ? Response.json({ key: { usage: 0, limit: null }, account: { current_plan: 'Researcher', plan_usage: accountUsed, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } }) : upstream(url, init));
  try {
    const [key] = f.add('tavily');
    await f.engine.search({ query: 'one real search contract' }, caller);
    await f.engine.syncUsage(key.id);
    const local = f.store.keys()[0];
    assert.equal(local.successes, 1); assert.equal(local.metering.reported_credits, 1); assert.equal(local.metering.reported_calls, 1);
    assert.equal(local.usage!.key!.used, 0); assert.equal(local.usage!.account!.used, 0); assert.equal(local.usage!.key!.limit, null);
    accountUsed = 9; await f.engine.syncUsage(key.id);
    assert.equal(f.store.keys()[0].usage!.key!.used, 0); assert.equal(f.store.keys()[0].usage!.account!.used, 9);
    assert.equal(f.store.keys()[0].metering.reported_credits, 1);
  } finally { await f.cleanup(); }
});

test('U1: monthly metering separates reported, estimated and unknown; historical usage is not current-month consumption', async () => {
  let count = 0;
  const f = fixture(async () => Response.json({ results: [], ...(count++ === 0 ? { usage: { credits: 1 } } : {}) }));
  try {
    const [key] = f.add('tavily'); f.add('parallel');
    f.store.saveProfile({ ...f.store.profile()!, modes: { tavily: 'advanced' }, cache_ttl_seconds: 0 });
    await f.engine.search({ query: 'reported' }, caller);
    await f.engine.search({ query: 'estimated' }, caller);
    let k = f.store.keys().find(k => k.id === key.id)!;
    assert.equal(k.metering.reported_credits, 1); assert.equal(k.metering.estimated_credits, 2);
    assert.equal(k.metering.estimated_calls, 1);
    f.store.run("UPDATE calls SET created_at='2000-01-01T00:00:00.000Z' WHERE billing_source='reported'");
    k = f.store.keys().find(k => k.id === key.id)!;
    assert.equal(k.metering.reported_credits, 0); assert.equal(k.successes, 2); assert.equal(k.metering.estimated_credits, 2);
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'advanced' } });
    await f.engine.search({ query: 'unknown charge' }, caller);
    assert.equal(f.store.keys().find(k => k.provider === 'parallel')!.metering.unreported_calls, 1);
  } finally { await f.cleanup(); }
});

test('U1: rendered official zero never replaces locally reported credits; null and zero limits stay distinct', () => {
  const metering = { month: '2026-09', reported_credits: 1, reported_calls: 1, estimated_credits: 0, estimated_calls: 0, unreported_calls: 0 };
  const value = snapshot(); value.account!.used = 7;
  const html = renderToStaticMarkup(createElement(Usage, { usage: value, error: 'failed', metering }));
  assert.match(html, /官方 key 已用 0 credits/); assert.match(html, /账号套餐已用 7/);
  assert.match(html, /网关本月已记录 1 credits/); assert.match(html, /查询于/); assert.match(html, /同步失败/); assert.match(html, /上限 未提供/);
  value.key!.limit = 0; value.account!.limit = 0;
  const zero = renderToStaticMarkup(createElement(Usage, { usage: value, error: null }));
  assert.match(zero, /key 上限 0/); assert.match(zero, /套餐剩余 0 credits/);
});

test('U3: explicit batch only touches selected keys, bounds concurrency and preserves partial success', async () => {
  const called: string[] = [], finished: string[] = []; let active = 0, peak = 0;
  const results = await refreshSelectedUsage(['a', 'b', 'c', 'd', 'e'], async id => {
    called.push(id); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (id === 'b') throw new Error('official usage unavailable');
    if (id === 'e') return { status: 'unsupported', source: 'unknown', synced_at: new Date().toISOString() };
    return snapshot(1);
  }, result => finished.push(result.id));
  assert.deepEqual(called, ['a', 'b', 'c', 'd', 'e']); assert.equal(peak, 3); assert.equal(finished.length, 5);
  assert.equal(results.filter(r => r.error).length, 1); assert.equal(results.filter(r => r.usage?.status === 'ok').length, 3);
  assert.equal(results.find(r => r.id === 'e')!.usage!.status, 'unsupported');
  for (const invalid of [[], ['a', 'a'], [''], Array.from({ length: 101 }, (_, i) => String(i))]) {
    let invoked = false;
    await assert.rejects(refreshSelectedUsage(invalid, async () => { invoked = true; return snapshot(); }, () => {}));
    assert.equal(invoked, false);
  }
});

test('U4: overlapping manual/batch calls coalesce, and a pending background batch skips keys manually refreshed meanwhile', async () => {
  let release!: () => void; const started: string[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (url, init) => {
    const auth = new Headers(init?.headers).get('authorization')!; started.push(auth);
    if (auth.includes('first')) await gate;
    return upstream(url, init);
  });
  try {
    const [a, b] = f.add('tavily', 'account', ['first-credential-123456', 'second-credential-123456']);
    const background = f.engine.syncDueUsage();
    const manual = f.engine.syncUsage(a.id);
    const batch = refreshSelectedUsage([a.id, b.id], id => f.engine.syncUsage(id), () => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(started.length, 2); release();
    await Promise.all([background, manual, batch]); assert.equal(started.length, 2);
    assert.ok(f.store.keys().every(k => k.usage?.status === 'ok'));
    f.store.saveSettings({ ...f.store.settings(), usage_sync_minutes: 0 });
    await f.engine.syncDueUsage(); assert.equal(started.length, 2);
  } finally { release(); await f.cleanup(); }
});

test('U4: usage finishing after account reassignment or deletion cannot repopulate a stale snapshot', async () => {
  for (const operation of ['reassign', 'delete'] as const) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async (url, init) => { await gate; return upstream(url, init); });
    try {
      const [key] = f.add('tavily'); const pending = f.engine.syncUsage(key.id);
      const rejected = assert.rejects(pending, /配置已变化/);
      if (operation === 'delete') f.store.deleteKey(key.id);
      else f.store.updateKey(key.id, { label: key.label, account: 'different owner', enabled: true, max_concurrency: 2, exa_key_id: '' });
      release(); await rejected;
      if (operation === 'reassign') { assert.equal(f.store.keys()[0].usage, null); assert.equal(f.store.keys()[0].usage_error, null); }
    } finally { release(); await f.cleanup(); }
  }
});
