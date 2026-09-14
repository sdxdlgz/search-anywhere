import test from 'node:test';
import assert from 'node:assert/strict';
import { channelQuotas } from '../src/channel-quotas.js';
import { fixture } from './helpers.js';
import { PARALLEL_BALANCE, accountMock, balanceResponse, savedTokens, tokenResponse } from './parallel-account-fixtures.js';

test('B3: organization balance preserves signed decimal cents, keeps pending separate and deduplicates independently of notes', async () => {
  let balance = balanceResponse({ credit_balance_cents: 2000.25 });
  const f = fixture(async (url, init) => {
    assert.equal(url, PARALLEL_BALANCE); assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer parallel-access-saved-12345678');
    return Response.json(balance);
  });
  try {
    const a = f.add('parallel', 'first note')[0], b = f.add('parallel', 'second note', ['parallel-second-secret-12345678'])[0];
    for (const key of [a, b]) f.store.setLoginSession(key.id, savedTokens());
    await f.engine.syncUsage(a.id); await f.engine.syncUsage(b.id);
    let channel = channelQuotas(f.store.keys())[0];
    assert.equal(channel.unit, 'USD'); assert.equal(channel.sharedCount, 1); assert.equal(channel.organizationTotals!.credits, 2000.25); assert.equal(channel.organizationTotals!.pending, 125.5);
    balance = balanceResponse({ credit_balance_cents: -0.5, pending_debit_balance_cents: 3.25, org_id: 'second-org' });
    f.store.setLoginSession(b.id, savedTokens({ org_id: 'second-org' })); await f.engine.syncUsage(b.id);
    channel = channelQuotas(f.store.keys())[0];
    assert.equal(channel.sharedCount, 0); assert.equal(channel.organizationTotals!.credits, 1999.75); assert.equal(channel.organizationTotals!.pending, 128.75);
    balance = balanceResponse({ credit_balance_cents: 0, pending_debit_balance_cents: 0, will_invoice: true, org_id: 'second-org' });
    await f.engine.syncUsage(b.id); channel = channelQuotas(f.store.keys())[0];
    assert.equal(channel.organizationTotals!.postpaid, 1); assert.equal(channel.organizationTotals!.prepaid, 1); assert.equal(channel.organizationTotals!.credits, 2000.25);
    assert.equal(f.store.keys().find(k => k.id === b.id)!.usage!.organization_balance!.postpaid, true);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});

test('B2: expired access refreshes once, persists the rotated pair before a balance failure and reuses it', async () => {
  let refreshes = 0, balanceFails = true;
  const f = fixture(async (url, init) => {
    if (url.endsWith('/token')) {
      refreshes++; const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('refresh_token'), 'parallel-refresh-saved-12345678');
      assert.equal(body.get('client_id'), 'fixture-client'); return Response.json(tokenResponse());
    }
    assert.equal(url, PARALLEL_BALANCE);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer parallel-access-rotated-12345678');
    assert.equal(f.store.parallelTokens(f.store.loginSession(f.store.keys()[0].id)!).refresh_token, tokenResponse().refresh_token);
    return balanceFails ? new Response('private error', { status: 500 }) : Response.json(balanceResponse());
  });
  try {
    const [key] = f.add('parallel'); f.store.setLoginSession(key.id, savedTokens({ expires_at: 0 }));
    await assert.rejects(f.engine.syncUsage(key.id), /HTTP 500/);
    assert.equal(refreshes, 1); assert.equal(f.store.loginSession(key.id)!.needs_login, 0);
    balanceFails = false;
    const [a, b] = await Promise.all([f.engine.syncUsage(key.id), f.engine.syncUsage(key.id)]);
    assert.deepEqual(a, b); assert.equal(a.organization_balance!.credits_cents, 2000); assert.equal(refreshes, 1);
    assert.equal(f.store.keys()[0].usage_error, null); assert.equal(f.store.keys()[0].state, 'ready'); assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});

test('B2: 401 refreshes at most once; absent rotated refresh token retains the previous one', async () => {
  for (const failAgain of [false, true]) {
    let balances = 0, refreshes = 0;
    const f = fixture(async (url, init) => {
      if (url.endsWith('/token')) { refreshes++; const { refresh_token, ...body } = tokenResponse(); return Response.json(body); }
      balances++; return balances === 1 || failAgain ? new Response(null, { status: 401 }) : accountMock(url, init);
    });
    try {
      const [key] = f.add('parallel'); f.store.setLoginSession(key.id, savedTokens());
      if (failAgain) await assert.rejects(f.engine.syncUsage(key.id), /授权已失效/); else assert.equal((await f.engine.syncUsage(key.id)).status, 'ok');
      assert.equal(refreshes, 1); assert.equal(balances, 2); assert.equal(f.store.loginSession(key.id)!.needs_login, Number(failAgain));
      assert.equal(f.store.parallelTokens(f.store.loginSession(key.id)!).refresh_token, 'parallel-refresh-saved-12345678');
      assert.equal(f.store.keys()[0].state, 'ready'); assert.equal(f.store.todayCalls(), 0);
    } finally { await f.cleanup(); }
  }
});

test('B2/B3: invalid grants pause sync; transient failures, malformed money and org mismatch preserve prior snapshots', async () => {
  for (const scenario of ['grant', 'transient', 'malformed', 'organization']) {
    let failing = false;
    const f = fixture(async (url, init) => {
      if (!failing) return accountMock(url, init);
      if (scenario === 'grant') return Response.json({ error: 'invalid_grant', error_description: 'secret-refresh-value' }, { status: 400 });
      if (scenario === 'transient') return new Response('secret-refresh-value', { status: 500 });
      return Response.json(balanceResponse(scenario === 'malformed' ? { pending_debit_balance_cents: null } : { org_id: 'unexpected-org' }));
    });
    try {
      const [key] = f.add('parallel'); f.store.setLoginSession(key.id, savedTokens());
      const old = await f.engine.syncUsage(key.id); failing = true;
      if (['grant', 'transient'].includes(scenario)) f.store.setLoginSession(key.id, savedTokens({ expires_at: 0 }));
      await assert.rejects(f.engine.syncUsage(key.id));
      const state = f.store.keys()[0];
      assert.deepEqual(state.usage, old); assert.equal(state.state, 'ready'); assert.ok(!state.usage_error!.includes('secret-refresh'));
      assert.equal(state.parallel_login!.needs_login, ['grant', 'organization'].includes(scenario));
    } finally { await f.cleanup(); }
  }
});

test('B2: replacing or removing credentials during refresh rejects the stale write and stale quota error', async () => {
  for (const remove of [false, true]) {
    let release!: (response: Response) => void, entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture(async url => { assert.ok(url.endsWith('/token')); entered(); return new Promise<Response>(resolve => { release = resolve; }); });
    try {
      const [key] = f.add('parallel'); f.store.setLoginSession(key.id, savedTokens({ expires_at: 0 }));
      const pending = f.engine.syncUsage(key.id); await entry;
      if (remove) f.store.removeLoginSession(key.id); else f.store.setLoginSession(key.id, savedTokens({ refresh_token: 'parallel-new-credential-12345678' }));
      const saved = f.store.loginSession(key.id)?.secret;
      release(Response.json(tokenResponse()));
      await assert.rejects(pending, /配置已变化/);
      assert.equal(f.store.loginSession(key.id)?.secret, saved); assert.equal(f.store.keys()[0].usage_error, null);
    } finally { await f.cleanup(); }
  }
});

test('B4: setup is optional; background sync includes configured Parallel keys and skips expired grants', async t => {
  let count = 0, time = Date.now(); t.mock.method(Date, 'now', () => time);
  const f = fixture(async (url, init) => { count++; return accountMock(url, init); });
  try {
    const [key] = f.add('parallel'); await f.engine.syncDueUsage(); assert.equal(count, 0);
    const empty = await f.engine.syncUsage(key.id); assert.equal(empty.status, 'needs_setup'); assert.equal(count, 0);
    f.store.setUsage(key.id, { ...empty, synced_at: new Date(time).toISOString() });
    f.store.setLoginSession(key.id, savedTokens()); time += 1800001;
    await f.engine.syncDueUsage(); assert.equal(count, 1); assert.equal(f.store.keys()[0].usage!.status, 'ok');
    f.store.setLoginSession(key.id, savedTokens({ authorization_expires_at: Date.now() / 1000 - 1 }));
    await assert.rejects(f.engine.syncUsage(key.id), /授权已失效/); time += 1800001;
    await f.engine.syncDueUsage(); assert.equal(count, 1); assert.equal(f.store.keys()[0].parallel_login!.needs_login, true);
  } finally { await f.cleanup(); }
});
