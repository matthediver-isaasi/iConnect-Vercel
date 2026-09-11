import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StructuredActionContractError,
  StructuredActionAuthorizationError,
  assertStructuredMutationAuthorized,
  assertStructuredRelationshipParentAuthorized,
  expandStructuredActionInvocations,
  mappedPayload,
  preflightPersistedStructuredMemberOrganizationGroups,
  processPersistedStructuredActions,
  processPrimaryPipelineRelatedRecords,
  recordReferenceFieldCapability,
  validatePrimaryPipelineRelatedRecordsContract,
  validateStructuredActionsContract,
} from './formStructuredActions.js';
import { FORM_NOT_LISTED_TEXT_KEY, FORM_NOT_LISTED_VALUE } from '../../shared/formNotListedChoice.js';

test('validates subordinate Related Records configuration against persisted relationship fields', () => {
  const valid = {
    fields: [{ id: 'department', type: 'relationship_dropdown', related_kind: 'custom_object', related_custom_object_id: 'department-object' }],
    entity_pipelines: {
      members: [{ isPrimary: true, related_records: [{ id: 'department-link', relationship_definition_id: 'member-department', source_field_id: 'department' }] }],
      organisations: [],
    },
  };
  assert.equal(validatePrimaryPipelineRelatedRecordsContract(valid).length, 1);
  assert.throws(() => validatePrimaryPipelineRelatedRecordsContract({
    ...valid,
    fields: [{ id: 'department', type: 'text' }],
  }), /Related Records configuration/);
});

test('links the exact primary pipeline result and treats a retry as already linked', async () => {
  const tenantId = 'tenant-1';
  const edges = [{
    id: 'org-department-edge',
    tenant_id: tenantId,
    relationship_definition_id: 'org-department',
    source_record_id: 'org-1',
    target_record_id: 'department-1',
    archived_at: null,
  }];
  const rows = {
    organization: [{ id: 'org-1', tenant_id: tenantId }],
    custom_object_definition: [{
      id: 'department-object', tenant_id: tenantId, status: 'active',
      primary_display_field_id: 'department-name',
    }],
    preference_field: [{
      id: 'department-name', tenant_id: tenantId, custom_object_id: 'department-object',
      entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
    }],
    custom_object_record: [{
      id: 'department-1', tenant_id: tenantId, custom_object_id: 'department-object',
      archived_at: null, data: { name: 'Radiology' },
    }],
    custom_object_relationship_definition: [
      {
        id: 'org-department', tenant_id: tenantId, status: 'active',
        source_kind: 'organization', source_custom_object_id: null,
        target_kind: 'custom_object', target_custom_object_id: 'department-object',
        show_on_source: true,
      },
      {
        id: 'member-department', tenant_id: tenantId, status: 'active',
        source_kind: 'member', source_custom_object_id: null,
        target_kind: 'custom_object', target_custom_object_id: 'department-object',
      },
    ],
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.nullFilters = []; this.payload = null; }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    is(column, value) { this.nullFilters.push([column, value]); return this; }
    insert(payload) { this.payload = payload; return this; }
    matchingRows() {
      const source = this.table === 'custom_object_relationship' ? edges : (rows[this.table] || []);
      return source.filter(row => this.filters.every(([column, value]) => String(row[column]) === String(value))
        && this.nullFilters.every(([column, value]) => row[column] === value));
    }
    async maybeSingle() { return { data: this.matchingRows()[0] || null, error: null }; }
    then(resolve, reject) {
      if (this.payload && this.table === 'custom_object_relationship') {
        edges.push({ id: `edge-${edges.length + 1}`, archived_at: null, ...this.payload });
        return Promise.resolve({ data: this.payload, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: this.matchingRows(), error: null }).then(resolve, reject);
    }
  }
  const db = { from: table => new Query(table) };
  const form = {
    fields: [
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'stale-hidden-org', type: 'organisation_dropdown',
        page_id: 'hidden-page', starts_hidden: false,
      },
      {
        id: 'department', type: 'relationship_dropdown', parent_field_id: 'org',
        relationship_definition_id: 'org-department', relationship_parent_kind: 'organization',
        relationship_parent_side: 'source', related_kind: 'custom_object',
        related_custom_object_id: 'department-object',
        related_primary_display_field_id: 'department-name',
      },
    ],
    pages: [{ id: 'hidden-page', starts_hidden: true }],
    entity_pipelines: {
      members: [{ isPrimary: true, related_records: [{ id: 'department-link', relationship_definition_id: 'member-department', source_field_id: 'department' }] }],
      organisations: [],
    },
  };
  // This reproduces the reported shape: an unrelated Organisation answer was
  // retained on a page that conditional logic hid. The primary Related Records
  // validator must receive persisted page metadata so that stale hidden answer
  // cannot block the valid Department selection.
  const submission = {
    submission_data: {
      org: 'org-1',
      department: 'department-1',
      'stale-hidden-org': 'unavailable-organization',
    },
  };
  const missingPages = await processPrimaryPipelineRelatedRecords({
    db,
    tenantId,
    form: { ...form, pages: undefined },
    submission,
    memberId: 'member-created',
  });
  assert.equal(missingPages.success, false);
  assert.equal(missingPages.outcomes[0].reason, 'submitted_relationship_invalid');
  assert.match(missingPages.outcomes[0].error, /Invalid organization selection/);
  assert.equal(edges.some(edge => edge.relationship_definition_id === 'member-department'), false);

  const first = await processPrimaryPipelineRelatedRecords({ db, tenantId, form, submission, memberId: 'member-created' });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.outcomes[0].status, 'linked');
  assert.equal(edges.at(-1).source_record_id, 'member-created');
  assert.equal(edges.at(-1).target_record_id, 'department-1');
  const retry = await processPrimaryPipelineRelatedRecords({ db, tenantId, form, submission, memberId: 'member-created' });
  assert.equal(retry.outcomes[0].status, 'already_linked');
  assert.equal(edges.filter(edge => edge.relationship_definition_id === 'member-department').length, 1);

  // A new organisation may not yet satisfy the picker filter. Its exact
  // server-only creation identity is valid for this internal second pass.
  const newOrganizationForm = {
    ...form,
    fields: [...form.fields.map(field => field.id === 'org' ? {
      ...field,
      not_listed_choice: { enabled: true, label: 'Not listed' },
      org_filter: { type: 'core', field: 'status', values: ['approved'] },
    } : field), {
      id: 'other-org',
      type: 'organisation_dropdown',
      not_listed_choice: { enabled: true, label: 'Not listed' },
    }],
  };
  const untrusted = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form: newOrganizationForm, submission, memberId: 'member-new-org',
  });
  assert.equal(untrusted.success, false);
  assert.match(untrusted.outcomes[0].error, /Invalid organization selection/);
  const createdContext = new Map([['org', 'org-1']]);
  const notListedSubmission = {
    submission_data: {
      ...submission.submission_data,
      org: FORM_NOT_LISTED_VALUE,
      'other-org': FORM_NOT_LISTED_VALUE,
      [FORM_NOT_LISTED_TEXT_KEY]: {
        org: 'New organisation',
        'other-org': 'Another valid not-listed organisation',
      },
    },
  };
  const originalAnswers = structuredClone(notListedSubmission.submission_data);
  const created = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form: newOrganizationForm, submission: notListedSubmission,
    memberId: 'member-new-org', serverCreatedOrganizations: createdContext,
  });
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.outcomes[0].status, 'linked');
  assert.deepEqual(notListedSubmission.submission_data, originalAnswers);
  const createdRetry = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form: newOrganizationForm, submission: notListedSubmission,
    memberId: 'member-new-org', serverCreatedOrganizations: createdContext,
  });
  assert.equal(createdRetry.outcomes[0].status, 'already_linked');
  assert.equal(edges.filter(edge => edge.source_record_id === 'member-new-org').length, 1);
  for (const visible of [true, false]) {
    const ruleForm = {
      ...newOrganizationForm,
      fields: newOrganizationForm.fields.map(field => field.id === 'department'
        ? { ...field, starts_hidden: visible } : field),
      visibility_rules: [{
        conditions: [{ field_id: 'org', operator: 'equals', value: FORM_NOT_LISTED_VALUE }],
        actions: [{
          action_type: 'visibility',
          field_states: { department: { visible } },
        }],
      }],
    };
    const ruleMember = `member-not-listed-rule-${visible}`;
    const ruleResult = await processPrimaryPipelineRelatedRecords({
      db, tenantId, form: ruleForm, submission: notListedSubmission,
      memberId: ruleMember, serverCreatedOrganizations: createdContext,
    });
    assert.equal(ruleResult.success, true, JSON.stringify(ruleResult));
    if (visible) {
      assert.equal(ruleResult.outcomes[0].status, 'linked');
      assert.equal(edges.filter(edge => edge.source_record_id === ruleMember).length, 1);
    } else {
      assert.equal(ruleResult.outcomes[0].reason, 'source_field_hidden');
      assert.equal(edges.some(edge => edge.source_record_id === ruleMember), false);
    }
    assert.deepEqual(notListedSubmission.submission_data, originalAnswers);
  }
  const spoofed = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form: newOrganizationForm,
    submission: { ...submission, serverCreatedOrganizations: createdContext },
    memberId: 'member-spoofed',
    serverCreatedOrganizations: { org: 'org-1' },
  });
  assert.equal(spoofed.success, false);
  assert.equal(edges.some(edge => edge.source_record_id === 'member-spoofed'), false);

  const hiddenForm = {
    ...form,
    fields: form.fields.map(field => field.id === 'department' ? { ...field, starts_hidden: true } : field),
  };
  const hidden = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form: hiddenForm, submission, memberId: 'member-hidden',
  });
  assert.equal(hidden.success, true);
  assert.equal(hidden.outcomes[0].reason, 'source_field_hidden');
  assert.equal(edges.some(edge => edge.source_record_id === 'member-hidden'), false);

  rows.custom_object_record[0].archived_at = '2026-09-01T00:00:00.000Z';
  const archived = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form, submission, memberId: 'member-archived',
  });
  assert.equal(archived.success, false);
  assert.equal(archived.outcomes[0].reason, 'submitted_relationship_invalid');
  assert.equal(edges.some(edge =>
    edge.source_record_id === 'member-archived' && edge.target_record_id === 'department-1'), false);

  rows.custom_object_record[0].archived_at = null;
  rows.custom_object_record[0].tenant_id = 'other-tenant';
  const crossTenant = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form, submission, memberId: 'member-cross-tenant',
  });
  assert.equal(crossTenant.success, false);
  assert.equal(crossTenant.outcomes[0].reason, 'submitted_relationship_invalid');
  assert.equal(edges.some(edge =>
    edge.source_record_id === 'member-cross-tenant' && edge.target_record_id === 'department-1'), false);

  rows.custom_object_record[0].tenant_id = tenantId;
  rows.custom_object_relationship_definition[1].source_custom_object_id = 'other-object';
  const incompatible = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form, submission, memberId: 'member-incompatible',
  });
  assert.equal(incompatible.success, false);
  assert.equal(incompatible.outcomes[0].reason, 'relationship_link_failed');
  assert.equal(incompatible.outcomes[0].source_field_id, 'department');
  assert.match(incompatible.outcomes[0].error, /incompatible/);
  assert.equal(edges.some(edge =>
    edge.source_record_id === 'member-incompatible' && edge.target_record_id === 'department-1'), false);
});

test('links a conditionally revealed Department to an already-created Member in Department-to-Member orientation', async () => {
  const tenantId = 'tenant-1';
  const edges = [{
    id: 'org-department-edge',
    tenant_id: tenantId,
    relationship_definition_id: 'org-department',
    source_record_id: 'department-1',
    target_record_id: 'org-1',
    archived_at: null,
  }, {
    id: 'org-department-edge-2',
    tenant_id: tenantId,
    relationship_definition_id: 'org-department',
    source_record_id: 'department-2',
    target_record_id: 'org-1',
    archived_at: null,
  }];
  const rows = {
    organization: [{ id: 'org-1', tenant_id: tenantId }],
    custom_object_definition: [{
      id: 'department-object', tenant_id: tenantId, status: 'active',
      primary_display_field_id: 'department-name',
    }],
    preference_field: [{
      id: 'department-name', tenant_id: tenantId, custom_object_id: 'department-object',
      entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
    }],
    custom_object_record: [
      {
        id: 'department-1', tenant_id: tenantId, custom_object_id: 'department-object',
        archived_at: null, data: { name: 'PET Centre' },
      },
      {
        id: 'department-2', tenant_id: tenantId, custom_object_id: 'department-object',
        archived_at: null, data: { name: 'Radiopharmacy' },
      },
    ],
    custom_object_relationship_definition: [
      {
        id: 'org-department', tenant_id: tenantId, status: 'active',
        source_kind: 'custom_object', source_custom_object_id: 'department-object',
        target_kind: 'organization', target_custom_object_id: null,
        show_on_target: true,
      },
      {
        id: 'member-department', tenant_id: tenantId, status: 'active',
        source_kind: 'custom_object', source_custom_object_id: 'department-object',
        target_kind: 'member', target_custom_object_id: null,
      },
    ],
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.nullFilters = []; this.payload = null; }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    is(column, value) { this.nullFilters.push([column, value]); return this; }
    insert(payload) { this.payload = payload; return this; }
    matchingRows() {
      const source = this.table === 'custom_object_relationship' ? edges : (rows[this.table] || []);
      return source.filter(row => this.filters.every(([column, value]) => String(row[column]) === String(value))
        && this.nullFilters.every(([column, value]) => row[column] === value));
    }
    async maybeSingle() { return { data: this.matchingRows()[0] || null, error: null }; }
    then(resolve, reject) {
      if (this.payload && this.table === 'custom_object_relationship') {
        edges.push({ id: `edge-${edges.length + 1}`, archived_at: null, ...this.payload });
        return Promise.resolve({ data: this.payload, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: this.matchingRows(), error: null }).then(resolve, reject);
    }
  }
  const db = { from: table => new Query(table) };
  const form = {
    fields: [
      { id: 'membership', type: 'select' },
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'department', type: 'relationship_dropdown', page_id: 'organization-page',
        starts_hidden: true, parent_field_id: 'org',
        relationship_definition_id: 'org-department', relationship_parent_kind: 'organization',
        relationship_parent_side: 'target', related_kind: 'custom_object',
        related_custom_object_id: 'department-object',
        related_primary_display_field_id: 'department-name',
        selection_mode: 'multiple',
      },
    ],
    pages: [{ id: 'organization-page', starts_hidden: true }],
    visibility_rules: [
      {
        conditions: [{ field_id: 'membership', operator: 'not_equals', value: 'Student' }],
        actions: [{
          action_type: 'visibility',
          field_states: { 'organization-page': { visible: true } },
        }],
      },
      {
        conditions: [{ field_id: 'org', operator: 'not_empty', value: '' }],
        actions: [{
          action_type: 'visibility',
          field_states: { department: { visible: true } },
        }],
      },
    ],
    entity_pipelines: {
      members: [{
        isPrimary: true,
        related_records: [{
          id: 'department-link',
          relationship_definition_id: 'member-department',
          source_field_id: 'department',
        }],
      }],
      organisations: [],
    },
  };
  const submission = {
    submission_data: {
      membership: 'Full with NMC',
      org: 'org-1',
      department: ['department-1', 'department-2'],
    },
  };

  const first = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form, submission, memberId: 'member-created',
  });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(first.outcomes.map(outcome => outcome.status), ['linked', 'linked']);
  const memberEdges = edges.filter(edge => edge.relationship_definition_id === 'member-department');
  assert.deepEqual(memberEdges.map(edge => edge.source_record_id), ['department-1', 'department-2']);
  assert.ok(memberEdges.every(edge => edge.target_record_id === 'member-created'));

  const retry = await processPrimaryPipelineRelatedRecords({
    db, tenantId, form, submission, memberId: 'member-created',
  });
  assert.equal(retry.success, true);
  assert.deepEqual(retry.outcomes.map(outcome => outcome.status), ['already_linked', 'already_linked']);
  assert.equal(edges.filter(edge => edge.relationship_definition_id === 'member-department').length, 2);
});

