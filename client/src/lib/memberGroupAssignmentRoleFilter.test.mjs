import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignmentMatchesRole,
  buildAssignmentRoleOptions,
} from './memberGroupAssignmentRoleFilter.mjs';

test('buildAssignmentRoleOptions removes blank and duplicate roles and sorts them', () => {
  const assignments = [
    { group_role: 'Treasurer' },
    { group_role: '' },
    { group_role: '  chair  ' },
    { group_role: null },
    { group_role: 'Member' },
    { group_role: 'CHAIR' },
    { group_role: 'Vice   Chair' },
    { group_role: 'all' },
  ];

  assert.deepEqual(buildAssignmentRoleOptions(assignments), [
    'all',
    'chair',
    'Member',
    'Treasurer',
    'Vice Chair',
  ]);
});

test('buildAssignmentRoleOptions is stable when assignments arrive in a different order', () => {
  const roles = [
    { group_role: 'Member 10' },
    { group_role: 'Member 2' },
    { group_role: 'Chair' },
    { group_role: 'CHAIR' },
  ];

  assert.deepEqual(
    buildAssignmentRoleOptions(roles),
    buildAssignmentRoleOptions([...roles].reverse()),
  );
});

test('assignmentMatchesRole supports role-only and combined report filtering', () => {
  const assignments = [
    { group_role: 'Chair', group_id: 'group-a', expiryStatus: 'active', memberName: 'Alex' },
    { group_role: 'Member', group_id: 'group-a', expiryStatus: 'active', memberName: 'Bailey' },
    { group_role: ' chair ', group_id: 'group-b', expiryStatus: 'expired', memberName: 'Casey' },
    { group_role: null, group_id: 'group-a', expiryStatus: 'active', memberName: 'Dana' },
  ];

  assert.deepEqual(
    assignments.filter(assignment => assignmentMatchesRole(assignment, 'Chair')),
    [assignments[0], assignments[2]],
  );

  assert.deepEqual(
    assignments.filter(assignment =>
      assignmentMatchesRole(assignment, 'Chair')
      && assignment.group_id === 'group-a'
      && assignment.expiryStatus === 'active'
      && assignment.memberName.toLowerCase().includes('alex')
    ),
    [assignments[0]],
  );
});

test('assignmentMatchesRole can filter a stored role named all', () => {
  const assignments = [
    { group_role: 'all' },
    { group_role: 'Chair' },
    { group_role: ' ALL ' },
  ];

  assert.deepEqual(
    assignments.filter(assignment => assignmentMatchesRole(assignment, 'all')),
    [assignments[0], assignments[2]],
  );
  assert.deepEqual(
    assignments.filter(assignment => assignmentMatchesRole(assignment, null)),
    assignments,
  );
});