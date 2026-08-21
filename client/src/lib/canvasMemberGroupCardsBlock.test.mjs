import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_DEFAULTS,
  BLOCK_TYPES,
  normalizeCanvasDesign,
  validateBlock,
} from './canvasDesign.js';
import {
  buildMemberGroupRoleHolderRequests,
  resolveSelectedMemberGroupRoles,
} from './memberGroupCards.js';

test('Member Group Cards has a safe live-data default', () => {
  const defaults = BLOCK_DEFAULTS[BLOCK_TYPES.MEMBER_GROUP_CARDS];
  assert.equal(defaults.name, 'Member Group Cards');
  assert.equal(defaults.content.limit, 6);
  assert.equal(defaults.content.source, 'self_join');
  assert.deepEqual(defaults.content.selectedGroupIds, []);
  assert.deepEqual(defaults.content.selectedGroupRoles, {});
  assert.equal('groupId' in defaults.content, false);
});

test('Member Group Cards normalizes per-group roles by stable selected group ID', () => {
  assert.deepEqual(
    resolveSelectedMemberGroupRoles(
      { 'group-a': ' Chair ', 'group-b': 'Treasurer', removed: 'Member' },
      ['group-b', 'group-a'],
    ),
    { 'group-b': 'Treasurer', 'group-a': 'Chair' },
  );
  assert.deepEqual(
    resolveSelectedMemberGroupRoles(
      { 'group-a': 'Chair', 'group-b': 'Treasurer' },
      ['group-b'],
    ),
    { 'group-b': 'Treasurer' },
  );

  const normalized = normalizeCanvasDesign({
    root: {
      sections: [{
        id: 'root-section',
        children: [{
          id: 'cards',
          type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
          content: {
            source: 'selected',
            selectedGroupIds: ['group-a', 'group-b', 'group-a'],
            selectedGroupRoles: {
              'group-a': ' Chair ',
              'group-b': '',
              removed: 'Member',
            },
          },
        }],
      }],
    },
  });
  const content = normalized.root.sections[0].children[0].content;
  assert.deepEqual(content.selectedGroupIds, ['group-a', 'group-b']);
  assert.deepEqual(content.selectedGroupRoles, { 'group-a': 'Chair' });
});

test('Member Group Cards validates role settings and builds only bounded available requests', () => {
  assert.deepEqual(validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: {
      limit: 6,
      source: 'selected',
      selectedGroupIds: ['group-a'],
      selectedGroupRoles: { 'group-a': 'Chair' },
    },
  }), []);

  const invalidShape = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: {
      limit: 6,
      source: 'selected',
      selectedGroupIds: ['group-a'],
      selectedGroupRoles: [],
    },
  });
  assert.ok(invalidShape.includes('Member Group Cards selected group roles must be an object.'));

  const orphaned = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: {
      limit: 6,
      source: 'selected',
      selectedGroupIds: ['group-a'],
      selectedGroupRoles: { removed: 'Chair' },
    },
  });
  assert.ok(orphaned.includes('Member Group Cards roles may only be configured for selected groups.'));

  assert.deepEqual(buildMemberGroupRoleHolderRequests(
    [{ id: 'group-a' }, { id: 'group-b', is_active: false }],
    { 'group-a': 'Chair', 'group-b': 'Member', removed: 'Treasurer' },
  ), [{ groupId: 'group-a', role: 'Chair' }]);
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