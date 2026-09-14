import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture } from './helpers.js';

test('R9: real SDK MCP initialize/list/search/fetch and failed tool result', async () => {
  const f = fixture(), base = await f.listen();
  f.add('exa');
  const { token } = f.store.createToken('MCP integration');
  const client = new Client({ name: 'acceptance-client', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
    const list = await client.listTools(); assert.deepEqual(list.tools.map(t => t.name), ['search', 'fetch', 'search_results', 'get_evidence']);
    const result = await client.callTool({ name: 'search', arguments: { query: 'mcp search query' } });
    assert.notEqual(result.isError, true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.equal(JSON.parse(text).results.length, 1);
    const stored = JSON.parse(text);
    const next = await client.callTool({ name: 'search_results', arguments: { collection_id: stored.collection_id } });
    assert.notEqual(next.isError, true);
    const evidence = await client.callTool({ name: 'get_evidence', arguments: { collection_id: stored.collection_id, url: stored.results[0].url } });
    assert.notEqual(evidence.isError, true);
    const invalidPage = await client.callTool({ name: 'search_results', arguments: { collection_id: stored.collection_id, offset: -1 } });
    assert.equal(invalidPage.isError, true);
    const page = await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com/page' } });
    assert.notEqual(page.isError, true);
    const bad = await client.callTool({ name: 'fetch', arguments: { url: 'http://localhost/private' } });
    assert.equal(bad.isError, true);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  } finally { await client.close(); await f.cleanup(); }
});
