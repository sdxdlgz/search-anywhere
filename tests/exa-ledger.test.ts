import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Providers } from '../server/providers.js';
import { fixture, caller, result, upstream } from './helpers.js';
import { exaBalanceSnapshot } from '../server/exa-balance.js';
import { exaCookieValue, exaCredits, exaPlan } from './exa-fixtures.js';
import { channelQuotas } from '../src/channel-quotas.js';

test('E8/E9: calibration counts subsequent search, fetch and key probes, skips cache/other providers, tracks unknown failures and allows negative estimates', async () => {
  let fail = false;
  const f = fixture(async (url, init) => fail ? new Response(null, { status: 503 }) : upstream(url, init));
  try {
    const [key] = f.add('exa'), [other] = f.add('tavily');
    f.store.saveProfile({ ...f.store.profile('balanced')!, modes: { exa: 'auto' } });
    await f.engine.search({ query: 'cached baseline' }, caller);
    f.store.exaLedger.configure(key.id, { mode: 'manual', balance_usd: 20 });
    assert.equal((await f.engine.search({ query: 'cached baseline' }, caller)).cache_hit, true);
    assert.equal(f.store.exaLedger.manualUsage(key.id)!.local_balance!.remaining_usd, 20);
    await f.engine.search({ query: 'new search after calibration' }, caller);
    const afterSearch = f.store.exaLedger.manualUsage(key.id)!.local_balance!;
    assert.equal(afterSearch.remaining_usd, 19.993);
    assert.equal((await f.engine.search({ query: 'cached baseline' }, caller)).cache_hit, true);
    await f.engine.fetch('https://example.com/page', caller, 'balanced');
    await f.engine.search({ query: 'probe' }, caller, { forcedKeyId: key.id });
    const beforeOther = f.store.exaLedger.manualUsage(key.id)!.local_balance!;
    await f.engine.search({ query: 'other supplier' }, caller, { forcedKeyId: other.id });
    assert.deepEqual(f.store.exaLedger.manualUsage(key.id)!.local_balance, beforeOther);
    assert.equal(beforeOther.remaining_usd, 19.979);
    fail = true;
    await assert.rejects(f.engine.search({ query: 'failed probe' }, caller, { forcedKeyId: key.id }));
    const unknown = f.store.exaLedger.manualUsage(key.id)!.local_balance!;
    assert.equal(unknown.remaining_usd, beforeOther.remaining_usd); assert.equal(unknown.unpriced_calls, 1);
    f.store.exaLedger.configure(key.id, { mode: 'manual', balance_usd: 0 });
    assert.equal(f.store.exaLedger.manualUsage(key.id)!.local_balance!.unpriced_calls, 0);
    fail = false; f.store.setKeyState(key.id, 'ready', null, null);
    await f.engine.search({ query: 'negative balance' }, caller, { forcedKeyId: key.id });
    assert.equal(f.store.exaLedger.manualUsage(key.id)!.local_balance!.remaining_usd, -0.007);
    assert.equal(f.store.key(key.id)!.state, 'ready');
  } finally { await f.cleanup(); }
});

test('E9: current mode rates use raw results before filtering, prefer reported zero/cost and price text extraction once', async () => {
  const f = fixture();
  try {
    const [key] = f.add('exa'); let report: number | undefined;
    const p = new Providers(f.store, async url => Response.json({ results: Array.from({ length: url.endsWith('/contents') ? 1 : 12 }, (_, i) => result('exa', i === 0 ? 'http://localhost/private' : `https://example.com/${i}`)), ...(report === undefined ? {} : { costDollars: { total: report } }) }));
    for (const [mode, cost] of [['instant', .009], ['fast', .009], ['auto', .009], ['deep-lite', .014], ['deep', .014], ['deep-reasoning', .017]] as const) {
      const data = await p.search(f.store.key(key.id)!, mode, { query: 'pricing' }, 100, AbortSignal.timeout(1000));
      assert.equal(data.results.length, 11); assert.equal(data.cost_usd, cost); assert.equal(data.billing_source, 'estimated');
    }
    assert.equal((await p.fetch(f.store.key(key.id)!, 'https://example.com/page', AbortSignal.timeout(1000))).cost_usd, .001);
    for (report of [0, .123456]) {
      const data = await p.search(f.store.key(key.id)!, 'auto', { query: 'reported' }, 100, AbortSignal.timeout(1000));
      assert.equal(data.cost_usd, report); assert.equal(data.billing_source, 'reported');
    }
  } finally { await f.cleanup(); }
});