test('malformed Related Records config is reported without throwing after primary persistence', async () => {
  const result = await processPrimaryPipelineRelatedRecords({
    db: { from() { throw new Error('database must not be reached'); } },
    tenantId: 'tenant-1',
    form: {
      fields: [{ id: 'plain-text', type: 'text' }],
      entity_pipelines: {
        members: [{
          isPrimary: true,
          related_records: [{ id: 'bad-link', relationship_definition_id: 'stale', source_field_id: 'plain-text' }],
        }],
      },
    },
    submission: { submission_data: { 'plain-text': 'forged-record-id' } },
    memberId: 'member-created',
  });
  assert.equal(result.success, false);
  assert.equal(result.outcomes[0].reason, 'invalid_configuration');
});

const repeatable = {
  id: 'people',
  type: 'repeatable_row',
  repeatable_row: {
    version: 1,
    child_fields: [
      { id: 'email', type: 'email', label: 'Email' },
      { id: 'org', type: 'organisation_dropdown', label: 'Organisation' },
    ],
  },
};

function structuralRepeatableActionFixture(repeatableField, submittedValue) {
  const form = {
    id: 'form-repeatable-structural',
    tenant_id: 'tenant-repeatable-structural',
    fields: [repeatableField],
    structured_actions: {
      version: 1,
      actions: [{
        id: 'create-person',
        source: { scope: 'repeatable_row', repeatable_field_id: repeatableField.id },
        target: { kind: 'member', custom_object_id: null },
        operation: 'upsert',
        uniqueness_field: 'email',
        mappings: [{
          id: 'email-map',
          source_field_id: 'email',
          target_type: 'core',
          target_field_id: 'email',
        }],
      }],
    },
  };
  const submission = {
    id: 'submission-repeatable-structural',
    form_id: form.id,
    tenant_id: form.tenant_id,
    submission_data: { [repeatableField.id]: submittedValue },
  };
  let sideEffects = 0;
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    async maybeSingle() {
      const row = this.table === 'form' ? form
        : this.table === 'form_submission' ? submission : null;
      const matches = row && this.filters.every(([key, value]) => String(row[key]) === String(value));
      return { data: matches ? row : null, error: null };
    }
    then(resolve, reject) {
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    }
  }
  return {
    form,
    db: {
      from: table => new Query(table),
      rpc: async () => {
        sideEffects += 1;
        return { data: null, error: null };
      },
    },
    sideEffectCount: () => sideEffects,
  };
}

test('structured actions reject malformed repeatable answers before claiming side effects', async () => {
  for (const submittedValue of [
    { email: 'person@example.test' },
    [{ email: 'person@example.test', forged: 'value' }],
  ]) {
    const fixture = structuralRepeatableActionFixture(repeatable, submittedValue);
    await assert.rejects(() => processPersistedStructuredActions({
      db: fixture.db,
      formId: fixture.form.id,
      submissionId: 'submission-repeatable-structural',
      tenantId: fixture.form.tenant_id,
      authorization: {},
    }), /Repeatable row answer must be an array|unsupported field/);
    assert.equal(fixture.sideEffectCount(), 0);
  }
});

test('structured actions reject malformed row-source configuration before side effects', async () => {
  const sourceField = {
    ...repeatable,
    repeatable_row: {
      ...repeatable.repeatable_row,
      child_fields: [
        ...repeatable.repeatable_row.child_fields,
        {
          id: 'child_region',
          type: 'relationship_dropdown',
          option_source: {
            version: 1,
            kind: 'distinct',
            custom_object_id: '10000000-0000-0000-0000-000000000001',
            primary_display_field_id: '10000000-0000-0000-0000-000000000002',
            value_field_id: 'not-a-database-uuid',
            filters: [],
          },
        },
      ],
    },
  };
  const fixture = structuralRepeatableActionFixture(sourceField, [{
    email: 'person@example.test',
    child_region: 'North',
  }]);
  await assert.rejects(() => processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: 'submission-repeatable-structural',
    tenantId: fixture.form.tenant_id,
    authorization: {},
  }), /option source is malformed/);
  assert.equal(fixture.sideEffectCount(), 0);
});

test('row-source record reference descriptors use option-source metadata without legacy aliases', () => {
  const source = {
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: '10000000-0000-0000-0000-000000000001',
      primary_display_field_id: '10000000-0000-0000-0000-000000000002',
      filters: [],
    },
  };
  assert.deepEqual(recordReferenceFieldCapability(source), {
    kind: 'custom_object',
    customObjectId: source.option_source.custom_object_id,
    cardinality: 'single',
    supportsNotListed: false,
  });
  assert.equal(recordReferenceFieldCapability({
    ...source,
    selection_mode: 'multiple',
  }), null);
  assert.equal(recordReferenceFieldCapability({
    ...source,
    not_listed_choice: { enabled: true, label: 'Other' },
  }), null);
});

test('validates the versioned structured-actions contract against persisted fields', () => {
  const contract = validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'create-person',
      source: { scope: 'repeatable_row', repeatable_field_id: 'people' },
      target: { kind: 'member', custom_object_id: null },
      operation: 'upsert',
      uniqueness_field: 'email',
      mappings: [{ id: 'email-map', source_field_id: 'email', target_type: 'core', target_field_id: 'email' }],
    }],
  }, [repeatable]);
  assert.equal(contract.version, 1);
  assert.equal(contract.actions.length, 1);
});

test('validates generic relationship actions using fields and earlier outputs', () => {
  const fields = [
    { id: 'member', type: 'member_dropdown' },
    { id: 'org', type: 'organisation_dropdown' },
  ];
  const contract = validateStructuredActionsContract({
    version: 1,
    actions: [
      {
        id: 'create-org',
        source: { scope: 'top_level' },
        target: { kind: 'organization' },
        operation: 'create',
        mappings: [{ id: 'name', source_type: 'static', static_value: 'Acme', target_field_id: 'name', target_type: 'core' }],
      },
      {
        id: 'link-member-org',
        source: { scope: 'top_level' },
        operation: 'link_relationship',
        relationship_definition_id: 'member-org-definition',
        source_endpoint: {
          kind: 'member',
          source: { type: 'field', field_id: 'member' },
        },
        target_endpoint: {
          kind: 'organization',
          source: { type: 'action_output', action_id: 'create-org' },
        },
      },
    ],
  }, fields);
  assert.equal(contract.actions[1].operation, 'link_relationship');
});

test('validates built-in Organisation Group assignment from a field or earlier group action', () => {
  const fields = [
    { id: 'group-name', type: 'text' },
    { id: 'existing-group', type: 'organisation_group_dropdown' },
    { id: 'org-name', type: 'text' },
  ];
  const groupAction = {
    id: 'create-group',
    source: { scope: 'top_level' },
    target: { kind: 'organization_group' },
    operation: 'create',
    mappings: [{ id: 'group-name-map', source_field_id: 'group-name', target_type: 'core', target_field_id: 'name' }],
  };
  const organizationAction = {
    id: 'create-organization',
    source: { scope: 'top_level' },
    target: { kind: 'organization' },
    operation: 'create',
    organization_group_source: { type: 'action_output', action_id: groupAction.id },
    mappings: [{ id: 'org-name-map', source_field_id: 'org-name', target_type: 'core', target_field_id: 'name' }],
  };
  assert.equal(validateStructuredActionsContract({
    version: 1,
    actions: [groupAction, organizationAction],
  }, fields).actions.length, 2);
  assert.equal(validateStructuredActionsContract({
    version: 1,
    actions: [{
      ...organizationAction,
      organization_group_source: { type: 'field', scope: 'form', field_id: 'existing-group' },
    }],
  }, fields).actions.length, 1);
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [organizationAction, groupAction],
  }, fields), error => {
    assert.match(error.details.join(' '), /earlier Organisation Group record action/);
    return true;
  });
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      ...organizationAction,
      organization_group_source: { type: 'field', scope: 'form', field_id: 'org-name' },
    }],
  }, fields), /Invalid persisted/);
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'link-with-stale-assignment',
      source: { scope: 'top_level' },
      operation: 'link_relationship',
      relationship_definition_id: 'relationship-1',
      organization_group_source: { type: 'field', scope: 'form', field_id: 'existing-group' },
      source_endpoint: { kind: 'organization', source: { type: 'field', scope: 'form', field_id: 'org-name' } },
      target_endpoint: { kind: 'organization_group', source: { type: 'field', scope: 'form', field_id: 'existing-group' } },
    }],
  }, fields, {
    relationshipDefinitions: [{
      id: 'relationship-1', tenant_id: 'tenant-1', status: 'active',
      source_kind: 'organization', target_kind: 'organization_group',
    }],
  }), error => {
    assert.match(error.details.join(' '), /not allowed for link_relationship/);
    return true;
  });
});

test('structured Member actions map a persisted single-select Organisation Group field', () => {
  const fields = [
    { id: 'email', type: 'email' },
    { id: 'organisation', type: 'organisation_dropdown' },
    { id: 'organisation-group', type: 'organisation_group_dropdown' },
  ];
  const action = {
    id: 'member-group',
    source: { scope: 'top_level' },
    target: { kind: 'member' },
    operation: 'upsert',
    uniqueness_field: 'email',
    mappings: [
      { id: 'member-email', source_field_id: 'email', target_type: 'core', target_field_id: 'email' },
      {
        id: 'member-group',
        source_type: 'field',
        source_field_id: 'organisation-group',
        target_type: 'core',
        target_field_id: 'organization_group_id',
      },
    ],
  };
  assert.equal(validateStructuredActionsContract({
    version: 1,
    actions: [action],
  }, fields).actions.length, 1);

  const payload = mappedPayload({
    action,
    values: { email: 'member@example.test', 'organisation-group': 'group-1' },
  }, 'member', new Map());
  assert.equal(payload.core.organization_group_id, 'group-1');

  const unanswered = mappedPayload({
    action,
    values: { email: 'member@example.test', 'organisation-group': '' },
  }, 'member', new Map());
  assert.equal(Object.hasOwn(unanswered.core, 'organization_group_id'), false);

  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      ...action,
      mappings: [
        action.mappings[0],
        {
          ...action.mappings[1],
          source_field_id: 'email',
        },
      ],
    }],
  }, fields), error => {
    assert.match(error.details.join(' '), /persisted organisation_group_dropdown/);
    return true;
  });
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      ...action,
      mappings: [
        action.mappings[0],
        {
          ...action.mappings[1],
          source_type: 'clear',
          source_field_id: undefined,
        },
      ],
    }],
  }, fields), error => {
    assert.match(error.details.join(' '), /persisted organisation_group_dropdown/);
    return true;
  });
});

function memberOrganizationGroupRuntimeFixture({
  email = 'member@example.test',
  groupId = 'group-direct',
  existingMember = null,
  organizationGroupId = null,
  groupTenantId = 'tenant-1',
  beforeExecutionMemberRead = null,
  onClaim = null,
} = {}) {
  const tenantId = 'tenant-1';
  const form = {
    id: 'member-group-runtime-form',
    tenant_id: tenantId,
    fields: [
      { id: 'email', type: 'email' },
      { id: 'organisation-group', type: 'organisation_group_dropdown' },
    ],
    structured_actions: {
      version: 1,
      actions: [{
        id: 'member-group-runtime',
        source: { scope: 'top_level' },
        target: { kind: 'member' },
        operation: 'upsert',
        uniqueness_field: 'email',
        mappings: [
          { id: 'email-map', source_type: 'field', source_field_id: 'email', target_type: 'core', target_field_id: 'email' },
          {
            id: 'group-map',
            source_type: 'field',
            source_field_id: 'organisation-group',
            target_type: 'core',
            target_field_id: 'organization_group_id',
          },
        ],
      }],
    },
  };
  const submission = {
    id: 'member-group-runtime-submission',
    form_id: form.id,
    tenant_id: tenantId,
    submission_data: { email, 'organisation-group': groupId },
    processing_notes: [],
  };
  const store = {
    member: existingMember ? [{ tenant_id: tenantId, ...existingMember }] : [],
    organization: organizationGroupId
      ? [{ id: 'organization-1', tenant_id: tenantId, organization_group_id: organizationGroupId }]
      : [],
    organization_group: [{ id: groupId, tenant_id: groupTenantId }],
    preference_field: [],
  };
  const ledger = new Map();
  let memberWrites = 0;
  const memberUpdatePayloads = [];
  let memberReadCount = 0;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.nullFilters = [];
      this.operation = null;
      this.payload = null;
      this.max = null;
      this.caseInsensitiveFilters = [];
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    is(column, value) { this.nullFilters.push([column, value]); return this; }
    ilike(column, value) { this.caseInsensitiveFilters.push([column, value]); return this; }
    in(column, values) { this.filters.push([column, new Set(values.map(String))]); return this; }
    limit(value) { this.max = value; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    source() {
      if (this.table === 'form') return [form];
      if (this.table === 'form_submission') return [submission];
      return store[this.table] || [];
    }
    matches(row) {
      return this.filters.every(([column, value]) => value instanceof Set
        ? value.has(String(row[column]))
        : String(row[column]) === String(value))
        && this.nullFilters.every(([column, value]) => row[column] === value)
        && this.caseInsensitiveFilters.every(([column, value]) =>
          String(row[column] || '').toLowerCase() === String(value || '').toLowerCase());
    }
    matchingRows() {
      const rows = this.source().filter(row => this.matches(row));
      return this.max == null ? rows : rows.slice(0, this.max);
    }
    applyUpdate() {
      if (this.operation !== 'update') return;
      for (const row of this.matchingRows()) {
        Object.assign(row, this.payload);
        if (this.table === 'member') {
          memberWrites += 1;
          memberUpdatePayloads.push({ ...this.payload });
        }
      }
    }
    async maybeSingle() {
      this.applyUpdate();
      return { data: this.matchingRows()[0] || null, error: null };
    }
    async single() {
      if (this.operation === 'insert') {
        const row = { ...this.payload };
        if (!row.id) row.id = `member-${store.member.length + 1}`;
        this.source().push(row);
        if (this.table === 'member') memberWrites += 1;
        return { data: row, error: null };
      }
      return this.maybeSingle();
    }
    then(resolve, reject) {
      if (this.table === 'member' && this.operation == null) {
        memberReadCount += 1;
        if (memberReadCount === 2 && beforeExecutionMemberRead) beforeExecutionMemberRead(store);
      }
      this.applyUpdate();
      return Promise.resolve({ data: this.matchingRows(), error: null }).then(resolve, reject);
    }
  }

  const db = {
    from: table => new Query(table),
    rpc: async (name, input) => {
      const key = `${input.p_action_id}:${input.p_row_identity}`;
      if (name === 'claim_form_structured_action') {
        const prior = ledger.get(key);
        if (prior?.status === 'completed') {
          return { data: { ...prior, claimed: false }, error: null };
        }
        if (onClaim) onClaim({ input, store });
        return {
          data: {
            claimed: true,
            claim_token: key,
            record_id: `reserved-${input.p_row_identity}`,
          },
          error: null,
        };
      }
      ledger.set(key, { status: input.p_status, record_id: input.p_record_id });
      return { data: null, error: null };
    },
  };
  return {
    db,
    form,
    submission,
    store,
    ledger,
    memberWrites: () => memberWrites,
    memberUpdatePayloads,
    tenantId,
  };
}

