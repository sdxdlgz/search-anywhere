import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { exaCookie, updatedExaCookie } from '../server/exa-cookies.js';
import { exaBalanceSnapshot } from '../server/exa-balance.js';
import { EXA_SITE, EXA_TEAM, exaBareValue, exaCookieValue, exaCredits, exaPlan, exaUpstream } from './exa-fixtures.js';

test('E6: paste a complete session value without its cookie name, rejecting incomplete and oversized values', () => {
  assert.equal(exaCookie(`  ${exaBareValue}  `), `next-auth.session-token=${exaBareValue}`);
  assert.equal(exaCookie(`__Secure-next-auth.session-token=${exaBareValue}`), `__Secure-next-auth.session-token=${exaBareValue}`);
  for (const input of [exaBareValue.split('.').slice(0, 4).join('.'), 'only-a-fragment', `${exaBareValue}\r\n`, `${exaBareValue}\x00`, `${exaBareValue}; _ga=analytics`, `next-auth.session-token=${exaBareValue}; __Secure-next-auth.session-token=${exaBareValue}`]) assert.throws(() => exaCookie(input), { code: 'invalid_login' });
  const largest = `a..b.${'c'.repeat(32768 - 'next-auth.session-token='.length - 7)}.d`;
  assert.equal(exaCookie(largest).length, 32768);
  assert.throws(() => exaCookie(largest + 'd'), { code: 'invalid_login' });
});

test('E1/E2: plain and secure cookies accept complete ordered chunks, strip analytics, reject ambiguity and retain official replacements', () => {
  const cookie = exaCookieValue();
  assert.equal(exaCookie(`Cookie: _ga=ignore; ${cookie}; _stripe_sid=ignore`), cookie);
  const base = '__Secure-next-auth.session-token';
  assert.equal(exaCookie(`${base}.1=parttwo; ${base}.0=partone`), `${base}.0=partone; ${base}.1=parttwo`);
  for (const input of ['', '_ga=not-a-session', `${cookie}; ${cookie}`, `${cookie}; ${base}=abcdefgh`, `${base}.1=abcdefgh`, `${base}.00=abcdefgh`, `${base}=abcdefgh; ${base}.0=abcdefgh`, `${cookie}\r\nX-Foo: bar`, `next-auth.session-token=${'a'.repeat(32768)}`]) assert.throws(() => exaCookie(input));
  const large = `next-auth.session-token=${'x'.repeat(32768 - 'next-auth.session-token='.length)}`;
  assert.equal(exaCookie(large).length, 32768);
  const headers = new Headers();
  headers.append('Set-Cookie', `${cookie}; Max-Age=0`);
  headers.append('Set-Cookie', 'next-auth.session-token.0=partone; Path=/');
  headers.append('Set-Cookie', 'next-auth.session-token.1=parttwo; Path=/');
  headers.append('Set-Cookie', '_ga=never-saved; Path=/');
  assert.equal(updatedExaCookie(cookie, headers).cookie, 'next-auth.session-token.0=partone; next-auth.session-token.1=parttwo');
  assert.throws(() => updatedExaCookie(cookie, new Headers({ 'Set-Cookie': 'next-auth.session-token=; Max-Age=0' })), { code: 'exa_login_expired' });
  assert.equal(updatedExaCookie(cookie, new Headers({ 'Set-Cookie': `${exaCookieValue('new')}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600` })).cookie, exaCookieValue('new'));
});

test('E2/E3: concurrent real query flow verifies both teams, isolates search credentials and immediately persists rotated cookies', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = fixture(async (url, init) => { calls.push({ url, init }); return exaUpstream(url, init); });
  try {
    const [key] = f.add('exa');
    f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    const [a, b] = await Promise.all([f.engine.syncUsage(key.id), f.engine.syncUsage(key.id)]);
    assert.deepEqual(a, b); assert.equal(calls.length, 4);
    assert.equal(a.money_balance!.available_cents, 2000); assert.equal(a.money_balance!.expiring[0].balance_cents, 1000);
    assert.equal(a.money_balance!.expiring[0].expires_at, '2026-10-01T07:00:00.000Z');
    for (const call of calls) {
      assert.equal(call.init!.method, 'GET'); assert.equal(call.init!.redirect, 'manual');
      const headers = new Headers(call.init!.headers);
      if (call.url.startsWith(EXA_SITE)) { assert.equal(headers.get('x-api-key'), null); assert.match(headers.get('Cookie')!, /next-auth.session-token=/); }
      else { assert.equal(headers.get('Cookie'), null); assert.equal(headers.get('x-api-key'), 'exa-secret-0123456789'); }
    }
    assert.equal(f.store.exaLogin(f.store.loginSession(key.id)!).cookie, exaCookieValue('rotated'));
    assert.doesNotMatch(JSON.stringify(f.store.keys()), /fixture-exa-session|exa-secret-0123456789/);
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});

