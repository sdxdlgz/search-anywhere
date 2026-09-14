import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { fixture, login } from './helpers.js';
import { keenableUpstream, tokens } from './keenable-fixtures.js';
import { refreshSelectedUsage } from '../src/usage-refresh.js';
import type { UsageSnapshot } from '../shared/types.js';

test('K1: credentials stay encrypted, survive restart and directory transfer, and remain bound after source-note edits', async () => {
  const f = fixture(keenableUpstream);
  try {
    const [a, b] = f.add('keenable', 'same source', ['keen-storage-a12345', 'keen-storage-b12345']);
    const original = tokens(3600, 'private-fixture');
    f.store.setKeenableSession(a.id, original);
    assert.equal(f.store.keenableSession(b.id), undefined);
    assert.ok(!JSON.stringify(f.store.all('SELECT * FROM keenable_sessions')).includes(original.refresh_token));
    assert.ok(!JSON.stringify(f.store.keys()).includes(original.access_token));
    f.store.updateKey(a.id, { label: a.label, account: 'edited source', enabled: true, max_concurrency: 2, exa_key_id: '' });
    assert.deepEqual(f.store.keenableTokens(f.store.keenableSession(a.id)!), original);
    await f.engine.syncUsage(a.id);
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const moved = join(f.directory, 'vps-copy'); mkdirSync(moved);
    for (const name of ['gateway.sqlite', 'encryption.key']) copyFileSync(join(f.directory, name), join(moved, name));
    assert.ok(!readFileSync(join(moved, 'gateway.sqlite')).includes(Buffer.from(original.refresh_token)));
    const restored = new Store(moved);
    try { assert.deepEqual(restored.keenableTokens(restored.keenableSession(a.id)!), original); assert.equal(restored.keys()[0].usage?.balance?.free_remaining, 99988); }
    finally { restored.close(); }
    f.store.deleteKey(a.id); assert.equal(f.store.keenableSession(a.id), undefined);
    assert.equal(f.store.keys().length, 1);
  } finally { await f.cleanup(); }
});

test('K1/K4: session endpoints enforce admin/provider/input boundaries and never return either token', async () => {
  let requests = 0;
  const f = fixture(async (url, init) => { requests++; return keenableUpstream(url, init); });
  const base = await f.listen();
  try {
    const [key] = f.add('keenable'); const [tavily] = f.add('tavily');
    const pair = tokens(3600, 'long-access-' + 'a'.repeat(900)); const cookie = await login(base);
    const path = `/api/keys/${key.id}/keenable-session`;
    const put = (body: unknown, id = key.id, auth = true) => fetch(`${base}/api/keys/${id}/keenable-session`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(auth ? { cookie } : {}) }, body: JSON.stringify(body) });
    const input = { access_token: pair.access_token, refresh_token: pair.refresh_token };
    assert.ok(pair.access_token.length > 512);
    assert.equal((await put(input, key.id, false)).status, 401);
    assert.equal((await put(input, tavily.id)).status, 400);
    assert.equal((await put(input, 'missing')).status, 404);
    for (const body of [{}, { refresh_token: '' }, { refresh_token: 'has white space' }, { refresh_token: 'a'.repeat(4097) }, { ...input, access_token: 'x'.repeat(16385) }, { ...input, access_token: 'not-a-valid-token' }, { ...input, arbitrary: 'untrusted' }]) assert.equal((await put(body)).status, 400);
    assert.equal(f.store.keenableSession(key.id), undefined);
    const saved = await put(input); assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /fixture-refresh-|fixture-signature/);
    assert.equal(requests, 0);
    for (const resource of ['/api/keys', '/api/dashboard', '/api/logs']) {
      const text = await (await fetch(base + resource, { headers: { cookie } })).text();
      assert.ok(!text.includes(pair.access_token)); assert.ok(!text.includes(pair.refresh_token));
    }
    assert.equal((await fetch(base + path, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${base}/api/keys/${key.id}/usage`, { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + path, { method: 'DELETE', headers: { cookie } })).status, 200);
    assert.equal(f.store.keenableSession(key.id), undefined); assert.equal(f.store.keys().find(k => k.id === key.id)!.usage, null);
    assert.equal(f.store.keys().find(k => k.id === key.id)!.state, 'ready'); assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});

test('K4: row and selected batch use only chosen keys; unconfigured keys stay unknown and page reads never refresh', async () => {
  const usedKeys: string[] = [];
  const f = fixture(async (url, init) => { if (url.endsWith('/v1/auth/user')) usedKeys.push(new Headers(init?.headers).get('x-api-key')!); return keenableUpstream(url, init); });
  const base = await f.listen();
  try {
    const [a, b, c] = f.add('keenable', 'same source', ['keen-selected-a1234', 'keen-selected-b1234', 'keen-unselected-1234']);
    f.store.setKeenableSession(a.id, tokens()); f.store.setKeenableSession(c.id, tokens());
    const cookie = await login(base);
    const query = async (id: string): Promise<UsageSnapshot> => {
      const response = await fetch(`${base}/api/keys/${id}/usage`, { method: 'POST', headers: { cookie } });
      assert.equal(response.status, 200); return response.json();
    };
    await query(a.id); assert.deepEqual(usedKeys, ['keen-selected-a1234']);
    const result = await refreshSelectedUsage([a.id, b.id], query, () => {});
    assert.equal(result.filter(r => r.usage?.status === 'ok').length, 1);
    assert.equal(result.filter(r => r.usage?.status === 'needs_setup').length, 1);
    assert.deepEqual(usedKeys, ['keen-selected-a1234', 'keen-selected-a1234']);
    assert.equal(f.store.key(c.id)!.usage_json, null);
    await fetch(`${base}/api/keys`, { headers: { cookie } }); assert.equal(usedKeys.length, 2);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});
