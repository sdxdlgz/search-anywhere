import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateKeyLabels } from '../server/key-labels.js';

test('N1/N2: automatic names continue the highest exact prefix, including repeated single imports and gaps', () => {
  assert.deepEqual(allocateKeyLabels('xy', 1, []), ['xy']);
  assert.deepEqual(allocateKeyLabels('xy', 1, ['xy']), ['xy 1']);
  assert.deepEqual(allocateKeyLabels('xy', 2, ['xy', 'xy 1', 'xy 10']), ['xy 11', 'xy 12']);
  assert.deepEqual(allocateKeyLabels('xy', 1, ['xy 1', 'xy 10']), ['xy 11']);
  assert.deepEqual(allocateKeyLabels('xy', 2, ['xyz 50', 'xy 2 note']), ['xy 1', 'xy 2']);
  assert.deepEqual(allocateKeyLabels('xy 2', 2, ['xy 2']), ['xy 2 1', 'xy 2 2']);
});

test('N2: maximum-size batches and 100-character names stay unique and editable across imports', () => {
  const base = '名'.repeat(100), first = allocateKeyLabels(base, 50, []);
  assert.equal(new Set(first).size, 50); assert.ok(first.every(label => label.length === 100));
  const next = allocateKeyLabels(base, 2, first);
  assert.ok(next[0].endsWith(' 51')); assert.ok(next[1].endsWith(' 52'));
  assert.ok(next.every(label => label.length === 100));
});
