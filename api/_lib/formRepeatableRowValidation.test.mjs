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