test('structured Member actions create and update direct group assignments, preserve empty values, reject conflicts, and retry idempotently', async () => {
  const created = memberOrganizationGroupRuntimeFixture();
  const createResult = await processPersistedStructuredActions({
    db: created.db,
    formId: created.form.id,
    submissionId: created.submission.id,
    tenantId: created.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(createResult.success, true, JSON.stringify(createResult.outcomes));
  assert.equal(created.store.member.length, 1);
  assert.equal(created.store.member[0].organization_group_id, 'group-direct');
  assert.equal(created.memberWrites(), 1);

  const retryResult = await processPersistedStructuredActions({
    db: created.db,
    formId: created.form.id,
    submissionId: created.submission.id,
    tenantId: created.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(retryResult.outcomes[0].status, 'already_completed');
  assert.equal(created.store.member.length, 1);
  assert.equal(created.memberWrites(), 1);

  const updated = memberOrganizationGroupRuntimeFixture({
    email: 'existing@example.test',
    groupId: 'group-new',
    existingMember: {
      id: 'member-existing',
      email: 'existing@example.test',
      organization_group_id: 'group-old',
      organization_id: null,
    },
  });
  const updateResult = await processPersistedStructuredActions({
    db: updated.db,
    formId: updated.form.id,
    submissionId: updated.submission.id,
    tenantId: updated.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(updateResult.success, true, JSON.stringify(updateResult.outcomes));
  assert.equal(updated.store.member[0].organization_group_id, 'group-new');
  assert.equal(updated.memberWrites(), 1);

  updated.submission.submission_data['organisation-group'] = '';
  updated.submission.processing_notes = [];
  updated.ledger.clear();
  const emptyResult = await processPersistedStructuredActions({
    db: updated.db,
    formId: updated.form.id,
    submissionId: updated.submission.id,
    tenantId: updated.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(emptyResult.success, true, JSON.stringify(emptyResult.outcomes));
  assert.equal(updated.store.member[0].organization_group_id, 'group-new');
  assert.equal(updated.memberWrites(), 2);

  const hidden = memberOrganizationGroupRuntimeFixture({
    email: 'hidden@example.test',
    groupId: 'group-forged-hidden-answer',
    existingMember: {
      id: 'member-hidden',
      email: 'hidden@example.test',
      organization_id: null,
      organization_group_id: 'group-existing',
    },
  });
  hidden.form.fields[1].starts_hidden = true;
  const hiddenResult = await processPersistedStructuredActions({
    db: hidden.db,
    formId: hidden.form.id,
    submissionId: hidden.submission.id,
    tenantId: hidden.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(hiddenResult.success, true, JSON.stringify(hiddenResult.outcomes));
  assert.equal(hidden.store.member[0].organization_group_id, 'group-existing');
  assert.equal(hidden.memberWrites(), 1);

  const conflict = memberOrganizationGroupRuntimeFixture({
    email: 'attached@example.test',
    groupId: 'group-direct',
    existingMember: {
      id: 'member-attached',
      email: 'attached@example.test',
      organization_id: 'organization-1',
      organization_group_id: null,
    },
    organizationGroupId: 'group-effective',
  });
  await assert.rejects(() => processPersistedStructuredActions({
    db: conflict.db,
    formId: conflict.form.id,
    submissionId: conflict.submission.id,
    tenantId: conflict.tenantId,
    authorization: { isAdmin: true },
  }), /conflicts with the effective Organisation/);
  assert.equal(conflict.ledger.size, 0);
  assert.equal(conflict.store.member[0].organization_id, 'organization-1');
  assert.equal(conflict.store.member[0].organization_group_id, null);
  assert.equal(conflict.memberWrites(), 0);
});

test('revalidates a matching Organisation assignment when its group changes after preflight', async () => {
  const fixture = memberOrganizationGroupRuntimeFixture({
    email: 'race@example.test',
    groupId: 'group-race',
    organizationGroupId: 'group-race',
    existingMember: {
      id: 'member-race',
      email: 'race@example.test',
      organization_id: 'organization-1',
      organization_group_id: null,
    },
    beforeExecutionMemberRead: store => {
      store.organization_group.push({ id: 'group-effective', tenant_id: 'tenant-1' });
      store.organization[0].organization_group_id = 'group-effective';
    },
  });
  const result = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(result.success, false);
  assert.match(result.outcomes[0].error, /conflicts with the effective Organisation/);
  assert.equal(fixture.store.member[0].organization_group_id, null);
  assert.equal(fixture.memberWrites(), 0);
  assert.equal(fixture.ledger.get('member-group-runtime:top').status, 'failed');
});

test('revalidates a recovered create row before completing a direct group assignment', async () => {
  const fixture = memberOrganizationGroupRuntimeFixture({
    email: 'recovery@example.test',
    groupId: 'group-recovery',
    onClaim: ({ store }) => {
      store.organization.push({
        id: 'organization-recovery',
        tenant_id: 'tenant-1',
        organization_group_id: 'group-effective',
      });
      store.member.push({
        id: 'reserved-top',
        tenant_id: 'tenant-1',
        email: 'recovery@example.test',
        organization_id: 'organization-recovery',
        organization_group_id: null,
      });
    },
  });
  fixture.form.structured_actions.actions[0].operation = 'create';
  const result = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(result.success, false);
  assert.match(result.outcomes[0].error, /conflicts with the effective Organisation/);
  assert.equal(fixture.store.member[0].organization_group_id, null);
  assert.equal(fixture.memberWrites(), 0);
  assert.equal(fixture.ledger.get('member-group-runtime:top').status, 'failed');
});

test('structured Member group references reject a cross-tenant persisted group before claiming an action', async () => {
  const fixture = memberOrganizationGroupRuntimeFixture({ groupTenantId: 'other-tenant' });
  await assert.rejects(() => processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true },
  }), /Invalid relationship selector/);
  assert.equal(fixture.ledger.size, 0);
  assert.equal(fixture.store.member.length, 0);
});

test('structured Member matching Organisation-derived groups are accepted without a direct write', async () => {
  const fixture = memberOrganizationGroupRuntimeFixture({
    email: 'attached-matching@example.test',
    groupId: 'group-effective',
    existingMember: {
      id: 'member-attached-matching',
      email: 'attached-matching@example.test',
      organization_id: 'organization-1',
      organization_group_id: null,
    },
    organizationGroupId: 'group-effective',
  });
  const result = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true },
  });
  assert.equal(result.success, true, JSON.stringify(result.outcomes));
  assert.equal(fixture.store.member[0].organization_group_id, null);
  assert.equal(fixture.memberWrites(), 1);
  assert.equal(Object.hasOwn(fixture.memberUpdatePayloads[0], 'organization_group_id'), false);
});

test('structured Member group preflight rejects every invocation before a multi-action partial write', async () => {
  const fixture = memberOrganizationGroupRuntimeFixture({
    email: 'new-member@example.test',
    groupId: 'group-new-member',
  });
  fixture.form.fields.push(
    { id: 'email-conflict', type: 'email' },
    { id: 'organisation-group-conflict', type: 'organisation_group_dropdown' },
  );
  const firstAction = fixture.form.structured_actions.actions[0];
  fixture.form.structured_actions.actions.push({
    ...firstAction,
    id: 'member-group-conflict',
    mappings: [
      {
        ...firstAction.mappings[0],
        id: 'conflict-email-map',
        source_field_id: 'email-conflict',
      },
      {
        ...firstAction.mappings[1],
        id: 'conflict-group-map',
        source_field_id: 'organisation-group-conflict',
      },
    ],
  });
  fixture.submission.submission_data.email = 'first-action@example.test';
  fixture.submission.submission_data['organisation-group'] = 'group-new-member';
  fixture.submission.submission_data['email-conflict'] = 'attached@example.test';
  fixture.submission.submission_data['organisation-group-conflict'] = 'group-conflict';
  fixture.store.organization_group.push(
    { id: 'group-conflict', tenant_id: fixture.tenantId },
  );
  fixture.store.organization.push({
    id: 'organization-conflict',
    tenant_id: fixture.tenantId,
    organization_group_id: 'group-effective',
  });
  fixture.store.member.push({
    id: 'member-conflict',
    tenant_id: fixture.tenantId,
    email: 'attached@example.test',
    organization_id: 'organization-conflict',
    organization_group_id: null,
  });

  await assert.rejects(() => processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true },
  }), /conflicts with the effective Organisation/);
  assert.equal(fixture.ledger.size, 0);
  assert.equal(fixture.store.member.length, 1);
  assert.equal(fixture.memberWrites(), 0);
});

test('selected scalar member references ignore stale companion groups while Not-listed remains valid for writing', async () => {
  const fixture = memberOrganizationGroupRuntimeFixture({
    email: 'ignored@example.test',
    groupId: 'group-conflict',
    existingMember: {
      id: 'member-selected',
      email: 'ignored@example.test',
      organization_id: 'organization-effective',
      organization_group_id: null,
    },
    organizationGroupId: 'group-effective',
  });
  fixture.form.fields = [
    {
      id: 'member-picker',
      type: 'relationship_dropdown',
      related_kind: 'member',
      not_listed_choice: { enabled: true, label: 'Not listed' },
    },
    { id: 'group-picker', type: 'organisation_group_dropdown' },
  ];
  fixture.form.structured_actions.actions[0] = {
    id: 'resolve-member',
    source: { scope: 'top_level' },
    target: { kind: 'member' },
    operation: 'resolve_record_reference',
    record_reference_field_id: 'member-picker',
    not_listed_operation: 'upsert',
    uniqueness_field: 'email',
    identity_mapping: {
      id: 'member-email',
      source_type: 'not_listed_text',
      source_field_id: 'member-picker',
      target_type: 'core',
      target_field_id: 'email',
    },
    companion_mappings: [{
      id: 'member-group',
      source_type: 'field',
      source_field_id: 'group-picker',
      target_type: 'core',
      target_field_id: 'organization_group_id',
    }],
    mappings: [],
  };
  fixture.submission.submission_data = {
    'member-picker': 'member-selected',
    'group-picker': 'group-conflict',
  };
  const selected = await preflightPersistedStructuredMemberOrganizationGroups({
    db: fixture.db,
    form: fixture.form,
    submission: fixture.submission,
    tenantId: fixture.tenantId,
  });
  assert.equal(selected.invocations.length, 1);
  assert.equal(selected.invocations[0].memberOrganizationGroupPreflight, undefined);

  fixture.submission.processing_notes = [];
  fixture.ledger.clear();
  fixture.submission.submission_data = {
    'member-picker': FORM_NOT_LISTED_VALUE,
    'group-picker': 'group-conflict',
    [FORM_NOT_LISTED_TEXT_KEY]: { 'member-picker': 'new@example.test' },
  };
  const notListed = await preflightPersistedStructuredMemberOrganizationGroups({
    db: fixture.db,
    form: fixture.form,
    submission: fixture.submission,
    tenantId: fixture.tenantId,
  });
  assert.deepEqual(notListed.invocations[0].memberOrganizationGroupPreflight, {
    shouldWrite: true,
  });
  assert.equal(mappedPayload({
    action: fixture.form.structured_actions.actions[0],
    values: fixture.submission.submission_data,
  }, 'member', new Map()).core.organization_group_id, 'group-conflict');
});

test('multi-record member references skip selected-item companions but validate Not-listed items for writing', async () => {
  const fixture = memberOrganizationGroupRuntimeFixture({
    email: 'ignored@example.test',
    groupId: 'group-conflict',
    existingMember: {
      id: 'member-selected',
      email: 'ignored@example.test',
      organization_id: 'organization-effective',
      organization_group_id: null,
    },
    organizationGroupId: 'group-effective',
  });
  const organization = {
    id: 'organization-parent',
    tenant_id: fixture.tenantId,
    organization_group_id: 'group-effective',
  };
  fixture.store.organization.push(organization);
  fixture.store.custom_object_relationship_definition = [{
    id: 'member-relationship',
    tenant_id: fixture.tenantId,
    status: 'active',
    source_kind: 'organization',
    source_custom_object_id: null,
    target_kind: 'member',
    target_custom_object_id: null,
    show_on_source: true,
  }];
  fixture.store.custom_object_relationship = [{
    id: 'member-edge',
    tenant_id: fixture.tenantId,
    relationship_definition_id: 'member-relationship',
    source_record_id: 'organization-parent',
    target_record_id: 'member-selected',
    archived_at: null,
  }];
  fixture.form.fields = [
    { id: 'organization-parent', type: 'organisation_dropdown' },
    {
      id: 'member-picker',
      type: 'relationship_dropdown',
      selection_mode: 'multiple',
      parent_field_id: 'organization-parent',
      relationship_definition_id: 'member-relationship',
      relationship_parent_kind: 'organization',
      relationship_parent_side: 'source',
      related_kind: 'member',
      not_listed_choice: { enabled: true, label: 'Not listed' },
    },
    { id: 'group-picker', type: 'organisation_group_dropdown' },
  ];
  fixture.form.structured_actions.actions[0] = {
    id: 'resolve-members',
    source: { scope: 'top_level' },
    target: { kind: 'member' },
    operation: 'resolve_record_references',
    record_reference_field_id: 'member-picker',
    not_listed_operation: 'upsert',
    uniqueness_field: 'email',
    identity_mapping: {
      id: 'member-email',
      source_type: 'not_listed_text',
      source_field_id: 'member-picker',
      target_type: 'core',
      target_field_id: 'email',
    },
    companion_mappings: [{
      id: 'member-group',
      source_type: 'field',
      source_field_id: 'group-picker',
      target_type: 'core',
      target_field_id: 'organization_group_id',
    }],
    mappings: [],
  };
  fixture.submission.submission_data = {
    'organization-parent': 'organization-parent',
    'member-picker': ['member-selected', FORM_NOT_LISTED_VALUE],
    'group-picker': 'group-conflict',
    [FORM_NOT_LISTED_TEXT_KEY]: { 'member-picker': 'multi-new@example.test' },
  };
  const result = await preflightPersistedStructuredMemberOrganizationGroups({
    db: fixture.db,
    form: fixture.form,
    submission: fixture.submission,
    tenantId: fixture.tenantId,
  });
  assert.equal(result.invocations.length, 2);
  assert.equal(result.invocations[0].memberOrganizationGroupPreflight, undefined);
  assert.deepEqual(result.invocations[1].memberOrganizationGroupPreflight, {
    shouldWrite: true,
  });
});

test('creates a group then assigns its durable action output to an organisation without a Data Studio edge', async () => {
  const tenantId = 'tenant-1';
  const groupAction = {
    id: 'create-group', source: { scope: 'top_level' },
    target: { kind: 'organization_group' }, operation: 'create',
    mappings: [{ id: 'group-name-map', source_field_id: 'group-name', target_type: 'core', target_field_id: 'name' }],
  };
  const organizationAction = {
    id: 'create-organization', source: { scope: 'top_level' },
    target: { kind: 'organization' }, operation: 'upsert', uniqueness_field: 'name',
    organization_group_source: { type: 'action_output', action_id: groupAction.id },
    mappings: [{ id: 'org-name-map', source_field_id: 'org-name', target_type: 'core', target_field_id: 'name' }],
  };
  const existingGroupOrganizationAction = {
    id: 'create-organization-existing-group', source: { scope: 'top_level' },
    target: { kind: 'organization' }, operation: 'create',
    organization_group_source: { type: 'field', scope: 'form', field_id: 'existing-group' },
    mappings: [{ id: 'existing-org-name-map', source_field_id: 'existing-org-name', target_type: 'core', target_field_id: 'name' }],
  };
  const form = {
    id: 'form-group-chain', tenant_id: tenantId,
    fields: [
      { id: 'group-name', type: 'text' },
      { id: 'org-name', type: 'text' },
      { id: 'existing-group', type: 'organisation_group_dropdown' },
      { id: 'existing-org-name', type: 'text' },
    ],
    structured_actions: { version: 1, actions: [groupAction, organizationAction, existingGroupOrganizationAction] },
  };
  const submission = {
    id: 'submission-group-chain', form_id: form.id, tenant_id: tenantId,
    submission_data: {
      'group-name': 'Northern Region',
      'org-name': 'Example Organisation',
      'existing-group': 'group-existing',
      'existing-org-name': 'Existing Group Organisation',
    },
    processing_notes: [],
  };
  const store = {
    organization_group: [{ id: 'group-existing', tenant_id: 'other-tenant', name: 'Existing Group' }],
    organization: [{
      id: 'organization-existing-upsert',
      tenant_id: tenantId,
      name: 'Example Organisation',
      organization_group_id: null,
    }],
    preference_field: [],
    custom_object_relationship: [],
  };
  const ledger = new Map();
  let failChainedOrganization = true;
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.payload = null;
      this.operation = null;
      this.caseInsensitiveFilters = [];
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    in() { return this; }
    is() { return this; }
    limit() { return this; }
    ilike(column, value) { this.caseInsensitiveFilters.push([column, value]); return this; }
    insert(payload) { this.payload = payload; this.operation = 'insert'; return this; }
    update(payload) { this.payload = payload; this.operation = 'update'; return this; }
    source() {
      if (this.table === 'form') return [form];
      if (this.table === 'form_submission') return [submission];
      return store[this.table] || [];
    }
    matches(row) {
      return this.filters.every(([column, value]) => String(row[column]) === String(value))
        && this.caseInsensitiveFilters.every(([column, value]) =>
          String(row[column] || '').toLowerCase() === String(value || '').toLowerCase());
    }
    async maybeSingle() {
      if (this.operation === 'update') {
        if (this.table === 'organization' && this.payload.organization_group_id === 'group-created' && failChainedOrganization) {
          return { data: null, error: { message: 'temporary organization update failure' } };
        }
        const row = this.source().find(candidate => this.matches(candidate));
        if (row) Object.assign(row, this.payload);
        return { data: row || null, error: null };
      }
      return { data: this.source().find(row => this.matches(row)) || null, error: null };
    }
    async single() {
      if (this.operation === 'update') {
        return this.maybeSingle();
      }
      if (this.operation === 'insert') {
        const row = { ...this.payload };
        this.source().push(row);
        return { data: row, error: null };
      }
      return this.maybeSingle();
    }
    then(resolve, reject) {
      if (this.operation === 'update') {
        for (const row of this.source().filter(candidate => this.matches(candidate))) Object.assign(row, this.payload);
      }
      return Promise.resolve({ data: this.source().filter(row => this.matches(row)), error: null }).then(resolve, reject);
    }
  }
  const db = {
    from: table => new Query(table),
    rpc: async (name, input) => {
      const key = `${input.p_action_id}:${input.p_row_identity}`;
      if (name === 'claim_form_structured_action') {
        const prior = ledger.get(key);
        if (prior?.status === 'completed') return { data: { ...prior, claimed: false }, error: null };
        return {
          data: {
            claimed: true,
            claim_token: key,
            record_id: input.p_action_id === groupAction.id
              ? 'group-created'
              : input.p_action_id === existingGroupOrganizationAction.id
                ? 'organization-existing-group'
                : 'organization-created',
          },
          error: null,
        };
      }
      ledger.set(key, { status: input.p_status, record_id: input.p_record_id });
      return { data: null, error: null };
    },
  };
  const authorization = {
    allowPersistedOrganizationGroupActions: true,
    verifiedOrganizationId: 'organization-existing-upsert',
  };
  await assert.rejects(() => processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  }), /Invalid relationship selector/);
  assert.equal(ledger.size, 0);
  assert.equal(store.organization.length, 1);
  store.organization_group[0].tenant_id = tenantId;

  const first = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.equal(first.success, false, JSON.stringify(first.outcomes));
  assert.equal(first.failed_count, 1);
  assert.deepEqual(store.organization_group.map(group => group.id), ['group-existing', 'group-created']);
  assert.deepEqual(store.organization, [{
    id: 'organization-existing-upsert',
    tenant_id: tenantId,
    name: 'Example Organisation',
    organization_group_id: null,
  }, {
    id: 'organization-existing-group', tenant_id: tenantId, name: 'Existing Group Organisation',
    organization_group_id: 'group-existing',
  }]);
  assert.deepEqual(store.custom_object_relationship, []);
  failChainedOrganization = false;
  const retry = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.equal(retry.success, true, JSON.stringify(retry.outcomes));
  assert.deepEqual(store.organization.map(organization => [
    organization.id, organization.organization_group_id,
  ]), [
    ['organization-existing-upsert', 'group-created'],
    ['organization-existing-group', 'group-existing'],
  ]);
  assert.equal(store.organization_group.length, 2);
  assert.equal(store.organization.length, 2);
  const finalRetry = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.ok(finalRetry.outcomes.every(outcome => outcome.status === 'already_completed'));
  assert.equal(store.organization_group.length, 2);
  assert.equal(store.organization.length, 2);
});

