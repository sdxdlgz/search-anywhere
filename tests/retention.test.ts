import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller } from './helpers.js';
import { Retention } from '../server/retention.js';
import { Store } from '../server/store.js';
import { captureBackup, restoreBackup, validateBackup } from '../server/backup-data.js';

const DAY = 86400000;
function backdate(f: ReturnType<typeof fixture>, id: string, date: string) {
  for (const table of ['requests', 'collections']) f.store.run(`UPDATE ${table} SET created_at=? WHERE id=?`, date, id);
  f.store.run('UPDATE calls SET created_at=? WHERE request_id=?', date, id);
}
function confirmation(preview: ReturnType<Retention['preview']>) {
  const { cutoff, expires_at, confirmation_token } = preview; return { cutoff, expires_at, confirmation_token };
}
function accounting(f: ReturnType<typeof fixture>) {
  return { dashboard: f.store.dashboard(), keys: f.store.keys().map(({ usage, ...key }) => ({ ...key, balance: usage?.local_balance })),
    calls: f.store.all('SELECT rowid,id,key_id,status,duration_ms,cost_usd,credits,billing_source,created_at,paid,transport,billing_scope FROM calls ORDER BY rowid') };
}

test('H1/H3: retention boundary, retained evidence, compact ledger, reusable space and empty repeat', async () => {
  const f = fixture();
  try {
    const [exa] = f.add('exa'); f.store.exaLedger.configure(exa.id, { mode: 'manual', balance_usd: 20 });
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const clock = Date.now(), retention = new Retention(f.store, f.engine, { busy: false }, () => clock);
    const cutoff = new Date(clock - 7 * DAY).toISOString();
    const old = await f.engine.search({ query: 'sensitive expired search' }, caller);
    backdate(f, old.collection_id, new Date(clock - 7 * DAY - 1).toISOString());
    // Large evidence makes reclaimed SQLite pages measurable, without depending on exact file bytes.
    f.store.run('UPDATE collections SET value=? WHERE id=?', JSON.stringify({ ...f.store.collection(old.collection_id, caller.id)!, query: 'private '.repeat(30000) }), old.collection_id);
    const boundary = await f.engine.search({ query: 'boundary search' }, caller);
    backdate(f, boundary.collection_id, cutoff);
    const recent = await f.engine.search({ query: 'recent search' }, caller);
    const before = accounting(f), secrets = f.store.all('SELECT * FROM credentials');
    const preview = retention.preview(7);
    assert.equal(preview.cutoff, cutoff); assert.equal(preview.requests, 1); assert.equal(preview.collections, 1); assert.equal(preview.call_details, 1); assert.ok(preview.content_bytes > 200000);
    const result = retention.confirm(confirmation(preview)); assert.equal(result.source, 'manual');
    assert.equal(f.store.collection(old.collection_id, caller.id), undefined);
    for (const id of [boundary.collection_id, recent.collection_id]) assert.ok(f.engine.results({ collection_id: id }, caller).results.length);
    assert.equal(f.store.logs().length, 2); assert.ok(!JSON.stringify(f.store.logs()).includes('sensitive expired search'));
    assert.equal(f.store.get<{ query: unknown }>('SELECT query FROM requests WHERE id=?', old.request_id)!.query, null);
    assert.equal(f.store.get<{ key_label: unknown }>('SELECT key_label FROM calls WHERE request_id=?', old.request_id)!.key_label, null);
    assert.deepEqual(accounting(f), before); assert.deepEqual(f.store.all('SELECT * FROM credentials'), secrets);
    assert.ok(retention.status().storage.reusable_bytes > 0);
    const empty = retention.preview(7); assert.equal(empty.requests + empty.collections + empty.call_details, 0);
    retention.confirm(confirmation(empty)); assert.deepEqual(accounting(f), before);
    assert.throws(() => retention.confirm(confirmation(preview)), /数据已变化/);
  } finally { await f.cleanup(); }
});

