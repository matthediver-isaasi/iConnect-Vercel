import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeAnswerDrivenMemberRoleWrite,
  formRoleFieldOptions,
  isFormRoleMappingField,
  resolveMemberRoleAssignment,
  validateFormMemberRoleAssignments,
} from './formMemberRoleAssignment.js';

const pipeline = (overrides = {}) => ({
  label: 'Primary Member',
  role_assignment: {
    mode: 'from_field',
    source_field_id: 'membership-type',
    value_to_role_id: { Student: 'role-student', Professional: 'role-pro' },
    fallback: 'default',
    ...overrides,
  },
});

const fakeSupabase = (tenantRoleIds) => ({
  from(table) {
    assert.equal(table, 'role');
    return {
      select() {
        return {
          eq(column, tenantId) {
            assert.equal(column, 'tenant_id');
            assert.equal(tenantId, 'tenant-1');
            return {
              async in(inColumn, ids) {
                assert.equal(inColumn, 'id');
                return {
                  data: ids.filter((id) => tenantRoleIds.includes(id)).map((id) => ({ id })),
                  error: null,
                };
              },
            };
          },
        };
      },
    };
  },
});

test('only scalar dropdown/radio fields expose role mapping options', () => {
  assert.deepEqual(formRoleFieldOptions({ type: 'select', options: ['Student', { value: 'pro', label: 'Professional' }] }), [
    { value: 'Student', label: 'Student' },
    { value: 'pro', label: 'Professional' },
  ]);
  assert.equal(isFormRoleMappingField({ type: 'radio', options: ['Yes'] }), true);
  assert.equal(isFormRoleMappingField({ type: 'checkbox', options: ['A'] }), false);
});

test('resolves only persisted answer mappings and never treats an answer as a role id', () => {
  assert.deepEqual(
    resolveMemberRoleAssignment({ pipeline: pipeline(), answers: { 'membership-type': 'Student' } }),
    { configured: true, roleId: 'role-student', source: 'field-mapped', answer: 'Student' },
  );
  assert.deepEqual(
    resolveMemberRoleAssignment({ pipeline: pipeline(), answers: { 'membership-type': 'attacker-role-id' } }),
    { configured: true, roleId: undefined, source: 'field-fallback-default' },
  );
});

test('supports explicit no-role and fixed-role fallbacks', () => {
  assert.deepEqual(
    resolveMemberRoleAssignment({
      pipeline: pipeline({ fallback: 'none' }),
      answers: {},
    }),
    { configured: true, roleId: null, source: 'field-fallback-none' },
  );
  assert.deepEqual(
    resolveMemberRoleAssignment({
      pipeline: pipeline({ fallback: 'fixed', fallback_role_id: 'role-fallback' }),
      answers: {},
    }),
    { configured: true, roleId: 'role-fallback', source: 'field-fallback-fixed' },
  );
});

test('rejects multi-value answers rather than selecting an arbitrary role', () => {
  const result = resolveMemberRoleAssignment({
    pipeline: pipeline(),
    answers: { 'membership-type': ['Student', 'Professional'] },
  });
  assert.equal(result.invalid, true);
  assert.equal(result.code, 'INVALID_MEMBER_ROLE_ANSWER');
});

