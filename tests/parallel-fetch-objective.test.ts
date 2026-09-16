import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { caller, fixture, login, result } from './helpers.js';
import { FREE_MCP, mcpResult, parallelMock } from './parallel-fixtures.js';

const url = 'https://sqlite.org/wal.html';
const objective = 'How does SQLite WAL handle concurrent writers?';
const content = 'Full page context and supporting evidence. '.repeat(1000);
const parallelOnly = { exa: null, parallel: 'basic', tavily: null, anysearch: null, keenable: null };

test('PF1: paid/free and parallel/fallback extraction carry explicit or general reading goals without reducing full content', async () => {
  for (const transport of ['api', 'free_first'] as const) {
    const captured: Record<string, any>[] = [];
    const free = parallelMock(rpc => {
      captured.push(rpc.params!.arguments);
      return mcpResult(rpc, { results: [{ ...result('parallel', url), full_content: content }] });
    });
    const f = fixture(async (target, init) => {
      if (target === FREE_MCP) return free(target, init);
      assert.equal(target, 'https://api.parallel.ai/v1/extract');
      captured.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ ...result('parallel', url), full_content: content }], warnings: [{ type: 'fixture_warning', message: 'Other upstream restrictions stay visible.' }] });
    }, 'balanced', transport);
    try {
      if (transport === 'api') f.add('parallel');
      for (const strategy of ['parallel', 'fallback'] as const) {
        f.store.saveProfile({ ...f.store.profile()!, modes: parallelOnly, fetch_strategy: strategy });
        for (const goal of [undefined, objective]) {
          const response = await f.engine.fetch(url, caller, undefined, undefined, goal);
          const sent = captured.at(-1)!;
          if (goal) assert.equal(sent.objective, goal);
          else { assert.match(sent.objective, /complete page/); assert.ok(sent.objective.length <= 200); }
          assert.equal(transport === 'api' ? sent.advanced_settings.full_content : sent.full_content, true);
          const evidence = f.engine.evidence({ collection_id: response.collection_id, url, offset: 30000, limit: 20000 }, caller);
          assert.equal(evidence.total_characters, content.length);
          assert.equal(evidence.evidence[0].content, content.slice(30000));
          if (transport === 'api') assert.match(response.providers[0].warnings!.join(' '), /Other upstream restrictions/);
        }
      }
      assert.equal(captured.length, 4);
      assert.equal(f.store.todayCalls(), 4);
    } finally { await f.cleanup(); }
  }
});

test('PF2: free extraction rate-limit fallback retains the same research objective and full-content request', async () => {
  const captured: any[] = [];
  const free = parallelMock(rpc => { captured.push(rpc.params!.arguments); return new Response(null, { status: 429 }); });
  const f = fixture(async (target, init) => {
    if (target === FREE_MCP) return free(target, init);
    assert.equal(target, 'https://api.parallel.ai/v1/extract');
    captured.push(JSON.parse(String(init?.body)));
    return Response.json({ results: [result('parallel', url)] });
  }, 'balanced', 'free_first');
  try {
    f.add('parallel');
    f.store.saveProfile({ ...f.store.profile()!, modes: parallelOnly });
    const response = await f.engine.fetch(url, caller, undefined, undefined, objective);
    assert.equal(response.providers[0].fallback_reason, 'free_rate_limited');
    assert.deepEqual(captured.map(body => body.objective), [objective, objective]);
    assert.equal(captured[0].full_content, true);
    assert.equal(captured[1].advanced_settings.full_content, true);
    assert.equal(f.store.todayCalls(), 2);
  } finally { await f.cleanup(); }
});

test('PF3: authenticated HTTP/admin/MCP accept bounded optional objective; invalid or unauthorized input makes no upstream call', async () => {
  const captured: any[] = [];
  const f = fixture(parallelMock(rpc => { captured.push(rpc.params!.arguments); return mcpResult(rpc, { results: [result('parallel', url)] }); }), 'balanced', 'free_first');
  const base = await f.listen();
  const client = new Client({ name: 'fetch-objective-test', version: '1' });
  try {
    f.store.saveProfile({ ...f.store.profile()!, modes: parallelOnly });
    const token = f.store.createToken('objective tests');
    const headers = { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' };
    const send = (body: unknown, requestHeaders: Record<string, string> = headers, path = '/v1/fetch') => fetch(base + path, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) });
    assert.equal((await send({ url, objective }, { 'Content-Type': 'application/json' })).status, 401);
    for (const value of ['', '   ', 'x'.repeat(201), 123, null]) assert.equal((await send({ url, objective: value })).status, 400);
    assert.equal(captured.length, 0);
    assert.equal((await send({ url, objective: '  ' + objective + '  ' })).status, 200);
    assert.equal(captured.at(-1).objective, objective);
    assert.equal((await send({ url, objective: 'x'.repeat(200) })).status, 200);
    assert.equal(captured.at(-1).objective.length, 200);
    assert.equal((await send({ url })).status, 200);
    assert.match(captured.at(-1).objective, /complete page/);
    const cookie = await login(base);
    assert.equal((await send({ url, objective }, { cookie, 'Content-Type': 'application/json' }, '/api/fetch')).status, 200);
    assert.equal(captured.at(-1).objective, objective);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } }));
    const tools = await client.listTools();
    const shape = tools.tools.find(t => t.name === 'fetch')!.inputSchema;
    assert.ok(shape.properties?.objective); assert.ok(!shape.required?.includes('objective'));
    const response = await client.callTool({ name: 'fetch', arguments: { url, objective } });
    assert.notEqual(response.isError, true); assert.equal(captured.at(-1).objective, objective);
    assert.equal((await client.callTool({ name: 'fetch', arguments: { url, objective: 'x'.repeat(201) } })).isError, true);
    assert.equal(captured.length, 5);
  } finally { await client.close(); await f.cleanup(); }
});
