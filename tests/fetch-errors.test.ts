import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedPage } from '../server/fetch-content.js';
import type { Provider } from '../shared/types.js';
import { caller, fixture, result, upstream } from './helpers.js';

test('F3/F5: page failures keep precise classification and reported usage without key cooldown or retry', async () => {
  const cases: { provider: Provider; status: number; data: unknown; code: string; credits?: number; cost?: number }[] = [
    { provider: 'anysearch', status: 422, data: { code: -1, error_code: 'extract_failed', message: 'leaked-secret' }, code: 'source_unavailable' },
    { provider: 'anysearch', status: 422, data: { error_code: 'bad_parameter', message: 'leaked-secret' }, code: 'upstream_validation' },
    { provider: 'anysearch', status: 200, data: { code: -1, message: 'leaked-secret' }, code: 'upstream_error' },
    { provider: 'exa', status: 200, data: { results: [], statuses: [{ status: 'error', error: { httpStatusCode: 403, tag: 'leaked-secret' } }], costDollars: { total: 0 } }, code: 'source_unavailable', cost: 0 },
    { provider: 'tavily', status: 200, data: { results: [], failed_results: [{ error: 'leaked-secret' }], usage: { credits: 0 } }, code: 'source_unavailable', credits: 0 },
    { provider: 'parallel', status: 200, data: { results: [], errors: [{ content: 'leaked-secret' }], usage: [{ name: 'sku_extract', count: 1 }] }, code: 'source_unavailable' },
    { provider: 'tavily', status: 200, data: { results: [] }, code: 'empty_content' },
  ];
  for (const c of cases) {
    let fail = true, calls = 0;
    const f = fixture(async (url, init) => { calls++; return fail ? Response.json(c.data, { status: c.status }) : upstream(url, init); }, 'coverage');
    try {
      f.add(c.provider, 'test', ['first-fake-key-1234', 'second-fake-key-1234']);
      f.store.saveProfile({ ...f.store.profile()!, modes: { [c.provider]: c.provider === 'parallel' ? 'advanced' : 'auto' } });
      await assert.rejects(f.engine.fetch('https://example.com/page', caller));
      const call = f.store.logs()[0].calls[0];
      assert.equal(calls, 1); assert.equal(call.error_code, c.code); assert.equal(call.http_status, c.status === 200 ? 502 : c.status);
      assert.equal(call.credits, c.credits ?? null); assert.equal(call.cost_usd, c.cost ?? null);
      assert.ok(!JSON.stringify(f.store.logs()).includes('leaked-secret'));
      assert.ok(call.warnings?.length); assert.ok(f.store.keys().every(k => k.state === 'ready'));
      if (c.provider === 'exa') assert.match(call.warnings!.join(' '), /源站 HTTP 403/);
      if (c.provider === 'parallel') assert.deepEqual(call.usage_items, [{ name: 'sku_extract', count: 1 }]);
      fail = false; assert.equal((await f.engine.fetch('https://example.com/page', caller)).partial, false);
      assert.equal(f.store.inflight.size, 0);
    } finally { await f.cleanup(); }
  }
});

test('F4: only recognizable short interstitials are rejected; normal short content and articles remain', () => {
  const check = (title: string, snippet: string) => blockedPage({ title, url: 'https://example.com', snippet });
  assert.ok(check('Untitled', "You've been blocked by network security.\nFile a ticket."));
  assert.ok(check('Just a moment...', 'Enable JavaScript and cookies to continue'));
  assert.ok(check('安全检测', '火山引擎\n正在进行安全检测...'));
  assert.equal(check('Cloudflare guide', 'This article explains checking your browser and how to verify you are human.'), false);
  assert.equal(check('Short article', 'Cloudflare supports security checks.'), false);
  assert.equal(check('Just a moment...', 'x'.repeat(3001)), false);
});

test('F4/F5: blocked evidence is excluded while usable sources remain; billed blocked fetch stays charged', async () => {
  const f = fixture(async (url, init) => url.includes('anysearch') ? Response.json({ code: 0, data: { url: 'https://example.com/page', title: '安全检测', content: '正在进行安全检测...' } }) : url.includes('exa') ? Response.json({ results: [{ ...result('exa'), title: 'Untitled', text: "You've been blocked by network security." }], costDollars: { total: .003 } }) : upstream(url, init), 'coverage');
  try {
    for (const p of ['exa', 'anysearch', 'tavily'] as const) f.add(p);
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'deep', anysearch: 'auto', tavily: 'advanced' } });
    const response = await f.engine.fetch('https://example.com/page', caller);
    assert.equal(response.partial, true); assert.equal(response.total_results, 1);
    assert.deepEqual(response.results[0].sources, ['tavily']);
    for (const p of ['exa', 'anysearch']) assert.equal(response.providers.find(r => r.provider === p)!.error_code, 'source_blocked');
    assert.equal(f.store.logs()[0].calls.find(c => c.provider === 'exa')!.cost_usd, .003);
  } finally { await f.cleanup(); }
});