test('validates mapped and fallback roles against the form tenant', async () => {
  const valid = await validateFormMemberRoleAssignments({
    supabase: fakeSupabase(['role-student', 'role-fallback']),
    tenantId: 'tenant-1',
    fields: [{ id: 'membership-type', type: 'select', options: ['Student', 'Professional'] }],
    entityPipelines: {
      members: [pipeline({
        value_to_role_id: { Student: 'role-student' },
        fallback: 'fixed',
        fallback_role_id: 'role-fallback',
      })],
    },
  });
  assert.deepEqual(valid, { ok: true });

  const invalid = await validateFormMemberRoleAssignments({
    supabase: fakeSupabase(['role-student']),
    tenantId: 'tenant-1',
    fields: [{ id: 'membership-type', type: 'select', options: ['Student'] }],
    entityPipelines: {
      members: [pipeline({
        value_to_role_id: { Student: 'role-other-tenant' },
      })],
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_MEMBER_ROLE_ASSIGNMENT');
  assert.deepEqual(invalid.details.invalid_role_ids, ['role-other-tenant']);
});

test('rejects stale source fields and stale answer options', async () => {
  const missingField = await validateFormMemberRoleAssignments({
    supabase: fakeSupabase([]),
    tenantId: 'tenant-1',
    fields: [],
    entityPipelines: { members: [pipeline()] },
  });
  assert.equal(missingField.ok, false);

  const staleOption = await validateFormMemberRoleAssignments({
    supabase: fakeSupabase(['role-student']),
    tenantId: 'tenant-1',
    fields: [{ id: 'membership-type', type: 'radio', options: ['Student'] }],
    entityPipelines: {
      members: [pipeline({ value_to_role_id: { Removed: 'role-student' } })],
    },
  });
  assert.equal(staleOption.ok, false);
  assert.match(staleOption.error, /no longer available/);
});

test('answer-driven configuration requires role-assignment authority', async () => {
  const entityPipelines = { members: [pipeline()] };
  const denied = await authorizeAnswerDrivenMemberRoleWrite({
    entityPipelines,
    tenantCtx: { isAuthenticated: true, tenantId: 'tenant-1', roleId: 'ordinary-role' },
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
  });
  assert.deepEqual(denied, {
    ok: false,
    status: 403,
    error: 'Member Role Assignment access required',
  });

  const delegated = await authorizeAnswerDrivenMemberRoleWrite({
    entityPipelines,
    tenantCtx: { isAuthenticated: true, tenantId: 'tenant-1', roleId: 'form-admin-role' },
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (_roleId, feature) => feature === 'admin.member-role-assignment',
  });
  assert.deepEqual(delegated, { ok: true });

  const legacyFixed = await authorizeAnswerDrivenMemberRoleWrite({
    entityPipelines: { members: [{ role_id: 'role-1' }] },
    tenantCtx: null,
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
  });
  assert.deepEqual(legacyFixed, { ok: true });
});

test('answer-driven assignment ignores inert fixed and fallback settings without mutating them', async () => {
  const member = {
    ...pipeline({ fallback_role_id: 'deleted-fallback' }),
    role_id: 'deleted-fixed',
  };
  const original = structuredClone(member);
  const result = await validateFormMemberRoleAssignments({
    supabase: fakeSupabase(['role-student', 'role-pro']),
    tenantId: 'tenant-1',
    fields: [{ id: 'membership-type', type: 'select', options: ['Student', 'Professional'] }],
    entityPipelines: { members: [member] },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(member, original);
  assert.equal(resolveMemberRoleAssignment({ pipeline: member }).roleId, undefined);
});

test('unavailable active roles identify every pipeline and setting without foreign role metadata', async () => {
  const result = await validateFormMemberRoleAssignments({
    supabase: fakeSupabase([]),
    tenantId: 'tenant-1',
    fields: [{ id: 'membership-type', type: 'radio', options: ['Student'] }],
    entityPipelines: { members: [
      { label: 'Fixed member', role_id: 'missing' },
      pipeline({ value_to_role_id: { Student: 'missing' }, fallback: 'fixed', fallback_role_id: 'foreign' }),
    ] },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.details.invalid_role_settings, [
    { pipeline_index: 0, pipeline_label: 'Fixed member', setting: 'role_id', role_id: 'missing' },
    { pipeline_index: 1, pipeline_label: 'Primary Member', setting: 'role_assignment.value_to_role_id', role_id: 'missing', answer: 'Student' },
    { pipeline_index: 1, pipeline_label: 'Primary Member', setting: 'role_assignment.fallback_role_id', role_id: 'foreign' },
  ]);
  assert.match(result.error, /Fixed member: fixed role/);
  assert.match(result.error, /Primary Member: role for answer "Student"/);
  assert.match(result.error, /Primary Member: fallback role/);
});

test('role lookup failures fail closed', async () => {
  const failure = new Error('Lookup unavailable');
  await assert.rejects(validateFormMemberRoleAssignments({
    supabase: { from() { throw failure; } },
    tenantId: 'tenant-1',
    entityPipelines: { members: [{ role_id: 'role-1' }] },
  }), failure);
});