test('relationship actions reject forward dependencies, descriptor mismatches, and cross-row outputs', () => {
  const rowMember = {
    id: 'members',
    type: 'repeatable_row',
    repeatable_row: { version: 1, child_fields: [{ id: 'member', type: 'member_dropdown' }] },
  };
  const link = {
    id: 'bad-link',
    source: { scope: 'repeatable_row', repeatable_field_id: 'members' },
    operation: 'link_relationship',
    relationship_definition_id: 'member-org-definition',
    source_endpoint: { kind: 'organization', source: { type: 'field', field_id: 'member' } },
    target_endpoint: { kind: 'organization', source: { type: 'action_output', action_id: 'later-org' } },
  };
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [
      link,
      {
        id: 'later-org',
        source: { scope: 'top_level' },
        target: { kind: 'organization' },
        operation: 'create',
        mappings: [{ id: 'name', source_type: 'static', static_value: 'Acme', target_field_id: 'name', target_type: 'core' }],
      },
    ],
  }, [rowMember]), (error) => {
    assert.match(error.details.join(' '), /compatible record field/);
    assert.match(error.details.join(' '), /earlier record action/);
    return true;
  });

  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [
      {
        id: 'top-org',
        source: { scope: 'top_level' },
        target: { kind: 'organization' },
        operation: 'create',
        mappings: [{ id: 'name', source_type: 'static', static_value: 'Acme', target_field_id: 'name', target_type: 'core' }],
      },
      { ...link, source_endpoint: { kind: 'member', source: { type: 'field', field_id: 'member' } },
        target_endpoint: { kind: 'organization', source: { type: 'action_output', action_id: 'top-org' } } },
    ],
  }, [rowMember]), /Invalid persisted/);
});

test('repeatable relationship actions resolve an explicit preceding form endpoint and current-row endpoint', () => {
  const primary = { id: 'primary-org', type: 'organisation_dropdown' };
  const organizations = {
    id: 'secondary-organizations',
    type: 'repeatable_row',
    repeatable_row: {
      version: 1,
      child_fields: [{ id: 'secondary-org', type: 'organisation_dropdown' }],
    },
  };
  const action = {
    id: 'link-organizations',
    source: { scope: 'repeatable_row', repeatable_field_id: organizations.id },
    operation: 'link_relationship',
    relationship_definition_id: 'org-org',
    source_endpoint: {
      kind: 'organization',
      source: { type: 'field', scope: 'form', field_id: primary.id },
    },
    target_endpoint: {
      kind: 'organization',
      source: { type: 'field', scope: 'row', field_id: 'secondary-org' },
    },
  };
  const contract = validateStructuredActionsContract({ version: 1, actions: [action] }, [primary, organizations]);
  const invocations = expandStructuredActionInvocations(contract, { fields: [primary, organizations] }, {
    [primary.id]: 'org-primary',
    [organizations.id]: [{ _row_id: 'row-1', 'secondary-org': 'org-secondary' }],
  });
  assert.equal(invocations[0].rootValues[primary.id], 'org-primary');
  assert.equal(invocations[0].values['secondary-org'], 'org-secondary');
  assert.throws(() => validateStructuredActionsContract(
    { version: 1, actions: [action] },
    [organizations, primary],
  ), /Invalid persisted/);
});

test('persists one canonical relationship edge and makes retries idempotent', async () => {
  const tenantId = 'tenant-1';
  const definition = {
    id: 'member-mentorship', tenant_id: tenantId, status: 'active',
    source_kind: 'member', source_custom_object_id: null,
    target_kind: 'member', target_custom_object_id: null,
  };
  const action = {
    id: 'link-mentor',
    source: { scope: 'top_level' },
    operation: 'link_relationship',
    relationship_definition_id: definition.id,
    source_endpoint: { kind: 'member', source: { type: 'field', field_id: 'mentor' } },
    target_endpoint: { kind: 'member', source: { type: 'field', field_id: 'mentee' } },
  };
  const form = {
    id: 'form-1', tenant_id: tenantId,
    fields: [{ id: 'mentor', type: 'member_dropdown' }, { id: 'mentee', type: 'member_dropdown' }],
    structured_actions: { version: 1, actions: [action] },
  };
  const submission = {
    id: 'submission-1', form_id: form.id, tenant_id: tenantId,
    submission_data: { mentor: 'member-1', mentee: 'member-2' },
    processing_notes: [],
  };
  const rows = {
    member: [
      { id: 'member-1', tenant_id: tenantId },
      { id: 'member-2', tenant_id: tenantId },
    ],
    custom_object_relationship_definition: [definition],
    custom_object_relationship: [],
    preference_field: [],
  };
  let relationshipInsertError = null;
  class Query {
    constructor(table) {
      this.table = table; this.filters = []; this.nullFilters = []; this.payload = null;
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    in(column, values) { this.filters.push([column, new Set(values.map(String))]); return this; }
    is(column, value) { this.nullFilters.push([column, value]); return this; }
    update(payload) { this.payload = payload; return this; }
    insert(payload) { this.payload = payload; return this; }
    sourceRows() {
      if (this.table === 'form') return [form];
      if (this.table === 'form_submission') return [submission];
      return rows[this.table] || [];
    }
    matches(row) {
      return this.filters.every(([column, value]) =>
        value instanceof Set ? value.has(String(row[column])) : String(row[column]) === String(value))
        && this.nullFilters.every(([column, value]) => row[column] === value);
    }
    async maybeSingle() { return { data: this.sourceRows().find(row => this.matches(row)) || null, error: null }; }
    then(resolve, reject) {
      if (this.payload && this.table === 'custom_object_relationship') {
        if (relationshipInsertError) {
          if ([
            relationshipInsertError.constraint,
            relationshipInsertError.details,
            relationshipInsertError.message,
          ].filter(Boolean).join(' ').includes('custom_object_relationship_active_pair_unique')) {
            rows.custom_object_relationship.push({
              id: `edge-${rows.custom_object_relationship.length + 1}`,
              archived_at: null,
              ...this.payload,
            });
          }
          return Promise.resolve({ data: null, error: relationshipInsertError }).then(resolve, reject);
        }
        rows.custom_object_relationship.push({
          id: `edge-${rows.custom_object_relationship.length + 1}`,
          archived_at: null,
          ...this.payload,
        });
      } else if (this.payload && this.table === 'form_submission') {
        Object.assign(submission, this.payload);
      }
      return Promise.resolve({
        data: this.sourceRows().filter(row => this.matches(row)),
        error: null,
      }).then(resolve, reject);
    }
  }
  const ledger = new Map();
  const db = {
    from: table => new Query(table),
    rpc: async (name, input) => {
      const key = `${input.p_action_id}:${input.p_row_identity}`;
      if (name === 'claim_form_structured_action') {
        const prior = ledger.get(key);
        return { data: prior?.status === 'completed' ? { ...prior, claimed: false } : { claimed: true, claim_token: 'claim-1' }, error: null };
      }
      ledger.set(key, { status: input.p_status, record_id: input.p_record_id });
      return { data: null, error: null };
    },
  };
  await assert.rejects(() => processPersistedStructuredActions({
    db,
    formId: form.id,
    submissionId: submission.id,
    tenantId,
    authorization: { verifiedMemberId: 'member-1' },
  }), StructuredActionAuthorizationError);
  assert.deepEqual(rows.custom_object_relationship, []);
  assert.equal(ledger.size, 0);

  // Admin-configured processing can link arbitrary tenant-owned endpoint records.
  const authorization = { isAdmin: true };
  const first = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.equal(first.success, true);
  assert.equal(first.outcomes[0].operation, 'linked');
  assert.deepEqual(rows.custom_object_relationship.map(edge => [
    edge.source_record_id, edge.target_record_id,
  ]), [['member-1', 'member-2']]);

  const retry = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.equal(retry.outcomes[0].status, 'already_completed');
  assert.equal(rows.custom_object_relationship.length, 1);

  rows.member[1].tenant_id = 'other-tenant';
  await assert.rejects(() => processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  }), /Invalid relationship selector/);

  // The exact active-pair duplicate is safe only when its re-read confirms
  // the edge that another concurrent worker inserted.
  rows.member[1].tenant_id = tenantId;
  rows.member.push({ id: 'member-4', tenant_id: tenantId });
  submission.submission_data.mentee = 'member-4';
  submission.processing_notes = [];
  ledger.clear();
  relationshipInsertError = {
    code: '23505',
    message: 'duplicate key value violates unique constraint "custom_object_relationship_active_pair_unique"',
  };
  const duplicateRace = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.equal(duplicateRace.outcomes[0].status, 'completed');
  assert.equal(duplicateRace.outcomes[0].already_linked, true);

  // Cardinality triggers also use 23505, but must remain failures (and leave
  // the ledger retryable), unlike the exact active-pair uniqueness constraint.
  rows.member.push({ id: 'member-3', tenant_id: tenantId });
  submission.submission_data.mentee = 'member-3';
  submission.processing_notes = [];
  ledger.clear();
  relationshipInsertError = {
    code: '23505',
    details: 'custom_object_relationship_source_cardinality',
    message: 'source cardinality violated',
  };
  const conflict = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.equal(conflict.outcomes[0].status, 'failed');
  assert.equal(conflict.outcomes[0].reason, 'relationship_cardinality_conflict');
  assert.equal(conflict.outcomes[0].retryable, true);
  assert.equal(ledger.get('link-mentor:top').status, 'failed');
  relationshipInsertError = null;
  const recovered = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId, authorization,
  });
  assert.equal(recovered.outcomes[0].status, 'completed');
  assert.equal(rows.custom_object_relationship.length, 3);
});

test('keeps composed repeatable producer outputs and form endpoints row-local across a descendant retry', async () => {
  const tenantId = 'tenant-1';
  const rowsField = { id: 'rows', type: 'repeatable_row', repeatable_row: { version: 1, child_fields: [
    { id: 'secondary-org', type: 'organisation_dropdown' }, { id: 'department-name', type: 'text' },
  ] } };
  const definitions = [
    { id: 'department-org', tenant_id: tenantId, status: 'active', source_kind: 'custom_object', source_custom_object_id: 'department-object', target_kind: 'organization', target_custom_object_id: null },
    { id: 'primary-secondary', tenant_id: tenantId, status: 'active', source_kind: 'organization', source_custom_object_id: null, target_kind: 'organization', target_custom_object_id: null },
  ];
  const producer = {
    id: 'create-department', source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
    target: { kind: 'custom_object', custom_object_id: 'department-object' }, operation: 'create',
    mappings: [{ id: 'name', source_field_id: 'department-name', target_type: 'custom', target_field_id: 'department-name-field' }],
  };
  const form = { id: 'form-rows', tenant_id: tenantId, fields: [{ id: 'primary-org', type: 'organisation_dropdown' }, rowsField],
    structured_actions: { version: 1, actions: [
      producer,
      { id: 'link-department', source: producer.source, operation: 'link_relationship', relationship_definition_id: 'department-org',
        source_endpoint: { kind: 'custom_object', custom_object_id: 'department-object', source: { type: 'action_output', action_id: producer.id } },
        target_endpoint: { kind: 'organization', source: { type: 'field', scope: 'row', field_id: 'secondary-org' } } },
      { id: 'link-primary', source: producer.source, operation: 'link_relationship', relationship_definition_id: 'primary-secondary',
        source_endpoint: { kind: 'organization', source: { type: 'field', scope: 'form', field_id: 'primary-org' } },
        target_endpoint: { kind: 'organization', source: { type: 'field', scope: 'row', field_id: 'secondary-org' } } },
    ] } };
  const submission = { id: 'submission-rows', form_id: form.id, tenant_id: tenantId, processing_notes: [], submission_data: {
    'primary-org': 'org-primary',
    rows: [
      { _row_id: 'row-a', 'secondary-org': 'org-secondary-a', 'department-name': 'Department A' },
      { _row_id: 'row-b', 'secondary-org': 'org-secondary-b', 'department-name': 'Department B' },
    ],
  } };
  const store = {
    organization: ['org-primary', 'org-secondary-a', 'org-secondary-b'].map(id => ({ id, tenant_id: tenantId })),
    preference_field: [{ id: 'department-name-field', tenant_id: tenantId, entity_scope: 'custom_object', custom_object_id: 'department-object', is_active: true, field_type: 'text', field_key: 'name', name: 'name', label: 'Name' }],
    custom_object_relationship_definition: definitions, custom_object_record: [], custom_object_relationship: [],
  };
  let failRowB = true;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.nulls = []; this.payload = null; }
    select() { return this; } eq(k, v) { this.filters.push([k, v]); return this; }
    in(k, v) { this.filters.push([k, new Set(v.map(String))]); return this; } is(k, v) { this.nulls.push([k, v]); return this; }
    update(payload) { this.payload = payload; return this; } insert(payload) { this.payload = payload; return this; }
    source() { return this.table === 'form' ? [form] : this.table === 'form_submission' ? [submission] : this.table === 'custom_object_definition' ? [{ id: 'department-object', tenant_id: tenantId, status: 'active' }] : store[this.table] || []; }
    matches(row) { return this.filters.every(([k, v]) => v instanceof Set ? v.has(String(row[k])) : String(row[k]) === String(v)) && this.nulls.every(([k, v]) => row[k] === v); }
    async maybeSingle() { return { data: this.source().find(row => this.matches(row)) || null, error: null }; }
    async single() {
      if (this.table === 'custom_object_record' && this.payload) {
        const data = { id: `department-${store.custom_object_record.length + 1}`, archived_at: null, ...this.payload };
        store.custom_object_record.push(data); return { data, error: null };
      }
      return this.maybeSingle();
    }
    then(resolve, reject) {
      if (this.table === 'custom_object_relationship' && this.payload) {
        if (failRowB && this.payload.relationship_definition_id === 'department-org'
          && this.payload.target_record_id === 'org-secondary-b') {
          return Promise.resolve({ data: null, error: { code: '23505', constraint: 'custom_object_relationship_target_cardinality', message: 'temporary cardinality conflict' } }).then(resolve, reject);
        }
        store.custom_object_relationship.push({ id: `edge-${store.custom_object_relationship.length + 1}`, archived_at: null, ...this.payload });
      }
      if (this.table === 'form_submission' && this.payload) Object.assign(submission, this.payload);
      return Promise.resolve({ data: this.source().filter(row => this.matches(row)), error: null }).then(resolve, reject);
    }
  }
  const ledger = new Map();
  const db = { from: table => new Query(table), rpc: async (name, input) => {
    const key = `${input.p_action_id}:${input.p_row_identity}`;
    if (name === 'claim_form_structured_action') {
      const old = ledger.get(key);
      return { data: old?.status === 'completed' ? { ...old, claimed: false } : { claimed: true, claim_token: key }, error: null };
    }
    ledger.set(key, { status: input.p_status, record_id: input.p_record_id }); return { data: null, error: null };
  } };
  const first = await processPersistedStructuredActions({ db, formId: form.id, submissionId: submission.id, tenantId, authorization: { isAdmin: true } });
  assert.equal(first.failed_count, 1, JSON.stringify(first.outcomes));
  assert.equal(store.custom_object_record.length, 2);
  assert.deepEqual(store.custom_object_relationship.map(edge => [edge.relationship_definition_id, edge.source_record_id, edge.target_record_id]), [
    ['department-org', 'department-1', 'org-secondary-a'],
    ['primary-secondary', 'org-primary', 'org-secondary-a'],
    ['primary-secondary', 'org-primary', 'org-secondary-b'],
  ]);
  failRowB = false;
  const retry = await processPersistedStructuredActions({ db, formId: form.id, submissionId: submission.id, tenantId, authorization: { isAdmin: true } });
  assert.equal(retry.success, true);
  assert.equal(store.custom_object_record.length, 2);
  assert.deepEqual(store.custom_object_relationship.map(edge => [edge.relationship_definition_id, edge.source_record_id, edge.target_record_id]), [
    ['department-org', 'department-1', 'org-secondary-a'],
    ['primary-secondary', 'org-primary', 'org-secondary-a'],
    ['primary-secondary', 'org-primary', 'org-secondary-b'],
    ['department-org', 'department-2', 'org-secondary-b'],
  ]);
});

