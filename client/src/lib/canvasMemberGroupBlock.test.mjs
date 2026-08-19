import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_DEFAULTS,
  BLOCK_TYPES,
  validateBlock,
} from './canvasDesign.js';

test('Member Group block has safe live-data defaults', () => {
  const defaults = BLOCK_DEFAULTS[BLOCK_TYPES.MEMBER_GROUP];
  assert.equal(defaults.content.groupId, '');
  assert.deepEqual(defaults.content.roleFilter, []);
  assert.equal(defaults.content.showMembers, true);
  assert.equal(defaults.content.showGroupName, true);
  assert.equal(defaults.content.showGroupDescription, true);
  assert.equal(defaults.content.rows, 2);
  assert.deepEqual(defaults.content.columns, { desktop: 3, tablet: 2, mobile: 1 });
  assert.equal('groupName' in defaults.content, false);
  assert.equal('members' in defaults.content, false);
});

test('Member Group block requires a selected group', () => {
  const errors = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP,
    content: BLOCK_DEFAULTS[BLOCK_TYPES.MEMBER_GROUP].content,
  });
  assert.ok(errors.includes('Member Group requires a group.'));
});

test('Member Group block accepts bounded rows, columns, gap, and role filters', () => {
  const errors = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP,
    content: {
      ...BLOCK_DEFAULTS[BLOCK_TYPES.MEMBER_GROUP].content,
      groupId: 'group-1',
      roleFilter: ['Chair', 'Member'],
    },
  });
  assert.deepEqual(errors, []);
});

test('Member Group block rejects grid settings outside publish bounds', () => {
  const errors = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP,
    content: {
      ...BLOCK_DEFAULTS[BLOCK_TYPES.MEMBER_GROUP].content,
      groupId: 'group-1',
      rows: 0,
      columns: { desktop: 7, tablet: 2.5, mobile: 0 },
      gap: 101,
      roleFilter: [''],
    },
  });
  assert.ok(errors.some((error) => error.includes('rows')));
  assert.ok(errors.some((error) => error.includes('desktop columns')));
  assert.ok(errors.some((error) => error.includes('tablet columns')));
  assert.ok(errors.some((error) => error.includes('mobile columns')));
  assert.ok(errors.some((error) => error.includes('gap')));
  assert.ok(errors.some((error) => error.includes('role filters')));
});