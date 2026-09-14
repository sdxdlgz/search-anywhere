import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createApp } from '../server/app.js';
import { ADMIN, upstream, fixture, login, caller } from './helpers.js';

test('H3/H5: admin-only retention APIs, validation, legacy settings update and explicit confirmation', async () => {
  const f = fixture();
  try {
    f.add('tavily'); f.store.saveProfile({ ...f.store.profile()!, modes: { tavily: 'basic' } });
    const search = await f.engine.search({ query: 'erase content' }, caller);
    const base = await f.listen(), cookie = await login(base);
    const request = (path: string, method: string, body?: unknown, headers = { Cookie: cookie }) => fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await request('retention', 'GET', undefined, { Cookie: '' })).status, 401);
    const token = f.store.createToken('search only');
    assert.equal((await fetch(base + '/api/retention/preview', { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' }, body: '{"days":0}' })).status, 401);
    for (const days of [-1, 0, 3651, 1.5, '7']) assert.equal((await request('retention', 'PUT', { enabled: true, days })).status, 400);
    for (const days of [-1, 3651, null]) assert.equal((await request('retention/preview', 'POST', { days })).status, 400);
    assert.equal((await request('retention/clean', 'POST', {})).status, 400);
    for (const days of [1, 3650, 7]) assert.equal((await request('retention', 'PUT', { enabled: false, days })).status, 200);
    const { default_profile, daily_call_limit, usage_sync_minutes } = f.store.settings();
    assert.equal((await request('settings', 'PUT', { default_profile, daily_call_limit, usage_sync_minutes })).status, 200);
    assert.deepEqual(f.store.settings().history_retention, { enabled: false, days: 7 });
    const preview = await (await request('retention/preview', 'POST', { days: 0 })).json(); assert.equal(preview.collections, 1);
    assert.ok(f.store.collection(search.collection_id, caller.id));
    const { cutoff, expires_at, confirmation_token } = preview;
    const confirm = { cutoff, expires_at, confirmation_token };
    assert.equal((await request('retention/clean', 'POST', confirm)).status, 200);
    assert.equal((await request('retention/clean', 'POST', confirm)).status, 409);
    assert.equal((await request('results', 'POST', { collection_id: search.collection_id })).status, 404);
    assert.equal((await request('evidence', 'POST', { collection_id: search.collection_id, url: search.results[0].url })).status, 404);
    assert.deepEqual(await (await request('logs', 'GET')).json(), []);
    const status = await (await request('retention', 'GET')).json(); assert.equal(status.retained.collections, 0); assert.equal(status.last_cleanup.source, 'manual'); assert.equal(status.next_cleanup_at, null);
    const count = f.store.todayCalls(); assert.equal(count, 1); assert.equal(f.store.keys()[0].metering.reported_credits, 1);
  } finally { await f.cleanup(); }
});

test('H2: the production background timer starts cleanup within one minute and stops on close', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'search-anywhere-timer-'));
  const runtime = createApp({ directory, adminToken: ADMIN, fetch: upstream, background: true });
  try {
    runtime.store.saveSettings({ ...runtime.store.settings(), usage_sync_minutes: 0 });
    const id = runtime.store.beginRequest('old fixture caller', 'search', 'old fixture query', 'balanced');
    runtime.store.finishRequest(id, 'error', 0);
    runtime.store.run('UPDATE requests SET created_at=? WHERE id=?', new Date(Date.now() - 8 * 86400000).toISOString(), id);
    t.mock.timers.tick(59999); assert.equal(runtime.store.logs().length, 1);
    t.mock.timers.tick(1); assert.equal(runtime.store.logs().length, 0); assert.equal(runtime.store.settings().history_cleanup!.source, 'automatic');
  } finally {
    runtime.close();
    t.mock.timers.tick(60000);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('search-anywhere-timer-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