test('rejects unknown versions, unsafe core columns, and forged source fields', () => {
  assert.throws(() => validateStructuredActionsContract({
    version: 2,
    actions: [{
      id: 'bad',
      entity_type: 'member',
      operation: 'update',
      mappings: [{ source_field_id: 'forged', target_type: 'core', target_field: 'tenant_id' }],
    }],
  }, [repeatable]), (error) => {
    assert.ok(error instanceof StructuredActionContractError);
    assert.match(error.details.join(' '), /unsupported/);
    assert.match(error.details.join(' '), /not writable/);
    assert.match(error.details.join(' '), /persisted action source scope/);
    return true;
  });
});

test('expands top-level and active repeatable rows with stable idempotency keys', () => {
  const contract = validateStructuredActionsContract({
    contract_version: 1,
    actions: [
      {
        id: 'org',
        source: { scope: 'top_level' },
        target: { kind: 'organization' },
        operation: 'create',
        mappings: [{ id: 'name-map', source_type: 'static', static_value: 'Acme', target_field: 'name' }],
      },
      {
        id: 'people',
        target: { kind: 'member' },
        operation: 'upsert',
        uniqueness_field: 'email',
        source: { scope: 'repeatable_row', repeatable_field_id: 'people' },
        mappings: [{ id: 'person-email-map', source_field_id: 'email', target_field_id: 'email', target_type: 'core' }],
      },
    ],
  }, [repeatable]);
  const invocations = expandStructuredActionInvocations(contract, { fields: [repeatable] }, {
    people: [
      { _row_id: 'row-a', email: 'a@example.test' },
      { email: 'deleted@example.test', _deleted: true },
      { email: 'inactive@example.test', active: false },
      { _row_id: 'row-b', email: 'b@example.test' },
    ],
  });
  // Persisted repeatable rows carry their stable identity; indexes are never
  // safe because admins can reorder/remove rows between retries.
  assert.deepEqual(invocations.map(row => row.invocationKey), ['org:top', 'people:row:row-a', 'people:row:row-b']);
  assert.equal(invocations[2].values.email, 'b@example.test');
});

test('does not expand repeatable actions when the persisted container is hidden', () => {
  const hiddenRepeatable = { ...repeatable, starts_hidden: true };
  const contract = validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'people',
      target: { kind: 'member' },
      operation: 'create',
        source: { scope: 'repeatable_row', repeatable_field_id: 'people' },
      mappings: [{ id: 'hidden-email-map', source_field_id: 'email', target_field_id: 'email', target_type: 'core' }],
    }],
  }, [hiddenRepeatable]);
  assert.deepEqual(
    expandStructuredActionInvocations(contract, { fields: [hiddenRepeatable] }, { people: [{ email: 'a@example.test' }] }),
    [],
  );
});

test('LMIC visibility options control repeatable expansion authoritatively', () => {
  const conditionalRepeatable = { ...repeatable, starts_hidden: true };
  const country = { id: 'country', type: 'country' };
  const form = {
    fields: [country, conditionalRepeatable],
    visibility_rules: [{
      id: 'show-lmic-rows',
      trigger_field_id: 'country',
      operator: 'is_lmic',
      actions: [{ action_type: 'show', target_field_ids: ['people'] }],
    }],
  };
  const contract = validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'people',
      source: { scope: 'repeatable_row', repeatable_field_id: 'people' },
      target: { kind: 'member' },
      operation: 'create',
      mappings: [{ id: 'email-map', source_field_id: 'email', target_field_id: 'email', target_type: 'core' }],
    }],
  }, form.fields);
  const answers = { country: 'Kenya', people: [{ _row_id: 'row-1', email: 'person@example.test' }] };
  assert.equal(expandStructuredActionInvocations(contract, form, answers).length, 0);
  assert.equal(expandStructuredActionInvocations(contract, form, answers, { lmicCodes: ['KE'] }).length, 1);
  assert.equal(expandStructuredActionInvocations(contract, form, {
    ...answers,
    country: 'United Kingdom',
  }, { lmicCodes: ['KE'] }).length, 0);
});

test('forged hidden top-level and repeatable child answers are excluded before mapping', () => {
  const topForm = {
    fields: [
      { id: 'email', type: 'email' },
      { id: 'hidden-name', type: 'text', starts_hidden: true },
    ],
  };
  const topContract = validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'top',
      source: { scope: 'top_level' },
      target: { kind: 'member' },
      operation: 'create',
      mappings: [
        { id: 'top-email', source_field_id: 'email', target_field_id: 'email', target_type: 'core' },
        { id: 'top-name', source_field_id: 'hidden-name', target_field_id: 'first_name', target_type: 'core' },
      ],
    }],
  }, topForm.fields);
  const [topInvocation] = expandStructuredActionInvocations(topContract, topForm, {
    email: 'visible@example.test',
    'hidden-name': 'forged hidden value',
  });
  assert.equal(topInvocation.values.email, 'visible@example.test');
  assert.equal(Object.hasOwn(topInvocation.values, 'hidden-name'), false);

  const hiddenChildRepeatable = {
    ...repeatable,
    repeatable_row: {
      ...repeatable.repeatable_row,
      child_fields: repeatable.repeatable_row.child_fields.map(child =>
        child.id === 'email' ? { ...child, starts_hidden: true } : child),
    },
  };
  const rowContract = validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'rows',
      source: { scope: 'repeatable_row', repeatable_field_id: 'people' },
      target: { kind: 'member' },
      operation: 'create',
      mappings: [{ id: 'row-email', source_field_id: 'email', target_field_id: 'email', target_type: 'core' }],
    }],
  }, [hiddenChildRepeatable]);
  assert.equal(expandStructuredActionInvocations(rowContract, { fields: [hiddenChildRepeatable] }, {
    people: [{ _row_id: 'forged-row', email: 'forged@example.test' }],
  }).length, 0);
});

test('custom-object fallback uniqueness matches by target id while querying by field key', () => {
  const action = {
    id: 'company-upsert',
    target: { kind: 'custom_object', custom_object_id: 'company-object' },
    operation: 'upsert',
    uniqueness_field: 'field-uuid',
    mappings: [
      { id: 'primary', source_field_id: 'primary-code', target_type: 'custom', target_field_id: 'field-uuid', fallback_group: { version: 1, id: 'code-fallback' } },
      { id: 'alternate', source_field_id: 'alternate-code', target_type: 'custom', target_field_id: 'field-uuid', fallback_group: { version: 1, id: 'code-fallback' } },
    ],
  };
  const preferenceFields = new Map([['field-uuid', {
    id: 'field-uuid',
    field_key: 'company_code',
  }]]);
  const payload = mappedPayload(
    { action, values: { 'primary-code': '', 'alternate-code': 'ACME-42' } },
    'custom_object',
    preferenceFields,
  );
  assert.deepEqual(payload.custom, { company_code: 'ACME-42' });
  assert.deepEqual(payload.match, [{
    targetType: 'custom',
    field: 'company_code',
    targetFieldId: 'field-uuid',
    value: 'ACME-42',
  }]);
  assert.throws(() => mappedPayload(
    { action, values: { 'primary-code': '', 'alternate-code': '' } },
    'custom_object',
    preferenceFields,
  ), /fallback uniqueness field has no visible, non-empty value/);
});

test('fallback upsert uniqueness rejects an explicit clear winner', () => {
  const baseAction = {
    id: 'member-upsert',
    target: { kind: 'member' },
    operation: 'upsert',
    uniqueness_field: 'email',
  };
  const clear = {
    id: 'clear-email',
    source_type: 'clear',
    target_type: 'core',
    target_field_id: 'email',
    fallback_group: { version: 1, id: 'email-fallback' },
  };
  const alternate = {
    id: 'alternate-email',
    source_field_id: 'alternate',
    target_type: 'core',
    target_field_id: 'email',
    fallback_group: { version: 1, id: 'email-fallback' },
  };
  assert.throws(() => mappedPayload(
    { action: { ...baseAction, mappings: [clear, alternate] }, values: { alternate: 'later@example.test' } },
    'member',
    new Map(),
  ), /fallback uniqueness field has no visible, non-empty value/);
  assert.throws(() => mappedPayload(
    {
      action: {
        ...baseAction,
        mappings: [
          { ...alternate, id: 'empty-email', source_field_id: 'empty' },
          clear,
        ],
      },
      values: { empty: '' },
    },
    'member',
    new Map(),
  ), /fallback uniqueness field has no visible, non-empty value/);
});

test('rejects relationship selectors mapped into arbitrary fields and requires exact update selector', () => {
  const fields = [{
    id: 'org-picker',
    type: 'organisation_dropdown',
    relationship_definition_id: 'relationship-1',
  }];
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'unsafe-selector',
      source: { scope: 'top_level' },
      target: { kind: 'member' },
      operation: 'upsert',
      mappings: [{ source_field_id: 'org-picker', target_field_id: 'first_name', target_type: 'core' }],
    }],
  }, fields), /Invalid persisted/);
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'missing-exact-selector',
      source: { scope: 'top_level' },
      target: { kind: 'member' },
      operation: 'update_selected',
      relationship_definition_id: 'relationship-1',
      selector_field_id: 'not-a-picker',
      mappings: [{ source_field_id: 'org-picker', target_field_id: 'organization_id', target_type: 'core' }],
    }],
  }, fields), /Invalid persisted/);
});

test('requires a stable row id only for material repeatable rows', () => {
  const contract = validateStructuredActionsContract({
    version: 1,
    actions: [{
      id: 'people',
      source: { scope: 'repeatable_row', repeatable_field_id: 'people' },
      target: { kind: 'member' },
      operation: 'create',
      mappings: [{ id: 'stable-row-email-map', source_field_id: 'email', target_field_id: 'email', target_type: 'core' }],
    }],
  }, [repeatable]);
  assert.deepEqual(expandStructuredActionInvocations(contract, { fields: [repeatable] }, {
    people: [{ _row_id: 'blank' }, { _row_id: 'real', email: 'real@example.test' }],
  }).map(x => x.invocationKey), ['people:row:real']);
  assert.throws(() => expandStructuredActionInvocations(contract, { fields: [repeatable] }, {
    people: [{ email: 'missing-id@example.test' }],
  }), /row\._row_id/);
});

test('anonymous and non-admin structured mutations cannot target another record', () => {
  const memberAction = { target: { kind: 'member' }, operation: 'update_selected' };
  const organizationAction = { target: { kind: 'organization' }, operation: 'update_selected' };
  assert.throws(() => assertStructuredMutationAuthorized({
    action: memberAction,
    recordId: 'victim-member',
    authorization: {},
  }), StructuredActionAuthorizationError);
  assert.throws(() => assertStructuredMutationAuthorized({
    action: memberAction,
    recordId: 'other-member',
    authorization: { verifiedMemberId: 'own-member' },
  }), /verified ownership/);
  assert.equal(assertStructuredMutationAuthorized({
    action: memberAction,
    recordId: 'own-member',
    authorization: { verifiedMemberId: 'own-member' },
  }), true);
  assert.equal(assertStructuredMutationAuthorized({
    action: organizationAction,
    recordId: 'own-org',
    authorization: { verifiedOrganizationId: 'own-org' },
  }), true);
  assert.throws(() => assertStructuredMutationAuthorized({
    action: { target: { kind: 'custom_object', custom_object_id: 'object-1' }, operation: 'upsert' },
    recordId: 'existing-object-record',
    authorization: { verifiedMemberId: 'own-member' },
  }), StructuredActionAuthorizationError);
  for (const action of [
    { target: { kind: 'custom_object', custom_object_id: 'object-1' }, operation: 'create' },
    { target: { kind: 'custom_object', custom_object_id: 'object-1' }, operation: 'upsert' },
    { target: { kind: 'organization_group' }, operation: 'create' },
    { target: { kind: 'organization_group' }, operation: 'upsert' },
  ]) {
    assert.throws(() => assertStructuredMutationAuthorized({
      action,
      recordId: null,
      authorization: { verifiedMemberId: 'own-member', verifiedOrganizationId: 'own-org' },
    }), StructuredActionAuthorizationError);
    assert.equal(assertStructuredMutationAuthorized({
      action,
      recordId: action.operation === 'create' ? null : 'tenant-owned-record',
      authorization: { isAdmin: true },
    }), true);
  }
  assert.equal(assertStructuredMutationAuthorized({
    action: { target: { kind: 'custom_object', custom_object_id: 'object-1' }, operation: 'create' },
    recordId: null,
    authorization: { allowPersistedCustomObjectCreates: true },
  }), true);
  assert.throws(() => assertStructuredMutationAuthorized({
    action: { target: { kind: 'custom_object', custom_object_id: 'object-1' }, operation: 'upsert' },
    recordId: null,
    authorization: { allowPersistedCustomObjectCreates: true },
  }), StructuredActionAuthorizationError);
});

