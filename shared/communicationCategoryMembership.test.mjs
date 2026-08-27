import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCommunicationCategoryAudienceMode,
  filterCommunicationCategoriesForMember,
  getCommunicationCategoryAudienceMode,
  isMemberEligibleForCommunicationCategory,
} from './communicationCategoryMembership.js';

const categories = [
  { id: 'open', name: 'Open' },
  { id: 'role-a', name: 'Role A' },
  { id: 'role-b', name: 'Role B' },
  { id: 'public-only', name: 'Public only', is_public: true, member_enabled: false },
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

test('public-only categories are excluded before member roles are evaluated', () => {
  assert.equal(
    isMemberEligibleForCommunicationCategory(
      { role_id: 'a' },
      [],
      { is_public: true, member_enabled: false },
    ),
    false,
  );
  assert.deepEqual(
    filterCommunicationCategoriesForMember(categories, assignments, { role_id: 'a' }).map(({ id }) => id),
    ['open', 'role-a'],
  );
});

test('missing member_enabled remains backward-compatible member access', () => {
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: null }, [], { is_public: false }), true);
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: null }, [], { is_public: true }), true);
});

test('all audience modes map to access flags without discarding configured roles', () => {
  const configured = { selectedRoles: ['role-a'], is_public: true, member_enabled: true };
  const membersOnly = applyCommunicationCategoryAudienceMode(configured, 'members_only');
  const publicOnly = applyCommunicationCategoryAudienceMode(configured, 'public_only');
  const both = applyCommunicationCategoryAudienceMode(configured, 'public_and_members');

  assert.deepEqual(
    [getCommunicationCategoryAudienceMode(membersOnly), membersOnly.is_public, membersOnly.member_enabled],
    ['members_only', false, true],
  );
  assert.deepEqual(
    [getCommunicationCategoryAudienceMode(publicOnly), publicOnly.is_public, publicOnly.member_enabled],
    ['public_only', true, false],
  );
  assert.deepEqual(
    [getCommunicationCategoryAudienceMode(both), both.is_public, both.member_enabled],
    ['public_and_members', true, true],
  );
  assert.deepEqual(publicOnly.selectedRoles, ['role-a']);
});

test('roleless categories are available to members with or without an assigned role', () => {
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: null }, []), true);
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: 'a' }, []), true);
});

test('member role arrays match when any assigned role is applicable', () => {
  assert.equal(isMemberEligibleForCommunicationCategory({ role_id: ['a', 'b'] }, ['b']), true);
});