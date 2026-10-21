import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowMemberFields, preserveWorkflowRoleValue } from './workflowRoleFields.mjs';

const fields = [{ id: 'role_id', label: 'Role ID', type: 'text' }, { id: 'status', type: 'text' }];
test('role dropdown shows names and stores unchanged IDs; other fields untouched', () => {
  const result = workflowMemberFields(fields, [{ id: 'id-z', name: 'Member' }, { id: 'id-a', name: 'Admin' }]);
  assert.deepEqual(result[0], { id: 'role_id', label: 'Role', type: 'dropdown', options: [
    { value: 'id-a', label: 'Admin' }, { value: 'id-z', label: 'Member' },
  ] });
  assert.equal(result[1], fields[1]);
  assert.equal(fields[0].label, 'Role ID');
});

test('saved role IDs survive loading, missing roles, and renamed roles', () => {
  const pending = workflowMemberFields(fields, [])[0];
  assert.equal(pending.type, 'dropdown');
  assert.deepEqual(preserveWorkflowRoleValue(pending, 'saved-id').options, [
    { value: 'saved-id', label: 'Unavailable role (saved selection)' },
  ]);
  const loaded = workflowMemberFields(fields, [{ id: 'saved-id', name: 'Renamed role' }])[0];
  assert.equal(preserveWorkflowRoleValue(loaded, 'saved-id'), loaded);
  assert.equal(preserveWorkflowRoleValue(loaded, '').options.length, 1);
});

test('non-role and custom fields retain original values/options', () => {
  assert.equal(preserveWorkflowRoleValue(fields[1], 'active'), fields[1]);
  assert.equal(preserveWorkflowRoleValue(undefined, 'unknown'), undefined);
});