test('non-admin Group and Custom Object creates fail before a ledger claim or insert', async () => {
  const tenantId = 'tenant-1';
  const makeDb = (action, fields, submissionData, preferenceFields = []) => {
    const writes = [];
    const rpcCalls = [];
    const form = { id: 'form-1', tenant_id: tenantId, fields, structured_actions: { version: 1, actions: [action] } };
    const submission = { id: 'submission-1', tenant_id: tenantId, form_id: form.id, submission_data: submissionData, processing_notes: [] };
    class Query {
      constructor(table) { this.table = table; }
      select() { return this; }
      eq() { return this; }
      in() { return this; }
      is() { return this; }
      insert(payload) { writes.push({ table: this.table, payload }); return this; }
      maybeSingle() {
        if (this.table === 'form') return Promise.resolve({ data: form, error: null });
        if (this.table === 'form_submission') return Promise.resolve({ data: submission, error: null });
        return Promise.resolve({ data: null, error: null });
      }
      then(resolve, reject) {
        const data = this.table === 'custom_object_definition'
          ? [{ id: 'object-1' }]
          : this.table === 'preference_field' ? preferenceFields : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
    }
    return {
      db: {
        from: table => new Query(table),
        rpc: async (name) => {
          rpcCalls.push(name);
          return { data: null, error: null };
        },
      },
      writes,
      rpcCalls,
    };
  };
  const cases = [
    {
      action: {
        id: 'group-create', source: { scope: 'top_level' },
        target: { kind: 'organization_group' }, operation: 'create',
        mappings: [{ id: 'group-name-map', source_field_id: 'name', target_type: 'core', target_field_id: 'name' }],
      },
      fields: [{ id: 'name', type: 'text' }],
      submissionData: { name: 'Untrusted group' },
      authorization: {},
    },
    {
      action: {
        id: 'object-upsert', source: { scope: 'top_level' },
        target: { kind: 'custom_object', custom_object_id: 'object-1' }, operation: 'upsert',
        uniqueness_field: 'object-key',
        mappings: [{
          id: 'object-key-map', source_field_id: 'key', target_type: 'custom',
          target_field_id: 'object-key', is_match: true,
        }],
      },
      fields: [{ id: 'key', type: 'text' }],
      submissionData: { key: 'unmatched' },
      preferenceFields: [{
        id: 'object-key', tenant_id: tenantId, entity_scope: 'custom_object',
        custom_object_id: 'object-1', field_type: 'text', is_active: true, field_key: 'key',
      }],
      authorization: { verifiedMemberId: 'member-1', verifiedOrganizationId: 'org-1' },
    },
  ];
  for (const item of cases) {
    const { db, writes, rpcCalls } = makeDb(item.action, item.fields, item.submissionData, item.preferenceFields);
    await assert.rejects(() => processPersistedStructuredActions({
      db, formId: 'form-1', submissionId: 'submission-1', tenantId,
      authorization: item.authorization,
    }), StructuredActionAuthorizationError);
    assert.deepEqual(rpcCalls, []);
    assert.deepEqual(writes, []);
  }
});

test('an already-running ledger claim keeps the aggregate incomplete and retryable', async () => {
  const tenantId = 'tenant-1';
  const form = {
    id: 'form-running',
    tenant_id: tenantId,
    fields: [{ id: 'group-name', type: 'text' }],
    structured_actions: {
      version: 1,
      actions: [{
        id: 'group-running',
        source: { scope: 'top_level' },
        target: { kind: 'organization_group' },
        operation: 'create',
        mappings: [{ id: 'name-map', source_field_id: 'group-name', target_type: 'core', target_field_id: 'name' }],
      }],
    },
  };
  const submission = {
    id: 'submission-running',
    form_id: form.id,
    tenant_id: tenantId,
    submission_data: { 'group-name': 'Running Group' },
    processing_notes: [],
  };
  class Query {
    constructor(table) { this.table = table; this.payload = null; }
    select() { return this; }
    eq() { return this; }
    update(payload) { this.payload = payload; return this; }
    async maybeSingle() {
      if (this.table === 'form') return { data: form, error: null };
      if (this.table === 'form_submission') return { data: submission, error: null };
      return { data: null, error: null };
    }
    then(resolve, reject) {
      if (this.table === 'form_submission' && this.payload) Object.assign(submission, this.payload);
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    }
  }
  const rpcCalls = [];
  const result = await processPersistedStructuredActions({
    db: {
      from: table => new Query(table),
      rpc: async (name) => {
        rpcCalls.push(name);
        return { data: { claimed: false, status: 'running' }, error: null };
      },
    },
    formId: form.id,
    submissionId: submission.id,
    tenantId,
    authorization: { allowPersistedOrganizationGroupActions: true },
  });
  assert.equal(result.success, false);
  assert.equal(result.incomplete_count, 1);
  assert.equal(result.outcomes[0].reason, 'already_running');
  assert.deepEqual(rpcCalls, ['claim_form_structured_action']);
});

test('relationship parents require verified ownership for non-admin processing', () => {
  assert.throws(() => assertStructuredRelationshipParentAuthorized({
    parentDescriptor: { kind: 'member' },
    parentId: 'victim-member',
    authorization: {},
  }), StructuredActionAuthorizationError);
  assert.throws(() => assertStructuredRelationshipParentAuthorized({
    parentDescriptor: { kind: 'organization' },
    parentId: 'other-org',
    authorization: { verifiedOrganizationId: 'own-org' },
  }), /verified ownership/);
  assert.equal(assertStructuredRelationshipParentAuthorized({
    parentDescriptor: { kind: 'organization' },
    parentId: 'own-org',
    authorization: { verifiedOrganizationId: 'own-org' },
  }), true);
  assert.throws(() => assertStructuredRelationshipParentAuthorized({
    parentDescriptor: { kind: 'organization_group' },
    parentId: 'group-1',
    authorization: { verifiedMemberId: 'own-member', verifiedOrganizationId: 'own-org' },
  }), StructuredActionAuthorizationError);
  assert.equal(assertStructuredRelationshipParentAuthorized({
    parentDescriptor: { kind: 'custom_object' },
    parentId: 'object-record-1',
    authorization: { isAdmin: true },
  }), true);
});

test('rejects direct record IDs, incomplete repeatable scope, and missing mapping IDs', () => {
  const base = {
    version: 1,
    actions: [{
      id: 'action',
      source: { scope: 'top_level' },
      target: { kind: 'member' },
      operation: 'create',
      mappings: [{ id: 'email-map', source_field_id: 'email', target_field_id: 'email', target_type: 'core' }],
    }],
  };
  assert.throws(() => validateStructuredActionsContract({
    ...base,
    actions: [{ ...base.actions[0], operation: 'update', target_record_id: 'forged-id' }],
  }, [{ id: 'email', type: 'email' }]), /Invalid persisted/);
  assert.throws(() => validateStructuredActionsContract({
    ...base,
    actions: [{ ...base.actions[0], source: { scope: 'repeatable_row' } }],
  }, [repeatable]), /Invalid persisted/);
  assert.throws(() => validateStructuredActionsContract({
    ...base,
    actions: [{ ...base.actions[0], mappings: [{ source_field_id: 'email', target_field_id: 'email', target_type: 'core' }] }],
  }, [{ id: 'email', type: 'email' }]), /Invalid persisted/);
});

test('address lookup mappings require a valid persisted component', () => {
  const action = {
    version: 1,
    actions: [{
      id: 'address-action',
      source: { scope: 'top_level' },
      target: { kind: 'organization' },
      operation: 'create',
      mappings: [{
        id: 'town-map',
        source_field_id: 'address',
        source_component: 'post_town',
        target_field_id: 'name',
        target_type: 'core',
      }],
    }],
  };
  assert.doesNotThrow(() => validateStructuredActionsContract(action, [
    { id: 'address', type: 'address_lookup' },
  ]));
  assert.throws(() => validateStructuredActionsContract(action, [
    { id: 'address', type: 'address_lookup', visible_components: ['line_1', 'postcode', 'country'] },
  ]), /Invalid persisted/);
  assert.throws(() => validateStructuredActionsContract({
    ...action,
    actions: [{
      ...action.actions[0],
      mappings: [{ ...action.actions[0].mappings[0], source_component: 'uprn' }],
    }],
  }, [{ id: 'address', type: 'address_lookup' }]), /Invalid persisted/);
  assert.throws(() => validateStructuredActionsContract({
    ...action,
    actions: [{
      ...action.actions[0],
      mappings: [{ ...action.actions[0].mappings[0], source_component: undefined }],
    }],
  }, [{ id: 'address', type: 'address_lookup' }]), /Invalid persisted/);
});

test('record-reference capability is metadata-driven and rejects incompatible or multi-record pickers', () => {
  assert.deepEqual(recordReferenceFieldCapability({
    id: 'department',
    type: 'relationship_dropdown',
    related_kind: 'custom_object',
    related_custom_object_id: 'department-object',
  }), {
    kind: 'custom_object',
    customObjectId: 'department-object',
    cardinality: 'single',
    supportsNotListed: false,
  });
  assert.equal(recordReferenceFieldCapability({ id: 'ordinary', type: 'select' }), null);

  const baseAction = {
    id: 'resolve-department',
    source: { scope: 'top_level' },
    target: { kind: 'custom_object', custom_object_id: 'department-object' },
    operation: 'resolve_record_reference',
    not_listed_operation: 'upsert',
    record_reference_field_id: 'department',
    mappings: [{
      id: 'name-map', source_field_id: 'department-name',
      target_type: 'custom', target_field_id: 'department-name-field',
    }],
  };
  const missingOperation = { ...baseAction };
  delete missingOperation.not_listed_operation;
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [missingOperation],
  }, [
    {
      id: 'department', type: 'relationship_dropdown',
      related_kind: 'custom_object', related_custom_object_id: 'department-object',
      not_listed_choice: { enabled: true, label: 'Not listed' },
    },
    { id: 'department-name', type: 'text' },
  ]), error => {
    assert.match(error.details.join(' '), /not_listed_operation must be create or upsert/);
    return true;
  });
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [baseAction],
  }, [
    { id: 'department', type: 'select' },
    { id: 'department-name', type: 'text' },
  ]), error => {
    assert.match(error.details.join(' '), /compatible record-reference picker/);
    return true;
  });
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [baseAction],
  }, [
    {
      id: 'department', type: 'relationship_dropdown', selection_mode: 'multiple',
      related_kind: 'custom_object', related_custom_object_id: 'department-object',
    },
    { id: 'department-name', type: 'text' },
  ]), error => {
    assert.match(error.details.join(' '), /single-record picker/);
    return true;
  });
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{ ...baseAction, target: { kind: 'organization' } }],
  }, [
    {
      id: 'department', type: 'relationship_dropdown',
      related_kind: 'custom_object', related_custom_object_id: 'department-object',
    },
    { id: 'department-name', type: 'text' },
  ]), error => {
    assert.match(error.details.join(' '), /incompatible with the action target/);
    return true;
  });
});

test('resolves existing and Not-listed organization references per persisted row with canonical retry output', async () => {
  const tenantId = 'tenant-resolver';
  const picker = {
    id: 'organization-picker',
    type: 'organisation_dropdown',
    not_listed_choice: { enabled: true, label: 'Not listed' },
  };
  const rowsField = {
    id: 'rows',
    type: 'repeatable_row',
    repeatable_row: { version: 1, child_fields: [picker] },
  };
  const action = {
    id: 'resolve-organization',
    source: { scope: 'repeatable_row', repeatable_field_id: rowsField.id },
    target: { kind: 'organization' },
    operation: 'resolve_record_reference',
    not_listed_operation: 'upsert',
    reference_field_id: picker.id,
    uniqueness_field: 'name',
    identity_mapping: {
      id: 'organization-name',
      source_type: 'not_listed_text',
      source_field_id: picker.id,
      target_type: 'core',
      target_field_id: 'name',
    },
    companion_mappings: [],
    mappings: [],
  };
  const form = {
    id: 'resolver-form',
    tenant_id: tenantId,
    fields: [rowsField],
    structured_actions: { version: 1, actions: [action] },
  };
  const submission = {
    id: 'resolver-submission',
    form_id: form.id,
    tenant_id: tenantId,
    processing_notes: [],
    submission_data: {
      rows: [
        { _row_id: 'listed-row', [picker.id]: 'organization-existing' },
        {
          _row_id: 'other-row',
          [picker.id]: FORM_NOT_LISTED_VALUE,
          [FORM_NOT_LISTED_TEXT_KEY]: { [picker.id]: 'Row-local New Organisation' },
        },
      ],
    },
  };
  const store = {
    organization: [{ id: 'organization-existing', tenant_id: tenantId, name: 'Existing' }],
    preference_field: [],
  };
  const ledger = new Map();
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.ilikeFilters = [];
      this.operation = null;
      this.payload = null;
    }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    is() { return this; }
    in() { return this; }
    limit() { return this; }
    ilike(key, value) { this.ilikeFilters.push([key, value]); return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    source() {
      if (this.table === 'form') return [form];
      if (this.table === 'form_submission') return [submission];
      return store[this.table] || [];
    }
    matches(row) {
      return this.filters.every(([key, value]) => String(row[key]) === String(value))
        && this.ilikeFilters.every(([key, value]) =>
          String(row[key] || '').toLowerCase() === String(value).toLowerCase());
    }
    async maybeSingle() {
      if (this.operation === 'update') {
        const row = this.source().find(candidate => this.matches(candidate));
        if (row) Object.assign(row, this.payload);
        return { data: row || null, error: null };
      }
      return { data: this.source().find(candidate => this.matches(candidate)) || null, error: null };
    }
    async single() {
      if (this.operation === 'insert') {
        const row = { id: this.payload.id || `organization-${store.organization.length + 1}`, ...this.payload };
        this.source().push(row);
        return { data: row, error: null };
      }
      return this.maybeSingle();
    }
    then(resolve, reject) {
      if (this.operation === 'update') {
        for (const row of this.source().filter(candidate => this.matches(candidate))) {
          Object.assign(row, this.payload);
        }
      }
      return Promise.resolve({
        data: this.source().filter(candidate => this.matches(candidate)),
        error: null,
      }).then(resolve, reject);
    }
  }
  const db = {
    from: table => new Query(table),
    rpc: async (name, input) => {
      const key = `${input.p_action_id}:${input.p_row_identity}`;
      if (name === 'claim_form_structured_action') {
        const prior = ledger.get(key);
        return {
          data: prior?.status === 'completed'
            ? { ...prior, claimed: false }
            : { claimed: true, claim_token: key, record_id: `reserved-${input.p_row_identity}` },
          error: null,
        };
      }
      ledger.set(key, { status: input.p_status, record_id: input.p_record_id });
      return { data: null, error: null };
    },
  };

  const first = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId,
    authorization: { allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(first.success, true, JSON.stringify(first.outcomes));
  assert.deepEqual(first.outcomes.map(outcome => [
    outcome.record_id,
    outcome.operation,
    outcome.record_reference,
  ]), [
    [
      'organization-existing',
      'resolved_existing',
      { record_id: 'organization-existing', kind: 'organization', custom_object_id: null },
    ],
    [
      'organization-2',
      'created',
      { record_id: 'organization-2', kind: 'organization', custom_object_id: null },
    ],
  ]);
  assert.equal(store.organization.find(row => row.id === 'organization-2').name, 'Row-local New Organisation');
  assert.equal(store.organization.length, 2);

  const retry = await processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.ok(retry.outcomes.every(outcome => outcome.status === 'already_completed'));
  assert.deepEqual(retry.outcomes.map(outcome => outcome.record_reference.record_id), [
    'organization-existing',
    'organization-2',
  ]);
  assert.equal(store.organization.length, 2);

  submission.processing_notes = [];
  ledger.clear();
  submission.submission_data.rows[0][picker.id] = ['organization-existing'];
  await assert.rejects(() => processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  }), /Invalid organization selection/);
  assert.equal(ledger.size, 0);

  submission.processing_notes = [];
  ledger.clear();
  submission.submission_data.rows[0][picker.id] = 'organization-existing';
  store.organization[0].tenant_id = 'another-tenant';
  await assert.rejects(() => processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  }), /Invalid relationship selector|Invalid organization selection/);
  assert.equal(ledger.size, 0);

  store.organization[0].tenant_id = tenantId;
  delete submission.submission_data.rows[1][FORM_NOT_LISTED_TEXT_KEY];
  await assert.rejects(() => processPersistedStructuredActions({
    db, formId: form.id, submissionId: submission.id, tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  }), /specify the not-listed value/);
  assert.equal(ledger.size, 0);
});

