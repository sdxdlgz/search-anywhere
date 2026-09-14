import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../server/store.js';
import { fixture, login, result } from './helpers.js';
import { mcpResult, parallelMock } from './parallel-fixtures.js';

test('P5: authenticated profile/API/MCP flows preserve free provenance and paginate full content', async () => {
  const f = fixture(parallelMock(rpc => mcpResult(rpc, { results: [{ ...result('parallel'), full_content: 'Evidence. '.repeat(4000) }] })), 'balanced', 'free_first');
  const base = await f.listen(), client = new Client({ name: 'free-mcp-acceptance', version: '1' });
  try {
    const cookie = await login(base), token = f.store.createToken('Parallel integration');
    const adminHeaders = { cookie, 'Content-Type': 'application/json' };
    const putProfile = (data: unknown) => fetch(`${base}/api/profiles/balanced`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify(data) });
    const profile = { ...f.store.profile()!, modes: { exa: null, parallel: 'basic', tavily: null, anysearch: null, keenable: null } };
    assert.equal((await putProfile({ ...profile, parallel_transport: 'unexpected' })).status, 400);
    assert.equal((await putProfile({ ...profile, parallel_transport: 'api' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/profiles`, { headers: adminHeaders })).json()).find((p: { id: string }) => p.id === 'balanced').parallel_transport, 'api');
    const { parallel_transport, ...legacy } = profile;
    assert.equal((await putProfile(legacy)).status, 200);
    assert.equal(f.store.profile()!.parallel_transport, 'free_first');
    assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"query":"no auth"}' })).status, 401);
    const headers = { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' };
    const post = (name: string, args: unknown) => fetch(`${base}/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
    const search = await post('search', { query: 'HTTP free search' }); assert.equal(search.status, 200);
    const data = await search.json(); assert.equal(data.providers[0].mode, 'fast'); assert.equal(data.providers[0].transport, 'free_mcp');
    const page = await (await post('fetch', { url: data.results[0].url })).json();
    const evidence = await (await post('evidence', { collection_id: page.collection_id, url: page.url, offset: 30000, limit: 20000 })).json();
    assert.equal(evidence.total_characters, 40000); assert.equal(evidence.evidence[0].content.length, 10000);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const listed = await client.listTools(); assert.match(listed.tools.find(t => t.name === 'search')!.description!, /free MCP fast/);
    const reply = await client.callTool({ name: 'search', arguments: { query: 'MCP free search' } });
    assert.notEqual(reply.isError, true);
    const body = JSON.parse((reply.content as { text: string }[])[0].text);
    assert.equal(body.providers[0].transport, 'free_mcp'); assert.equal(body.results[0].evidence[0].mode, 'fast');
    const detail = await client.callTool({ name: 'fetch', arguments: { url: body.results[0].url } });
    assert.notEqual(detail.isError, true); assert.ok(JSON.parse((detail.content as { text: string }[])[0].text).collection_id);
    const logs = await (await fetch(`${base}/api/logs`, { headers: adminHeaders })).json();
    assert.ok(logs.flatMap((l: { calls: { transport: string }[] }) => l.calls).every((c: { transport: string }) => c.transport === 'free_mcp'));
    assert.equal(f.store.todayCalls(), 4); assert.equal(f.store.keys().length, 0);
  } finally { await client.close(); await f.cleanup(); }
});

test('P5: old call rows migrate as API while credentials, profiles and new anonymous records survive reopening', async () => {
  const f = fixture(parallelMock(), 'balanced', 'free_first');
  try {
    const [key] = f.add('parallel');
    const before = f.store.key(key.id)!.secret;
    const request = f.store.beginRequest('legacy', 'search', 'legacy call', 'balanced');
    const call = f.store.beginCall(request, f.store.key(key.id)!, 'basic', 'search')!;
    f.store.finishCall(call, { status: 'success', duration_ms: 1 });
    f.store.finishRequest(request, 'success', 1);
    f.store.db.exec('ALTER TABLE calls DROP COLUMN transport');
    f.store.db.exec('ALTER TABLE calls DROP COLUMN fallback_reason');
    const reopened = new Store(f.directory);
    try {
      assert.equal(reopened.logs()[0].calls[0].transport, 'api');
      assert.equal(reopened.key(key.id)!.secret, before);
      assert.equal(reopened.profile()!.parallel_transport, 'free_first');
    } finally { reopened.close(); }
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'fast' } });
    const response = await f.engine.search({ query: 'after migration' }, { id: 'migration', name: 'migration' });
    const next = new Store(f.directory);
    try {
      const log = next.logs().find(l => l.id === response.request_id)!.calls[0];
      assert.equal(log.transport, 'free_mcp'); assert.equal(log.key_id, null); assert.equal(next.key(key.id)!.secret, before);
      assert.equal(next.collection(response.collection_id, 'migration')!.providers[0].transport, 'free_mcp');
    } finally { next.close(); }
  } finally { await f.cleanup(); }
});
