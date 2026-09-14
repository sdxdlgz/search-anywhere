import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { balance, keenableUpstream, tokens, AUTH } from './keenable-fixtures.js';
import { keenableTokens } from '../server/keenable-balance.js';

test('K2/K3: expired sessions rotate once across concurrent queries, save both tokens and verify organization', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const f = fixture(async (url, init) => { requests.push({ url, init }); await new Promise(resolve => setTimeout(resolve, 5)); return keenableUpstream(url, init); });
  try {
    const [key] = f.add('keenable'); const initial = tokens(-100);
    f.store.setKeenableSession(key.id, initial);
    const snapshots = await Promise.all(Array.from({ length: 12 }, () => f.engine.syncUsage(key.id)));
    assert.equal(requests.length, 3);
    const refresh = requests.find(r => r.url.startsWith(AUTH))!;
    assert.deepEqual(JSON.parse(String(refresh.init!.body)), { refresh_token: initial.refresh_token });
    assert.ok(new Headers(refresh.init!.headers).has('apikey'));
    const session = f.store.keenableTokens(f.store.keenableSession(key.id)!);
    assert.equal(session.refresh_token, 'fixture-refresh-rotated'); assert.notEqual(session.access_token, initial.access_token);
    assert.equal(new Headers(requests[2].init!.headers).get('authorization'), `Bearer ${session.access_token}`);
    assert.ok(requests.every(r => r.init?.redirect === 'error' && r.init.signal));
    assert.ok(snapshots.every(s => s.balance?.free_remaining === 99988 && s.balance.paid_remaining === 25));
    assert.equal(f.store.todayCalls(), 0); assert.equal(f.store.keys()[0].state, 'ready');
    assert.ok(!JSON.stringify(snapshots).includes('fixture-org'));
  } finally { await f.cleanup(); }
});

test('K2: a still-valid token gets one refresh after 401; a second 401 requires login without a loop', async () => {
  for (const rejectedAfterRefresh of [false, true]) {
    let refreshes = 0, balances = 0;
    const f = fixture(async (url, init) => {
      if (url.startsWith(AUTH)) refreshes++;
      if (url.endsWith('/organization/balance') && (++balances === 1 || rejectedAfterRefresh)) return new Response('do-not-leak', { status: 401 });
      return keenableUpstream(url, init);
    });
    try {
      const [key] = f.add('keenable'); f.store.setKeenableSession(key.id, tokens());
      if (rejectedAfterRefresh) await assert.rejects(f.engine.syncUsage(key.id), /续期后仍拒绝/);
      else assert.equal((await f.engine.syncUsage(key.id)).status, 'ok');
      assert.equal(refreshes, 1); assert.equal(balances, 2);
      assert.equal(!!f.store.keenableSession(key.id)!.needs_login, rejectedAfterRefresh);
      assert.equal(f.store.keys()[0].state, 'ready');
    } finally { await f.cleanup(); }
  }
});

test('K2/K4: rejected refresh pauses renewal, preserves old quota and search health; replacing it recovers', async () => {
  let rejected = false, refreshes = 0;
  const f = fixture(async (url, init) => {
    if (url.startsWith(AUTH)) { refreshes++; if (rejected) return Response.json({ error: 'SECRET_TOKEN_DETAIL' }, { status: 400 }); }
    return keenableUpstream(url, init);
  });
  try {
    const [key] = f.add('keenable'); f.store.setKeenableSession(key.id, tokens());
    const previous = await f.engine.syncUsage(key.id);
    f.store.setKeenableSession(key.id, tokens(-10)); rejected = true;
    await assert.rejects(f.engine.syncUsage(key.id), /登录已失效/);
    await assert.rejects(f.engine.syncUsage(key.id), /登录已失效/);
    assert.equal(refreshes, 1); assert.deepEqual(f.store.keys()[0].usage, previous);
    assert.doesNotMatch(JSON.stringify(f.store.keys()), /SECRET_TOKEN_DETAIL/);
    assert.equal(f.store.keys()[0].state, 'ready'); assert.equal(f.store.todayCalls(), 0);
    f.store.setKeenableSession(key.id, tokens(-10, 'updated')); rejected = false;
    assert.equal((await f.engine.syncUsage(key.id)).status, 'ok'); assert.equal(f.store.keys()[0].usage_error, null);
  } finally { await f.cleanup(); }
});

test('K2: transient refresh failure retains session; successful rotation survives later balance failure', async () => {
  for (const failAt of ['refresh', 'balance']) {
    const f = fixture(async (url, init) => {
      if ((failAt === 'refresh' && url.startsWith(AUTH)) || (failAt === 'balance' && url.endsWith('/organization/balance'))) return new Response('private-response', { status: 503 });
      return keenableUpstream(url, init);
    });
    try {
      const [key] = f.add('keenable'); const initial = tokens(-10); f.store.setKeenableSession(key.id, initial);
      await assert.rejects(f.engine.syncUsage(key.id), /HTTP 503/);
      const saved = f.store.keenableSession(key.id)!;
      assert.equal(saved.needs_login, 0);
      assert.equal(f.store.keenableTokens(saved).refresh_token, failAt === 'refresh' ? initial.refresh_token : 'fixture-refresh-rotated');
      assert.doesNotMatch(f.store.keys()[0].usage_error!, /private-response/);
    } finally { await f.cleanup(); }
  }
});

