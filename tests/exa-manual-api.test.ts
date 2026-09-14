import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixture, login } from './helpers.js';
import { exaBalanceSnapshot } from '../server/exa-balance.js';
import { exaCookieValue, exaCredits, exaPlan, EXA_TEAM } from './exa-fixtures.js';
import { Usage } from '../src/components.js';
import { ChannelQuotas } from '../src/pages/ChannelQuotas.js';

test('E8/E11: manual balance endpoints require admin, validate amounts/providers and retain official snapshots and cookies across mode changes', async () => {
  let upstream = 0;
  const f = fixture(async () => { upstream++; throw new Error('unexpected upstream call'); });
  const base = await f.listen();
  try {
    const [key] = f.add('exa'), [other] = f.add('tavily');
    const auth = await login(base), path = `/api/keys/${key.id}/exa-balance`;
    const put = (value: unknown, target = path, authorized = true) => fetch(base + target, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(authorized ? { Cookie: auth } : {}) }, body: JSON.stringify(value) });
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await put({ mode: 'manual', balance_usd: 20 }, path, false)).status, 401);
    assert.equal((await put({ mode: 'official' }, `/api/keys/${other.id}/exa-balance`)).status, 400);
    assert.equal((await put({ mode: 'official' }, '/api/keys/missing/exa-balance')).status, 404);
    for (const body of [{}, { mode: 'guess' }, { mode: 'manual' }, { mode: 'manual', balance_usd: '20' }, { mode: 'manual', balance_usd: null }, { mode: 'manual', balance_usd: .1234567 }, { mode: 'manual', balance_usd: 1000001 }, { mode: 'manual', balance_usd: 20, team_id: 'bad team' }, { mode: 'manual', balance_usd: 20, team_id: 'x'.repeat(101) }, { mode: 'official', balance_usd: 20 }]) assert.equal((await put(body)).status, 400);
    const old = exaBalanceSnapshot(exaCredits, exaPlan, EXA_TEAM); f.store.setUsage(key.id, old);
    f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    const session = f.store.loginSession(key.id);
    assert.equal((await put({ mode: 'manual', balance_usd: 0, team_id: EXA_TEAM })).status, 200);
    const manual = await (await fetch(base + path, { headers: { Cookie: auth } })).json();
    assert.equal(manual.usage.source, 'estimated'); assert.equal(manual.usage.local_balance.remaining_usd, 0);
    assert.doesNotMatch(JSON.stringify(manual), /fixture-exa-session|exa-secret-0123456789/);
    const query = await fetch(`${base}/api/keys/${key.id}/usage`, { method: 'POST', headers: { Cookie: auth } });
    assert.equal(query.status, 200); assert.equal((await query.json()).source, 'estimated'); assert.equal(upstream, 0);
    assert.equal((await put({ mode: 'official' })).status, 200);
    assert.deepEqual(f.store.keys().find(k => k.id === key.id)!.usage, old); assert.deepEqual(f.store.loginSession(key.id), session);
    const pending = f.store.beginCall('busy', f.store.key(key.id)!, 'auto', 'search')!;
    assert.equal((await put({ mode: 'manual', balance_usd: 30 })).status, 409);
    f.store.finishCall(pending, { status: 'error', duration_ms: 0 });
    assert.equal((await put({ mode: 'manual', balance_usd: 30 })).status, 200);
    assert.equal(f.store.exaLedger.manualUsage(key.id)!.local_balance!.remaining_usd, 30);
  } finally { await f.cleanup(); }
});

test('E10/E11: estimated rows, channel totals and challenge details are labeled without presenting an estimate as official quota', async () => {
  const f = fixture();
  try {
    const [key] = f.add('exa');
    f.store.exaLedger.configure(key.id, { mode: 'manual', balance_usd: 20.123456 });
    const cell = renderToStaticMarkup(createElement(Usage, { usage: f.store.keys()[0].usage, error: null }));
    assert.match(cell, /本地估算 \$20.123456/); assert.match(cell, /仅本网关费用/); assert.doesNotMatch(cell, /官网余额|未结算账单/);
    const channel = renderToStaticMarkup(createElement(ChannelQuotas, { keys: f.store.keys(), onAdd() {} }));
    assert.match(channel, /已知余额（含估算）/); assert.match(channel, /USD/); assert.doesNotMatch(channel, /credits/);
    f.store.exaLedger.configure(key.id, { mode: 'official' });
    f.store.exaLedger.pause(key.id, 'challenge', 'Exa requires browser verification'); f.store.usageError(key.id, 'Exa requires browser verification');
    const challenged = f.store.keys()[0];
    const diagnosis = renderToStaticMarkup(createElement(Usage, { usage: challenged.usage, error: challenged.usage_error, exaBalance: challenged.exa_balance }));
    assert.match(diagnosis, /<details><summary>官网需浏览器验证/); assert.doesNotMatch(diagnosis, /同步失败/);
  } finally { await f.cleanup(); }
});
