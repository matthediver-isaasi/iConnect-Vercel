import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRepeatableRowSubmission } from './formRepeatableRowValidation.js';
import { createFormRelationshipService } from './formRelationshipOptions.js';

const form = {
  id: 'form-1',
  fields: [{
    id: 'rows',
    type: 'repeatable_row',
    min_rows: 1,
    max_rows: 3,
    children: [
      { id: 'org', type: 'organisation_dropdown', required: true },
      {
        id: 'unit',
        type: 'relationship_dropdown',
        required: true,
        parent_field_id: 'org',
        relationship_definition_id: 'rel-1',
        custom_object_id: 'object-1',
        custom_object_primary_display_field_id: 'name-field',
      },
    ],
  }],
};

test('passes each row to tenant-scoped saved-field validation with row-local values', async () => {
  const calls = [];
  const relationshipService = {
    async validateSubmission(input) {
      calls.push(input);
      if (input.submissionData.org === 'org-2' && input.submissionData.unit !== 'unit-2') {
        throw new Error('stale dependent value');
      }
    },
  };
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form,
    submissionData: {
      rows: [
        { _row_id: 'row-1', org: 'org-1', unit: 'unit-1' },
        { _row_id: 'row-2', org: 'org-2', unit: 'unit-2' },
      ],
    },
    relationshipService,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.submissionData.org), ['org-1', 'org-2']);
  assert.deepEqual(calls[0].form.fields.map((child) => child.id), ['org', 'unit']);
  assert.strictEqual(calls[0].cache, calls[1].cache);
});

test('rejects row tampering before querying dynamic option resolvers', async () => {
  let calls = 0;
  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form,
      submissionData: { rows: [{ org: 'org-1', unit: 'unit-1', forged: true }] },
      relationshipService: { async validateSubmission() { calls += 1; } },
    }),
    (error) => error.status === 400 && error.code === 'unknown_child',
  );
  assert.equal(calls, 0);
});

test('skips initialized invalid rows when the persisted repeatable container starts hidden', async () => {
  let calls = 0;
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: {
      ...form,
      fields: [{ ...form.fields[0], starts_hidden: true }],
    },
    submissionData: { rows: [{ org: '', unit: '' }] },
    relationshipService: { async validateSubmission() { calls += 1; } },
  });
  assert.equal(calls, 0);
});

test('skips initialized invalid rows when a persisted condition hides the container', async () => {
  let calls = 0;
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: {
      ...form,
      fields: [{ id: 'kind', type: 'text' }, form.fields[0]],
      visibility_rules: [{
        trigger_field_id: 'kind',
        operator: 'equals',
        value: 'hide rows',
        action: 'hide',
        target_field_ids: ['rows'],
      }],
    },
    submissionData: { kind: 'hide rows', rows: [{ org: '', unit: '' }] },
    relationshipService: { async validateSubmission() { calls += 1; } },
  });
  assert.equal(calls, 0);
});

test('ignores hidden relationship children inside a visible repeatable container', async () => {
  const calls = [];
  const childVisibilityForm = {
    ...form,
    fields: [{ id: 'kind', type: 'text' }, form.fields[0]],
    visibility_rules: [{
      trigger_field_id: 'kind',
      operator: 'equals',
      value: 'hide unit',
      action: 'hide',
      target_field_ids: ['unit'],
    }],
  };
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: childVisibilityForm,
    submissionData: {
      kind: 'hide unit',
      rows: [{ org: 'org-1', unit: 'stale-forged-unit' }],
    },
    relationshipService: {
      async validateSubmission(input) { calls.push(input); },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].form.fields.map(child => child.id), ['org']);

  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form: childVisibilityForm,
      submissionData: { kind: 'show unit', rows: [{ org: 'org-1', unit: '' }] },
      relationshipService: { async validateSubmission() {} },
    }),
    error => error.status === 400 && error.code === 'required_child',
  );
});

