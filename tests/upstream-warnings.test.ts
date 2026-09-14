import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamWarnings } from '../server/upstream-warnings.js';
import { Store } from '../server/store.js';
import { caller, fixture, login, result, upstream } from './helpers.js';

// W1: real reasons remain nonfatal; W2: redaction/bounds; W3: API, logs, cache,
// pagination and restart; W4: old data is preserved; W5: errors remain errors.
const warning = { type: 'input_validation_warning', message: 'Reducing max_results=40 to 20.' };

test('W2: display fields are allowlisted and credentials are redacted before truncation', () => {
  const secret = 'opaque/value+123456';
  const messages = upstreamWarnings([
    warning,
    { code: 'quota_hint', message: `opaque ${secret}; encoded ${encodeURIComponent(secret)}; Bearer abc.def.ghi; user@example.com`, headers: { secret: 'never-display-this-field' } },
    'api_key="unrelated-key-value" refresh_token: another-token-value',
    'Cookie: next-auth.session-token=private-cookie; other=private-other',
    'See https://user:password@example.com/help?access_token=private-query#private-fragment',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.c2lnbmF0dXJl keen_abcdefghijk123456',
    '<img src=x onerror=window.injected=true>', { unknown: 'never-display-this-field' }, null,
  ], [secret]);
  const joined = messages.join('\n');
  assert.match(joined, /input_validation_warning.*Reducing max_results=40 to 20\./);
  assert.match(joined, /https:\/\/example.com\/help/);
  for (const privateValue of [secret, encodeURIComponent(secret), 'abc.def.ghi', 'user@example.com', 'unrelated-key-value', 'another-token-value', 'private-cookie', 'private-other', 'private-query', 'private-fragment', 'password@', 'never-display-this-field', 'eyJhbGci', 'keen_abcdefghijk123456']) assert.ok(!joined.includes(privateValue), privateValue);
  assert.match(joined, /未提供可显示的说明/);
  assert.deepEqual(upstreamWarnings(null), []); assert.deepEqual(upstreamWarnings({ message: 'not an array' }), []);
  const bounded = upstreamWarnings(Array.from({ length: 15 }, () => ` ${'字'.repeat(2000)} ${secret}`), [secret]);
  assert.equal(bounded.length, 11); assert.match(bounded[10], /另有 5 项/);
  assert.ok(bounded.every(item => item.length < 850)); assert.ok(!bounded.join('').includes(secret));
});

test('W1/W3/W5: warnings survive HTTP, logs, caching, pagination, fetch and restart without changing status', async () => {
  let fail = false, upstreamCalls = 0;
  const f = fixture(async (_url, init) => {
    upstreamCalls++;
    if (fail) return new Response('private-error-body', { status: 500 });
    const secret = new Headers(init?.headers).get('x-api-key')!;
    return Response.json({ results: [result('parallel'), result('parallel', 'https://docs.example.com/second')], warnings: [warning, `Echoed key ${secret}`], usage: [{ name: 'sku_search', count: 1 }] });
  });
  try {
    const [key] = f.add('parallel');
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'advanced' }, max_results: 1 });
    const base = await f.listen(), cookie = await login(base);
    const response = await fetch(`${base}/api/search`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'warning persistence' }) });
    assert.equal(response.status, 200);
    const data = await response.json(), expected = data.providers[0].warnings;
    assert.equal(data.partial, false); assert.equal(data.providers[0].status, 'success');
    assert.equal(expected.length, 2); assert.match(expected[0], /Reducing max_results=40 to 20/);
    assert.ok(!JSON.stringify(data).includes('parallel-secret-0123456789'));
    const logs = await (await fetch(`${base}/api/logs`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(logs[0].calls[0].warnings, expected); assert.equal(logs[0].calls[0].status, 'success');
    const page = f.engine.results({ collection_id: data.collection_id, offset: 1 }, { id: 'admin', name: 'admin' });
    assert.deepEqual(page.providers[0].warnings, expected); assert.equal(page.results.length, 1);
    const uncached = await f.engine.search({ query: 'warning persistence' }, { id: 'admin', name: 'admin' });
    assert.equal(uncached.cache_hit, false);
    const cached = await f.engine.search({ query: 'warning persistence' }, { id: 'admin', name: 'admin' });
    assert.equal(cached.cache_hit, true); assert.deepEqual(cached.providers[0].warnings, expected); assert.equal(upstreamCalls, 2);
    const fetched = await f.engine.fetch('https://docs.example.com/source', caller);
    assert.deepEqual(fetched.providers[0].warnings, expected);
    const reopened = new Store(f.directory);
    try {
      assert.deepEqual(reopened.collection(data.collection_id, 'admin')!.providers[0].warnings, expected);
      assert.deepEqual(reopened.logs().find(r => r.id === data.request_id)!.calls[0].warnings, expected);
      assert.equal(reopened.key(key.id)!.state, 'ready');
    } finally { reopened.close(); }
    fail = true;
    await assert.rejects(f.engine.providers.search(f.store.key(key.id)!, 'advanced', { query: 'failure' }, 1, AbortSignal.timeout(1000)), error => error instanceof Error && !error.message.includes('private-error-body'));
  } finally { await f.cleanup(); }
});

test('W1/W2: AnySearch and Keenable extraction wrappers preserve and redact warnings', async () => {
  const f = fixture(async (url, init) => {
    const payload = { ...result('wrapped'), warnings: [{ code: 'source_hint', detail: 'Some page content was omitted.' }, 'api_key=private-fixture-value'] };
    if (url.endsWith('/extract')) return Response.json({ code: 0, data: payload });
    const rpc = init?.body ? JSON.parse(String(init.body)) : {};
    if (rpc.method === 'tools/call') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    return upstream(url, init);
  });
  try {
    for (const provider of ['anysearch', 'keenable'] as const) {
      const [key] = f.add(provider);
      const data = await f.engine.providers.fetch(f.store.key(key.id)!, 'https://docs.example.com/page', AbortSignal.timeout(5000));
      assert.equal(data.results.length, 1); assert.equal(data.warnings!.length, 2);
      assert.match(data.warnings![0], /source_hint.*Some page content was omitted/);
      assert.ok(!data.warnings!.join('').includes('private-fixture-value'));
    }
  } finally { await f.cleanup(); }
});

test('W4: additive migration preserves old collections and marks discarded warning text as unavailable', async () => {
  const f = fixture(async () => Response.json({ results: [result('parallel')] }));
  try {
    const [key] = f.add('parallel'), secret = f.store.key(key.id)!.secret;
    f.store.saveProfile({ ...f.store.profile()!, modes: { parallel: 'advanced' } });
    const data = await f.engine.search({ query: 'old warning' }, caller);
    const stored = f.store.collection(data.collection_id, caller.id)!;
    stored.providers[0].warnings = ['上游报告 1 项警告；本次检索可能受限制。'];
    const legacyValue = JSON.stringify(stored);
    f.store.run('UPDATE collections SET value=? WHERE id=?', legacyValue, data.collection_id);
    f.store.db.exec('ALTER TABLE calls DROP COLUMN warnings_json');
    const reopened = new Store(f.directory);
    try {
      const expected = ['历史记录仅保存了 1 项上游警告，未保存具体原因。'];
      assert.deepEqual(reopened.collection(data.collection_id, caller.id)!.providers[0].warnings, expected);
      assert.deepEqual(reopened.logs()[0].calls[0].warnings, expected);
      assert.equal(reopened.get<{ value: string }>('SELECT value FROM collections WHERE id=?', data.collection_id)!.value, legacyValue);
      assert.equal(reopened.key(key.id)!.secret, secret);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});
