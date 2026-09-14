import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { fixture, login } from './helpers.js';
import { anyTokens, anyUpstream } from './anysearch-fixtures.js';
import { tokens } from './keenable-fixtures.js';
import { refreshSelectedUsage } from '../src/usage-refresh.js';
import type { UsageSnapshot } from '../shared/types.js';

test('A1: shared login storage preserves existing Keenable ciphertext and both providers survive directory transfer', async () => {
  const f = fixture(anyUpstream());
  try {
    const [keen] = f.add('keenable'); const [any] = f.add('anysearch');
    const keenPair = tokens(); const anyPair = anyTokens();
    f.store.setKeenableSession(keen.id, keenPair);
    const original = f.store.keenableSession(keen.id);
    f.store.setLoginSession(any.id, anyPair);
    await f.engine.syncUsage(any.id);
    assert.deepEqual(f.store.keenableSession(keen.id), original);
    assert.deepEqual(f.store.keenableTokens(f.store.keenableSession(keen.id)!), keenPair);
    assert.doesNotMatch(JSON.stringify(f.store.all('SELECT * FROM anysearch_sessions')), /fixture-any-refresh/);
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const moved = join(f.directory, 'transfer'); mkdirSync(moved);
    for (const name of ['gateway.sqlite', 'encryption.key']) copyFileSync(join(f.directory, name), join(moved, name));
    assert.ok(!readFileSync(join(moved, 'gateway.sqlite')).includes(Buffer.from(anyPair.refresh_token)));
    const restored = new Store(moved);
    try {
      assert.deepEqual(restored.loginTokens(restored.loginSession(any.id)!), anyPair);
      assert.deepEqual(restored.keenableSession(keen.id), original);
      assert.equal(restored.keys().find(k => k.id === any.id)!.usage!.request_quota!.remaining, 993);
    } finally { restored.close(); }
    f.store.deleteKey(any.id); assert.equal(f.store.loginSession(any.id), undefined);
    assert.deepEqual(f.store.keenableSession(keen.id), original);
  } finally { await f.cleanup(); }
});

test('A1/A4: admin-only AnySearch setup/removal reject cross-provider paths and never reveal tokens', async () => {
  let upstreamCalls = 0; const mock = anyUpstream();
  const f = fixture(async (url, init) => { upstreamCalls++; return mock(url, init); }); const base = await f.listen();
  try {
    const [key] = f.add('anysearch'); const [keen] = f.add('keenable'); const cookie = await login(base);
    const pair = anyTokens(1800, 'long-' + 'x'.repeat(1000));
    const body = { access_token: pair.access_token, refresh_token: pair.refresh_token };
    const path = `/api/keys/${key.id}/anysearch-session`;
    const put = (data: unknown, target = path, auth = true) => fetch(base + target, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(auth ? { cookie } : {}) }, body: JSON.stringify(data) });
    assert.equal((await put(body, path, false)).status, 401);
    for (const target of [`/api/keys/${keen.id}/anysearch-session`, `/api/keys/${key.id}/keenable-session`]) assert.equal((await put(body, target)).status, 400);
    assert.equal((await put(body, '/api/keys/missing/anysearch-session')).status, 404);
    for (const data of [{}, { refresh_token: 'short' }, { refresh_token: 'has whitespace' }, { refresh_token: 'x'.repeat(4097) }, { ...body, access_token: tokens().access_token }, { ...body, access_token: 'x'.repeat(16385) }, { ...body, unknown: 'value' }]) assert.equal((await put(data)).status, 400);
    const saved = await put(body); assert.equal(saved.status, 200); assert.doesNotMatch(await saved.text(), /fixture-any-refresh|fixture-signature/);
    assert.equal(upstreamCalls, 0);
    for (const resource of ['/api/keys', '/api/dashboard', '/api/logs']) {
      const output = await (await fetch(base + resource, { headers: { cookie } })).text();
      assert.ok(!output.includes(pair.access_token) && !output.includes(pair.refresh_token));
    }
    assert.equal((await fetch(base + path, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(base + path, { method: 'DELETE', headers: { cookie } })).status, 200);
    assert.equal(f.store.loginSession(key.id), undefined); assert.equal(f.store.keys().find(k => k.id === key.id)!.state, 'ready');
  } finally { await f.cleanup(); }
});

test('A4: mixed selected batch and one-row query leave other AnySearch keys untouched and do not meter searches', async () => {
  let reads = 0; const secrets = ['any-row-a12345', 'any-row-b12345', 'any-row-c12345']; const mock = anyUpstream(secrets);
  const f = fixture(async (url, init) => { if (url.endsWith('/billing/overview')) reads++; return mock(url, init); }); const base = await f.listen();
  try {
    const [a, b, c] = f.add('anysearch', 'same source', secrets);
    f.store.setLoginSession(a.id, anyTokens()); f.store.setLoginSession(c.id, anyTokens());
    const cookie = await login(base);
    const query = async (id: string): Promise<UsageSnapshot> => {
      const r = await fetch(`${base}/api/keys/${id}/usage`, { method: 'POST', headers: { cookie } }); assert.equal(r.status, 200); return r.json();
    };
    await query(a.id); assert.equal(reads, 1);
    const result = await refreshSelectedUsage([a.id, b.id], query, () => {});
    assert.equal(result.filter(r => r.usage?.status === 'ok').length, 1); assert.equal(result.filter(r => r.usage?.status === 'needs_setup').length, 1);
    assert.equal(reads, 2); assert.equal(f.store.key(c.id)!.usage_json, null);
    await fetch(`${base}/api/keys`, { headers: { cookie } }); assert.equal(reads, 2);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});