function customResolverFixture({
  includeLink = false,
  ambiguous = false,
  notListedOperation = 'upsert',
  identityFieldType = 'text',
  identityText = 'New Department',
} = {}) {
  const tenantId = 'tenant-custom-resolver';
  const objectId = 'department-object';
  const definition = {
    id: 'department-organization', tenant_id: tenantId, status: 'active',
    source_kind: 'custom_object', source_custom_object_id: objectId,
    target_kind: 'organization', target_custom_object_id: null,
    show_on_target: true,
  };
  const picker = {
    id: 'department', type: 'relationship_dropdown',
    parent_field_id: 'organization', parent_field_scope: 'row',
    relationship_definition_id: definition.id,
    relationship_parent_kind: 'organization',
    relationship_parent_side: 'target',
    related_kind: 'custom_object',
    related_custom_object_id: objectId,
    related_primary_display_field_id: 'department-name',
    not_listed_choice: { enabled: true, label: 'Not listed' },
  };
  const rowsField = {
    id: 'rows', type: 'repeatable_row',
    repeatable_row: { version: 1, child_fields: [
      { id: 'organization', type: 'organisation_dropdown' },
      picker,
    ] },
  };
  const resolver = {
    id: 'resolve-department',
    source: { scope: 'repeatable_row', repeatable_field_id: rowsField.id },
    target: { kind: 'custom_object', custom_object_id: objectId },
    operation: 'resolve_record_reference',
    reference_field_id: picker.id,
    not_listed_operation: notListedOperation,
    uniqueness_field: notListedOperation === 'upsert' ? 'department-name' : null,
    identity_mapping: {
      id: 'identity', source_type: 'not_listed_text', source_field_id: picker.id,
      target_type: 'custom', target_field_id: 'department-name',
    },
    companion_mappings: [],
    mappings: [],
  };
  const link = {
    id: 'link-department',
    source: resolver.source,
    operation: 'link_relationship',
    relationship_definition_id: definition.id,
    source_endpoint: {
      kind: 'custom_object', custom_object_id: objectId,
      source: { type: 'action_output', action_id: resolver.id },
    },
    target_endpoint: {
      kind: 'organization',
      source: { type: 'field', scope: 'row', field_id: 'organization' },
    },
  };
  const form = {
    id: 'custom-resolver-form', tenant_id: tenantId, fields: [rowsField],
    structured_actions: { version: 1, actions: includeLink ? [resolver, link] : [resolver] },
  };
  const submission = {
    id: 'custom-resolver-submission', form_id: form.id, tenant_id: tenantId,
    processing_notes: [],
    submission_data: { rows: [
      { _row_id: 'row-a', organization: 'org-a', department: 'department-existing' },
      {
        _row_id: 'row-b', organization: 'org-b', department: FORM_NOT_LISTED_VALUE,
        [FORM_NOT_LISTED_TEXT_KEY]: { department: identityText },
      },
    ] },
  };
  const store = {
    organization: [
      { id: 'org-a', tenant_id: tenantId },
      { id: 'org-b', tenant_id: tenantId },
    ],
    custom_object_definition: [{
      id: objectId, tenant_id: tenantId, status: 'active',
      primary_display_field_id: 'department-name',
    }],
    preference_field: [{
      id: 'department-name', tenant_id: tenantId, custom_object_id: objectId,
      entity_scope: 'custom_object', is_active: true, field_type: identityFieldType,
      field_key: 'name', name: 'name', label: 'Name',
    }],
    custom_object_record: [
      { id: 'department-existing', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'Existing' } },
      ...(ambiguous ? [
        { id: 'duplicate-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'New Department' } },
        { id: 'duplicate-2', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'New Department' } },
      ] : []),
    ],
    custom_object_relationship_definition: [definition],
    custom_object_relationship: [{
      id: 'edge-existing', tenant_id: tenantId,
      relationship_definition_id: definition.id,
      source_record_id: 'department-existing', target_record_id: 'org-a',
      archived_at: null,
    }],
  };
  const ledger = new Map();
  let failNewLink = false;
  let busyRecordIdentity = null;
  class Query {
    constructor(table) {
      this.table = table; this.filters = []; this.nulls = []; this.containsFilters = [];
      this.payload = null; this.operation = null; this.max = null;
    }
    select() { return this; }
    eq(k, v) { this.filters.push([k, v]); return this; }
    is(k, v) { this.nulls.push([k, v]); return this; }
    in(k, values) { this.filters.push([k, new Set(values.map(String))]); return this; }
    contains(k, value) { this.containsFilters.push([k, value]); return this; }
    ilike(k, value) { this.filters.push([k, String(value).replaceAll('\\', '').toLowerCase()]); return this; }
    limit(value) { this.max = value; return this; }
    order() { return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    source() {
      if (this.table === 'form') return [form];
      if (this.table === 'form_submission') return [submission];
      return store[this.table] || [];
    }
    matches(row) {
      return this.filters.every(([k, v]) => v instanceof Set
        ? v.has(String(row[k]))
        : String(row[k]).toLowerCase() === String(v).toLowerCase())
        && this.nulls.every(([k, v]) => row[k] === v)
        && this.containsFilters.every(([k, value]) =>
          Object.entries(value).every(([key, expected]) => row[k]?.[key] === expected));
    }
    rows() {
      const rows = this.source().filter(row => this.matches(row));
      return this.max == null ? rows : rows.slice(0, this.max);
    }
    async maybeSingle() {
      if (this.operation === 'update') {
        const row = this.rows()[0] || null;
        if (row) Object.assign(row, this.payload);
        return { data: row, error: null };
      }
      return { data: this.rows()[0] || null, error: null };
    }
    async single() {
      if (this.operation === 'insert') {
        if (this.table === 'custom_object_relationship' && failNewLink
          && this.payload.target_record_id === 'org-b') {
          return { data: null, error: { code: '23505', constraint: 'custom_object_relationship_target_cardinality', message: 'temporary conflict' } };
        }
        const row = { id: this.payload.id || `${this.table}-${this.source().length + 1}`, archived_at: null, ...this.payload };
        this.source().push(row);
        return { data: row, error: null };
      }
      return this.maybeSingle();
    }
    then(resolve, reject) {
      if (this.operation === 'insert') {
        return this.single().then(result => resolve(result), reject);
      }
      if (this.operation === 'update') {
        for (const row of this.rows()) Object.assign(row, this.payload);
      }
      return Promise.resolve({ data: this.rows(), error: null }).then(resolve, reject);
    }
  }
  const db = {
    from: table => new Query(table),
    rpc: async (name, input) => {
      const key = `${input.p_action_id}:${input.p_row_identity}`;
      if (name === 'claim_form_structured_action') {
        if (busyRecordIdentity && input.p_row_identity.includes(busyRecordIdentity)) {
          return { data: { claimed: false }, error: null };
        }
        const prior = ledger.get(key);
        if (prior?.fingerprint && prior.fingerprint !== input.p_fingerprint) {
          return { data: null, error: new Error('fingerprint drift') };
        }
        if (!prior) ledger.set(key, { status: 'processing', fingerprint: input.p_fingerprint });
        return { data: prior?.status === 'completed'
          ? { ...prior, claimed: false }
          : { claimed: true, claim_token: key, record_id: `reserved-${input.p_row_identity}` }, error: null };
      }
      ledger.set(key, {
        ...ledger.get(key),
        status: input.p_status,
        record_id: input.p_record_id,
      });
      return { data: null, error: null };
    },
  };
  return {
    tenantId, objectId, definition, picker, form, submission, store, ledger, db,
    setFailNewLink(value) { failNewLink = value; },
    setBusyRecordIdentity(value) { busyRecordIdentity = value; },
  };
}

test('primary pipeline endpoints wait before ledger claim, then complete row-local links idempotently', async () => {
  const fixture = customResolverFixture();
  fixture.form.entity_pipelines = {
    members: [{ id: 'primary-member', isPrimary: true }],
    organisations: [],
  };
  fixture.store.member = [{ id: 'member-created', tenant_id: fixture.tenantId }];
  const memberRelationship = {
    id: 'department-member',
    tenant_id: fixture.tenantId,
    status: 'active',
    source_kind: 'custom_object',
    source_custom_object_id: fixture.objectId,
    target_kind: 'member',
    target_custom_object_id: null,
  };
  fixture.store.custom_object_relationship_definition.push(memberRelationship);
  fixture.form.structured_actions.actions.push({
    id: 'link-department-member',
    source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
    operation: 'link_relationship',
    relationship_definition_id: memberRelationship.id,
    source_endpoint: {
      kind: 'custom_object',
      custom_object_id: fixture.objectId,
      source: { type: 'action_output', action_id: 'resolve-department' },
    },
    target_endpoint: {
      kind: 'member',
      source: { type: 'primary_pipeline_output' },
    },
  });
  const authorization = { isAdmin: true, allowPersistedRecordReferenceWrites: true };
  const recordCountBeforePrimary = fixture.store.custom_object_record.length;

  const prePipeline = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization,
  });
  assert.equal(prePipeline.success, false);
  assert.equal(prePipeline.incomplete_count, 4);
  assert.equal(fixture.store.custom_object_record.length, recordCountBeforePrimary);
  assert.equal(fixture.ledger.size, 0, 'nothing may claim or mutate before the primary pipeline');
  assert.ok(prePipeline.outcomes.every(
    outcome => outcome.reason === 'primary_pipeline_output_unavailable',
  ));
  assert.deepEqual(
    prePipeline.outcomes
      .filter(outcome => outcome.action_id === 'link-department-member')
      .map(outcome => [outcome.row_index, outcome.status, outcome.reason]),
    [
      [0, 'skipped', 'primary_pipeline_output_unavailable'],
      [1, 'skipped', 'primary_pipeline_output_unavailable'],
    ],
  );
  assert.equal(
    [...fixture.ledger.keys()].some(key => key.startsWith('link-department-member:')),
    false,
    'a relationship waiting for the primary pipeline must not claim its ledger row',
  );

  const postPipeline = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization,
    primaryRecords: { memberId: 'member-created' },
  });
  assert.equal(postPipeline.success, true, JSON.stringify(postPipeline));
  assert.deepEqual(
    postPipeline.outcomes
      .filter(outcome => outcome.action_id === 'link-department-member')
      .map(outcome => [outcome.row_index, outcome.status]),
    [[0, 'completed'], [1, 'completed']],
  );
  assert.equal(
    fixture.store.custom_object_relationship.filter(
      edge => edge.relationship_definition_id === memberRelationship.id,
    ).length,
    2,
  );

  const retry = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization,
    primaryRecords: { memberId: 'member-created' },
  });
  assert.equal(retry.success, true);
  assert.ok(
    retry.outcomes
      .filter(outcome => outcome.action_id === 'link-department-member')
      .every(outcome => outcome.status === 'already_completed'),
  );
  assert.equal(
    fixture.store.custom_object_relationship.filter(
      edge => edge.relationship_definition_id === memberRelationship.id,
    ).length,
    2,
  );
  fixture.store.member.push({ id: 'different-member', tenant_id: fixture.tenantId });
  await assert.rejects(
    processPersistedStructuredActions({
      db: fixture.db,
      formId: fixture.form.id,
      submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization,
      primaryRecords: { memberId: 'different-member' },
    }),
    /fingerprint drift/,
  );
});

test('Custom Object creates compose canonical resolved record labels and keep them stable on retry', async () => {
  const fixture = customResolverFixture({ includeLink: false });
  const assignmentObjectId = 'member-organization-assignment';
  const assignmentNameFieldId = 'assignment-name';
  const organizationResolver = {
    id: 'resolve-organization',
    label: 'Resolve secondary Organisation',
    source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
    target: { kind: 'organization' },
    operation: 'resolve_record_reference',
    reference_field_id: 'organization',
    not_listed_operation: 'upsert',
    uniqueness_field: 'name',
    identity_mapping: {
      id: 'organization-name',
      source_type: 'not_listed_text',
      source_field_id: 'organization',
      target_type: 'core',
      target_field_id: 'name',
    },
    companion_mappings: [],
    mappings: [],
  };
  const assignmentCreate = {
    id: 'create-assignment',
    label: 'Create secondary Organisation assignment',
    source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
    target: { kind: 'custom_object', custom_object_id: assignmentObjectId },
    operation: 'create',
    mappings: [{
      id: 'assignment-display-name',
      source_type: 'resolved_record_labels',
      record_sources: [
        { type: 'primary_pipeline_output', kind: 'member' },
        { type: 'action_output', action_id: organizationResolver.id },
      ],
      separator: ' - ',
      target_type: 'custom',
      target_field_id: assignmentNameFieldId,
    }],
  };
  fixture.form.fields[0].repeatable_row.child_fields[0].not_listed_choice = {
    enabled: true,
    label: 'Not listed',
  };
  fixture.form.entity_pipelines = {
    members: [{ id: 'primary-member', isPrimary: true }],
    organisations: [],
  };
  fixture.form.structured_actions.actions = [
    organizationResolver,
    assignmentCreate,
    ...fixture.form.structured_actions.actions,
  ];
  fixture.store.member = [{
    id: 'member-created',
    tenant_id: fixture.tenantId,
    first_name: 'Alex',
    last_name: 'Morgan',
    email: 'alex@example.test',
  }];
  fixture.store.organization.forEach((organization, index) => {
    organization.name = index === 0 ? 'North Site' : 'South Site';
  });
  fixture.store.custom_object_definition.push({
    id: assignmentObjectId,
    tenant_id: fixture.tenantId,
    status: 'active',
    primary_display_field_id: assignmentNameFieldId,
  });
  fixture.store.preference_field.push({
    id: assignmentNameFieldId,
    tenant_id: fixture.tenantId,
    custom_object_id: assignmentObjectId,
    entity_scope: 'custom_object',
    is_active: true,
    is_required: true,
    field_type: 'text',
    field_key: 'name',
    name: 'name',
    label: 'Name',
  });
  const authorization = {
    isAdmin: true,
    allowPersistedRecordReferenceWrites: true,
    allowPersistedCustomObjectCreates: true,
  };

  const result = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization,
    primaryRecords: { memberId: 'member-created' },
  });
  assert.equal(result.success, true, JSON.stringify(result.outcomes));
  const assignments = fixture.store.custom_object_record.filter(
    record => record.custom_object_id === assignmentObjectId,
  );
  assert.deepEqual(assignments.map(record => record.data.name), [
    'Alex Morgan - North Site',
    'Alex Morgan - South Site',
  ]);

  fixture.store.member[0].first_name = 'Renamed';
  fixture.store.organization[0].name = 'Renamed Site';
  const retry = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization,
    primaryRecords: { memberId: 'member-created' },
  });
  assert.ok(retry.outcomes.every(outcome => outcome.status === 'already_completed'));
  assert.equal(
    fixture.store.custom_object_record.filter(record => record.custom_object_id === assignmentObjectId).length,
    2,
  );
  assert.deepEqual(assignments.map(record => record.data.name), [
    'Alex Morgan - North Site',
    'Alex Morgan - South Site',
  ]);
});

test('resolved record label mappings reject unsafe dependencies while static mappings remain valid', () => {
  const fields = [{
    id: 'rows',
    type: 'repeatable_row',
    repeatable_row: { version: 1, child_fields: [{ id: 'name', type: 'text' }] },
  }];
  const create = {
    id: 'create-assignment',
    source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
    target: { kind: 'custom_object', custom_object_id: 'assignment-object' },
    operation: 'create',
    mappings: [{
      id: 'name',
      source_type: 'static',
      static_value: 'Legacy static label',
      target_type: 'custom',
      target_field_id: 'assignment-name',
    }],
  };
  assert.doesNotThrow(() => validateStructuredActionsContract({
    version: 1,
    actions: [create],
  }, fields));
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [{
      ...create,
      mappings: [{
        ...create.mappings[0],
        source_type: 'resolved_record_labels',
        static_value: undefined,
        record_sources: [{ type: 'action_output', action_id: 'future-action' }],
      }],
    }],
  }, fields), /Invalid persisted/);
});

