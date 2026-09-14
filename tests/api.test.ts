import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, login, ADMIN } from './helpers.js';

test('R8: admin login, session cookies, origin protection, token permission separation and revocation', async () => {
  const f = fixture(), base = await f.listen();
  try {
    assert.equal((await fetch(`${base}/api/keys`)).status, 401);
    assert.equal((await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) })).status, 401);
    const cookie = await login(base);
    assert.match(cookie, /^sa_session=/);
    assert.equal((await fetch(`${base}/api/keys`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/keys`, { headers: { cookie, Origin: 'https://evil.example' } })).status, 403);
    const created = await fetch(`${base}/api/tokens`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Hermes' }) });
    const token = await created.json(); assert.match(token.token, /^sa_/);
    const tokens = await (await fetch(`${base}/api/tokens`, { headers: { cookie } })).json(); assert.ok(!JSON.stringify(tokens).includes(token.token));
    assert.equal((await fetch(`${base}/api/keys`, { headers: { Authorization: `Bearer ${token.token}` } })).status, 401);
    assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ query: 'test' }) })).status, 401);
    f.add('exa');
    const valid = await fetch(`${base}/v1/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ query: 'test' }) });
    assert.equal(valid.status, 200);
    await fetch(`${base}/api/tokens/${token.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ query: 'test' }) })).status, 401);
    await fetch(`${base}/api/session`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await fetch(`${base}/api/keys`, { headers: { cookie } })).status, 401);
  } finally { await f.cleanup(); }
});
test('R1/R3: API validates inputs, masks secrets, preserves historical owner and updates modes', async () => {
  const f = fixture(), base = await f.listen(), cookie = await login(base);
  const request = (path: string, method = 'GET', value?: unknown) => fetch(`${base}/api${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  try {
    assert.equal((await request('/keys', 'POST', { provider: 'exa', label: 'key', account: 'owner', keys: ['short'] })).status, 400);
    assert.equal((await request('/keys', 'POST', { provider: 'exa', label: 'batch', account: 'owner', keys: ['first-key-12345678', 'second-key-12345678'], exa_key_id: 'same-id' })).status, 400);
    assert.equal(f.store.keys().length, 0);
    const full = 'super-private-test-key-123456789';
    const response = await request('/keys', 'POST', { provider: 'exa', label: 'my key', account: 'owner@one.com', keys: [full] });
    const body = await response.text(); assert.equal(response.status, 201); assert.ok(!body.includes(full));
    const key = JSON.parse(body)[0]; assert.equal(key.account, 'owner@one.com');
    const probe = await request(`/keys/${key.id}/test`, 'POST'); assert.equal(probe.status, 200);
    await request(`/keys/${key.id}`, 'PATCH', { label: 'renamed', account: 'owner@two.com', enabled: false, max_concurrency: 2 });
    const updated = await (await request('/keys')).json(); assert.equal(updated[0].state, 'disabled'); assert.equal(updated[0].account, 'owner@two.com');
    const logs = await (await request('/logs')).json(); assert.equal(logs[0].calls[0].account, 'owner@one.com'); assert.ok(!JSON.stringify(logs).includes(full));
    const p = f.store.profile()!;
    assert.equal((await request(`/profiles/${p.id}`, 'PUT', { ...p, modes: { exa: 'fake', parallel: null, tavily: null } })).status, 400);
    assert.equal((await request(`/profiles/${p.id}`, 'PUT', { ...p, modes: { exa: null, parallel: null, tavily: null } })).status, 400);
    assert.equal((await request(`/profiles/${p.id}`, 'PUT', { ...p, modes: { exa: 'fast', parallel: null, tavily: null } })).status, 200);
    assert.equal(f.store.profile()!.modes.exa, 'fast');
    const fast = f.store.profile('fast')!;
    f.store.saveProfile({ ...fast, modes: { exa: null, parallel: 'basic', tavily: null } });
    await request(`/keys/${key.id}`, 'PATCH', { label: 'renamed', account: 'owner@two.com', enabled: true, max_concurrency: 2 });
    assert.equal((await request(`/keys/${key.id}/test`, 'POST')).status, 200);
    assert.equal(f.store.logs()[0].calls[0].mode, 'fast');
    assert.equal((await request('/logs?limit=-1')).status, 400);
    await request(`/keys/${key.id}`, 'DELETE'); assert.equal(f.store.keys().length, 0); assert.equal(f.store.logs()[0].calls.length, 1);
  } finally { await f.cleanup(); }
});

test('R8: local HTTPS proxy preserves same-origin login and secure cookie; oversized input is rejected', async () => {
  const previous = process.env.SA_TRUST_PROXY;
  process.env.SA_TRUST_PROXY = 'loopback';
  const f = fixture(), base = await f.listen();
  try {
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: base.replace('http:', 'https:') }, body: JSON.stringify({ token: ADMIN }) });
    assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie')!, /; Secure/);
    const huge = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(66000) }) });
    assert.equal(huge.status, 413); assert.ok(!(await huge.text()).includes('aaaa'));
  } finally { if (previous === undefined) delete process.env.SA_TRUST_PROXY; else process.env.SA_TRUST_PROXY = previous; await f.cleanup(); }
});

test('N1/N3: separate imports continue numbering; conflicts roll back without consuming a name or changing existing keys', async () => {
  const f = fixture(), base = await f.listen(), cookie = await login(base);
  const add = (keys: string[], provider = 'tavily') => fetch(`${base}/api/keys`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, label: 'xy', account: 'source-note', keys }) });
  try {
    const initial = await (await add(['number-a-12345678', 'number-b-12345678'])).json();
    assert.deepEqual(initial.map((k: { label: string }) => k.label), ['xy 1', 'xy 2']);
    assert.equal((await add(['number-c-12345678', 'number-a-12345678'])).status, 409);
    const next = await (await add(['number-c-12345678'])).json();
    assert.equal(next[0].label, 'xy 3');
    assert.deepEqual((await (await add(['number-d-12345678', 'number-e-12345678'])).json()).map((k: { label: string }) => k.label), ['xy 4', 'xy 5']);
    assert.deepEqual((await (await add(['number-f-12345678', 'number-g-12345678'], 'exa')).json()).map((k: { label: string }) => k.label), ['xy 1', 'xy 2']);
    const current = await (await fetch(`${base}/api/keys`, { headers: { cookie } })).json();
    assert.deepEqual(current.filter((k: { id: string }) => initial.some((v: { id: string }) => v.id === k.id)), initial);
  } finally { await f.cleanup(); }
});
