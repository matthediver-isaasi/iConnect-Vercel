import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_DEFAULTS,
  BLOCK_TYPES,
  validateBlock,
} from './canvasDesign.js';

test('Member Group Cards has a safe live-data default', () => {
  const defaults = BLOCK_DEFAULTS[BLOCK_TYPES.MEMBER_GROUP_CARDS];
  assert.equal(defaults.name, 'Member Group Cards');
  assert.equal(defaults.content.limit, 6);
  assert.equal(defaults.content.source, 'self_join');
  assert.deepEqual(defaults.content.selectedGroupIds, []);
  assert.equal('groupId' in defaults.content, false);
});

test('Member Group Cards validates source values and a unique bounded selected set', () => {
  assert.deepEqual(validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: { limit: 6, source: 'selected', selectedGroupIds: ['group-a', 'group-b'] },
  }), []);

  const errors = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: { limit: 6, source: 'not-a-source', selectedGroupIds: ['group-a', 'group-a'] },
  });
  assert.ok(errors.includes('Member Group Cards source must be self_join or selected.'));
  assert.ok(errors.includes('Member Group Cards selected groups must be unique.'));

  const emptyIdErrors = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: { limit: 6, source: 'selected', selectedGroupIds: [''] },
  });
  assert.ok(emptyIdErrors.includes('Member Group Cards selected groups must use non-empty IDs.'));
});
test('Member Group Cards validates a bounded card count before publishing', () => {
  assert.deepEqual(validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: { limit: 12 },
  }), []);

  const errors = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: { limit: 24.5 },
  });
  assert.ok(errors.includes('Member Group Cards count must be a whole number from 1 to 24.'));
});