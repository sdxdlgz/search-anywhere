import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { fixture, login } from './helpers.js';
import { anyTokens } from './anysearch-fixtures.js';
import { tokens } from './keenable-fixtures.js';
import { EXA_TEAM, exaBareValue, exaCookieValue, exaUpstream } from './exa-fixtures.js';
import { refreshSelectedUsage } from '../src/usage-refresh.js';
import type { UsageSnapshot } from '../shared/types.js';

test('E1: cookie storage and directory transfer preserve all three providers and existing management credentials', async () => {
  const f = fixture(exaUpstream);
  try {
    const [exa] = f.add('exa'), [any] = f.add('anysearch'), [keen] = f.add('keenable');
    f.store.setLoginSession(any.id, anyTokens()); f.store.setKeenableSession(keen.id, tokens());
    f.store.setManagementSecret(exa.account, 'fixture-management-secret');
    const previous = [f.store.loginSession(any.id), f.store.loginSession(keen.id)];
    f.store.setExaSession(exa.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    await f.engine.syncUsage(exa.id);
    assert.deepEqual([f.store.loginSession(any.id), f.store.loginSession(keen.id)], previous);
    assert.doesNotMatch(JSON.stringify(f.store.all('SELECT * FROM exa_sessions')), /fixture-exa-session/);
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const moved = join(f.directory, 'transfer'); mkdirSync(moved);
    for (const file of ['gateway.sqlite', 'encryption.key']) copyFileSync(join(f.directory, file), join(moved, file));
    assert.ok(!readFileSync(join(moved, 'gateway.sqlite')).includes(Buffer.from('fixture-exa-session')));
    const restored = new Store(moved);
    try {
      assert.equal(restored.exaLogin(restored.loginSession(exa.id)!).cookie, exaCookieValue('rotated'));
      assert.equal(restored.keys().find(k => k.id === exa.id)!.usage!.money_balance!.available_cents, 2000);
      assert.deepEqual([restored.loginSession(any.id), restored.loginSession(keen.id)], previous);
      assert.equal(restored.managementSecret(exa.account), 'fixture-management-secret');
    } finally { restored.close(); }
    f.store.deleteKey(exa.id); assert.equal(f.store.loginSession(exa.id), undefined);
    assert.deepEqual([f.store.loginSession(any.id), f.store.loginSession(keen.id)], previous);
  } finally { await f.cleanup(); }
});

test('E1/E4: admin-only cookie endpoints reject invalid input/providers, expose no cookies and retain search keys on removal', async () => {
  let reads = 0;
  const f = fixture(async (url, init) => { reads++; return exaUpstream(url, init); }); const base = await f.listen();
  try {
    const [key] = f.add('exa'), [any] = f.add('anysearch'); const auth = await login(base);
    const path = `/api/keys/${key.id}/exa-session`;
    const put = (data: unknown, target = path, authenticated = true) => fetch(base + target, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(authenticated ? { cookie: auth } : {}) }, body: JSON.stringify(data) });
    const data = { cookie: `${exaCookieValue()}; _ga=ignore-this-analytics-cookie`, team_id: EXA_TEAM };
    assert.equal((await put(data, path, false)).status, 401);
    assert.equal((await put(data, `/api/keys/${any.id}/exa-session`)).status, 400);
    assert.equal((await put(data, `/api/keys/${key.id}/anysearch-session`)).status, 400);
    assert.equal((await put(data, '/api/keys/missing/exa-session')).status, 404);
    for (const input of [{}, { ...data, team_id: '' }, { ...data, team_id: 'contains spaces' }, { ...data, team_id: 'x'.repeat(101) }, { ...data, cookie: '_ga=only-analytics' }, { ...data, cookie: 'x'.repeat(32769) }, { ...data, unknown: true }]) assert.equal((await put(input)).status, 400);
    const saved = await put(data); assert.equal(saved.status, 200); assert.doesNotMatch(await saved.text(), /fixture-exa-session|analytics-cookie/);
    assert.equal(f.store.exaLogin(f.store.loginSession(key.id)!).cookie, exaCookieValue()); assert.equal(reads, 0);
    for (const resource of ['/api/keys', '/api/dashboard', '/api/logs']) assert.doesNotMatch(await (await fetch(base + resource, { headers: { cookie: auth } })).text(), /fixture-exa-session|analytics-cookie/);
    const bare = await put({ ...data, cookie: exaBareValue }); assert.equal(bare.status, 200); assert.ok(!(await bare.text()).includes(exaBareValue));
    assert.equal(f.store.exaLogin(f.store.loginSession(key.id)!).cookie, `next-auth.session-token=${exaBareValue}`);
    const previous = f.store.loginSession(key.id);
    assert.equal((await put({ ...data, cookie: 'incomplete-fragment' })).status, 400);
    assert.deepEqual(f.store.loginSession(key.id), previous);
    for (const resource of ['/api/keys', '/api/dashboard', '/api/logs']) assert.ok(!(await (await fetch(base + resource, { headers: { cookie: auth } })).text()).includes(exaBareValue));
    assert.equal(reads, 0);
    assert.equal((await fetch(base + path, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(base + path, { method: 'DELETE', headers: { cookie: auth } })).status, 200);
    assert.equal(f.store.loginSession(key.id), undefined); assert.equal(f.store.key(key.id)!.state, 'ready');
  } finally { await f.cleanup(); }
});

test('E4: row and mixed batch isolate keys, scheduler skips expired cookies, and unconfigured cookies retain legacy management usage', async () => {
  let balances = 0, sessions = 0;
  const f = fixture(async (url, init) => {
    if (url.startsWith('https://admin-api.exa.ai/')) return Response.json({ total_cost_usd: 1.25 });
    if (url.endsWith('/get-credits')) balances++;
    if (url.endsWith('/api/auth/session')) sessions++;
    return exaUpstream(url, init);
  }); const base = await f.listen();
  try {
    const [a, b, c] = f.add('exa', 'same source', ['exa-a-12345678', 'exa-b-12345678', 'exa-c-12345678']);
    for (const key of [a, c]) f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    const cookie = await login(base);
    const query = async (id: string): Promise<UsageSnapshot> => {
      const r = await fetch(`${base}/api/keys/${id}/usage`, { method: 'POST', headers: { cookie } }); assert.equal(r.status, 200); return r.json();
    };
    await query(a.id); assert.equal(balances, 1);
    const result = await refreshSelectedUsage([a.id, b.id], query, () => {});
    assert.equal(result.filter(r => r.usage?.status === 'ok').length, 1); assert.equal(result.filter(r => r.usage?.status === 'needs_setup').length, 1);
    assert.equal(balances, 2); assert.equal(f.store.key(c.id)!.usage_json, null);
    f.store.invalidateLoginSession(f.store.loginSession(c.id)!);
    const priorSessions = sessions; await f.engine.syncDueUsage(); assert.equal(sessions, priorSessions);
    f.store.setManagementSecret(b.account, 'legacy-management-12345');
    f.store.run('UPDATE credentials SET exa_key_id=? WHERE id=?', 'legacy-key-id', b.id);
    assert.equal((await query(b.id)).cost_usd, 1.25);
    f.store.removeLoginSession(a.id); f.store.run('UPDATE credentials SET exa_key_id=? WHERE id=?', 'legacy-key-a', a.id);
    assert.equal((await query(a.id)).cost_usd, 1.25);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});
