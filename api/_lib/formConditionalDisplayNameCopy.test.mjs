import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConditionalDisplayNameCopies } from './formConditionalDisplayNameCopy.js';
import { validatePaymentRelationships } from '../public/form-payment.js';

function dbWithOrganisation(id = 'org-a', name = 'Authorised Organisation') {
  return {
    from(table) {
      assert.equal(table, 'organization');
      let selectedId = null;
      return {
        select() { return this; },
        eq(column, value) {
          if (column === 'id') selectedId = value;
          return this;
        },
        async maybeSingle() {
          return { data: selectedId === id ? { name } : null, error: null };
        },
      };
    },
  };
}

const form = {
  fields: [
    { id: 'enabled', type: 'text' },
    { id: 'org', type: 'organisation_dropdown' },
    { id: 'name', type: 'text' },
  ],
  visibility_rules: [{
    conditions: [{ field_id: 'enabled', operator: 'equals', value: 'yes' }],
    actions: [{
      action_type: 'set_value',
      set_value_source: 'field',
      set_value_field_id: 'org',
      target_field_id: 'name',
      copy_mode: 'display_name',
    }],
  }],
};

test('shared display-name validator rejects forged and stale public payment values', async () => {
  const common = {
    db: dbWithOrganisation(),
    tenantId: 'tenant-a',
    form,
    relationshipService: {},
  };
  await assert.rejects(
    validateConditionalDisplayNameCopies({
      ...common,
      submissionData: { enabled: 'yes', org: 'org-a', name: 'Forged Name' },
    }),
    error => error.code === 'DISPLAY_NAME_COPY_INVALID' && /stale/.test(error.message),
  );
  await assert.rejects(
    validateConditionalDisplayNameCopies({
      ...common,
      submissionData: { enabled: 'yes', org: 'org-missing', name: 'Old Name' },
    }),
    error => error.code === 'DISPLAY_NAME_COPY_INVALID' && /unavailable/.test(error.message),
  );
});

test('shared display-name validator requires empty targets when active source is cleared', async () => {
  await assert.rejects(
    validateConditionalDisplayNameCopies({
      db: dbWithOrganisation(),
      tenantId: 'tenant-a',
      form,
      submissionData: { enabled: 'yes', org: '', name: 'Stale Name' },
      relationshipService: {},
    }),
    error => error.code === 'DISPLAY_NAME_COPY_INVALID' && /stale/.test(error.message),
  );
});

test('payment relationship validation boundary rejects a forged display name before creation', async () => {
  const sent = [];
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { sent.push(body); } };
  const ok = await validatePaymentRelationships(
    res,
    dbWithOrganisation(),
    { id: 'tenant-a' },
    form,
    { enabled: 'yes', org: 'org-a', name: 'Browser-forged label' },
  );
  assert.equal(ok, false);
  assert.equal(res.statusCode, 400);
  assert.equal(sent[0]?.code, 'DISPLAY_NAME_COPY_INVALID');
  assert.match(sent[0]?.error || '', /stale/);
});

test('shared validator accepts selected Group records but rejects forged Group and relationship labels', async () => {
  const groupDb = {
    from(table) {
      assert.equal(table, 'organization_group');
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: { name: 'North Group' }, error: null }; },
      };
    },
  };
  const groupForm = {
    fields: [
      { id: 'enabled', type: 'text' },
      { id: 'group', type: 'organisation_group_dropdown', not_listed_choice: { enabled: true } },
      { id: 'name', type: 'text' },
    ],
    visibility_rules: [{
      conditions: [{ field_id: 'enabled', operator: 'equals', value: 'yes' }],
      actions: [{ set_value_source: 'field', copy_mode: 'display_name', set_value_field_id: 'group', target_field_id: 'name' }],
    }],
  };
  await validateConditionalDisplayNameCopies({
    db: groupDb, tenantId: 'tenant-a', form: groupForm,
    submissionData: { enabled: 'yes', group: 'group-a', name: 'North Group' }, relationshipService: {},
  });
  await assert.rejects(validateConditionalDisplayNameCopies({
    db: groupDb, tenantId: 'tenant-a', form: groupForm,
    submissionData: { enabled: 'yes', group: 'group-a', name: 'Forged Group' }, relationshipService: {},
  }), error => error.code === 'DISPLAY_NAME_COPY_INVALID');
  await assert.rejects(validateConditionalDisplayNameCopies({
    db: groupDb, tenantId: 'tenant-a', form: groupForm,
    submissionData: { enabled: 'yes', group: '__form_not_listed__', name: '' }, relationshipService: {},
  }), error => error.code === 'DISPLAY_NAME_COPY_INVALID' && /unavailable/.test(error.message));

  const relationshipForm = {
    fields: [
      { id: 'enabled', type: 'text' }, { id: 'parent', type: 'organisation_dropdown' },
      { id: 'relationship', type: 'relationship_dropdown', parent_field_id: 'parent' },
      { id: 'name', type: 'textarea' },
    ],
    visibility_rules: [{
      conditions: [{ field_id: 'enabled', operator: 'equals', value: 'yes' }],
      actions: [{ set_value_source: 'field', copy_mode: 'display_name', set_value_field_id: 'relationship', target_field_id: 'name' }],
    }],
  };
  const relationshipService = {
    async relationshipOptions() { return { data: [{ id: 'relationship-a', label: 'Authorised relationship' }] }; },
  };
  await assert.rejects(validateConditionalDisplayNameCopies({
    db: {}, tenantId: 'tenant-a', form: relationshipForm,
    submissionData: { enabled: 'yes', parent: 'parent-a', relationship: 'relationship-a', name: 'Forged relationship' },
    relationshipService,
  }), error => error.code === 'DISPLAY_NAME_COPY_INVALID');
});