test('ignores required row constraints when every relationship child is hidden', async () => {
  const allHiddenForm = {
    id: 'all-hidden-relationships',
    fields: [
      { id: 'kind', type: 'text' },
      {
        id: 'rows',
        type: 'repeatable_row',
        min_rows: 1,
        max_rows: 1,
        first_row_required: true,
        children: [
          { id: 'org', type: 'organisation_dropdown', required: true },
          { id: 'group', type: 'organisation_group_dropdown', required: true },
          {
            id: 'unit',
            type: 'relationship_dropdown',
            required: true,
            parent_field_id: 'org',
            relationship_definition_id: 'rel-1',
            custom_object_id: 'object-1',
            custom_object_primary_display_field_id: 'name-field',
          },
        ],
      },
    ],
    visibility_rules: [{
      trigger_field_id: 'kind',
      operator: 'equals',
      value: 'hide all',
      action: 'hide',
      target_field_ids: ['org', 'group', 'unit'],
    }],
  };
  let calls = 0;
  const relationshipService = {
    async validateSubmission() { calls += 1; },
  };
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: allHiddenForm,
    submissionData: { kind: 'hide all' },
    relationshipService,
  });
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: allHiddenForm,
    submissionData: {
      kind: 'hide all',
      rows: [{
        _row_id: 'stale-row',
        org: 'stale-org',
        group: 'stale-group',
        unit: 'stale-unit',
      }],
    },
    relationshipService,
  });
  assert.equal(calls, 0);

  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form: allHiddenForm,
      submissionData: {
        kind: 'hide all',
        rows: [
          { org: 'stale-org-1' },
          { org: 'stale-org-2' },
        ],
      },
      relationshipService,
    }),
    error => error.status === 400 && error.code === 'max_rows',
  );
  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form: allHiddenForm,
      submissionData: {
        kind: 'hide all',
        rows: [{ org: 'stale-org', forged: true }],
      },
      relationshipService,
    }),
    error => error.status === 400 && error.code === 'unknown_child',
  );
});

test('skips initialized invalid rows on a hidden page but rejects the same rows on a visible page', async () => {
  const pagedForm = {
    ...form,
    fields: [{ ...form.fields[0], page_id: 'page-2' }],
    pages: [{ id: 'page-2', starts_hidden: true }],
  };
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: pagedForm,
    submissionData: { rows: [{ org: '', unit: '' }] },
    relationshipService: { async validateSubmission() { throw new Error('hidden row queried'); } },
  });
  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form: { ...pagedForm, pages: [{ id: 'page-2' }] },
      submissionData: { rows: [{ org: '', unit: '' }] },
      relationshipService: { async validateSubmission() {} },
    }),
    error => error.status === 400 && error.code === 'required_child',
  );
});

test('rejects missing required values and excessive rows', async () => {
  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form,
      submissionData: {
        rows: [
          { org: 'org-1' },
          { org: 'org-2', unit: 'unit-2' },
          { org: 'org-3', unit: 'unit-3' },
          { org: 'org-4', unit: 'unit-4' },
        ],
      },
      relationshipService: { async validateSubmission() {} },
    }),
    (error) => error.status === 400
      && error.details.some((detail) => detail.code === 'max_rows')
      && error.details.some((detail) => detail.code === 'required_child'),
  );
});

test('rejects duplicate values in a server-trusted unique repeatable column', async () => {
  const uniqueForm = {
    ...form,
    fields: [{
      ...form.fields[0],
      children: form.fields[0].children.map(child => (
        child.id === 'org' ? { ...child, label: 'Organisation', unique_across_rows: true } : child
      )),
    }],
  };
  let calls = 0;
  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form: uniqueForm,
      submissionData: {
        rows: [
          { org: 'org-1', unit: 'unit-1' },
          { org: 'org-1', unit: 'unit-2' },
        ],
      },
      relationshipService: { async validateSubmission() { calls += 1; } },
    }),
    error => error.status === 400
      && error.code === 'duplicate_child_value'
      && error.details.every(detail => detail.code === 'duplicate_child_value'),
  );
  assert.equal(calls, 0);
});

test('rejects persisted earlier-field exclusions before dynamic option lookups', async () => {
  const exclusionForm = {
    id: 'exclusion-form',
    fields: [
      { id: 'primary_org', type: 'organisation_dropdown' },
      {
        id: 'rows',
        type: 'repeatable_rows',
        children: [{
          id: 'org',
          label: 'Additional organisation',
          type: 'organisation_dropdown',
          exclude_values_from: { scope: 'form', source_field_id: 'primary_org' },
        }],
      },
    ],
  };
  let calls = 0;
  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form: exclusionForm,
      submissionData: {
        primary_org: 'org-1',
        rows: [{ org: 'org-1' }],
      },
      relationshipService: { async validateSubmission() { calls += 1; } },
    }),
    error => error.status === 400 && error.code === 'excluded_repeatable_value',
  );
  assert.equal(calls, 0);

  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: exclusionForm,
    submissionData: {
      primary_org: '',
      rows: [{ org: 'org-1' }],
    },
    relationshipService: { async validateSubmission() { calls += 1; } },
  });
  assert.equal(calls, 1);
});