test('E3: ordinary debt, enterprise credits, unknown fields and expiring portions retain correct money semantics', () => {
  const parsed = exaBalanceSnapshot({ ...exaCredits, orbInvoiceDebt: 2500 }, exaPlan, EXA_TEAM);
  assert.equal(parsed.money_balance!.available_cents, -500);
  assert.equal(exaBalanceSnapshot({ ...exaCredits, orbInvoiceDebt: 2500 }, { subscription: { plan: { external_plan_id: 'search_api_enterprise' } } }, EXA_TEAM).money_balance!.available_cents, 2000);
  assert.equal(exaBalanceSnapshot({ ...exaCredits, orbCreditsInCents: -100 }, { subscription: { plan: { external_plan_id: 'search_websets' } } }, EXA_TEAM).money_balance!.available_cents, 0);
  assert.equal(exaBalanceSnapshot({ orbCreditsInCents: 0, orbInvoiceDebt: 0, expiringCredits: [] }, { subscription: null }, EXA_TEAM).money_balance!.available_cents, 0);
  for (const data of [{ ...exaCredits, orbCreditsInCents: null }, { ...exaCredits, orbCreditsInCents: '2000' }, { ...exaCredits, orbInvoiceDebt: -1 }, { ...exaCredits, expiringCredits: null }, { ...exaCredits, expiringCredits: [{ balanceCents: 1000, expiresAt: 'invalid' }] }]) assert.throws(() => exaBalanceSnapshot(data, exaPlan, EXA_TEAM), { code: 'invalid_response' });
  for (const plan of [{}, { error: 'private-error' }, { subscription: {} }]) assert.throws(() => exaBalanceSnapshot(exaCredits, plan, EXA_TEAM), { code: 'invalid_response' });
});

test('E2/E4: wrong selected team and mismatched key team cannot contribute balance or change search health', async () => {
  for (const mismatch of ['selected', 'key']) {
    let balanceReads = 0;
    const f = fixture(async (url, init) => {
      if (url.endsWith('/get-credits')) balanceReads++;
      if (mismatch === 'key' && url.endsWith('/v0/teams/me')) return Response.json({ id: 'different-team' });
      return exaUpstream(url, init);
    });
    try {
      const [key] = f.add('exa'); f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: mismatch === 'selected' ? 'wrong-team' : EXA_TEAM });
      await assert.rejects(f.engine.syncUsage(key.id), { code: 'usage_sync_failed', status: 409 });
      assert.equal(balanceReads, 0); assert.equal(f.store.key(key.id)!.state, 'ready'); assert.equal(f.store.loginSession(key.id)!.needs_login, 1);
    } finally { await f.cleanup(); }
  }
});

test('E2/E4: expired sessions stop without a refresh loop, retain snapshots and recover with replacement', async () => {
  let expired = false, reads = 0;
  const f = fixture(async (url, init) => { reads++; return expired && url.endsWith('/api/auth/session') ? Response.json({}) : exaUpstream(url, init); });
  try {
    const [key] = f.add('exa'); f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    await f.engine.syncUsage(key.id); const old = f.store.key(key.id)!.usage_json;
    expired = true; await assert.rejects(f.engine.syncUsage(key.id), { code: 'usage_sync_failed', status: 401 });
    const attempts = reads; await assert.rejects(f.engine.syncUsage(key.id), { code: 'usage_sync_failed', status: 401 });
    assert.equal(reads, attempts); assert.equal(f.store.key(key.id)!.usage_json, old); assert.equal(f.store.key(key.id)!.state, 'ready');
    expired = false; f.store.setExaSession(key.id, { cookie: exaCookieValue('recovery'), team_id: EXA_TEAM });
    await f.engine.syncUsage(key.id); assert.equal(f.store.loginSession(key.id)!.needs_login, 0);
  } finally { await f.cleanup(); }
});

test('E2/E4: transient and permission errors are sanitized, save prior cookie updates and preserve quota', async () => {
  let status = 200;
  const f = fixture(async (url, init) => status !== 200 && url.endsWith('/get-credits') ? new Response('secret-upstream-content', { status }) : exaUpstream(url, init));
  try {
    const [key] = f.add('exa'); f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
    await f.engine.syncUsage(key.id); const old = f.store.key(key.id)!.usage_json;
    for (const code of [403, 429, 503]) {
      status = code; await assert.rejects(f.engine.syncUsage(key.id));
      assert.equal(f.store.loginSession(key.id)!.needs_login, 0); assert.equal(f.store.key(key.id)!.usage_json, old);
      assert.equal(f.store.exaLogin(f.store.loginSession(key.id)!).cookie, exaCookieValue('rotated'));
      assert.doesNotMatch(f.store.key(key.id)!.usage_error!, /secret-upstream-content/);
    }
    assert.equal(f.store.todayCalls(), 0);
  } finally { await f.cleanup(); }
});

test('E2/E4: in-flight cookie replacement, removal and key deletion reject stale quota writes', async () => {
  for (const action of ['replace', 'remove', 'delete']) {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    const f = fixture(async (url, init) => { if (url.endsWith('/get-credits')) { started(); await gate; } return exaUpstream(url, init); });
    try {
      const [key] = f.add('exa'); f.store.setExaSession(key.id, { cookie: exaCookieValue(), team_id: EXA_TEAM });
      const query = f.engine.syncUsage(key.id); const rejected = assert.rejects(query, { code: 'usage_context_changed' });
      await reached;
      if (action === 'replace') f.store.setExaSession(key.id, { cookie: exaCookieValue('replacement'), team_id: EXA_TEAM });
      if (action === 'remove') f.store.removeLoginSession(key.id);
      if (action === 'delete') f.store.deleteKey(key.id);
      release(); await rejected;
      assert.ok(!f.store.key(key.id)?.usage_json);
      if (action === 'replace') assert.equal(f.store.exaLogin(f.store.loginSession(key.id)!).cookie, exaCookieValue('replacement'));
      else assert.equal(f.store.loginSession(key.id), undefined);
    } finally { release(); await f.cleanup(); }
  }
});
