import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_HEIGHT_LEAF_TYPES,
  BLOCK_DEFAULTS,
  BLOCK_TYPES,
  normalizeCanvasDesign,
  validateBlock,
} from './canvasDesign.js';
import {
  buildMemberGroupRoleHolderRequests,
  resolveMemberGroupCardColumns,
  resolveSelectedMemberGroupRoles,
} from './memberGroupCards.js';

test('Member Group Cards has a safe live-data default', () => {
  const defaults = BLOCK_DEFAULTS[BLOCK_TYPES.MEMBER_GROUP_CARDS];
  assert.equal(defaults.name, 'Member Group Cards');
  assert.equal(defaults.content.limit, 6);
  assert.equal(defaults.content.source, 'self_join');
  assert.deepEqual(defaults.content.columns, { desktop: 3, tablet: 2, mobile: 1 });
  assert.deepEqual(defaults.content.selectedGroupIds, []);
  assert.deepEqual(defaults.content.selectedGroupRoles, {});
  assert.equal('groupId' in defaults.content, false);
  assert.equal(AUTO_HEIGHT_LEAF_TYPES.has(BLOCK_TYPES.MEMBER_GROUP_CARDS), true);
});

test('Member Group Cards resolves legacy and partial column settings to the established layout', () => {
  assert.deepEqual(
    resolveMemberGroupCardColumns(undefined),
    { desktop: 3, tablet: 2, mobile: 1 },
  );
  assert.deepEqual(
    resolveMemberGroupCardColumns({ desktop: 5 }),
    { desktop: 5, tablet: 2, mobile: 1 },
  );

  const normalized = normalizeCanvasDesign({
    root: {
      sections: [{
        id: 'root-section',
        children: [{
          id: 'legacy-cards',
          type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
          content: { limit: 6 },
        }],
      }],
    },
  });
  assert.deepEqual(
    normalized.root.sections[0].children[0].content.columns,
    { desktop: 3, tablet: 2, mobile: 1 },
  );
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

test('Member Group Cards validates complete bounded responsive column settings', () => {
  assert.deepEqual(validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: {
      limit: 6,
      columns: { desktop: 6, tablet: 3, mobile: 2 },
    },
  }), []);

  const errors = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: {
      limit: 6,
      columns: { desktop: 7, tablet: 2.5, mobile: 0 },
    },
  });
  assert.ok(errors.some((error) => error.includes('desktop columns')));
  assert.ok(errors.some((error) => error.includes('tablet columns')));
  assert.ok(errors.some((error) => error.includes('mobile columns')));

  const incomplete = validateBlock({
    type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
    content: {
      limit: 6,
      columns: { desktop: 3 },
    },
  });
  assert.ok(incomplete.some((error) => error.includes('tablet columns')));
  assert.ok(incomplete.some((error) => error.includes('mobile columns')));

  for (const invalidValue of [true, [2], null, '2']) {
    const typeErrors = validateBlock({
      type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
      content: {
        limit: 6,
        columns: { desktop: invalidValue, tablet: 2, mobile: 1 },
      },
    });
    assert.ok(
      typeErrors.some((error) => error.includes('desktop columns')),
      `expected ${JSON.stringify(invalidValue)} to be rejected`,
    );
  }
});