test('rejects any repeated choice contained in a multi-value earlier answer', async () => {
  const exclusionForm = {
    id: 'choice-exclusion-form',
    fields: [
      { id: 'primary_choices', type: 'checkbox', options: ['A', 'B', 'C'] },
      {
        id: 'rows',
        type: 'repeatable_rows',
        children: [{
          id: 'choice',
          type: 'select',
          options: ['A', 'B', 'C'],
          exclude_values_from: { scope: 'form', source_field_id: 'primary_choices' },
        }],
      },
    ],
  };
  await assert.rejects(
    validateRepeatableRowSubmission({
      tenantId: 'tenant-1',
      form: exclusionForm,
      submissionData: {
        primary_choices: ['A', 'B'],
        rows: [{ choice: 'B' }],
      },
      relationshipService: { async validateSubmission() {} },
    }),
    error => error.code === 'excluded_repeatable_value',
  );
});

test('accepts the reserved value only when the persisted repeatable child enables it', async () => {
  const enabledChild = {
    id: 'org',
    type: 'organisation_dropdown',
    required: true,
    not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
  };
  const repeatableForm = {
    id: 'form-not-listed',
    fields: [{
      id: 'rows',
      type: 'repeatable_row',
      min_rows: 1,
      children: [enabledChild],
    }],
  };
  const noQueryDb = { from() { throw new Error('not-listed must not query entity tables'); } };
  const service = createFormRelationshipService({ tenantId: 'tenant-1', db: noQueryDb });

  await validateRepeatableRowSubmission({
    db: noQueryDb,
    tenantId: 'tenant-1',
    form: repeatableForm,
    submissionData: {
      rows: [{
        org: '__form_not_listed__',
        __not_listed_choice_text: { org: 'Acme Ltd' },
      }],
    },
    relationshipService: service,
  });

  await assert.rejects(
    validateRepeatableRowSubmission({
      db: noQueryDb,
      tenantId: 'tenant-1',
      form: {
        ...repeatableForm,
        fields: [{
          ...repeatableForm.fields[0],
          children: [{ ...enabledChild, not_listed_choice: { enabled: false, label: 'Disabled' } }],
        }],
      },
      submissionData: {
        rows: [{
          org: '__form_not_listed__',
          __not_listed_choice_text: { org: 'Acme Ltd' },
        }],
      },
      relationshipService: service,
    }),
    error => error.status === 400 && /Invalid not-listed selection/.test(error.message),
  );
});

test('requires valid not-listed text for each repeatable child row', async () => {
  const repeatableForm = {
    id: 'form-not-listed-text',
    fields: [{
      id: 'rows',
      type: 'repeatable_row',
      min_rows: 1,
      children: [{
        id: 'org',
        type: 'organisation_dropdown',
        required: true,
        not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
      }],
    }],
  };
  const noQueryDb = { from() { throw new Error('invalid text must not query entity tables'); } };
  const service = createFormRelationshipService({ tenantId: 'tenant-1', db: noQueryDb });

  await assert.rejects(
    validateRepeatableRowSubmission({
      db: noQueryDb,
      tenantId: 'tenant-1',
      form: repeatableForm,
      submissionData: { rows: [{ org: '__form_not_listed__' }] },
      relationshipService: service,
    }),
    error => error.status === 400 && /Please specify the not-listed value/.test(error.message),
  );
  await assert.rejects(
    validateRepeatableRowSubmission({
      db: noQueryDb,
      tenantId: 'tenant-1',
      form: repeatableForm,
      submissionData: {
        rows: [{
          org: 'ordinary-org',
          __not_listed_choice_text: { org: 'Acme Ltd' },
        }],
      },
      relationshipService: service,
    }),
    error => error.status === 400 && /must match a not-listed selection/.test(error.message),
  );
});

