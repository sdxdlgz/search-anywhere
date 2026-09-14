import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { PROVIDERS } from '../shared/types.js';
import { caller, fixture, result, upstream } from './helpers.js';

test('C2: coverage is the new default; existing settings and legacy profiles survive additive migration', async () => {
  const f = fixture(upstream, 'coverage');
  try {
    assert.equal(f.store.settings().default_profile, 'coverage');
    assert.equal(f.store.settings().daily_call_limit, 0);
    assert.equal(f.store.profile()!.fetch_strategy, 'parallel');
    assert.ok(PROVIDERS.every(p => f.store.profile()!.modes[p]));
    f.store.run('DELETE FROM profiles WHERE id=?', 'coverage');
    const old = { ...f.store.profile('balanced')!, modes: { exa: 'deep', parallel: null, tavily: 'basic' } };
    delete old.per_provider_results; delete old.fetch_strategy;
    f.store.run('UPDATE profiles SET value=? WHERE id=?', JSON.stringify(old), 'balanced');
    f.store.saveSettings({ default_profile: 'balanced', daily_call_limit: 777, usage_sync_minutes: 0 });
    const reopened = new Store(f.directory);
    try {
      assert.equal(reopened.settings().daily_call_limit, 777);
      assert.equal(reopened.settings().default_profile, 'balanced');
      assert.equal(reopened.profile()!.modes.exa, 'deep');
      assert.equal(reopened.profile()!.modes.anysearch, null);
      assert.equal(reopened.profile()!.per_provider_results, old.max_results);
      assert.equal(reopened.profiles().filter(p => p.id === 'coverage').length, 1);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});

test('C3/C4/C5: all pages and differing same-URL excerpts persist independently of output limit and caller names', async () => {
  let calls = 0;
  const f = fixture(async (url, init) => {
    calls++;
    const p = url.includes('tavily') ? 'tavily' : 'exa';
    const body = JSON.parse(String(init?.body));
    assert.equal(p === 'exa' ? body.numResults : body.max_results, 20);
    const entries = Array.from({ length: 20 }, (_, i) => ({ ...result(p, `https://${p}.example.com/${i}`), content: 'body'.repeat(3000) }));
    return Response.json({ results: [{ ...result(p, `https://shared.example.com/a?utm_source=${p}`), highlights: [`${p} original excerpt`], content: `${p} alternate account` }, ...entries, { ...result(p, 'https://shared.example.com/a'), content: `${p} another excerpt`, highlights: ['duplicate distinct text'] }] });
  });
  try {
    f.add('exa'); f.add('tavily');
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'deep', tavily: 'advanced', parallel: null }, per_provider_results: 20 });
    const first = await f.engine.search({ query: 'conflicting claims', max_results: 1 }, caller);
    assert.equal(first.results.length, 1); assert.equal(first.total_results, 41); assert.equal(first.next_offset, 1);
    assert.equal(first.providers[0].unique_urls, 21); assert.equal(first.providers[0].exclusive_urls, 20);
    const shared = first.results[0]; assert.equal(shared.evidence.length, 4); assert.deepEqual(shared.sources, ['exa', 'tavily']);
    assert.equal(shared.evidence[0].url, 'https://shared.example.com/a?utm_source=exa');
    assert.equal(shared.evidence[0].query, 'conflicting claims'); assert.equal(shared.evidence[0].mode, 'deep');
    const evidence = f.engine.evidence({ collection_id: first.collection_id, url: shared.url }, caller);
    assert.equal(evidence.evidence[0].snippet, 'exa original excerpt');
    assert.ok(evidence.evidence.some(e => e.snippet === 'tavily alternate account'));
    const seen = [shared.url]; let offset: number | null = first.next_offset;
    while (offset !== null) { const page = f.engine.results({ collection_id: first.collection_id, offset, limit: 7 }, caller); seen.push(...page.results.map(r => r.url)); offset = page.next_offset; }
    assert.equal(new Set(seen).size, 41); assert.equal(seen.length, 41); assert.equal(calls, 2);
    assert.equal(f.engine.results({ collection_id: first.collection_id, offset: 1000 }, caller).results.length, 0);
    assert.throws(() => f.engine.results({ collection_id: first.collection_id }, { id: 'other', name: caller.name }), /无权/);
    assert.equal(f.engine.results({ collection_id: first.collection_id }, { id: 'admin', name: 'admin' }).total_results, 41);
    const reopened = new Store(f.directory);
    try { assert.equal(reopened.collection(first.collection_id, caller.id)!.results.length, 41); } finally { reopened.close(); }
    const cached = await f.engine.search({ query: 'conflicting claims', max_results: 1 }, caller);
    assert.equal(cached.cache_hit, true); assert.equal(cached.collection_id, first.collection_id); assert.equal(calls, 2);
  } finally { await f.cleanup(); }
});

