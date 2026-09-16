import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { Config } = require('../plugins/pi-desktop/config.cjs');
const { Tasks } = require('../plugins/pi-desktop/tasks.cjs');
const manifest = { net: { domains: ['gateway.example', 'other.example'] } };
const defaults = { gateway: 'https://gateway.example' };
const token = 'sa_unit_test_only_abcdefghijklmnop';

test('PI P3: private connection persists across reload; empty token preserves it and clear removes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-pi-config-'));
  try {
    const config = new Config(dir, manifest, defaults);
    await assert.rejects(config.ready(), { code: 'configuration' });
    const status = await config.save({ gateway: defaults.gateway, token, profile: 'coverage', timeoutSeconds: 200 });
    assert.equal(status.configured, true); assert.equal(status.token, undefined);
    assert.equal(status.tokenMask, `${token.slice(0, 6)}••••••${token.slice(-4)}`);
    assert.ok(!JSON.stringify(status).includes(token));
    await config.save({ token: '', timeoutSeconds: 300 });
    const reloaded = new Config(dir, manifest, defaults);
    assert.equal((await reloaded.ready()).token, token);
    assert.equal((await reloaded.ready()).profile, 'coverage');
    assert.equal((await reloaded.ready()).timeoutSeconds, 300);
    await reloaded.save({ clearToken: true });
    assert.equal((await reloaded.status()).configured, false);
    assert.ok(!(await readFile(join(dir, 'connection.json'), 'utf8')).includes(token));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PI P3: bad edits retain good configuration, origin changes require a new token, saves serialize', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-pi-config-'));
  try {
    const config = new Config(dir, manifest, defaults);
    await config.save({ token });
    for (const input of [{ timeoutSeconds: 29 }, { timeoutSeconds: 601 }, { timeoutSeconds: 30.5 }, { token: 'wrong' }, { profile: 'x'.repeat(51) }, { gateway: 'https://other.example' }]) {
      await assert.rejects(config.save(input), { code: 'configuration' });
      assert.equal((await config.ready()).gateway, defaults.gateway);
    }
    await Promise.all([config.save({ profile: 'coverage' }), config.save({ timeoutSeconds: 30 })]);
    assert.equal((await config.ready()).profile, 'coverage');
    assert.equal((await config.ready()).timeoutSeconds, 30);
    await config.save({ gateway: 'https://other.example', token });
    assert.equal((await config.ready()).gateway, 'https://other.example');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PI P3: corrupted or incompatible configuration can be replaced without exposing the old credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-pi-config-'));
  try {
    const config = new Config(dir, manifest, defaults);
    await writeFile(join(dir, 'connection.json'), '{broken');
    const status = await config.status();
    assert.equal(status.configured, false); assert.ok(status.warning);
    await assert.rejects(config.save({ profile: 'coverage' }), { code: 'configuration' });
    await config.save({ token, profile: 'coverage' });
    assert.equal((await config.ready()).token, token);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PI P2: fast calls return directly; slow calls are submitted once and repeated polls preserve all results', async () => {
  const tasks = new Tasks({ firstWaitMs: 5, pollWaitMs: 5 });
  try {
    assert.deepEqual(await tasks.start('one', async () => ({ value: 1 })), { value: 1 });
    let finish!: (value: unknown) => void;
    let calls = 0;
    const pending = await tasks.start('one', () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    assert.equal(pending.status, 'pending');
    assert.equal((await tasks.poll('one', { task_id: pending.task_id })).status, 'pending');
    await assert.rejects(tasks.poll('two', { task_id: pending.task_id }), { code: 'task_not_found' });
    const result = { partial: true, next_offset: 10, collection_id: 'retained', warnings: ['upstream 403'], evidence: ['full retained text'] };
    finish(result);
    assert.deepEqual(await tasks.poll('one', { task_id: pending.task_id }), result);
    assert.deepEqual(await tasks.poll('one', { task_id: pending.task_id }), result);
    assert.equal(calls, 1);
  } finally { tasks.close(); }
});

test('PI P2: cancel, stop waiting, unload, expiry and concurrency limits do not duplicate requests', async () => {
  const tasks = new Tasks({ firstWaitMs: 5, pollWaitMs: 5, maxActive: 1, ttlMs: 50 });
  let signal!: AbortSignal;
  const operation = (s: AbortSignal) => { signal = s; return new Promise(() => {}); };
  try {
    const pending = await tasks.start('one', operation);
    await assert.rejects(tasks.start('one', operation), { code: 'busy' });
    await assert.rejects(tasks.poll('one', { task_id: pending.task_id, action: 'invalid' }), { code: 'validation_error' });
    assert.equal((await tasks.poll('one', { task_id: pending.task_id, action: 'cancel' })).status, 'cancelled');
    assert.equal(signal.aborted, true);
    const controller = new AbortController();
    const next = tasks.start('one', operation, controller.signal);
    const timer = setTimeout(() => controller.abort(), 1);
    await assert.rejects(next, { code: 'cancelled' }); clearTimeout(timer);
    assert.equal(signal.aborted, true);
    const last = await tasks.start('one', operation);
    tasks.items.get(last.task_id).updated -= 100;
    tasks.prune();
    assert.equal(signal.aborted, true);
    await assert.rejects(tasks.poll('one', { task_id: last.task_id }), { code: 'task_not_found' });
    await tasks.start('one', operation);
    tasks.close();
    assert.equal(signal.aborted, true);
  } finally { tasks.close(); }
});

test('PI P2: provider failures stay failures after pending, pre-aborted calls do not start work', async () => {
  const tasks = new Tasks({ firstWaitMs: 1, pollWaitMs: 5 });
  try {
    let fail!: (error: Error) => void;
    const pending = await tasks.start('one', () => new Promise((_, reject) => { fail = reject; }));
    fail(Object.assign(new Error('upstream unavailable'), { code: 'upstream_error' }));
    await assert.rejects(tasks.poll('one', { task_id: pending.task_id }), { code: 'upstream_error' });
    let ran = false;
    await assert.rejects(tasks.start('one', () => { ran = true; }, AbortSignal.abort()), { code: 'cancelled' });
    assert.equal(ran, false);
    assert.deepEqual(await tasks.start('one', async () => ({ recovered: true })), { recovered: true });
  } finally { tasks.close(); }
});
