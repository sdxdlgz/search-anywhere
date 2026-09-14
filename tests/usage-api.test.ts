import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, login, upstream } from './helpers.js';

test('U2/U3: one-row endpoint calls one credential; local page reads do not refresh any upstream quota', async () => {
  const requests: string[] = [];
  const f = fixture(async (url, init) => { requests.push(new Headers(init?.headers).get('authorization')!); return upstream(url, init); });
  const base = await f.listen();
  try {
    const keys = f.add('tavily', 'same owner', Array.from({ length: 10 }, (_, i) => `credential-${i}-123456789`));
    const cookie = await login(base);
    for (const path of ['/api/keys', '/api/dashboard', '/api/settings']) assert.equal((await fetch(`${base}${path}`, { headers: { cookie } })).status, 200);
    assert.equal(requests.length, 0);
    const target = keys[4];
    const response = await fetch(`${base}/api/keys/${target.id}/usage`, { method: 'POST', headers: { cookie } });
    assert.equal(response.status, 200); assert.equal((await response.json()).key.used, 20);
    assert.deepEqual(requests, ['Bearer credential-4-123456789']);
    const stored = f.store.keys(); assert.equal(stored.filter(k => k.usage !== null).length, 1);
    assert.equal(stored.find(k => k.id === keys[0].id)!.usage, null);
    assert.equal((await fetch(`${base}/api/keys/${target.id}/usage`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/keys/does-not-exist/usage`, { method: 'POST', headers: { cookie } })).status, 404);
    assert.equal(requests.length, 1); assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});

test('U2/U4: failed quota refresh preserves last snapshot, releases retry and does not invalidate search credentials', async () => {
  let failure = false;
  const f = fixture(async (url, init) => failure ? new Response('sensitive account detail', { status: 429 }) : upstream(url, init));
  const base = await f.listen();
  try {
    const [key] = f.add('tavily'); const cookie = await login(base);
    const post = () => fetch(`${base}/api/keys/${key.id}/usage`, { method: 'POST', headers: { cookie } });
    await post(); const previous = f.store.keys()[0].usage;
    failure = true;
    const response = await post(); assert.equal(response.status, 429); const message = await response.text(); assert.ok(!message.includes('sensitive')); assert.match(message, /用量接口限流/);
    assert.deepEqual(f.store.keys()[0].usage, previous); assert.ok(f.store.keys()[0].usage_error); assert.equal(f.store.keys()[0].state, 'ready');
    failure = false; assert.equal((await post()).status, 200); assert.equal(f.store.keys()[0].usage_error, null);
  } finally { await f.cleanup(); }
});
