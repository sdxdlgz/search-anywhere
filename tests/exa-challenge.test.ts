import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { exaCookieValue, EXA_TEAM, exaUpstream, exaCredits, exaPlan } from './exa-fixtures.js';
import { exaBalanceSnapshot } from '../server/exa-balance.js';

test('E7: explicit Vercel and Cloudflare challenges pause only automatic balance reads, preserve credentials and recover on explicit retry', async () => {
  for (const [header, status] of [['x-vercel-mitigated', 429], ['cf-mitigated', 403]] as const) {
    let challenged = true, reads = 0;
    const f = fixture(async (url, init) => { reads++; return challenged ? new Response('private upstream HTML', { status, headers: { [header]: 'challenge', 'Content-Type': 'text/html' } }) : exaUpstream(url, init); });
    const clock = Date.now;
    try {
      const [key] = f.add('exa'); f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
      f.store.setUsage(key.id, exaBalanceSnapshot(exaCredits, exaPlan, EXA_TEAM));
      const previous = f.store.key(key.id)!.usage_json, login = f.store.loginSession(key.id);
      await assert.rejects(f.engine.syncUsage(key.id), /浏览器验证/);
      assert.equal(reads, 1); assert.equal(f.store.exaLedger.autoPaused(key.id), true);
      assert.deepEqual(f.store.loginSession(key.id), login); assert.equal(f.store.key(key.id)!.usage_json, previous);
      assert.equal(f.store.key(key.id)!.state, 'ready'); assert.equal(f.store.todayCalls(), 0);
      Date.now = () => clock() + 31 * 60000;
      await f.engine.syncDueUsage(); assert.equal(reads, 1);
      challenged = false; await f.engine.syncUsage(key.id);
      assert.equal(reads, 5); assert.equal(f.store.exaLedger.autoPaused(key.id), false);
      assert.equal(f.store.key(key.id)!.usage_error, null);
    } finally { Date.now = clock; await f.cleanup(); }
  }
});

test('E7: genuine 429 honors Retry-After while permissions and unmarked HTML are not mislabeled as a challenge', async () => {
  let response: (() => Response) | null = () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  let reads = 0;
  const f = fixture(async (url, init) => { reads++; return response ? response() : exaUpstream(url, init); });
  const clock = Date.now;
  try {
    const [key] = f.add('exa'); f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    await assert.rejects(f.engine.syncUsage(key.id), { status: 429 });
    await assert.rejects(f.engine.syncUsage(key.id), { status: 429 }); assert.equal(reads, 1);
    assert.equal(f.store.exaLedger.block(key.id)!.reason, 'rate_limited');
    Date.now = () => clock() + 61000; response = null;
    await f.engine.syncUsage(key.id); assert.equal(reads, 5); assert.equal(f.store.exaLedger.block(key.id), undefined);
    for (const next of [() => new Response(null, { status: 403 }), () => new Response('<html>Vercel Security Checkpoint</html>', { headers: { 'Content-Type': 'text/html' } })]) {
      response = next; await assert.rejects(f.engine.syncUsage(key.id)); assert.equal(f.store.exaLedger.block(key.id), undefined);
      assert.equal(f.store.loginSession(key.id)!.needs_login, 0); assert.doesNotMatch(f.store.key(key.id)!.usage_error!, /浏览器验证/);
    }
  } finally { Date.now = clock; await f.cleanup(); }
});

test('E8: switching to manual while official sync is pending rejects stale writes and skips all scheduled/row upstream reads', async () => {
  let release!: () => void, started!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(async (url, init) => { reads++; if (url.endsWith('/get-credits')) { started(); await gate; } return exaUpstream(url, init); });
  const clock = Date.now;
  try {
    const [key] = f.add('exa'); f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    const query = f.engine.syncUsage(key.id), rejected = assert.rejects(query, { code: 'usage_context_changed' }); await reached;
    f.store.exaLedger.configure(key.id, { mode: 'manual', balance_usd: 12, team_id: EXA_TEAM });
    release(); await rejected; const previousReads = reads;
    assert.equal(f.store.key(key.id)!.usage_json, null);
    assert.equal((await f.engine.syncUsage(key.id)).local_balance!.remaining_usd, 12);
    Date.now = () => clock() + 31 * 60000; await f.engine.syncDueUsage(); assert.equal(reads, previousReads);
    f.store.exaLedger.configure(key.id, { mode: 'official' }); await f.engine.syncUsage(key.id);
    assert.equal(f.store.keys()[0].usage!.money_balance!.available_cents, 2000);
  } finally { Date.now = clock; release(); await f.cleanup(); }
});
