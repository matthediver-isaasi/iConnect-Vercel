import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterFormCommunicationCategories, formCommunicationCreationRole } from './formCommunicationCategoryEligibility.js';
import { initializeCommunicationPreferenceDefaults } from './formCommunicationPreferenceDefaults.js';

const categories = [
  { id: 'public-role', is_public: true, member_enabled: false, role_ids: ['graduate'] },
  { id: 'public-member-role', is_public: true, member_enabled: true, role_ids: ['graduate'] },
  { id: 'private', is_public: false, member_enabled: true, role_ids: [] },
  { id: 'public-general', is_public: true, member_enabled: true, role_ids: [] },
];

test('anonymous visitors see only public categories, even when role-scoped or member-disabled', () => {
  assert.deepEqual(filterFormCommunicationCategories(categories, { memberContext: false }).map(c => c.id),
    ['public-role', 'public-member-role', 'public-general']);
  assert.deepEqual(filterFormCommunicationCategories(categories, {
    memberContext: false, allowedIds: ['public-role', 'private'],
  }).map(c => c.id), ['public-role']);
});

test('member creation and existing members enforce member enabled and assigned role, including roleless creation', () => {
  assert.deepEqual(filterFormCommunicationCategories(categories, {
    memberContext: true, roleId: 'graduate',
  }).map(c => c.id), ['public-member-role', 'private', 'public-general']);
  assert.deepEqual(filterFormCommunicationCategories(categories, {
    memberContext: true, roleId: null,
  }).map(c => c.id), ['private', 'public-general']);
  assert.deepEqual(filterFormCommunicationCategories(categories, {
    memberContext: true, roleId: 'other',
  }).map(c => c.id), ['private', 'public-general']);
});

test('answer-mapped member role cannot fall back to stale fixed role while unresolved', () => {
  const pipeline = {
    role_id: 'stale-role',
    role_assignment: {
      mode: 'from_field', source_field_id: 'choice',
      value_to_role_id: { Graduate: 'graduate' }, fallback: 'none',
    },
  };
  assert.equal(formCommunicationCreationRole(pipeline, {}), null);
  assert.equal(formCommunicationCreationRole(pipeline, { choice: 'Graduate' }), 'graduate');
  assert.equal(formCommunicationCreationRole(pipeline, { choice: 'attacker' }), null);
  assert.equal(formCommunicationCreationRole({ role_id: 'fixed' }), 'fixed');
  assert.equal(formCommunicationCreationRole({ ...pipeline, role_assignment: {
    ...pipeline.role_assignment, fallback: 'fixed', fallback_role_id: 'safe-fallback',
  } }), 'safe-fallback');
});

test('defaults only select eligible categories', () => {
  const eligible = filterFormCommunicationCategories(categories, { memberContext: false });
  assert.deepEqual(initializeCommunicationPreferenceDefaults({
    value: {}, categories: eligible, defaultSelectedCategoryIds: ['public-role', 'private'],
  }), { 'public-role': true, 'public-member-role': false, 'public-general': false });
});

test('renderer defers mutations on unresolved or failed category/eligibility loads and offers retry', () => {
  const source = readFileSync(new URL('../components/forms/FormRenderer.jsx', import.meta.url), 'utf8');
  const field = source.match(/function CommunicationPreferencesField[\s\S]*?export default function FormRenderer/)?.[0] || '';
  assert.match(field, /!communicationEligibilityReady \|\| initializedDefaults\.current \|\| isFetching \|\| isError \|\| !Array\.isArray\(allCategories\)/);
  assert.match(field, /!communicationEligibilityReady \|\| isFetching \|\| isError \|\| !Array\.isArray\(allCategories\)/);
  assert.match(field, /Could not load communication preferences:[\s\S]*?refetch\(\)/);
  assert.match(field, /Could not load member eligibility:[\s\S]*?communicationEligibilityError\.retry\(\)/);
});

test('form view propagates explicit member-creation and failure contexts to all renderers', () => {
  const source = readFileSync(new URL('../pages/FormView.jsx', import.meta.url), 'utf8');
  assert.match(source, /form\?\.entity_pipelines\?\.members\?\.length/);
  assert.match(source, /!memberRecordError && !prefillMemberError/);
  assert.equal((source.match(/communicationMemberContext=\{communicationMemberContext\}/g) || []).length, 4);
  assert.equal((source.match(/communicationEligibilityError=\{communicationEligibilityError\}/g) || []).length, 4);
  assert.match(source, /prefillMember\?\.role_id \|\| memberData\?\.role_id \|\| communicationCreationRoleId/);
});