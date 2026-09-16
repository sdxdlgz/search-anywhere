import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GatewayError } from '../server/upstream.js';
import { McpCancellation } from '../server/mcp-cancellation.js';
import { caller, fixture, upstream } from './helpers.js';

test('F6: cancellation is caller-scoped, type-sensitive and never guesses between reused active IDs', () => {
  const bridge = new McpCancellation();
  const response = () => Object.assign(new EventEmitter(), { writableFinished: false }) as Response;
  const a = response(), b = response();
  const signal = bridge.track('one', { method: 'tools/call', id: 1 }, a);
  bridge.cancel('two', { method: 'notifications/cancelled', params: { requestId: 1 } });
  bridge.cancel('one', { method: 'notifications/cancelled', params: { requestId: '1' } });
  assert.equal(signal.aborted, false);
  const duplicate = bridge.track('one', { method: 'tools/call', id: 1 }, b);
  bridge.cancel('one', { method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal(signal.aborted, false); assert.equal(duplicate.aborted, false);
  a.writableFinished = true; a.emit('close');
  bridge.cancel('one', { method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal(signal.aborted, false); assert.equal(duplicate.aborted, true);
  b.emit('close');
  const c = response(), reused = bridge.track('one', { method: 'tools/call', id: 1 }, c);
  assert.equal(reused.aborted, false); c.emit('close'); assert.equal(reused.aborted, true);
});

test('F6: client cancellation and profile deadline are distinct and release reservations without retries', async () => {
  for (const cancelled of [true, false]) {
    let slow = true;
    const started = Promise.withResolvers<void>();
    const f = fixture(async (url, init) => {
      if (!slow) return upstream(url, init);
      started.resolve();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    });
    try {
      f.add('exa', 'owner', ['key-one-test-1234', 'key-two-test-1234']);
      f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'deep-reasoning' }, timeout_ms: cancelled ? 1000 : 50 });
      const controller = new AbortController();
      const task = f.engine.search({ query: 'cancellation' }, caller, { signal: controller.signal });
      const checked = assert.rejects(task, e => e instanceof GatewayError && e.code === (cancelled ? 'cancelled' : 'timeout'));
      await started.promise;
      if (cancelled) controller.abort(new Error('client-credential-must-never-appear'));
      await Promise.all([checked, delay(60)]);
      const calls = f.store.logs()[0].calls;
      assert.equal(calls.length, 1); assert.equal(calls[0].error_code, cancelled ? 'cancelled' : 'timeout');
      assert.equal(calls[0].http_status, cancelled ? 499 : 504);
      assert.ok(!JSON.stringify(calls).includes('client-credential'));
      assert.equal(f.engine.busy, false); assert.ok(f.store.keys().every(k => k.state === 'ready'));
      slow = false; assert.equal((await f.engine.search({ query: 'recovered' }, caller)).partial, false);
    } finally { await f.cleanup(); }
  }
});

test('F6/F7: MCP and HTTP disconnects cancel upstream work; a healthy slower tool call remains usable', async () => {
  for (const transport of ['mcp', 'http']) {
    let slow = true;
    const started = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>();
    const f = fixture(async (url, init) => {
      if (!slow) { await delay(120); return upstream(url, init); }
      started.resolve();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted.resolve(); reject(init!.signal!.reason); }, { once: true }));
    }, 'coverage');
    const client = new Client({ name: 'cancellation-test', version: '1' });
    try {
      f.add('exa'); f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'deep-reasoning' } });
      const base = await f.listen(), { token } = f.store.createToken('cancel-test');
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
      const controller = new AbortController();
      const task = transport === 'mcp'
        ? client.callTool({ name: 'search', arguments: { query: 'disconnect test' } }, undefined, { signal: controller.signal, timeout: 5000 })
        : fetch(`${base}/v1/fetch`, { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/page' }), signal: controller.signal });
      const checked = assert.rejects(task);
      await started.promise; controller.abort(); await checked;
      await Promise.race([aborted.promise, delay(2000).then(() => { throw new Error(`${transport} disconnect did not abort upstream`); })]);
      for (let i = 0; f.engine.busy && i < 50; i++) await delay(10);
      assert.equal(f.engine.busy, false);
      assert.equal(f.store.logs()[0].calls[0].error_code, 'cancelled');
      slow = false;
      const recovered = await client.callTool({ name: 'search', arguments: { query: 'healthy slower request' } }, undefined, { timeout: 5000 });
      assert.notEqual(recovered.isError, true);
      const result = JSON.parse((recovered.content as { text: string }[])[0].text);
      assert.equal(result.partial, false); assert.equal(result.scope.profile.timeout_ms, 120000);
    } finally { await client.close(); await f.cleanup(); }
  }
});
