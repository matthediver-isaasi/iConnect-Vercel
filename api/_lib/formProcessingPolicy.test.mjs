import test from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePersistedFormRole,
  resolveFormProcessingPrefillTargets,
} from './formProcessingPolicy.js';

test('conditional role is derived only from rules matched by persisted answers', () => {
  const rules = [{
    conditions: [{ field_id: 'kind', operator: 'equals', value: 'eligible' }],
    actions: [{ action_type: 'set_role', role_id: 'privileged-role' }],
  }];
  assert.equal(derivePersistedFormRole({
    defaultRoleId: 'default-role',
    visibilityRules: rules,
    answers: { kind: 'ordinary' },
  }), 'default-role');
  assert.equal(derivePersistedFormRole({
    defaultRoleId: 'default-role',
    visibilityRules: rules,
    answers: { kind: 'eligible' },
  }), 'privileged-role');
});

test('non-admin processing can target only the submitter and their own organisation', () => {
  assert.deepEqual(resolveFormProcessingPrefillTargets({
    isAdmin: false,
    submitterMember: { id: 'member-1', organization_id: 'own-org' },
    persistedSubmission: { organization_id: 'attacker-selected-org' },
    requestedOrganizationId: 'other-org',
  }), { memberId: 'member-1', organizationId: 'own-org' });
});