test('H1/H2: clearing all content preserves today/month statistics, free calls, unknown charges and daily budgets', async () => {
  const f = fixture();
  try {
    const [key] = f.add('exa'); f.store.exaLedger.configure(key.id, { mode: 'manual', balance_usd: 10, team_id: 'shared-fixture-team' });
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    await f.engine.search({ query: 'today query' }, caller);
    const request = f.store.beginRequest('private caller', 'fetch', 'private URL', 'balanced');
    const unknown = f.store.beginCall(request, f.store.key(key.id)!, 'auto', 'fetch')!;
    f.store.finishCall(unknown, { status: 'error', duration_ms: 5 });
    const free = f.store.beginCall(request, { id: null, provider: 'parallel', label: 'free', account: 'free', masked: '' }, 'fast', 'search', { transport: 'free_mcp' })!;
    f.store.finishCall(free, { status: 'success', duration_ms: 2, cost_usd: 0, billing_source: 'free' });
    f.store.finishRequest(request, 'partial', 7);
    f.store.saveSettings({ ...f.store.settings(), daily_call_limit: f.store.todayCalls() });
    const before = accounting(f), retention = new Retention(f.store, f.engine, { busy: false }, () => Date.now() + 1000);
    retention.confirm(confirmation(retention.preview(0)));
    assert.deepEqual(accounting(f), before); assert.equal(f.store.logs().length, 0);
    assert.equal(f.store.beginCall(request, f.store.key(key.id)!, 'auto', 'search'), undefined);
    assert.equal(f.store.exaLedger.manualUsage(key.id)!.local_balance!.unpriced_calls, 1);
    f.store.saveSettings({ ...f.store.settings(), daily_call_limit: 0 });
    const prior = f.store.exaLedger.manualUsage(key.id)!.local_balance!.remaining_usd;
    await f.engine.search({ query: 'new charge after cleanup' }, caller);
    assert.equal(f.store.exaLedger.manualUsage(key.id)!.local_balance!.remaining_usd, prior - .007);
  } finally { await f.cleanup(); }
});

test('H2: enabled 7-day default, disabled state, daily schedule, busy postponement and restart persistence', async () => {
  const f = fixture();
  try {
    f.add('tavily'); f.store.saveProfile({ ...f.store.profile()!, modes: { tavily: 'basic' } });
    let clock = Date.now(); const auth = { busy: false }, retention = new Retention(f.store, f.engine, auth, () => clock);
    assert.deepEqual(f.store.settings().history_retention, { enabled: true, days: 7 });
    const old = await f.engine.search({ query: 'expired' }, caller); backdate(f, old.collection_id, new Date(clock - 8 * DAY).toISOString());
    f.store.saveSettings({ ...f.store.settings(), history_retention: { enabled: false, days: 7 } }); retention.tick(); assert.ok(f.store.collection(old.collection_id, caller.id));
    f.store.saveSettings({ ...f.store.settings(), history_retention: { enabled: true, days: 7 } }); auth.busy = true; retention.tick(); assert.equal(f.store.settings().history_cleanup, undefined);
    auth.busy = false; f.store.maintenance = true; retention.tick(); f.store.maintenance = false;
    retention.tick(); assert.equal(f.store.collection(old.collection_id, caller.id), undefined); assert.equal(retention.status().last_cleanup!.source, 'automatic');
    const last = f.store.settings().history_cleanup; clock += DAY - 1; retention.tick(); assert.deepEqual(f.store.settings().history_cleanup, last);
    const reopened = new Store(f.directory);
    try { assert.deepEqual(reopened.settings().history_cleanup, last); assert.deepEqual(reopened.settings().history_retention, { enabled: true, days: 7 }); } finally { reopened.close(); }
    clock++; retention.tick(); assert.notEqual(f.store.settings().history_cleanup!.completed_at, last!.completed_at);
  } finally { await f.cleanup(); }
});

