import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, login } from './helpers.js';
import { accountMock, tokenResponse } from './parallel-account-fixtures.js';

test('B1/B4: only admins authorize and remove Parallel sessions; row queries are isolated and never meter search usage', async t => {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const f = fixture(accountMock), base = await f.listen();
  try {
    const [key, other] = f.add('parallel', 'same source', ['parallel-api-one-12345678', 'parallel-api-two-12345678']);
    const [exa] = f.add('exa');
    const cookie = await login(base), token = f.store.createToken('ordinary search client');
    const send = (path: string, method = 'POST', headers: Record<string, string> = { cookie }) => fetch(`${base}/api/keys/${path}`, { method, headers });
    assert.equal((await send(`${key.id}/parallel-auth`, 'POST', {})).status, 401);
    assert.equal((await send(`${key.id}/parallel-auth`, 'POST', { Authorization: `Bearer ${token.token}` })).status, 401);
    assert.equal((await send(`${exa.id}/parallel-auth`)).status, 400);
    assert.equal((await send(`missing/parallel-auth`)).status, 404);
    const start = await send(`${key.id}/parallel-auth`); assert.equal(start.status, 200);
    const flow = await start.json(); assert.ok(!JSON.stringify(flow).includes('device_code'));
    assert.equal((await send(`${key.id}/parallel-auth/not-uuid/poll`)).status, 400);
    time += 1000;
    assert.equal((await (await send(`${key.id}/parallel-auth/${flow.id}/poll`)).json()).status, 'connected');
    const before = f.store.keys().find(k => k.id === other.id)!;
    const quota = await send(`${key.id}/usage`); assert.equal(quota.status, 200); assert.equal((await quota.json()).organization_balance.credits_cents, 2000);
    assert.deepEqual(f.store.keys().find(k => k.id === other.id), before);
    const keys = await (await fetch(`${base}/api/keys`, { headers: { cookie } })).json();
    assert.equal(keys.find((k: { id: string }) => k.id === key.id).parallel_login.org_id, 'org-fixture');
    assert.ok(!JSON.stringify(keys).includes(tokenResponse().access_token)); assert.ok(!JSON.stringify(keys).includes(tokenResponse().refresh_token));
    const newFlow = await (await send(`${key.id}/parallel-auth`)).json();
    assert.equal((await send(`${key.id}/parallel-auth/${newFlow.id}`, 'DELETE')).status, 200);
    assert.ok(f.store.loginSession(key.id));
    assert.equal((await send(`${key.id}/parallel-auth/${newFlow.id}/poll`)).status, 409);
    assert.equal((await send(`${key.id}/parallel-session`, 'DELETE')).status, 200);
    assert.equal(f.store.loginSession(key.id), undefined); assert.equal(f.store.keys().find(k => k.id === key.id)!.usage, null);
    assert.equal(f.store.keys().find(k => k.id === key.id)!.state, 'ready'); assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});
