import test from 'node:test';
import assert from 'node:assert/strict';
import { ParallelAuth } from '../server/parallel-auth.js';
import { GatewayError } from '../server/providers.js';
import { Store } from '../server/store.js';
import { fixture } from './helpers.js';
import { accountMock, deviceResponse, savedTokens, tokenResponse } from './parallel-account-fixtures.js';

test('B1: device authorization is balance-only, respects polling/slow_down and saves encrypted tokens without exposing device_code', async t => {
  let time = Date.now(), polls = 0, registers = 0;
  t.mock.method(Date, 'now', () => time);
  const http = async (url: string, init?: RequestInit) => {
    assert.equal(init?.redirect, 'error');
    if (url.endsWith('/register')) registers++;
    if (url.endsWith('/device/code')) assert.equal(new URLSearchParams(String(init?.body)).get('scope'), 'balance:read');
    if (url.endsWith('/token')) {
      polls++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('device_code'), 'private-device-code-12345678'); assert.equal(form.get('client_id'), 'fixture-client');
      if (polls <= 2) return Response.json({ error: polls === 1 ? 'authorization_pending' : 'slow_down' }, { status: 400 });
    }
    return accountMock(url, init);
  };
  const f = fixture(http), auth = new ParallelAuth(f.store, http);
  try {
    const [key] = f.add('parallel');
    const [a, b] = await Promise.all([auth.start(key.id), auth.start(key.id)]);
    assert.equal(a.id, b.id); assert.equal(registers, 1); assert.ok(!JSON.stringify(a).includes('private-device-code')); assert.equal(a.user_code, 'TEST-CODE');
    assert.equal((await auth.poll(key.id, a.id)).status, 'pending'); assert.equal(polls, 0);
    time += 1000; assert.equal((await auth.poll(key.id, a.id)).status, 'pending');
    time += 1000; assert.deepEqual(await auth.poll(key.id, a.id), { status: 'pending', poll_after_seconds: 6 });
    time += 5999; assert.equal((await auth.poll(key.id, a.id)).status, 'pending'); assert.equal(polls, 2);
    time += 1; assert.equal((await auth.poll(key.id, a.id)).status, 'connected'); assert.equal(polls, 3);
    assert.equal((await auth.poll(key.id, a.id)).status, 'connected'); assert.equal(polls, 3);
    const session = f.store.loginSession(key.id)!;
    assert.equal(f.store.parallelTokens(session).refresh_token, tokenResponse().refresh_token);
    assert.ok(!session.secret.includes('parallel-access')); assert.ok(!JSON.stringify(f.store.keys()).includes('parallel-refresh'));
    assert.equal(f.store.keys()[0].parallel_login!.org_id, 'org-fixture'); assert.equal(f.store.todayCalls(), 0);
    const next = new Store(f.directory);
    try { assert.equal(next.parallelClientId(), 'fixture-client'); assert.equal(next.parallelTokens(next.loginSession(key.id)!).org_id, 'org-fixture'); } finally { next.close(); }
    await new ParallelAuth(f.store, http).start(key.id); assert.equal(registers, 1);
  } finally { await f.cleanup(); }
});

test('B1: denial, expiry and untrusted verification links retain existing authorization and allow a new attempt', async t => {
  let time = Date.now(), denied = true;
  t.mock.method(Date, 'now', () => time);
  const http = async (url: string, init?: RequestInit) => url.endsWith('/token') && denied ? Response.json({ error: 'access_denied', error_description: 'sensitive upstream details' }, { status: 400 }) : accountMock(url, init);
  const f = fixture(http), auth = new ParallelAuth(f.store, http);
  try {
    const [key] = f.add('parallel'); f.store.setLoginSession(key.id, savedTokens()); const old = f.store.loginSession(key.id)!.secret;
    const a = await auth.start(key.id); time += 1000;
    await assert.rejects(auth.poll(key.id, a.id), /已拒绝/); assert.equal(f.store.loginSession(key.id)!.secret, old);
    denied = false; const b = await auth.start(key.id); time += 601000;
    await assert.rejects(auth.poll(key.id, b.id), /已过期/); assert.equal(f.store.loginSession(key.id)!.secret, old);
    const evil = new ParallelAuth(f.store, async url => url.endsWith('/device/code') ? Response.json(deviceResponse({ verification_uri_complete: 'https://evil.example.com/login' })) : accountMock(url));
    await assert.rejects(evil.start(key.id), /未受信任/); assert.equal(f.store.loginSession(key.id)!.secret, old);
    const zero = new ParallelAuth(f.store, async url => url.endsWith('/device/code') ? Response.json(deviceResponse({ expires_in: 0 })) : accountMock(url));
    await assert.rejects(zero.start(key.id), /有效期或轮询间隔无效/);
  } finally { await f.cleanup(); }
});

test('B1: concurrent polls coalesce; cancel and credential replacement prevent late token writes', async t => {
  let time = Date.now(), polls = 0;
  t.mock.method(Date, 'now', () => time);
  let release!: (value: Response) => void, entered!: () => void;
  let entry = new Promise<void>(resolve => { entered = resolve; });
  const http = async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/token')) return accountMock(url, init);
    polls++; entered(); return new Promise<Response>(resolve => { release = resolve; });
  };
  const f = fixture(http), auth = new ParallelAuth(f.store, http);
  try {
    const [key] = f.add('parallel');
    const a = await auth.start(key.id); time += 1000;
    const p = auth.poll(key.id, a.id), same = auth.poll(key.id, a.id);
    assert.equal(p, same); await entry; auth.cancel(key.id, a.id); release(Response.json(tokenResponse()));
    await assert.rejects(p, /已取消或配置已变化/); assert.equal(f.store.loginSession(key.id), undefined); assert.equal(polls, 1);
    entry = new Promise<void>(resolve => { entered = resolve; });
    const b = await auth.start(key.id); time += 1000;
    const pending = auth.poll(key.id, b.id); await entry;
    f.store.setLoginSession(key.id, savedTokens({ refresh_token: 'parallel-new-manual-refresh' }));
    const kept = f.store.loginSession(key.id)!.secret; release(Response.json(tokenResponse()));
    await assert.rejects(pending, /配置已变化/); assert.equal(f.store.loginSession(key.id)!.secret, kept);
    await assert.rejects(Promise.resolve().then(() => auth.poll(key.id, b.id)), e => e instanceof GatewayError && e.status === 409);
  } finally { await f.cleanup(); }
});