test('E8/E10: shared team ledger deduplicates official snapshots, retains deleted-key charges and survives transfer without changing secrets', async () => {
  const f = fixture();
  try {
    const [a, b, c] = f.add('exa', 'same note', ['exa-ledger-a12345678', 'exa-ledger-b12345678', 'exa-ledger-c12345678']);
    for (const key of [a, b]) f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: 'shared-team' });
    const old = exaBalanceSnapshot(exaCredits, exaPlan, 'shared-team');
    f.store.setUsage(b.id, old);
    f.store.exaLedger.configure(a.id, { mode: 'manual', balance_usd: 20, team_id: 'shared-team' });
    f.store.exaLedger.configure(c.id, { mode: 'manual', balance_usd: 5 });
    const call = f.store.beginCall('fixture-call', f.store.key(b.id)!, 'auto', 'search')!;
    f.store.finishCall(call, { status: 'success', duration_ms: 1, cost_usd: .007, billing_source: 'reported' });
    const [summary] = channelQuotas(f.store.keys());
    assert.equal(summary.sharedCount, 1); assert.equal(summary.manualCount, 2); assert.equal(summary.moneyTotals, null);
    assert.equal(Math.round(summary.manualTotal * 10000), 24993000);
    f.store.deleteKey(b.id);
    assert.equal(f.store.exaLedger.manualUsage(a.id)!.local_balance!.remaining_usd, 19.993);
    f.store.updateKey(a.id, { label: a.label, account: 'new note', enabled: true, max_concurrency: 2, exa_key_id: '' });
    assert.equal(f.store.exaLedger.manualUsage(a.id)!.local_balance!.remaining_usd, 19.993);
    const session = f.store.loginSession(a.id);
    f.store.exaLedger.pause(a.id, 'challenge', 'Fixture browser challenge');
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const moved = join(f.directory, 'transfer'); mkdirSync(moved);
    for (const name of ['gateway.sqlite', 'encryption.key']) copyFileSync(join(f.directory, name), join(moved, name));
    const restored = new Store(moved);
    try { assert.equal(restored.exaLedger.manualUsage(a.id)!.local_balance!.remaining_usd, 19.993); assert.deepEqual(restored.loginSession(a.id), session); assert.equal(restored.exaLedger.block(a.id)!.reason, 'challenge'); }
    finally { restored.close(); }
    f.store.exaLedger.configure(a.id, { mode: 'manual', balance_usd: 10, team_id: 'shared-team' });
    assert.equal(f.store.exaLedger.manualUsage(a.id)!.local_balance!.remaining_usd, 10);
    f.store.exaLedger.configure(a.id, { mode: 'official' });
    assert.equal(f.store.exaLedger.manualUsage(a.id), undefined); assert.deepEqual(f.store.loginSession(a.id), session);
  } finally { await f.cleanup(); }
});

test('E8/E10: reject invalid calibration and in-flight related calls without damaging the prior baseline', async () => {
  const f = fixture();
  try {
    const [a, b] = f.add('exa', 'source', ['exa-input-a12345678', 'exa-input-b12345678']);
    f.store.exaLedger.configure(a.id, { mode: 'manual', balance_usd: 0.000001, team_id: 'shared' });
    f.store.setExaSession(b.id, { cookie: exaCookieValue(), team_id: 'shared' });
    for (const amount of [NaN, Infinity, 1000001, -1000001, .1234567, 1e-11]) assert.throws(() => f.store.exaLedger.configure(a.id, { mode: 'manual', balance_usd: amount }), { code: 'invalid_balance' });
    const pending = f.store.beginCall('pending', f.store.key(b.id)!, 'auto', 'search')!;
    assert.throws(() => f.store.exaLedger.configure(a.id, { mode: 'manual', balance_usd: 10, team_id: 'shared' }), { code: 'balance_busy' });
    assert.equal(f.store.exaLedger.manualUsage(a.id)!.local_balance!.baseline_usd, .000001);
    f.store.finishCall(pending, { status: 'success', duration_ms: 1, cost_usd: 0, billing_source: 'reported' });
    assert.equal(f.store.exaLedger.manualUsage(a.id)!.local_balance!.unpriced_calls, 0);
    f.store.exaLedger.configure(a.id, { mode: 'manual', balance_usd: -1000000 });
    assert.equal(f.store.exaLedger.manualUsage(a.id)!.local_balance!.remaining_usd, -1000000);
  } finally { await f.cleanup(); }
});
