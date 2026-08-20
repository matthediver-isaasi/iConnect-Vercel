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
  assert.equal('groupId' in defaults.content, false);
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