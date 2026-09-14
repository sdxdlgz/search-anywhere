import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { anyTokens, anyUpstream, anyQuota, envelope, ANY_BASE } from './anysearch-fixtures.js';
import { anysearchTokens } from '../server/anysearch-balance.js';

test('A2/A3: concurrent expired sessions rotate once, save the pair and preserve official remaining and request units', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const mock = anyUpstream();
  const f = fixture(async (url, init) => { calls.push({ url, init }); return mock(url, init); });
  try {
    const [key] = f.add('anysearch'); f.store.setLoginSession(key.id, anyTokens(-100));
    const results = await Promise.all(Array.from({ length: 10 }, () => f.engine.syncUsage(key.id)));
    assert.equal(calls.length, 4); assert.equal(calls.filter(c => c.url.endsWith('/auth/refresh')).length, 1);
    assert.ok(calls.every(c => c.url.startsWith(ANY_BASE) && c.init?.redirect === 'error' && c.init.signal));
    const saved = f.store.loginTokens(f.store.loginSession(key.id)!);
    assert.equal(saved.refresh_token, 'fixture-any-refresh-rotated');
    assert.equal(new Headers(calls[1].init?.headers).get('authorization'), `Bearer ${saved.access_token}`);
    assert.equal(new Headers(calls[0].init?.headers).get('authorization'), null);
    assert.equal(results[0].request_quota!.remaining, 993); assert.equal(results[0].request_quota!.used, 5);
    assert.equal(results[0].request_quota!.key_limit, null); assert.equal(results[0].request_quota!.reset_period, 'daily');
    assert.ok(!results[0].account && !results[0].balance && !results[0].key);
    assert.doesNotMatch(JSON.stringify(results), /fixture-any-account|anysearch-secret|fixture-any-refresh/);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});

test('A2: HTTP or envelope session rejection refreshes once; repeated rejection stops without disabling search', async () => {
  for (const mode of ['http', 'envelope', 'repeated']) {
    let authReads = 0, refreshes = 0;
    const mock = anyUpstream();
    const f = fixture(async (url, init) => {
      if (url.endsWith('/auth/refresh')) refreshes++;
      if (url.endsWith('/auth/me') && (++authReads === 1 || mode === 'repeated')) return mode === 'http' ? new Response('SECRET', { status: 401 }) : envelope({ message: 'SECRET' }, 40141);
      return mock(url, init);
    });
    try {
      const [key] = f.add('anysearch'); f.store.setLoginSession(key.id, anyTokens());
      if (mode === 'repeated') await assert.rejects(f.engine.syncUsage(key.id), /登录已失效/);
      else assert.equal((await f.engine.syncUsage(key.id)).status, 'ok');
      assert.equal(refreshes, 1); assert.equal(authReads, 2);
      assert.equal(f.store.loginSession(key.id)!.needs_login, mode === 'repeated' ? 1 : 0);
      assert.equal(f.store.keys()[0].state, 'ready');
    } finally { await f.cleanup(); }
  }
});

test('A2/A4: invalid refresh preserves old snapshot and pauses retries; a replacement recovers', async () => {
  let invalid = false, refreshes = 0;
  const mock = anyUpstream();
  const f = fixture(async (url, init) => {
    if (url.endsWith('/auth/refresh')) { refreshes++; if (invalid) return Response.json({ code: 40141, message: 'PRIVATE_TOKEN' }, { status: 401 }); }
    return mock(url, init);
  });
  try {
    const [key] = f.add('anysearch'); f.store.setLoginSession(key.id, anyTokens());
    const previous = await f.engine.syncUsage(key.id);
    invalid = true; f.store.setLoginSession(key.id, anyTokens(-1));
    await assert.rejects(f.engine.syncUsage(key.id), /登录已失效/);
    await assert.rejects(f.engine.syncUsage(key.id), /登录已失效/);
    assert.equal(refreshes, 1); assert.deepEqual(f.store.keys()[0].usage, previous);
    assert.doesNotMatch(f.store.keys()[0].usage_error!, /PRIVATE_TOKEN/);
    invalid = false; f.store.setLoginSession(key.id, anyTokens(-1, 'replacement'));
    assert.equal((await f.engine.syncUsage(key.id)).status, 'ok'); assert.equal(f.store.keys()[0].usage_error, null);
  } finally { await f.cleanup(); }
});

test('A2: transient failures retain tokens; rotation persists even if the subsequent billing request fails', async () => {
  for (const failure of ['refresh429', 'refresh503', 'billing503', 'bad-envelope']) {
    const mock = anyUpstream();
    const f = fixture(async (url, init) => {
      if (failure.startsWith('refresh') && url.endsWith('/auth/refresh')) return new Response('PRIVATE', { status: failure.endsWith('429') ? 429 : 503 });
      if (url.endsWith('/billing/overview') && failure === 'billing503') return new Response('PRIVATE', { status: 503 });
      if (url.endsWith('/billing/overview') && failure === 'bad-envelope') return Response.json({ code: 9999, message: 'PRIVATE' });
      return mock(url, init);
    });
    try {
      const [key] = f.add('anysearch'); const original = anyTokens(-1); f.store.setLoginSession(key.id, original);
      await assert.rejects(f.engine.syncUsage(key.id));
      const stored = f.store.loginSession(key.id)!;
      assert.equal(stored.needs_login, 0); assert.doesNotMatch(f.store.keys()[0].usage_error!, /PRIVATE/);
      assert.equal(f.store.loginTokens(stored).refresh_token, failure.startsWith('refresh') ? original.refresh_token : 'fixture-any-refresh-rotated');
      assert.equal(f.store.keys()[0].state, 'ready');
    } finally { await f.cleanup(); }
  }
});

