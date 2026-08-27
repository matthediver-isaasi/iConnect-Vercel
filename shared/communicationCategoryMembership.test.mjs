import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterCommunicationCategoriesForMember,
  isMemberEligibleForCommunicationCategory,
} from './communicationCategoryMembership.js';

const categories = [
  { id: 'open', name: 'Open' },
  { id: 'role-a', name: 'Role A' },
  { id: 'role-b', name: 'Role B' },
];
const assignments = [
  { category_id: 'role-a', role_id: 'a' },
  { category_id: 'role-b', role_id: 'b' },
];

test('a member can access categories with no role assignments and matching assignments', () => {
  assert.deepEqual(
    filterCommunicationCategoriesForMember(categories, assignments, { role_id: 'a' }).map(({ id }) => id),
    ['open', 'role-a'],
  );
});

test('public status does not affect member role eligibility', () => {
  assert.equal(
    isMemberEligibleForCommunicationCategory(
      { role_id: 'a' },
      ['b'],
    ),
    false,
  );
});

test('roleless categories are available to members with or without an assigned role', () => {
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: null }, []), true);
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: 'a' }, []), true);
});

test('member role arrays match when any assigned role is applicable', () => {
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: ['a', 'b'] }, ['b']), true);
});