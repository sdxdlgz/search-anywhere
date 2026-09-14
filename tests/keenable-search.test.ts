import test from 'node:test';
import assert from 'node:assert/strict';
import { keenableSearchData } from '../server/keenable-search.js';
import { GatewayError } from '../server/upstream.js';
import { caller, fixture, login, upstream } from './helpers.js';

// KP1: native text reaches results/evidence and billing; KP2: JSON/structured compatibility;
// KP3: text boundaries, empty/invalid data and URL filtering; KP4: tool errors and recovery.
const first = 'Title: 官方额度说明\nURL: https://docs.example.com/credits\nPublished: 2026-08-26\nAcquired: 2026-09-05\nSnippets:\nOne credit per request.\nTitle: this line belongs to the excerpt.\nMore details.';
const second = 'Title: Pricing\nURL: https://docs.example.com/pricing\nSnippets:\nPublic pricing.';
const usage = { sku: 'search.pro', amount: 1, credits: 1, paid: false };

test('KP3: native search text preserves multiple results, Unicode, dates and multiline excerpts', () => {
  const data = keenableSearchData(`\n${first}\n\n${second}\n`.replace(/\n/g, '\r\n'));
  assert.deepEqual(data.results, [
    { title: '官方额度说明', url: 'https://docs.example.com/credits', published_at: '2026-08-26', acquired_at: '2026-09-05', snippet: 'One credit per request.\nTitle: this line belongs to the excerpt.\nMore details.' },
    { title: 'Pricing', url: 'https://docs.example.com/pricing', published_at: undefined, acquired_at: undefined, snippet: 'Public pricing.' },
  ]);
  assert.deepEqual(keenableSearchData('{"results":[]}'), { results: [] });
  assert.deepEqual(keenableSearchData('Title: Empty excerpt\nURL: https://docs.example.com/empty\nSnippets:\n').results,
    [{ title: 'Empty excerpt', url: 'https://docs.example.com/empty', published_at: undefined, acquired_at: undefined, snippet: '' }]);
  for (const body of ['', 'unrecognized upstream text', 'null', '[]', 'Title: Incomplete\nSnippets:\nNo URL', `upstream error\n${first}`]) {
    assert.throws(() => keenableSearchData(body), error => error instanceof GatewayError && error.code === 'invalid_response');
  }
});

test('KP1/KP3: HTTP search exposes text results, retains evidence and records actual Pro free credits', async () => {
  const f = fixture(async (url, init) => {
    const rpc = init?.body ? JSON.parse(String(init.body)) : {};
    if (rpc.method !== 'tools/call') return upstream(url, init);
    assert.equal(rpc.params._meta['keenable/overrides'].mode, 'pro');
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: first }, { type: 'text', text: second }, { type: 'text', text: 'Title: Private\nURL: http://127.0.0.1/private\nSnippets:\nDiscard this.' }], _meta: { 'keenable/usage': usage } } });
  });
  try {
    const [key] = f.add('keenable');
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: null, parallel: null, tavily: null, keenable: 'pro' } });
    const base = await f.listen(), cookie = await login(base);
    const response = await fetch(`${base}/api/search`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Keenable Pro metering', max_results: 1 }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.total_results, 2); assert.equal(data.results.length, 1); assert.equal(data.partial, false);
    const all = f.engine.results({ collection_id: data.collection_id }, { id: 'admin', name: 'admin' });
    assert.equal(all.results.length, 2); assert.ok(all.results.some(r => r.title === '官方额度说明'));
    const evidence = f.engine.evidence({ collection_id: data.collection_id, url: 'https://docs.example.com/credits' }, { id: 'admin', name: 'admin' });
    assert.match(evidence.evidence[0].snippet, /More details\./);
    assert.equal(evidence.evidence[0].published_at, '2026-08-26');
    const call = f.store.logs()[0].calls[0];
    assert.equal(call.status, 'success'); assert.equal(call.mode, 'pro'); assert.equal(call.credits, 1);
    assert.equal(call.cost_usd, null); assert.equal(call.paid, 0);
    assert.deepEqual(call.usage_items, [{ name: 'search.pro', count: 1 }]);
    assert.equal(f.store.keys().find(k => k.id === key.id)!.state, 'ready');
    assert.equal(f.store.dashboard().credits_by_provider.find(p => p.provider === 'keenable')!.reported, 1);
  } finally { await f.cleanup(); }
});

test('KP2/KP4: structured results take precedence, JSON remains supported, tool errors never become results', async () => {
  let format: 'structured' | 'json' | 'error' | 'text' = 'structured';
  const f = fixture(async (url, init) => {
    const rpc = init?.body ? JSON.parse(String(init.body)) : {};
    if (rpc.method !== 'tools/call') return upstream(url, init);
    const data = { results: [{ title: 'JSON source', url: 'https://docs.example.com/json', snippet: 'Structured excerpt' }] };
    const content = [{ type: 'text', text: format === 'json' ? JSON.stringify(data) : first }];
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content, ...(format === 'structured' ? { structuredContent: data } : {}), isError: format === 'error', _meta: { 'keenable/usage': { ...usage, credits: 2, paid: true } } } });
  });
  try {
    const [key] = f.add('keenable');
    const search = () => f.engine.providers.search(f.store.key(key.id)!, 'pro', { query: caller.name }, 3, AbortSignal.timeout(5000));
    for (const next of ['structured', 'json'] as const) { format = next; const data = await search(); assert.equal(data.results[0].title, 'JSON source'); assert.equal(data.credits, 2); assert.equal(data.paid, true); }
    format = 'error'; await assert.rejects(search(), error => error instanceof GatewayError && error.code === 'upstream_error');
    format = 'text'; assert.equal((await search()).results[0].title, '官方额度说明');
  } finally { await f.cleanup(); }
});