test('A2: in-flight replacement/removal/deletion cannot restore old tokens or old quota', async () => {
  for (const action of ['replace', 'remove', 'delete']) {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    const mock = anyUpstream();
    const f = fixture(async (url, init) => { if (url.endsWith('/auth/refresh')) { entered(); await gate; } return mock(url, init); });
    try {
      const [key] = f.add('anysearch'); f.store.setLoginSession(key.id, anyTokens(-1));
      const rejected = assert.rejects(f.engine.syncUsage(key.id), /配置已变化/);
      await started;
      if (action === 'replace') f.store.setLoginSession(key.id, anyTokens(1800, 'new'));
      else if (action === 'remove') f.store.removeLoginSession(key.id);
      else f.store.deleteKey(key.id);
      release(); await rejected;
      if (action === 'replace') assert.equal(f.store.loginTokens(f.store.loginSession(key.id)!).refresh_token, 'fixture-any-refresh-new');
      else assert.equal(f.store.loginSession(key.id), undefined);
      assert.ok(!f.store.key(key.id)?.usage_json);
    } finally { release(); await f.cleanup(); }
  }
});

test('A3: exact key membership is required; an account with only a matching prefix is rejected', async () => {
  const f = fixture(anyUpstream(['anysearch-secret-OTHER-ACCOUNT']));
  try {
    const [key] = f.add('anysearch'); f.store.setLoginSession(key.id, anyTokens());
    await assert.rejects(f.engine.syncUsage(key.id), /未找到此 AnySearch key/);
    assert.equal(f.store.loginSession(key.id)!.needs_login, 1); assert.equal(f.store.keys()[0].usage, null);
    assert.equal(f.store.keys()[0].state, 'ready');
  } finally { await f.cleanup(); }
});

test('A3: unknown/invalid counters never become zero; reset cycles and unavailable usage stats remain explicit', async () => {
  for (const overrides of [{ total: null }, { used: -1 }, { remaining: '999' }, { reset_period: 'unexpected' }, { next_reset_at: 'invalid' }]) {
    const mock = anyUpstream();
    const f = fixture(async (url, init) => url.endsWith('/billing/overview') ? envelope({ ...anyQuota, ...overrides }) : mock(url, init));
    try { const [key] = f.add('anysearch'); f.store.setLoginSession(key.id, anyTokens()); await assert.rejects(f.engine.syncUsage(key.id), /格式|字段/); assert.equal(f.store.keys()[0].usage, null); }
    finally { await f.cleanup(); }
  }
  const mock = anyUpstream();
  const f = fixture(async (url, init) => url.endsWith('/billing/overview') ? envelope({ ...anyQuota, total: 0, used: 0, remaining: 0, reset_period: 'none', next_reset_at: null, usage_stats_available: false }) : mock(url, init));
  try {
    const [key] = f.add('anysearch'); f.store.setLoginSession(key.id, anyTokens());
    const quota = (await f.engine.syncUsage(key.id)).request_quota!;
    assert.equal(quota.remaining, 0); assert.equal(quota.next_reset_at, null); assert.equal(quota.total_calls, null); assert.equal(quota.month_calls, null);
  } finally { await f.cleanup(); }
});

test('A2/A4: refresh-only configuration and scheduler eligibility work alongside unconfigured and disabled keys', async () => {
  let refreshes = 0; const secrets = ['any-ready-12345', 'any-missing-12345', 'any-expired-12345', 'any-disabled-12345'];
  const mock = anyUpstream(secrets);
  const f = fixture(async (url, init) => { if (url.endsWith('/auth/refresh')) refreshes++; return mock(url, init); });
  try {
    const [ready, missing, expired, disabled] = f.add('anysearch', 'same source', secrets);
    for (const key of [ready, expired, disabled]) f.store.setLoginSession(key.id, anysearchTokens({ refresh_token: 'fixture-refresh-only' }));
    f.store.invalidateLoginSession(f.store.loginSession(expired.id)!);
    f.store.updateKey(disabled.id, { label: disabled.label, account: disabled.account, enabled: false, max_concurrency: 2, exa_key_id: '' });
    assert.equal((await f.engine.syncUsage(missing.id)).status, 'needs_setup');
    await f.engine.syncDueUsage(); await f.engine.syncDueUsage();
    assert.equal(refreshes, 1); assert.equal(f.store.keys().filter(k => k.usage?.status === 'ok').length, 1);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});