test('accepts an enabled not-listed sentinel outside persisted static category options', async () => {
  const staticForm = {
    fields: [{
      id: 'rows',
      type: 'repeatable_row',
      min_rows: 1,
      children: [{
        id: 'category',
        type: 'category_multiselect',
        required: true,
        options: ['category-1', 'category-2'],
        not_listed_choice: { enabled: true, label: 'Another category' },
      }],
    }],
  };
  const service = createFormRelationshipService({
    tenantId: 'tenant-1',
    db: { from() { throw new Error('sentinel must not query static option tables'); } },
  });
  await validateRepeatableRowSubmission({
    tenantId: 'tenant-1',
    form: staticForm,
    submissionData: {
      rows: [{
        category: ['__form_not_listed__'],
        __not_listed_choice_text: { category: 'Specialist category' },
      }],
    },
    relationshipService: service,
  });
});

test('accepts an auto-selected not-listed relationship beneath a not-listed row parent', async () => {
  const repeatableForm = {
    fields: [{
      id: 'rows',
      type: 'repeatable_row',
      min_rows: 1,
      children: [
        {
          id: 'org',
          type: 'organisation_dropdown',
          required: true,
          not_listed_choice: { enabled: true, label: 'Organisation is not listed' },
        },
        {
          id: 'department',
          type: 'relationship_dropdown',
          parent_field_id: 'org',
          required: true,
          not_listed_choice: { enabled: true, label: 'Department is not listed' },
        },
      ],
    }],
  };
  const noQueryDb = { from() { throw new Error('not-listed relationship must not query entities'); } };
  await validateRepeatableRowSubmission({
    db: noQueryDb,
    tenantId: 'tenant-1',
    form: repeatableForm,
    submissionData: {
      rows: [{
        org: '__form_not_listed__',
        department: '__form_not_listed__',
        __not_listed_choice_text: {
          org: 'Independent organisation',
          department: 'Specialist department',
        },
      }],
    },
    relationshipService: createFormRelationshipService({
      tenantId: 'tenant-1',
      db: noQueryDb,
    }),
  });

  await assert.rejects(
    validateRepeatableRowSubmission({
      db: noQueryDb,
      tenantId: 'tenant-1',
      form: repeatableForm,
      submissionData: {
        rows: [{
          org: '__form_not_listed__',
          department: '__form_not_listed__',
          __not_listed_choice_text: { org: 'Independent organisation' },
        }],
      },
      relationshipService: createFormRelationshipService({
        tenantId: 'tenant-1',
        db: noQueryDb,
      }),
    }),
    error => error.status === 400 && /Please specify the not-listed value/.test(error.message),
  );

  await assert.rejects(
    validateRepeatableRowSubmission({
      db: noQueryDb,
      tenantId: 'tenant-1',
      form: {
        ...repeatableForm,
        fields: [{
          ...repeatableForm.fields[0],
          children: repeatableForm.fields[0].children.map(child => (
            child.id === 'department'
              ? { ...child, not_listed_choice: { enabled: false, label: 'Disabled' } }
              : child
          )),
        }],
      },
      submissionData: {
        rows: [{
          org: '__form_not_listed__',
          department: '__form_not_listed__',
          __not_listed_choice_text: {
            org: 'Independent organisation',
            department: 'Forged department',
          },
        }],
      },
      relationshipService: createFormRelationshipService({
        tenantId: 'tenant-1',
        db: noQueryDb,
      }),
    }),
    error => error.status === 400 && /Invalid not-listed selection/.test(error.message),
  );
});

