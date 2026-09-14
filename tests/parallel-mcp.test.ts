import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayError } from '../server/providers.js';
import { fixture, result } from './helpers.js';
import { FREE_MCP, mcpResult, parallelMock, type Rpc } from './parallel-fixtures.js';

test('P1/P4: anonymous SDK JSON and SSE responses retain all excerpts and full text without keys or overrides', async () => {
  for (const options of [{}, { text: true }, { sse: true }]) {
    const calls: Rpc[] = [];
    const full = 'Full source evidence. '.repeat(2000);
    const mock = parallelMock(rpc => {
      calls.push(rpc);
      return mcpResult(rpc, { results: [{ ...result('parallel'), excerpts: ['Excerpt A', 'Excerpt B'], full_content: full }], warnings: ['upstream restriction'] }, options);
    });
    const f = fixture(async (url, init) => {
      assert.equal(url, FREE_MCP);
      const headers = new Headers(init?.headers);
      assert.equal(headers.has('authorization'), false); assert.equal(headers.has('x-api-key'), false);
      assert.equal(init?.redirect, 'error');
      return mock(url, init);
    });
    try {
      const search = await f.engine.providers.parallelFree({ query: 'SQLite official WAL', include_domains: ['sqlite.org'] }, 'stable-session', AbortSignal.timeout(3000));
      assert.equal(search.results[0].snippet, 'Excerpt A\nExcerpt B');
      assert.equal(search.results[0].content, full); assert.equal(search.results[0].truncated, false);
      assert.equal(search.cost_usd, 0); assert.equal(search.paid, false); assert.equal(search.credits, null); assert.equal(search.billing_source, 'free');
      assert.match(search.warnings!.join(' '), /25,000/); assert.match(search.warnings!.join(' '), /域名条件仅在网关过滤/); assert.match(search.warnings!.join(' '), /上游提示：upstream restriction/);
      assert.deepEqual(calls[0].params, { name: 'web_search', arguments: { objective: 'SQLite official WAL', search_queries: ['SQLite official WAL'], session_id: 'stable-session' } });
      const fetched = await f.engine.providers.parallelFree('https://sqlite.org/wal.html', 'stable-session', AbortSignal.timeout(3000));
      assert.equal(fetched.results[0].snippet, full); assert.ok(full.length > 25000);
      assert.deepEqual(calls[1].params, { name: 'web_fetch', arguments: { urls: ['https://sqlite.org/wal.html'], full_content: true, session_id: 'stable-session' } });
      assert.equal(f.store.keys().length, 0);
    } finally { await f.cleanup(); }
  }
});

test('P2: free MCP HTTP limits, tool errors and malformed results are classified without leaking upstream text', async () => {
  const cases = [
    { reply: () => new Response('secret-token-from-error', { status: 429, headers: { 'Retry-After': '120' } }), code: 'rate_limited', cooldown: 120000 },
    { reply: () => new Response('secret-token-from-error', { status: 403 }), code: 'forbidden' },
    { reply: () => new Response('secret-token-from-error', { status: 500 }), code: 'upstream_error' },
    { reply: (rpc: Rpc) => mcpResult(rpc, { error: { status: 429, message: 'secret-token-from-error' } }, { isError: true }), code: 'rate_limited', cooldown: 60000 },
    { reply: (rpc: Rpc) => mcpResult(rpc, { error: { message: '429 secret-token-from-error' } }, { isError: true }), code: 'upstream_error' },
    { reply: (rpc: Rpc) => mcpResult(rpc, { unexpected: 'secret-token-from-error' }), code: 'invalid_response' },
    { reply: () => new Response('secret-token-from-error', { headers: { 'Content-Type': 'application/json' } }), code: 'connection_error' },
  ];
  for (const scenario of cases) {
    const f = fixture(parallelMock(scenario.reply));
    try {
      await assert.rejects(f.engine.providers.parallelFree({ query: 'error case' }, 'stable-session', AbortSignal.timeout(3000)), error => {
        assert.ok(error instanceof GatewayError); assert.equal(error.code, scenario.code); assert.ok(!error.message.includes('secret-token'));
        if (scenario.cooldown) assert.equal(error.cooldownMs, scenario.cooldown);
        return true;
      });
    } finally { await f.cleanup(); }
  }
});

test('P4: overlong content is marked, a response beyond 4 MB is rejected, and invalid fetch URLs never reach upstream', async () => {
  let size = 100001, requests = 0;
  const mock = parallelMock(rpc => { requests++; return mcpResult(rpc, { results: [{ ...result('parallel'), full_content: 'x'.repeat(size) }] }, { text: true }); });
  const f = fixture(mock);
  try {
    const data = await f.engine.providers.parallelFree('https://example.com/large', 'same', AbortSignal.timeout(3000));
    assert.equal(data.results[0].snippet.length, 100000); assert.equal(data.results[0].truncated, true);
    size = 4000001;
    await assert.rejects(f.engine.providers.parallelFree('https://example.com/large', 'same', AbortSignal.timeout(3000)), (e: unknown) => e instanceof GatewayError && e.code === 'response_too_large');
    await assert.rejects(f.engine.providers.parallelFree('http://127.0.0.1/admin', 'same', AbortSignal.timeout(3000)), /公网域名/);
    assert.equal(requests, 2);
  } finally { await f.cleanup(); }
});