test('C4: preview and character pagination retain full text and mark irreversible truncation', async () => {
  const f = fixture(async () => Response.json({ results: [{ ...result('exa'), highlights: ['a'.repeat(5000)], text: 'b'.repeat(100005) }] }));
  try {
    f.add('exa');
    const response = await f.engine.search({ query: 'long evidence' }, caller);
    const entry = response.results[0];
    assert.equal(entry.snippet.length, 1800); assert.equal(entry.evidence[0].preview_truncated, true);
    assert.equal(entry.evidence[0].content, undefined); assert.equal(entry.evidence[0].truncated, true);
    let offset: number | null = 0, content = '', snippet = '';
    while (offset !== null) { const e = f.engine.evidence({ collection_id: response.collection_id, url: entry.url, offset, limit: 20000 }, caller); content += e.evidence[0].content; snippet += e.evidence[0].snippet; offset = e.next_offset; }
    assert.equal(content, 'b'.repeat(100000)); assert.equal(snippet, 'a'.repeat(5000));
    assert.throws(() => f.engine.evidence({ collection_id: response.collection_id, url: 'https://missing.example.com' }, caller), /没有此 URL/);
    assert.ok(response.providers[0].warnings!.length);
  } finally { await f.cleanup(); }
});

test('C1/C6: all five search adapters and coverage fetch retain versions and failures with separate credits', async () => {
  const f = fixture(upstream, 'coverage');
  try {
    for (const p of PROVIDERS) f.add(p);
    const response = await f.engine.search({ query: 'all providers' }, caller);
    assert.equal(response.partial, false); assert.equal(response.providers.length, 5); assert.equal(response.total_results, 5);
    assert.equal(response.providers.find(p => p.provider === 'tavily')!.effective_limit, 20);
    assert.equal(response.providers.find(p => p.provider === 'keenable')!.effective_limit, 50);
    const page = await f.engine.fetch('https://example.com/a', caller);
    assert.ok('collection_id' in page);
    const complete = f.store.collection(page.collection_id as string, caller.id)!;
    assert.equal(complete.results.flatMap(r => r.evidence).length, 5);
    assert.ok(complete.results.flatMap(r => r.evidence).every(e => e.snippet.length > 0));
    assert.equal(f.store.inflight.size, 0); assert.equal(f.store.todayCalls(), 10);
    assert.equal(f.store.dashboard().reported_credits, 2);
    assert.equal(f.store.dashboard().credits_by_provider.find(p => p.provider === 'keenable')!.reported, 6);
    assert.equal(f.store.dashboard().credits_by_provider.find(p => p.provider === 'keenable')!.paid, 0);
    for (const p of ['anysearch', 'keenable'] as const) { const k = f.store.keys().find(k => k.provider === p)!; assert.equal((await f.engine.syncUsage(k.id) as { status: string }).status, 'needs_setup'); }
    const exa = f.store.keys().find(k => k.provider === 'exa')!;
    f.store.setKeyState(exa.id, 'invalid', 'bad key', null);
    const partial = await f.engine.fetch('https://example.com/a', caller);
    assert.ok('partial' in partial && partial.partial); assert.equal(f.store.inflight.size, 0);
  } finally { await f.cleanup(); }
});

test('C6: coverage fetch deadline retains completed source text and records missing channels', async () => {
  const f = fixture(async (url, init) => {
    if (url.includes('parallel')) return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    return upstream(url, init);
  }, 'coverage');
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    f.add('exa'); f.add('parallel');
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'deep', parallel: 'advanced' }, timeout_ms: 50 });
    const response = await f.engine.fetch('https://example.com/deadline', caller);
    assert.ok('collection_id' in response);
    const stored = f.store.collection(response.collection_id as string, caller.id)!;
    assert.equal(stored.partial, true); assert.equal(stored.results[0].evidence[0].snippet, 'Full page text');
    assert.equal(stored.providers[1].status, 'error'); assert.equal(f.store.inflight.size, 0);
  } finally { clearTimeout(keepAlive); await f.cleanup(); }
});