function customObjectRowSourceFixture() {
  const id = suffix => `20000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const ids = {
    container: id(1),
    a: id(2),
    b: id(3),
    c: id(4),
    parentObject: id(5),
    recordObject: id(6),
    parentDisplay: id(7),
    recordDisplay: id(8),
    maker: id(9),
    relationship: id(10),
  };
  const recordSource = {
    version: 1,
    kind: 'records',
    custom_object_id: ids.recordObject,
    primary_display_field_id: ids.recordDisplay,
    filters: [],
  };
  const a = {
    id: ids.a,
    type: 'relationship_dropdown',
    required: true,
    option_source: {
      ...recordSource,
      custom_object_id: ids.parentObject,
      primary_display_field_id: ids.parentDisplay,
    },
  };
  const relationship = {
    parent_field_id: ids.a,
    relationship_definition_id: ids.relationship,
    relationship_parent_kind: 'custom_object',
    relationship_parent_custom_object_id: ids.parentObject,
    relationship_parent_side: 'source',
    related_kind: 'custom_object',
  };
  const b = {
    id: ids.b,
    type: 'relationship_dropdown',
    required: true,
    ...relationship,
    option_source: {
      ...recordSource,
      kind: 'distinct',
      value_field_id: ids.maker,
    },
  };
  const c = {
    id: ids.c,
    type: 'relationship_dropdown',
    required: true,
    ...relationship,
    option_source: {
      ...recordSource,
      filters: [{ field_id: ids.maker, source_field_id: ids.b }],
    },
  };
  return {
    ids,
    form: {
      id: 'three-stage-row-source-form',
      fields: [{
        id: ids.container,
        type: 'repeatable_rows',
        min_rows: 1,
        children: [a, b, c],
      }],
    },
    seed: {
      custom_object_definition: [
        {
          id: ids.parentObject,
          tenant_id: 'tenant-1',
          status: 'active',
          primary_display_field_id: ids.parentDisplay,
        },
        {
          id: ids.recordObject,
          tenant_id: 'tenant-1',
          status: 'active',
          primary_display_field_id: ids.recordDisplay,
        },
      ],
      preference_field: [
        {
          id: ids.parentDisplay,
          tenant_id: 'tenant-1',
          custom_object_id: ids.parentObject,
          entity_scope: 'custom_object',
          is_active: true,
          archived_at: null,
          name: 'name',
          field_type: 'text',
        },
        {
          id: ids.recordDisplay,
          tenant_id: 'tenant-1',
          custom_object_id: ids.recordObject,
          entity_scope: 'custom_object',
          is_active: true,
          archived_at: null,
          name: 'name',
          field_type: 'text',
        },
        {
          id: ids.maker,
          tenant_id: 'tenant-1',
          custom_object_id: ids.recordObject,
          entity_scope: 'custom_object',
          is_active: true,
          archived_at: null,
          name: 'maker',
          field_type: 'text',
        },
      ],
      custom_object_relationship_definition: [{
        id: ids.relationship,
        tenant_id: 'tenant-1',
        status: 'active',
        archived_at: null,
        source_kind: 'custom_object',
        source_custom_object_id: ids.parentObject,
        target_kind: 'custom_object',
        target_custom_object_id: ids.recordObject,
        show_on_source: true,
      }],
      custom_object_record: [
        {
          id: 'type-a',
          tenant_id: 'tenant-1',
          custom_object_id: ids.parentObject,
          archived_at: null,
          data: { name: 'Type A' },
        },
        {
          id: 'type-b',
          tenant_id: 'tenant-1',
          custom_object_id: ids.parentObject,
          archived_at: null,
          data: { name: 'Type B' },
        },
        {
          id: 'model-acme',
          tenant_id: 'tenant-1',
          custom_object_id: ids.recordObject,
          archived_at: null,
          data: { name: 'Acme model', maker: 'Acme' },
        },
        {
          id: 'model-beta',
          tenant_id: 'tenant-1',
          custom_object_id: ids.recordObject,
          archived_at: null,
          data: { name: 'Beta model', maker: 'Beta' },
        },
        {
          id: 'model-mismatch',
          tenant_id: 'tenant-1',
          custom_object_id: ids.recordObject,
          archived_at: null,
          data: { name: 'Other type model', maker: 'Acme' },
        },
        {
          id: 'model-archived',
          tenant_id: 'tenant-1',
          custom_object_id: ids.recordObject,
          archived_at: '2026-01-01',
          data: { name: 'Archived model', maker: 'Acme' },
        },
        {
          id: 'model-foreign',
          tenant_id: 'tenant-2',
          custom_object_id: ids.recordObject,
          archived_at: null,
          data: { name: 'Foreign model', maker: 'Acme' },
        },
      ],
      custom_object_relationship: [
        {
          id: 'edge-acme',
          tenant_id: 'tenant-1',
          relationship_definition_id: ids.relationship,
          source_record_id: 'type-a',
          target_record_id: 'model-acme',
          archived_at: null,
        },
        {
          id: 'edge-beta',
          tenant_id: 'tenant-1',
          relationship_definition_id: ids.relationship,
          source_record_id: 'type-a',
          target_record_id: 'model-beta',
          archived_at: null,
        },
        {
          id: 'edge-mismatch',
          tenant_id: 'tenant-1',
          relationship_definition_id: ids.relationship,
          source_record_id: 'type-b',
          target_record_id: 'model-mismatch',
          archived_at: null,
        },
        {
          id: 'edge-archived',
          tenant_id: 'tenant-1',
          relationship_definition_id: ids.relationship,
          source_record_id: 'type-a',
          target_record_id: 'model-archived',
          archived_at: null,
        },
        {
          id: 'edge-foreign',
          tenant_id: 'tenant-2',
          relationship_definition_id: ids.relationship,
          source_record_id: 'type-a',
          target_record_id: 'model-foreign',
          archived_at: null,
        },
      ],
    },
  };
}

function rowSourceDb(seed) {
  const tables = structuredClone(seed);
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }
    select() { return this; }
    eq(column, value) {
      this.filters.push(row => row[column] === value);
      return this;
    }
    is(column, value) {
      this.filters.push(row => (value === null ? row[column] == null : row[column] === value));
      return this;
    }
    in(column, values) {
      this.filters.push(row => values.includes(row[column]));
      return this;
    }
    range(from, to) {
      this.slice = [from, to + 1];
      return this;
    }
    execute() {
      const rows = (tables[this.table] || []).filter(row => (
        this.filters.every(filter => filter(row))
      ));
      return {
        data: structuredClone(this.slice ? rows.slice(...this.slice) : rows),
        error: null,
      };
    }
    async maybeSingle() {
      const result = this.execute();
      return { ...result, data: result.data[0] || null };
    }
    then(resolve, reject) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }
  return { from(table) { return new Query(table); } };
}

test('validates persisted A-record to B-distinct to C-filtered-record row sources as one row', async (t) => {
  const fixture = customObjectRowSourceFixture();
  const validRow = {
    [fixture.ids.a]: 'type-a',
    [fixture.ids.b]: 'Acme',
    [fixture.ids.c]: 'model-acme',
  };
  const validate = row => validateRepeatableRowSubmission({
    db: rowSourceDb(fixture.seed),
    tenantId: 'tenant-1',
    form: fixture.form,
    submissionData: { [fixture.ids.container]: [row] },
  });

  await validate(validRow);

  const rejected = [
    ['forged direct record', { ...validRow, [fixture.ids.a]: 'type-forged' }],
    ['stale distinct scalar', { ...validRow, [fixture.ids.b]: 'Stale maker' }],
    ['archived final record', { ...validRow, [fixture.ids.c]: 'model-archived' }],
    ['cross-tenant final record', { ...validRow, [fixture.ids.c]: 'model-foreign' }],
    ['record from a different parent', { ...validRow, [fixture.ids.c]: 'model-mismatch' }],
    ['record not matching the selected scalar', { ...validRow, [fixture.ids.c]: 'model-beta' }],
  ];
  for (const [name, row] of rejected) {
    await t.test(name, async () => {
      await assert.rejects(
        validate(row),
        error => error.status === 400 && /Invalid Custom Object row source selection/.test(error.message),
      );
    });
  }
});

test('hidden row-source children are ignored, but become authoritative when effectively visible', async () => {
  const fixture = customObjectRowSourceFixture();
  fixture.form.fields.unshift({ id: 'mode', type: 'text' });
  fixture.form.visibility_rules = [{
    trigger_field_id: 'mode',
    operator: 'equals',
    value: 'hide',
    action: 'hide',
    target_field_ids: [fixture.ids.b, fixture.ids.c],
  }];
  const staleRow = {
    [fixture.ids.a]: 'type-a',
    [fixture.ids.b]: 'Stale maker',
    [fixture.ids.c]: 'model-archived',
  };
  const input = mode => ({
    db: rowSourceDb(fixture.seed),
    tenantId: 'tenant-1',
    form: fixture.form,
    submissionData: { mode, [fixture.ids.container]: [staleRow] },
  });

  await validateRepeatableRowSubmission(input('hide'));
  await assert.rejects(
    validateRepeatableRowSubmission(input('show')),
    error => error.status === 400 && /Invalid Custom Object row source selection/.test(error.message),
  );
});