test('relationship display-name validation walks ordinary pages past the public first page', async () => {
  const calls = [];
  const pagedService = {
    async relationshipOptions({ query }) {
      calls.push(query);
      return query.page === 2
        ? { data: [{ id: 'relationship-26', label: 'Twenty Sixth' }], total: 26, page: 2, pageSize: 25 }
        : { data: Array.from({ length: 25 }, (_, index) => ({ id: `relationship-${index + 1}`, label: `Record ${index + 1}` })), total: 26, page: 1, pageSize: 25 };
    },
  };
  const pagedForm = {
    fields: [
      { id: 'enabled', type: 'text' }, { id: 'parent', type: 'organisation_dropdown' },
      { id: 'relationship', type: 'relationship_dropdown', parent_field_id: 'parent' },
      { id: 'name', type: 'text' },
    ],
    visibility_rules: [{
      conditions: [{ field_id: 'enabled', operator: 'equals', value: 'yes' }],
      actions: [{ set_value_source: 'field', copy_mode: 'display_name', set_value_field_id: 'relationship', target_field_id: 'name' }],
    }],
  };
  await validateConditionalDisplayNameCopies({
    db: {}, tenantId: 'tenant-a', form: pagedForm,
    submissionData: {
      enabled: 'yes', parent: 'parent-a', relationship: 'relationship-26', name: 'Twenty Sixth',
    },
    relationshipService: pagedService,
  });
  assert.deepEqual(calls.map(call => call.page), [1, 2]);
  assert.deepEqual(calls.map(call => call.pageSize), [25, 25]);
  assert.equal(calls.some(call => 'all' in call), false);
});

test('paid validation boundary accepts page-two relationship labels and rejects forged labels', async () => {
  const calls = [];
  const relationshipService = {
    async validateSubmission() {},
    async relationshipOptions({ query }) {
      calls.push(query.page);
      return query.page === 2
        ? { data: [{ id: 'relationship-26', label: 'Twenty Sixth' }], total: 26, page: 2, pageSize: 25 }
        : { data: Array.from({ length: 25 }, (_, index) => ({ id: `relationship-${index + 1}`, label: `Record ${index + 1}` })), total: 26, page: 1, pageSize: 25 };
    },
  };
  const paidForm = {
    fields: [
      { id: 'enabled', type: 'text' }, { id: 'parent', type: 'organisation_dropdown' },
      { id: 'relationship', type: 'relationship_dropdown', parent_field_id: 'parent' },
      { id: 'name', type: 'text' },
    ],
    visibility_rules: [{
      conditions: [{ field_id: 'enabled', operator: 'equals', value: 'yes' }],
      actions: [{ set_value_source: 'field', copy_mode: 'display_name', set_value_field_id: 'relationship', target_field_id: 'name' }],
    }],
  };
  const invoke = async (name) => {
    const sent = [];
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { sent.push(body); } };
    const ok = await validatePaymentRelationships(
      res, {}, { id: 'tenant-a' }, paidForm,
      { enabled: 'yes', parent: 'parent-a', relationship: 'relationship-26', name },
      null,
      { relationshipService },
    );
    return { ok, res, sent };
  };
  const accepted = await invoke('Twenty Sixth');
  assert.equal(accepted.ok, true);
  assert.deepEqual(calls, [1, 2]);
  calls.length = 0;
  const forged = await invoke('Forged label');
  assert.equal(forged.ok, false);
  assert.equal(forged.res.statusCode, 400);
  assert.equal(forged.sent[0]?.code, 'DISPLAY_NAME_COPY_INVALID');
  assert.deepEqual(calls, [1, 2]);
});