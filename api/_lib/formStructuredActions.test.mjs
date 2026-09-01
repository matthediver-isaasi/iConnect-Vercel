import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StructuredActionContractError,
  StructuredActionAuthorizationError,
  assertStructuredMutationAuthorized,
  assertStructuredRelationshipParentAuthorized,
  expandStructuredActionInvocations,
  processPersistedStructuredActions,
  processPrimaryPipelineRelatedRecords,
  validatePrimaryPipelineRelatedRecordsContract,
  validateStructuredActionsContract,
} from './formStructuredActions.js';

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