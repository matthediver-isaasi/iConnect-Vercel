import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectMemberOrganizationGroupAssignments,
  isOrganisationGroupDropdownField,
  resolveMemberOrganizationGroupSelection,
  validateMemberOrganizationGroupAssignments,
  validateMemberOrganizationGroupWrite,
  MemberOrganizationGroupValidationError,
} from './formMemberOrganizationGroup.js';

function fakeDb({ groups = [], organizations = [], members = [] } = {}) {
  return {
    from(table) {
      const filters = [];
      let rows = table === 'organization_group'
        ? groups
        : table === 'organization'
          ? organizations
          : members;
      const query = {
        select() { return query; },
        eq(column, value) {
          filters.push([column, value]);
          return query;
        },
        ilike(column, value) {
          filters.push([column, value, 'ilike']);
          return query;
        },
        limit() { return query; },
        maybeSingle() {
          const row = rows.find(candidate => filters.every(([column, value, mode]) =>
            mode === 'ilike'
              ? String(candidate[column] || '').toLowerCase() === String(value).toLowerCase()
              : String(candidate[column]) === String(value)));
          return Promise.resolve({ data: row || null, error: null });
        },
      };
      return query;
    },
  };
}

test('member group selections require a persisted group dropdown and one existing-style value', () => {
  assert.equal(isOrganisationGroupDropdownField({ type: 'organisation_group_dropdown' }), true);
  assert.deepEqual(resolveMemberOrganizationGroupSelection({
    field: { id: 'group', type: 'organisation_group_dropdown' },
    sourceFieldId: 'group',
    value: 'group-a',
  }), {
    groupId: 'group-a',
    organizationGroupId: 'group-a',
    sourceFieldId: 'group',
  });
  assert.equal(resolveMemberOrganizationGroupSelection({
    field: { id: 'group', type: 'organisation_group_dropdown' },
    sourceFieldId: 'group',
    value: '',
  }), null);
  assert.throws(() => resolveMemberOrganizationGroupSelection({
    field: { id: 'group', type: 'text' },
    sourceFieldId: 'group',
    value: 'group-a',
  }), error => error.code === 'INVALID_MEMBER_ORGANIZATION_GROUP');
  assert.throws(() => resolveMemberOrganizationGroupSelection({
    field: { id: 'group', type: 'organisation_group_dropdown' },
    sourceFieldId: 'group',
    value: '__form_not_listed__',
  }), MemberOrganizationGroupValidationError);
});

test('collection is configuration-driven and hidden answers preserve existing assignment', () => {
  const fields = [
    { id: 'group', type: 'organisation_group_dropdown' },
    { id: 'name', type: 'text', core_field_mapping: 'member.email' },
  ];
  const mappings = [{
    source_type: 'field',
    source_field_id: 'group',
    target_type: 'core',
    target_entity: 'member',
    target_field: 'organization_group_id',
  }];
  assert.equal(collectMemberOrganizationGroupAssignments({
    fields,
    fieldMappings: mappings,
    formValues: { group: 'group-a' },
  }).length, 1);
  assert.equal(collectMemberOrganizationGroupAssignments({
    fields,
    fieldMappings: mappings,
    formValues: { group: 'forged' },
    hiddenFieldIds: new Set(['group']),
  }).length, 0);
  assert.equal(collectMemberOrganizationGroupAssignments({
    fields,
    fieldMappings: [{
      ...mappings[0],
      target_entity: 'organization',
    }],
    formValues: { group: 'group-a' },
  }).length, 0);
});

test('pipeline mappings without target metadata retain their member owner', () => {
  const fields = [{ id: 'group', type: 'organisation_group_dropdown' }];
  const assignments = collectMemberOrganizationGroupAssignments({
    fields,
    entityPipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'group',
          target_type: 'core',
          target_field: 'organization_group_id',
        }],
      }],
      organisations: [],
    },
    formValues: { group: 'group-a' },
  });
  assert.equal(assignments.length, 1);
  assert.equal(collectMemberOrganizationGroupAssignments({
    fields,
    entityPipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'group',
          target_type: 'core',
          target_entity: 'organization',
          target_field: 'organization_group_id',
        }],
      }],
      organisations: [],
    },
    formValues: { group: 'group-a' },
  }).length, 0);
});

test('unrelated member dropdown answers do not select the primary assignment target', () => {
  const fields = [
    { id: 'email', type: 'email' },
    { id: 'group', type: 'organisation_group_dropdown' },
    { id: 'unrelated-member', type: 'member_dropdown' },
  ];
  const assignments = collectMemberOrganizationGroupAssignments({
    fields,
    entityPipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'email',
          target_type: 'core',
          target_field: 'email',
        }, {
          source_type: 'field',
          source_field_id: 'group',
          target_type: 'core',
          target_field: 'organization_group_id',
        }],
      }],
      organisations: [],
    },
    formValues: {
      email: 'new@example.test',
      group: 'group-a',
      'unrelated-member': 'member-attached',
    },
  });
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].memberId, undefined);
  assert.equal(assignments[0].email, 'new@example.test');
});

test('group validation is tenant scoped and rejects an Organisation conflict', async () => {
  const db = fakeDb({
    groups: [{ id: 'group-a', tenant_id: 'tenant-a' }],
    organizations: [{
      id: 'org-a',
      tenant_id: 'tenant-a',
      organization_group_id: 'group-b',
    }],
  });
  await assert.rejects(validateMemberOrganizationGroupAssignments({
    db,
    tenantId: 'tenant-a',
    assignments: [{ groupId: 'group-a', organizationId: 'org-a' }],
  }), error => error.code === 'INVALID_MEMBER_ORGANIZATION_GROUP');
  await assert.rejects(validateMemberOrganizationGroupWrite({
    db,
    tenantId: 'tenant-a',
    groupId: 'group-a',
    organizationId: 'org-a',
  }), error => error.code === 'INVALID_MEMBER_ORGANIZATION_GROUP');
});

test('direct assignment is writable only without an effective Organisation', async () => {
  const db = fakeDb({ groups: [{ id: 'group-a', tenant_id: 'tenant-a' }] });
  assert.deepEqual(await validateMemberOrganizationGroupWrite({
    db,
    tenantId: 'tenant-a',
    groupId: 'group-a',
  }), {
    groupId: 'group-a',
    organizationGroupId: 'group-a',
    organizationId: null,
    shouldWrite: true,
    organization: null,
  });
});