test('primary pipeline endpoints require a matching persisted primary pipeline', async () => {
  const fixture = customResolverFixture();
  fixture.form.structured_actions.actions.push({
    id: 'link-department-member',
    source: { scope: 'repeatable_row', repeatable_field_id: 'rows' },
    operation: 'link_relationship',
    relationship_definition_id: 'department-member',
    source_endpoint: {
      kind: 'custom_object',
      custom_object_id: fixture.objectId,
      source: { type: 'action_output', action_id: 'resolve-department' },
    },
    target_endpoint: {
      kind: 'member',
      source: { type: 'primary_pipeline_output' },
    },
  });
  fixture.store.custom_object_relationship_definition.push({
    id: 'department-member',
    tenant_id: fixture.tenantId,
    status: 'active',
    source_kind: 'custom_object',
    source_custom_object_id: fixture.objectId,
    target_kind: 'member',
    target_custom_object_id: null,
  });

  await assert.rejects(
    processPersistedStructuredActions({
      db: fixture.db,
      formId: fixture.form.id,
      submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
      primaryRecords: { memberId: 'member-created' },
    }),
    /require configured primary pipelines: member/,
  );
});

test('trusted non-admin processing resolves selected and Not-listed Custom Object records canonically', async () => {
  for (const notListedOperation of ['create', 'upsert']) {
    const fixture = customResolverFixture({ notListedOperation });
    const result = await processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    });
    assert.equal(result.success, true, JSON.stringify(result.outcomes));
    assert.deepEqual(result.outcomes.map(outcome => outcome.record_reference), [
      { record_id: 'department-existing', kind: 'custom_object', custom_object_id: fixture.objectId },
      { record_id: 'reserved-row-b', kind: 'custom_object', custom_object_id: fixture.objectId },
    ]);
    assert.equal(fixture.store.custom_object_record.length, 2);
    const retry = await processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    });
    assert.ok(retry.outcomes.every(outcome => outcome.status === 'already_completed'));
    assert.deepEqual(retry.outcomes.map(outcome => outcome.record_reference),
      result.outcomes.map(outcome => outcome.record_reference));
    assert.equal(fixture.store.custom_object_record.length, 2);
  }
});

test('fans out a multi-record picker with stable item retries and collection relationship output', async () => {
  const fixture = customResolverFixture({ includeLink: true });
  const resolver = fixture.form.structured_actions.actions[0];
  resolver.operation = 'resolve_record_references';
  fixture.picker.selection_mode = 'multiple';
  fixture.submission.submission_data.rows[0].department = [
    'department-existing',
    'department-second',
  ];
  fixture.submission.submission_data.rows[1].department = [FORM_NOT_LISTED_VALUE];
  fixture.store.custom_object_record.push({
    id: 'department-second',
    tenant_id: fixture.tenantId,
    custom_object_id: fixture.objectId,
    archived_at: null,
    data: { name: 'Second' },
  });
  fixture.store.custom_object_relationship.push({
    id: 'edge-second',
    tenant_id: fixture.tenantId,
    relationship_definition_id: fixture.definition.id,
    source_record_id: 'department-second',
    target_record_id: 'org-a',
    archived_at: null,
  });

  const first = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(first.success, true, JSON.stringify(first.outcomes));
  const resolverOutcomes = first.outcomes.filter(outcome => outcome.action_id === resolver.id);
  assert.equal(resolverOutcomes.length, 3);
  assert.ok(resolverOutcomes.every(outcome => outcome.record_reference?.kind === 'custom_object'));
  assert.equal(new Set(resolverOutcomes.map(outcome => outcome.invocation_key)).size, 3);
  assert.deepEqual(fixture.store.custom_object_relationship.map(edge => [
    edge.source_record_id, edge.target_record_id,
  ]), [
    ['department-existing', 'org-a'],
    ['department-second', 'org-a'],
    [resolverOutcomes.find(outcome => outcome.operation === 'created').record_id, 'org-b'],
  ]);

  fixture.submission.submission_data.rows[0].department.reverse();
  fixture.submission.processing_notes = [];
  const retry = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(retry.success, true, JSON.stringify(retry.outcomes));
  assert.ok(retry.outcomes.every(outcome => outcome.status === 'already_completed'));
  assert.equal(fixture.store.custom_object_record.length, 3);
  assert.equal(fixture.store.custom_object_relationship.length, 3);
});

test('blocks a relationship until every multi-reference item has completed', async () => {
  const fixture = customResolverFixture({ includeLink: true });
  const resolver = fixture.form.structured_actions.actions[0];
  const link = fixture.form.structured_actions.actions[1];
  const linkDefinition = {
    ...fixture.definition,
    id: 'department-organization-fanout',
  };
  fixture.store.custom_object_relationship_definition.push(linkDefinition);
  link.relationship_definition_id = linkDefinition.id;
  resolver.operation = 'resolve_record_references';
  fixture.picker.selection_mode = 'multiple';
  fixture.submission.submission_data.rows[0].department = [
    'department-existing',
    'department-second',
  ];
  fixture.submission.submission_data.rows[1]._deleted = true;
  fixture.store.custom_object_record.push({
    id: 'department-second',
    tenant_id: fixture.tenantId,
    custom_object_id: fixture.objectId,
    archived_at: null,
    data: { name: 'Second' },
  });
  fixture.store.custom_object_relationship.push({
    id: 'edge-second-picker',
    tenant_id: fixture.tenantId,
    relationship_definition_id: fixture.definition.id,
    source_record_id: 'department-second',
    target_record_id: 'org-a',
    archived_at: null,
  });
  fixture.setBusyRecordIdentity('record:department-second');

  const partial = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(partial.success, false);
  assert.equal(
    fixture.store.custom_object_relationship.filter(
      edge => edge.relationship_definition_id === linkDefinition.id,
    ).length,
    0,
  );
  assert.match(
    partial.outcomes.find(outcome => outcome.action_id === 'link-department').error,
    /incomplete record items/,
  );

  fixture.setBusyRecordIdentity(null);
  const retry = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(retry.success, true, JSON.stringify(retry.outcomes));
  assert.deepEqual(
    fixture.store.custom_object_relationship
      .filter(edge => edge.relationship_definition_id === linkDefinition.id)
      .map(edge => edge.source_record_id),
    ['department-existing', 'department-second'],
  );
});

test('does not claim a relationship while a scalar action-output dependency is incomplete', async () => {
  const fixture = customResolverFixture({ includeLink: true });
  fixture.submission.submission_data.rows[1]._deleted = true;
  fixture.setBusyRecordIdentity('row-a');

  const partial = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(partial.success, false);
  assert.equal(
    [...fixture.ledger.keys()].some(key => key.startsWith('link-department:')),
    false,
  );

  fixture.setBusyRecordIdentity(null);
  const retry = await processPersistedStructuredActions({
    db: fixture.db,
    formId: fixture.form.id,
    submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(retry.success, true, JSON.stringify(retry.outcomes));
  assert.equal(
    [...fixture.ledger.keys()].some(key => key.startsWith('link-department:')),
    true,
  );
});

test('rejects two record collections as relationship endpoints before execution', () => {
  const fixture = customResolverFixture();
  const resolver = fixture.form.structured_actions.actions[0];
  resolver.operation = 'resolve_record_references';
  fixture.picker.selection_mode = 'multiple';
  const other = { ...structuredClone(resolver), id: 'resolve-other' };
  const link = {
    id: 'link-two-collections',
    source: resolver.source,
    operation: 'link_relationship',
    relationship_definition_id: 'relationship-two-collections',
    source_endpoint: {
      kind: 'custom_object',
      custom_object_id: fixture.objectId,
      source: { type: 'action_output', action_id: resolver.id },
    },
    target_endpoint: {
      kind: 'custom_object',
      custom_object_id: fixture.objectId,
      source: { type: 'action_output', action_id: other.id },
    },
  };
  assert.throws(() => validateStructuredActionsContract({
    version: 1,
    actions: [resolver, other, link],
  }, fixture.form.fields), error => {
    assert.match(error.details.join(' '), /cannot use record collections for both relationship endpoints/);
    return true;
  });
});

test('Custom Object scalar identities accept email, number, and date then defer typed validation to the service', async () => {
  const validCases = [
    ['email', 'new.department@example.test', 'upsert', 'new.department@example.test'],
    ['number', '42', 'create', 42],
    ['date', '2027-04-05', 'upsert', '2027-04-05'],
  ];
  for (const [identityFieldType, identityText, notListedOperation, expected] of validCases) {
    const fixture = customResolverFixture({
      identityFieldType, identityText, notListedOperation,
    });
    const result = await processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    });
    assert.equal(result.success, true, `${identityFieldType}: ${JSON.stringify(result.outcomes)}`);
    assert.deepEqual(result.outcomes[0].record_reference, {
      record_id: 'department-existing',
      kind: 'custom_object',
      custom_object_id: fixture.objectId,
    });
    assert.deepEqual(result.outcomes[1].record_reference, {
      record_id: 'reserved-row-b',
      kind: 'custom_object',
      custom_object_id: fixture.objectId,
    });
    assert.equal(
      fixture.store.custom_object_record.find(row => row.id === 'reserved-row-b').data.name,
      expected,
    );
  }

  for (const [identityFieldType, identityText] of [
    ['email', 'not-an-email'],
    ['number', 'not-a-number'],
    ['date', 'not-a-date'],
  ]) {
    const fixture = customResolverFixture({
      identityFieldType, identityText, notListedOperation: 'create',
    });
    const result = await processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    });
    assert.equal(result.success, false, identityFieldType);
    assert.equal(result.outcomes[0].status, 'completed');
    assert.equal(result.outcomes[1].status, 'failed');
    assert.equal(fixture.store.custom_object_record.length, 1);
    assert.equal(
      fixture.store.custom_object_record.some(row => row.id === 'reserved-row-b'),
      false,
    );
  }
  for (const identityFieldType of ['textarea', 'list']) {
    const fixture = customResolverFixture({
      identityFieldType, identityText: 'unsupported', notListedOperation: 'upsert',
    });
    await assert.rejects(() => processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    }), /incompatible mapping|ineligible Custom Object uniqueness field/);
    assert.equal(fixture.ledger.size, 0);
    assert.equal(fixture.store.custom_object_record.length, 1);
  }
});

test('typed Custom Object upserts look up canonical number and decimal identity values without duplicates', async () => {
  for (const [identityFieldType, text, typed] of [
    ['number', '42', 42],
    ['decimal', '42.50', 42.5],
  ]) {
    const fixture = customResolverFixture({
      identityFieldType, identityText: text, notListedOperation: 'upsert',
    });
    fixture.store.custom_object_record[0].data.name = typed;
    const first = await processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    });
    assert.equal(first.success, true, JSON.stringify(first.outcomes));
    assert.equal(first.outcomes[1].record_id, 'department-existing');
    assert.equal(fixture.store.custom_object_record.length, 1);

    // A distinct processing attempt with the same canonical typed value still
    // finds the existing record rather than creating another one.
    fixture.submission.processing_notes = [];
    fixture.ledger.clear();
    const second = await processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    });
    assert.equal(second.success, true, JSON.stringify(second.outcomes));
    assert.equal(second.outcomes[1].record_id, 'department-existing');
    assert.equal(fixture.store.custom_object_record.length, 1);
  }
});

test('canonical typed Custom Object identity matches remain ambiguous when more than one record matches', async () => {
  const fixture = customResolverFixture({
    identityFieldType: 'number', identityText: '42', notListedOperation: 'upsert',
  });
  fixture.store.custom_object_record[0].data.name = 42;
  fixture.store.custom_object_record.push(
    { id: 'typed-duplicate-1', tenant_id: fixture.tenantId, custom_object_id: fixture.objectId, archived_at: null, data: { name: 42 } },
    { id: 'typed-duplicate-2', tenant_id: fixture.tenantId, custom_object_id: fixture.objectId, archived_at: null, data: { name: 42 } },
  );
  const result = await processPersistedStructuredActions({
    db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(result.success, false);
  assert.match(result.outcomes[1].error, /ambiguous/);
  assert.equal(fixture.store.custom_object_record.length, 3);
});

test('record-reference upsert rejects a forged companion uniqueness key before claiming', async () => {
  const fixture = customResolverFixture();
  const resolver = fixture.form.structured_actions.actions[0];
  fixture.form.fields[0].repeatable_row.child_fields.push({ id: 'alternate-key', type: 'text' });
  fixture.submission.submission_data.rows.forEach(row => { row['alternate-key'] = 'forged'; });
  fixture.store.preference_field.push({
    id: 'alternate-field', tenant_id: fixture.tenantId,
    custom_object_id: fixture.objectId, entity_scope: 'custom_object',
    is_active: true, field_type: 'text', field_key: 'alternate', name: 'alternate',
  });
  resolver.companion_mappings = [{
    id: 'forged-identity', source_field_id: 'alternate-key',
    target_type: 'custom', target_field_id: 'alternate-field',
  }];
  resolver.uniqueness_field = 'alternate-field';
  await assert.rejects(() => processPersistedStructuredActions({
    db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { allowPersistedRecordReferenceWrites: true },
  }), error => {
    assert.match(error.details.join(' '), /uniqueness_field must equal identity_mapping/);
    return true;
  });
  assert.equal(fixture.ledger.size, 0);
  assert.equal(fixture.store.custom_object_record.length, 1);
});

test('Custom Object resolver rejects ambiguous upsert before creating a record', async () => {
  const fixture = customResolverFixture({ ambiguous: true });
  const result = await processPersistedStructuredActions({
    db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(result.success, false);
  assert.match(result.outcomes.find(outcome => outcome.invocation_key.endsWith('row-b')).error, /ambiguous/);
  assert.equal(fixture.store.custom_object_record.length, 3);
});

test('same-row resolver output links without cross-row mixing and partial retry duplicates nothing', async () => {
  const fixture = customResolverFixture({ includeLink: true });
  fixture.setFailNewLink(true);
  const first = await processPersistedStructuredActions({
    db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(first.failed_count, 1, JSON.stringify(first.outcomes));
  assert.equal(fixture.store.custom_object_record.length, 2);
  fixture.setFailNewLink(false);
  const retry = await processPersistedStructuredActions({
    db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
    tenantId: fixture.tenantId,
    authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
  });
  assert.equal(retry.success, true, JSON.stringify(retry.outcomes));
  assert.equal(fixture.store.custom_object_record.length, 2);
  assert.deepEqual(fixture.store.custom_object_relationship.map(edge => [
    edge.source_record_id, edge.target_record_id,
  ]), [
    ['department-existing', 'org-a'],
    ['reserved-row-b', 'org-b'],
  ]);
});

test('stale resolver relationship side and display metadata fail before ledger claim', async () => {
  for (const stale of ['side', 'display']) {
    const fixture = customResolverFixture();
    if (stale === 'side') fixture.picker.relationship_parent_side = 'source';
    else fixture.store.preference_field[0].is_active = false;
    await assert.rejects(() => processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { allowPersistedRecordReferenceWrites: true },
    }), /relationship configuration|display field/i);
    assert.equal(fixture.ledger.size, 0);
    assert.equal(fixture.store.custom_object_record.length, 1);
  }
});

test('repeatable resolver revalidates the selected edge against its own row parent before claiming', async () => {
  for (const scenario of ['archived-edge', 'different-parent']) {
    const fixture = customResolverFixture({ includeLink: true });
    if (scenario === 'archived-edge') {
      fixture.store.custom_object_relationship[0].archived_at = '2027-01-01T00:00:00.000Z';
    } else {
      fixture.store.custom_object_record.push({
        id: 'department-other', tenant_id: fixture.tenantId,
        custom_object_id: fixture.objectId, archived_at: null,
        data: { name: 'Other Parent Department' },
      });
      fixture.store.custom_object_relationship.push({
        id: 'edge-other-parent', tenant_id: fixture.tenantId,
        relationship_definition_id: fixture.definition.id,
        source_record_id: 'department-other', target_record_id: 'org-b',
        archived_at: null,
      });
      fixture.submission.submission_data.rows[0].department = 'department-other';
    }
    const recordCount = fixture.store.custom_object_record.length;
    const edgeCount = fixture.store.custom_object_relationship.length;
    await assert.rejects(() => processPersistedStructuredActions({
      db: fixture.db, formId: fixture.form.id, submissionId: fixture.submission.id,
      tenantId: fixture.tenantId,
      authorization: { isAdmin: true, allowPersistedRecordReferenceWrites: true },
    }), /Invalid relationship selection/);
    assert.equal(fixture.ledger.size, 0);
    assert.equal(fixture.store.custom_object_record.length, recordCount);
    assert.equal(fixture.store.custom_object_relationship.length, edgeCount);
  }
});