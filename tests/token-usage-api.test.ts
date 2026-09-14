import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, login } from './helpers.js';

test('T1/T3: HTTP and MCP attribute search/fetch/cache to IDs; reads, rejected input and console activity are excluded', async () => {
  const f = fixture(), base = await f.listen(), client = new Client({ name: 'metering-fixture', version: '1' });
  try {
    f.add('exa'); f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const a = f.store.createToken('same name'), b = f.store.createToken('same name');
    const post = (path: string, body: unknown, token = a.token) => fetch(`${base}/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const first = await (await post('search', { query: 'owned search' })).json();
    assert.equal((await (await post('search', { query: 'owned search' })).json()).cache_hit, true);
    assert.equal((await post('fetch', { url: first.results[0].url })).status, 200);
    assert.equal((await post('results', { collection_id: first.collection_id })).status, 200);
    assert.equal((await post('evidence', { collection_id: first.collection_id, url: first.results[0].url })).status, 200);
    assert.equal((await post('search', { query: '', max_results: -1 })).status, 400);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${b.token}` } } }));
    await client.listTools(); assert.equal(f.store.tokens().find(t => t.id === b.id)!.usage!.lifetime.requests, 0);
    assert.ok(!(await client.callTool({ name: 'search', arguments: { query: 'mcp search' } })).isError);
    const mcpFetch = await client.callTool({ name: 'fetch', arguments: { url: first.results[0].url } }); assert.ok(!mcpFetch.isError);
    await client.callTool({ name: 'search_results', arguments: { collection_id: first.collection_id } });
    const cookie = await login(base);
    assert.equal((await fetch(`${base}/api/search`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'admin search' }) })).status, 200);
    assert.equal((await fetch(`${base}/api/tokens`, { headers: { Authorization: `Bearer ${a.token}` } })).status, 401);
    const response = await fetch(`${base}/api/tokens`, { headers: { Cookie: cookie } }); const tokens = await response.json();
    const left = tokens.find((t: { id: string }) => t.id === a.id).usage.lifetime, right = tokens.find((t: { id: string }) => t.id === b.id).usage.lifetime;
    assert.equal(left.requests, 3); assert.equal(left.cache_hits, 1); assert.equal(left.upstream_calls, 2); assert.equal(left.reported_cost_usd, .014);
    assert.equal(right.requests, 2); assert.equal(right.upstream_calls, 2);
    const publicJson = JSON.stringify(tokens); for (const secret of [a.token, b.token, 'fingerprint', 'fixture-exa-secret']) assert.ok(!publicJson.includes(secret));
    f.store.revokeToken(a.id); assert.equal((await post('search', { query: 'revoked' })).status, 401);
    assert.deepEqual(f.store.tokens().find(t => t.id === a.id)!.usage!.lifetime, left);
  } finally { await client.close(); await f.cleanup(); }
});
