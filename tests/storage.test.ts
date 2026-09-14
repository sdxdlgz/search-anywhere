import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { fixture } from './helpers.js';

test('R1/R11: encrypted keys, masked APIs, account edits and persistent profiles survive restart', async () => {
  const f = fixture();
  try {
    const plaintext = 'exa-private-secret-abcdef123456';
    const [k] = f.add('exa', 'original@example.com', [plaintext]);
    assert.equal(k.masked, 'exa-••••••••3456');
    assert.equal(k.account, 'original@example.com');
    assert.ok(!JSON.stringify(f.store.keys()).includes(plaintext));
    assert.ok(!JSON.stringify(f.store.all('SELECT * FROM credentials')).includes(plaintext));
    f.store.updateKey(k.id, { label: 'renamed', account: 'new@example.com', enabled: false, max_concurrency: 3, exa_key_id: '' });
    const second = new Store(f.directory);
    assert.equal(second.keys()[0].state, 'disabled');
    assert.equal(second.keys()[0].account, 'new@example.com');
    assert.equal(second.secret(second.key(k.id)!), plaintext);
    assert.equal(second.profiles().length, 4);
    second.close();
    assert.ok(!readFileSync(join(f.directory, 'gateway.sqlite')).includes(Buffer.from(plaintext)));
  } finally { await f.cleanup(); }
});
test('R1: duplicate batch is atomic and duplicate secrets rejected by supplier', async () => {
  const f = fixture();
  try {
    f.add('exa', 'account', ['existing-secret-0123456789']);
    assert.throws(() => f.add('exa', 'account', ['new-secret-0123456789', 'existing-secret-0123456789']));
    assert.equal(f.store.keys().length, 1);
    f.add('tavily', 'account', ['existing-secret-0123456789']);
    assert.equal(f.store.keys().length, 2);
  } finally { await f.cleanup(); }
});
test('R2: round robin, supplier isolation, disabled/cooling/busy exclusion and recovery', async () => {
  const f = fixture();
  try {
    const keys = f.add('exa', 'account', ['first-secret-0123456', 'second-secret-0123456', 'third-secret-0123456']);
    f.add('tavily');
    const selections: string[] = [];
    for (let i = 0; i < 6; i++) { const key = f.store.reserve('exa')!; selections.push(key.id); f.store.release(key.id); }
    assert.deepEqual(selections.slice(0, 3), selections.slice(3));
    assert.equal(new Set(selections).size, 3);
    f.store.setKeyState(keys[0].id, 'cooldown', 'limited', new Date(Date.now() + 60000).toISOString());
    f.store.setKeyState(keys[1].id, 'invalid', 'invalid', null);
    const a = f.store.reserve('exa')!, b = f.store.reserve('exa')!;
    assert.equal(a.id, keys[2].id); assert.equal(b.id, keys[2].id); assert.equal(f.store.reserve('exa'), undefined);
    f.store.release(a.id); f.store.release(b.id);
    f.store.setKeyState(keys[0].id, 'cooldown', 'limited', new Date(Date.now() - 100).toISOString());
    const recovered = f.store.reserve('exa', [keys[2].id])!;
    assert.equal(recovered.id, keys[0].id); f.store.release(recovered.id);
  } finally { await f.cleanup(); }
});
test('R11: missing encryption material never silently resets an existing database', async () => {
  const f = fixture();
  try {
    renameSync(join(f.directory, 'encryption.key'), join(f.directory, 'saved.key'));
    assert.throws(() => new Store(f.directory), /加密密钥缺失/);
    renameSync(join(f.directory, 'saved.key'), join(f.directory, 'encryption.key'));
  } finally { await f.cleanup(); }
});
