import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { keenableFetchData } from '../server/keenable-fetch.js';
import { caller, fixture, upstream } from './helpers.js';

const url = 'https://example.com/article';
const body = 'Article body.\n\nTitle: A heading inside the article\nURL: https://example.com/citation\n\nMore details.';
const native = `Title: Article\nURL: ${url}\n\n${body}`;
const billing = { sku: 'fetch.live', amount: 1, credits: 1, paid: false };

test('F1/F2: native fetch header preserves the complete document; invalid values stay invalid', () => {
  for (const value of [native, native.replaceAll('\n', '\r\n')]) assert.deepEqual(keenableFetchData(value), { title: 'Article', url, content: body });
  assert.equal(keenableFetchData(`Title: Empty\nURL: ${url}\n\n`).content, '');
  for (const value of ['', 'Failed to fetch', 'null', '[]', '12', '"plain"', 'Title: Missing URL\n\nBody']) assert.throws(() => keenableFetchData(value), /格式无法识别/);
  assert.deepEqual(keenableFetchData(JSON.stringify({ url, content: body })), { url, content: body });
});

test('F1/F2/F5: Keenable native, JSON and structured fetch work through HTTP/MCP; errors retain billing and recover', async () => {
  let mode = 'native';
  const f = fixture(async (target, init) => {
    const rpc = init?.body ? JSON.parse(String(init.body)) : {};
    if (rpc.method !== 'tools/call') return upstream(target, init);
    assert.equal(rpc.params.name, 'fetch_page_content'); assert.equal(rpc.params.arguments.live, true);
    const content = mode === 'json' ? JSON.stringify({ url, title: 'Article', content: body }) : mode === 'bad' ? 'upstream-secret-DO-NOT-PRINT' : mode === 'long' ? `Title: Long\nURL: ${url}\n\n${'x'.repeat(100001)}` : mode === 'private' ? native.replace(url, 'http://127.0.0.1/private') : native;
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: content }], isError: mode === 'error', ...(mode === 'structured' ? { structuredContent: { url, title: 'Structured', content: body } } : {}), _meta: { 'keenable/usage': billing } } });
  }, 'coverage');
  const client = new Client({ name: 'fetch-test', version: '1' });
  try {
    f.add('keenable');
    f.store.saveProfile({ ...f.store.profile()!, modes: { keenable: 'pro' } });
    const base = await f.listen(), { token } = f.store.createToken('fetch-test');
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const httpFetch = () => fetch(`${base}/v1/fetch`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    for (mode of ['native', 'json', 'structured']) {
      const response = await httpFetch(); assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.partial, false);
      const evidence = await client.callTool({ name: 'get_evidence', arguments: { collection_id: result.collection_id, url } });
      assert.equal(JSON.parse((evidence.content as { text: string }[])[0].text).evidence[0].content, body);
    }
    mode = 'native';
    const mcp = await client.callTool({ name: 'fetch', arguments: { url } }); assert.notEqual(mcp.isError, true);
    for (mode of ['bad', 'error', 'private']) {
      const response = await httpFetch(); assert.equal(response.status, 503);
      assert.ok(!(await response.text()).includes('upstream-secret'));
      const call = f.store.logs()[0].calls[0];
      assert.equal(call.status, 'error'); assert.equal(call.credits, 1); assert.equal(call.paid, 0);
      assert.deepEqual(call.usage_items, [{ name: 'fetch.live', count: 1 }]);
      assert.equal(f.store.keys()[0].state, 'ready'); assert.ok(!JSON.stringify(call).includes('upstream-secret'));
    }
    mode = 'long';
    const large = await f.engine.fetch(url, caller);
    const evidence = f.engine.evidence({ collection_id: large.collection_id, url, offset: 99990, limit: 20 }, caller);
    assert.equal(evidence.total_characters, 100000); assert.equal(evidence.evidence[0].truncated, true);
    mode = 'native'; assert.equal((await httpFetch()).status, 200);
    assert.equal(f.store.inflight.size, 0);
  } finally { await client.close(); await f.cleanup(); }
});
