import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRepeatableRowSubmission } from './formRepeatableRowValidation.js';

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