test('H2/H3: transaction rollback, automatic error recovery, expired/tampered/replayed and stale previews', async t => {
  const f = fixture();
  try {
    f.add('tavily'); f.store.saveProfile({ ...f.store.profile()!, modes: { tavily: 'basic' } });
    const old = await f.engine.search({ query: 'rollback private text' }, caller); backdate(f, old.collection_id, new Date(Date.now() - 8 * DAY).toISOString());
    let clock = Date.now(); const retention = new Retention(f.store, f.engine, { busy: false }, () => clock);
    const preview = retention.preview(7); const credentials = f.store.all('SELECT * FROM credentials');
    assert.throws(() => retention.confirm({ ...confirmation(preview), cutoff: new Date(0).toISOString() }), /数据已变化/);
    clock += 600000; assert.throws(() => retention.confirm(confirmation(preview)), /预览已过期/);
    const stale = retention.preview(7); f.store.createToken('concurrent change'); assert.throws(() => retention.confirm(confirmation(stale)), /数据已变化/);
    const snapshot = captureBackup(f.store).tables;
    f.store.db.exec("CREATE TRIGGER fixture_cleanup_failure BEFORE UPDATE ON calls BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(() => retention.confirm(confirmation(retention.preview(7))), /fixture failure/); assert.deepEqual(captureBackup(f.store).tables, snapshot); assert.equal(f.store.maintenance, false);
    retention.tick(); assert.match(retention.status().last_error!, /回滚/); assert.equal(retention.status().last_cleanup, null);
    f.store.db.exec('DROP TRIGGER fixture_cleanup_failure'); retention.tick(); assert.equal(retention.status().last_error, null); assert.equal(retention.status().retained.collections, 0);
    const readFailure = t.mock.method(f.store, 'settings', () => { throw new Error('fixture read failure'); });
    assert.doesNotThrow(() => retention.tick()); readFailure.mock.restore();
    assert.match(retention.status().last_error!, /自动清理未完成/);
    assert.deepEqual(f.store.all('SELECT * FROM credentials'), credentials);
  } finally { await f.cleanup(); }
});

test('H2/H5: cleanup invalidates cached collections; old and new backups preserve policies and ledger rowids', async () => {
  const f = fixture(), target = fixture();
  try {
    const [key] = f.add('exa'); f.store.exaLedger.configure(key.id, { mode: 'manual', balance_usd: 5 });
    f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const old = await f.engine.search({ query: 'cached' }, caller); backdate(f, old.collection_id, new Date(Date.now() - 8 * DAY).toISOString());
    assert.equal((await f.engine.search({ query: 'cached' }, caller)).cache_hit, true);
    const legacy = captureBackup(f.store); const settings = JSON.parse(String(legacy.tables.settings[0].value)); delete settings.history_retention; delete settings.history_cleanup; legacy.tables.settings[0].value = JSON.stringify(settings);
    restoreBackup(target.store, validateBackup(target.store, legacy)); assert.deepEqual(target.store.settings().history_retention, { enabled: true, days: 7 });
    f.retention.tick(); assert.throws(() => f.engine.results({ collection_id: old.collection_id }, caller), /不存在/);
    const current = await f.engine.search({ query: 'cached' }, caller); assert.equal(current.cache_hit, false); assert.notEqual(current.collection_id, old.collection_id);
    f.store.saveSettings({ ...f.store.settings(), history_retention: { enabled: false, days: 30 } });
    restoreBackup(target.store, validateBackup(target.store, captureBackup(f.store)));
    assert.deepEqual(target.store.settings(), f.store.settings());
    assert.deepEqual(target.store.exaLedger.manualUsage(key.id)!.local_balance, f.store.exaLedger.manualUsage(key.id)!.local_balance);
    assert.deepEqual(target.store.all('SELECT rowid,id FROM calls ORDER BY rowid'), f.store.all('SELECT rowid,id FROM calls ORDER BY rowid'));
  } finally { await f.cleanup(); await target.cleanup(); }
});
