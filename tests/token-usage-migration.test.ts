import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { Store } from '../server/store.js';
import { backupSummary, captureBackup, restoreBackup, validateBackup } from '../server/backup-data.js';
import { Retention } from '../server/retention.js';

test('D2: startup and old-backup restore remove disabled credentials while preserving active rows and historical accounting', async () => {
  const source = fixture(), target = fixture();
  try {
    source.add('exa'); source.store.saveProfile({ ...source.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const removed = source.store.createToken('legacy revoked'), active = source.store.createToken('active'), inactive = source.store.createToken('legacy null');
    await source.engine.search({ query: 'retained deleted-owner history' }, removed);
    source.store.run('UPDATE client_tokens SET enabled=0 WHERE id=?', removed.id);
    source.store.run('UPDATE client_tokens SET enabled=NULL WHERE id=?', inactive.id);
    const legacy = captureBackup(source.store), dashboard = source.store.dashboard();
    const expected = { ...legacy.tables, client_tokens: legacy.tables.client_tokens.filter(t => t.id === active.id) };
    const imported = validateBackup(target.store, legacy);
    assert.equal(backupSummary(imported).access_tokens, 1);
    restoreBackup(target.store, imported);
    assert.deepEqual(captureBackup(target.store).tables, expected);
    assert.equal(target.store.authenticateToken(removed.token), undefined);
    assert.deepEqual(target.store.dashboard(), dashboard);
    for (let pass = 0; pass < 2; pass++) {
      const reopened = new Store(source.directory);
      try {
        assert.deepEqual(captureBackup(reopened).tables, expected);
        assert.equal(reopened.authenticateToken(removed.token), undefined);
        assert.equal(reopened.authenticateToken(inactive.token), undefined);
      } finally { reopened.close(); }
    }
    restoreBackup(target.store, validateBackup(target.store, captureBackup(source.store)));
    assert.deepEqual(captureBackup(target.store).tables, expected);
    assert.equal(target.store.authenticateToken(active.token)?.id, active.id);
    source.store.run('UPDATE client_tokens SET enabled=0');
    const allRevoked = validateBackup(target.store, captureBackup(source.store));
    assert.equal(backupSummary(allRevoked).access_tokens, 0);
    restoreBackup(target.store, allRevoked);
    assert.deepEqual(target.store.tokens(), []);
    assert.deepEqual(target.store.dashboard(), dashboard);
    for (let pass = 0; pass < 2; pass++) {
      const reopened = new Store(source.directory);
      try { assert.deepEqual(reopened.tokens(), []); assert.deepEqual(reopened.dashboard(), dashboard); }
      finally { reopened.close(); }
    }
  } finally { await source.cleanup(); await target.cleanup(); }
});

test('T3/T4: clean-up and backup restore preserve client statistics and manual balance rowids', async () => {
  const source = fixture(), target = fixture();
  try {
    const [key] = source.add('exa'), token = source.store.createToken('retained client');
    source.store.saveProfile({ ...source.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    source.store.run("INSERT INTO calls(rowid,id,status) VALUES(99,'gap','success')");
    source.store.exaLedger.configure(key.id, { mode: 'manual', balance_usd: 20 }); source.store.run("DELETE FROM calls WHERE id='gap'");
    const search = await source.engine.search({ query: 'private search' }, token);
    await source.engine.search({ query: 'private search' }, token);
    const before = source.store.tokens(), balance = source.store.exaLedger.manualUsage(key.id)!.local_balance;
    const retention = new Retention(source.store, source.engine, { busy: false }, () => Date.now() + 1000);
    const { cutoff, expires_at, confirmation_token } = retention.preview(0); retention.confirm({ cutoff, expires_at, confirmation_token });
    assert.equal(source.store.logs().length, 0); assert.equal(source.store.collection(search.collection_id, token.id), undefined);
    assert.deepEqual(source.store.tokens(), before);
    restoreBackup(target.store, validateBackup(target.store, captureBackup(source.store)));
    assert.deepEqual(target.store.tokens(), before); assert.deepEqual(target.store.exaLedger.manualUsage(key.id)!.local_balance, balance);
    assert.deepEqual(target.store.all('SELECT rowid,id FROM calls'), source.store.all('SELECT rowid,id FROM calls'));
    assert.equal(target.store.authenticateToken(token.token)?.id, token.id);
  } finally { await source.cleanup(); await target.cleanup(); }
});

test('T3/T4: old databases and old exports recover only authoritative collection owners, never matching names', async () => {
  const source = fixture(), target = fixture();
  try {
    source.add('exa'); source.store.saveProfile({ ...source.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const a = source.store.createToken('duplicate'), b = source.store.createToken('duplicate');
    const first = await source.engine.search({ query: 'legacy owned search' }, a);
    const cached = await source.engine.search({ query: 'legacy owned search' }, a);
    const failure = source.store.beginRequest(a.name, 'search', 'old failed search', 'balanced'); source.store.finishRequest(failure, 'error', 1);
    const legacy = captureBackup(source.store);
    for (const row of legacy.tables.requests) delete row.caller_id;
    restoreBackup(target.store, validateBackup(target.store, legacy));
    for (const id of [cached.request_id, failure]) assert.equal(target.store.get<{ caller_id: string | null }>('SELECT caller_id FROM requests WHERE id=?', id)!.caller_id, null);
    assert.equal(target.store.get<{ caller_id: string }>('SELECT caller_id FROM requests WHERE id=?', first.request_id)!.caller_id, a.id);
    assert.equal(target.store.tokens().find(t => t.id === a.id)!.usage!.lifetime.requests, 1); assert.equal(target.store.tokens().find(t => t.id === b.id)!.usage!.lifetime.requests, 0);
    source.store.db.exec('DROP INDEX requests_caller_time; ALTER TABLE requests DROP COLUMN caller_id');
    const reopened = new Store(source.directory);
    try {
      assert.deepEqual(reopened.tokens(), target.store.tokens());
      assert.deepEqual(reopened.all('SELECT rowid,id FROM calls'), target.store.all('SELECT rowid,id FROM calls'));
    } finally { reopened.close(); }
  } finally { await source.cleanup(); await target.cleanup(); }
});

test('T4: malformed or contradictory caller attribution is rejected without mutating the target', async () => {
  const f = fixture();
  try {
    f.add('exa'); f.store.saveProfile({ ...f.store.profile()!, modes: { exa: 'auto', parallel: null, tavily: null } });
    const token = f.store.createToken('owner'); await f.engine.search({ query: 'validated attribution' }, token);
    const original = captureBackup(f.store);
    for (const value of [123, '', 'wrong-owner', 'x'.repeat(129)]) {
      const bad = structuredClone(original); bad.tables.requests[0].caller_id = value;
      assert.throws(() => validateBackup(f.store, bad));
    }
    const extra = structuredClone(original); extra.tables.requests[0].unexpected = 'not allowed'; assert.throws(() => validateBackup(f.store, extra));
    assert.deepEqual(captureBackup(f.store).tables, original.tables);
  } finally { await f.cleanup(); }
});
