import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, login } from './helpers.js';

test('C3/C5: authenticated collection pages and evidence enforce token IDs, validation, admin access and revocation', async () => {
  const f = fixture(), base = await f.listen();
  try {
    f.add('exa');
    const a = f.store.createToken('same client'), b = f.store.createToken('same client');
    const post = (path: string, body: unknown, token = a.token) => fetch(`${base}/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const search = await post('search', { query: 'owned collection', max_results: 1 }); assert.equal(search.status, 200);
    const data = await search.json();
    const args = { collection_id: data.collection_id };
    assert.equal((await post('results', args)).status, 200);
    assert.equal((await post('results', args, b.token)).status, 404);
    assert.equal((await post('evidence', { ...args, url: data.results[0].url }, b.token)).status, 404);
    assert.equal((await post('evidence', { ...args, url: data.results[0].url })).status, 200);
    for (const bad of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 31 }]) assert.equal((await post('results', { ...args, ...bad })).status, 400);
    assert.equal((await post('search', { query: 'too many', per_provider_results: 101 })).status, 400);
    assert.equal((await post('evidence', { ...args, url: data.results[0].url, limit: 20001 })).status, 400);
    const empty = await (await post('results', { ...args, offset: 99 })).json(); assert.deepEqual(empty.results, []); assert.equal(empty.next_offset, null);
    const cookie = await login(base);
    assert.equal((await fetch(`${base}/api/results`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).status, 200);
    assert.equal(f.store.todayCalls(), 1);
    f.store.deleteToken(a.id);
    assert.equal((await post('results', args)).status, 401);
    assert.equal((await post('evidence', { ...args, url: data.results[0].url })).status, 401);
  } finally { await f.cleanup(); }
});