test('K2: replacing or removing credentials during renewal rejects stale writes and quota', async () => {
  for (const action of ['replace', 'remove', 'delete']) {
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(r => { release = r; }); const refreshing = new Promise<void>(r => { started = r; });
    const f = fixture(async (url, init) => { if (url.startsWith(AUTH)) { started(); await waiting; } return keenableUpstream(url, init); });
    try {
      const [key] = f.add('keenable'); f.store.setKeenableSession(key.id, tokens(-1));
      const result = f.engine.syncUsage(key.id); const rejected = assert.rejects(result, /配置已变化/);
      await refreshing;
      if (action === 'replace') f.store.setKeenableSession(key.id, tokens(3600, 'replacement'));
      else if (action === 'remove') f.store.removeKeenableSession(key.id);
      else f.store.deleteKey(key.id);
      release(); await rejected;
      if (action === 'replace') assert.equal(f.store.keenableTokens(f.store.keenableSession(key.id)!).refresh_token, 'fixture-refresh-replacement');
      else assert.equal(f.store.keenableSession(key.id), undefined);
      assert.ok(!f.store.key(key.id)?.usage_json);
    } finally { release(); await f.cleanup(); }
  }
});

test('K3: mismatched organization cannot contribute quota, and invalid/unknown values never become zero', async () => {
  const responses = [
    { ...balance, org_id: 'different-org' }, { ...balance, org_id: undefined },
    { ...balance, free_credits: null }, { ...balance, paid_credits: '25' },
    { ...balance, charged_spendings: -1 }, { ...balance, charged_spendings: undefined },
  ];
  for (const data of responses) {
    const f = fixture(async (url, init) => url.endsWith('/organization/balance') ? Response.json(data) : keenableUpstream(url, init));
    try {
      const [key] = f.add('keenable'); f.store.setKeenableSession(key.id, tokens());
      await assert.rejects(f.engine.syncUsage(key.id), /组织|字段/);
      assert.equal(f.store.keys()[0].usage, null); assert.equal(f.store.keys()[0].state, 'ready');
      assert.equal(!!f.store.keenableSession(key.id)!.needs_login, data.org_id === 'different-org');
    } finally { await f.cleanup(); }
  }
});

test('K1/K3: refresh-only input, zero balances, categorized fallback and exhausted free quota are supported', async () => {
  assert.equal(keenableTokens({ refresh_token: 'fixture-refresh-only' }).expires_at, 0);
  assert.throws(() => keenableTokens({ access_token: 'not-a-jwt', refresh_token: 'fixture-refresh-only' }), /格式不正确/);
  for (const free of [0, 5, 100]) {
    const f = fixture(async (url, init) => url.endsWith('/organization/balance') ? Response.json({ org_id: 'fixture-org', free_credits: free, paid_credits: 0, search_spendings: 2, fetch_spendings: 3, workflow_spendings: 4 }) : keenableUpstream(url, init));
    try {
      const [key] = f.add('keenable'); f.store.setKeenableSession(key.id, keenableTokens({ refresh_token: 'fixture-refresh-only' }));
      const usage = await f.engine.syncUsage(key.id);
      assert.equal(usage.balance!.charged_used, 9); assert.equal(usage.balance!.paid_remaining, 0);
      assert.equal(usage.balance!.free_remaining, Math.max(0, free - 9));
    } finally { await f.cleanup(); }
  }
});

test('K4: scheduled queries include only enabled, configured and recoverable Keenable sessions', async () => {
  let identities = 0;
  const f = fixture(async (url, init) => { if (url.endsWith('/v1/auth/user')) identities++; return keenableUpstream(url, init); });
  try {
    const [ready, missing, expired, disabled] = f.add('keenable', 'same source', ['keen-ready-12345', 'keen-missing-12345', 'keen-expired-12345', 'keen-disabled-12345']);
    for (const key of [ready, expired, disabled]) f.store.setKeenableSession(key.id, tokens());
    f.store.invalidateKeenableSession(f.store.keenableSession(expired.id)!);
    f.store.updateKey(disabled.id, { label: disabled.label, account: disabled.account, enabled: false, max_concurrency: 2, exa_key_id: '' });
    assert.equal((await f.engine.syncUsage(missing.id)).status, 'needs_setup'); assert.equal(identities, 0);
    await f.engine.syncDueUsage(); assert.equal(identities, 1);
    await f.engine.syncDueUsage(); assert.equal(identities, 1);
    assert.equal(f.store.keys().filter(k => k.usage?.status === 'ok').length, 1);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});
