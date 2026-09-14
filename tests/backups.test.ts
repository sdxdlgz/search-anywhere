import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, login, caller, upstream } from './helpers.js';
import { Store } from '../server/store.js';
import { captureBackup, validateBackup } from '../server/backup-data.js';
import { openBackup, sealBackup, MAX_ARCHIVE_BYTES } from '../server/backup-crypto.js';
import { accountMock } from './parallel-account-fixtures.js';

const PASSWORD = 'backup-fixture-password-only';
function upload(file: Buffer, password = PASSWORD, confirmation_token?: string) {
  const metadata = Buffer.from(JSON.stringify({ password, confirmation_token })), length = Buffer.alloc(4);
  length.writeUInt32BE(metadata.length); return Buffer.concat([length, metadata, file]);
}
async function exportFile(base: string, cookie: string) {
  const response = await fetch(`${base}/api/backups/export`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition')!, /\.sab/); assert.equal(response.headers.get('cache-control'), 'no-store');
  return Buffer.from(await response.arrayBuffer());
}
function importFile(base: string, cookie: string, action: string, file: Buffer, confirmation?: string, password = PASSWORD) {
  return fetch(`${base}/api/backups/${action}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: upload(file, password, confirmation) });
}

test('M1/M3: encrypted browser migration preserves every durable table, tokens, evidence and rowid-based balances', async () => {
  const source = fixture(), target = fixture();
  try {
    const keys = ['exa', 'parallel', 'tavily', 'anysearch', 'keenable'].map(p => source.add(p as 'exa', 'same source note')[0]);
    const token = source.store.createToken('migrated client');
    source.store.setManagementSecret('same source note', 'management-fixture-secret');
    for (const key of keys.filter(k => ['parallel', 'anysearch', 'keenable'].includes(k.provider))) source.store.setLoginSession(key.id, { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: 2000000000, ...key.provider === 'parallel' ? { client_id: 'fixture-client', org_id: 'fixture-org', org_name: 'Fixture organization' } : {} });
    source.store.setExaSession(keys[0].id, { cookie: 'next-auth.session-token=fixture-cookie', team_id: 'fixture-team' });
    source.store.setParallelClientId('fixture-client');
    source.store.run("INSERT INTO calls (rowid,id,status) VALUES (99,'old-call','success')");
    source.store.exaLedger.configure(keys[0].id, { mode: 'manual', balance_usd: 20 });
    source.store.run("DELETE FROM calls WHERE id='old-call'");
    // Preserve a gap before the calibration cursor so re-numbering would change the balance.
    source.store.run("INSERT INTO calls (rowid,id,status) VALUES (100,'unrelated-call','success')");
    const search = await source.engine.search({ query: 'portable evidence', profile: 'coverage' }, { id: token.id, name: token.name });
    const remaining = source.store.exaLedger.manualUsage(keys[0].id)!.local_balance!.remaining_usd;
    target.add('tavily', 'will be replaced');
    const sourceBase = await source.listen(), targetBase = await target.listen();
    const sourceCookie = await login(sourceBase), targetCookie = await login(targetBase);
    const oldTargetKey = readFileSync(join(target.directory, 'encryption.key'));
    const file = await exportFile(sourceBase, sourceCookie);
    for (const hidden of ['fixture-refresh-token', 'management-fixture-secret', 'portable evidence', sourceCookie]) assert.ok(!file.includes(Buffer.from(hidden)));
    const decoded = await openBackup(file, PASSWORD) as ReturnType<typeof captureBackup>;
    assert.ok(!('sessions' in decoded.tables));
    const previewResponse = await importFile(targetBase, targetCookie, 'preview', file);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.summary.keys, 5); assert.equal(preview.summary.login_sessions, 4); assert.equal(target.store.keys().length, 1);
    assert.ok(!JSON.stringify(preview).includes('fixture-refresh-token'));
    const response = await importFile(targetBase, targetCookie, 'restore', file, preview.confirmation_token);
    assert.equal(response.status, 200); assert.equal(target.store.keys().length, 5);
    assert.deepEqual(readFileSync(join(target.directory, 'encryption.key')), oldTargetKey);
    assert.equal((await fetch(`${targetBase}/api/keys`, { headers: { Cookie: targetCookie } })).status, 200);
    assert.equal((await fetch(`${targetBase}/api/keys`, { headers: { Cookie: sourceCookie } })).status, 401);
    assert.equal(target.store.authenticateToken(token.token)?.id, token.id);
    assert.equal(target.store.secret(target.store.key(keys[0].id)!), source.store.secret(source.store.key(keys[0].id)!));
    assert.notEqual(target.store.key(keys[0].id)!.secret, source.store.key(keys[0].id)!.secret);
    assert.equal(target.store.managementSecret('same source note'), 'management-fixture-secret');
    assert.equal(target.store.exaLedger.manualUsage(keys[0].id)!.local_balance!.remaining_usd, remaining);
    assert.deepEqual(target.store.collection(search.collection_id, token.id), source.store.collection(search.collection_id, token.id));
    assert.deepEqual(target.store.tokens()[0].usage, source.store.tokens()[0].usage);
    assert.deepEqual(target.store.all('SELECT rowid,id FROM calls ORDER BY rowid'), source.store.all('SELECT rowid,id FROM calls ORDER BY rowid'));
    const reopened = new Store(target.directory);
    try { assert.equal(reopened.keys().length, 5); assert.equal(reopened.loginTokens(reopened.loginSession(keys[4].id)!).refresh_token, 'fixture-refresh-token'); assert.equal(reopened.exaLedger.manualUsage(keys[0].id)!.local_balance!.remaining_usd, remaining); }
    finally { reopened.close(); }
  } finally { await source.cleanup(); await target.cleanup(); }
});

test('M2: wrong password, corrupt/future/oversized archives and invalid relational/JSON content never alter data', async () => {
  const f = fixture();
  try {
    f.add('tavily'); const initial = captureBackup(f.store), file = await sealBackup(JSON.stringify(initial), PASSWORD);
    await assert.rejects(openBackup(file, 'wrong-backup-password'), /密码不正确/);
    const altered = Buffer.from(file); altered[altered.length - 17] ^= 1;
    await assert.rejects(openBackup(altered, PASSWORD), /密码不正确/);
    await assert.rejects(openBackup(file.subarray(0, 20), PASSWORD), /密码不正确/);
    await assert.rejects(openBackup(Buffer.alloc(MAX_ARCHIVE_BYTES + 1), PASSWORD), /密码不正确/);
    for (const mutate of [
      (v: any) => { v.version = 99; }, (v: any) => { v.tables.sessions = []; },
      (v: any) => { v.tables.credentials[0].secret = 'wrong-secret'; },
      (v: any) => { v.tables.profiles[0].value = 'not-json'; },
      (v: any) => { v.tables.credentials[0].extra_column = 'invalid'; },
      (v: any) => { v.tables.keenable_sessions.push({ rowid: 1, key_id: 'absent', secret: '{}', generation: 'g', version: 'v', expires_at: '', needs_login: 0 }); },
    ]) { const invalid = structuredClone(initial); mutate(invalid); assert.throws(() => validateBackup(f.store, invalid), /密码不正确/); }
    assert.deepEqual(captureBackup(f.store).tables, initial.tables);
  } finally { await f.cleanup(); }
});

test('M2/M3: API auth, stale previews, explicit confirmation and transaction failure preserve target data', async () => {
  const f = fixture();
  try {
    f.add('tavily'); const base = await f.listen(), cookie = await login(base), file = await exportFile(base, cookie);
    assert.equal((await importFile(base, '', 'preview', file)).status, 401);
    const access = f.store.createToken('search only');
    assert.equal((await fetch(`${base}/api/backups/export`, { method: 'POST', headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).status, 401);
    assert.equal((await fetch(`${base}/api/backups/export`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).status, 403);
    assert.equal((await importFile(base, cookie, 'preview', file, undefined, 'incorrect-password')).status, 400);
    const first = await (await importFile(base, cookie, 'preview', file)).json();
    f.add('exa');
    assert.equal((await importFile(base, cookie, 'restore', file, first.confirmation_token)).status, 409);
    assert.equal((await importFile(base, cookie, 'restore', file)).status, 409);
    const initial = captureBackup(f.store).tables;
    f.store.db.exec("CREATE TRIGGER fixture_restore_failure BEFORE INSERT ON credentials BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    const second = await (await importFile(base, cookie, 'preview', file)).json();
    const failed = await importFile(base, cookie, 'restore', file, second.confirmation_token);
    assert.equal(failed.status, 500); assert.ok(!(await failed.text()).includes('fixture failure'));
    assert.deepEqual(captureBackup(f.store).tables, initial); assert.equal(f.store.maintenance, false);
    f.store.db.exec('DROP TRIGGER fixture_restore_failure');
    const third = await (await importFile(base, cookie, 'preview', file)).json();
    assert.equal((await importFile(base, cookie, 'restore', file, third.confirmation_token)).status, 200);
    assert.equal(f.store.keys().length, 1);
  } finally { await f.cleanup(); }
});

test('M3: active search, quota and OAuth block backup; maintenance rejects writes and background work', async () => {
  let release = () => {}, started = () => {};
  let gate = Promise.resolve();
  const f = fixture(async (url, init) => { started(); await gate; return url.includes('/getServiceKeys/') ? accountMock(url, init) : upstream(url, init); });
  try {
    const [key] = f.add('tavily'); f.store.saveProfile({ ...f.store.profile()!, modes: { tavily: 'basic' } });
    const base = await f.listen(), cookie = await login(base);
    for (const action of [() => f.engine.search({ query: 'active' }, caller), () => f.engine.syncUsage(key.id), async () => { const [parallel] = f.add('parallel'); return fetch(`${base}/api/keys/${parallel.id}/parallel-auth`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }); }]) {
      const entered = new Promise<void>(resolve => { started = resolve; });
      gate = new Promise<void>(resolve => { release = resolve; });
      const work = action(); await entered;
      await assert.rejects(f.backups.exclusive(async () => undefined), /正在进行/);
      assert.throws(() => f.retention.preview(0), /正在进行/);
      f.retention.tick(); assert.equal(f.store.settings().history_cleanup, undefined);
      release(); await work;
    }
    await f.backups.exclusive(async () => {
      assert.equal((await fetch(`${base}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(f.store.settings()) })).status, 503);
      await assert.rejects(f.engine.search({ query: 'blocked' }, caller), /正在备份/);
      await assert.rejects(f.engine.syncUsage(key.id), /正在备份/);
      await f.engine.syncDueUsage();
      assert.equal((await fetch(`${base}/health`)).status, 200);
    });
    assert.equal(f.store.maintenance, false);
  } finally { release(); await f.cleanup(); }
});
