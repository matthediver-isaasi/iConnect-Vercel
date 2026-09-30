import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccessRelationshipLabelContext,
  loadSubmissionScopedRelationshipDisplayLabels,
  resolveReviewSubmissionIds,
  resolveSubmissionBoundRelationshipRecordIds,
} from './relationshipDisplayLabelAccess.js';
import { loadTenantRelationshipDisplayLabels } from './relationshipDisplayLabels.js';

function fakeSupabase(rowsByTable) {
  return {
    from(table) {
      let rows = [...(rowsByTable[table] || [])];
      const query = {
        select() { return query; },
        eq(column, value) {
          rows = rows.filter((row) => String(row[column]) === String(value));
          return query;
        },
        is(column, value) {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in(column, values) {
          const allowed = new Set(values.map(String));
          rows = rows.filter((row) => allowed.has(String(row[column])));
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

const db = fakeSupabase({
  form_submission: [
    { id: 'submission-a', tenant_id: 'tenant-a', form_id: 'form-a', submission_data: { relationship: 'allowed-record' } },
    { id: 'submission-b', tenant_id: 'tenant-b', form_id: 'form-b', submission_data: { relationship: 'other-tenant-record' } },
  ],
  form: [
    { id: 'form-a', tenant_id: 'tenant-a', fields: [{ id: 'relationship', type: 'relationship_dropdown' }] },
    { id: 'form-b', tenant_id: 'tenant-b', fields: [{ id: 'relationship', type: 'relationship_dropdown' }] },
  ],
  form_submission_due_diligence: [
    { tenant_id: 'tenant-a', form_submission_id: 'submission-a' },
  ],
});

test('relationship labels are limited to IDs persisted in the requested tenant submission', async () => {
  const ids = await resolveSubmissionBoundRelationshipRecordIds(
    db,
    'tenant-a',
    ['submission-a'],
    ['allowed-record', 'arbitrary-record', 'other-tenant-record'],
  );

  assert.deepEqual(ids, ['allowed-record']);
});

test('a submission ID from another tenant cannot authorize a relationship label', async () => {
  const ids = await resolveSubmissionBoundRelationshipRecordIds(
    db,
    'tenant-a',
    ['submission-b'],
    ['other-tenant-record'],
  );

  assert.deepEqual(ids, []);
});

test('relationship values in persisted repeatable rows authorize requested labels', async () => {
  const repeatableDb = fakeSupabase({
    form_submission: [{
      id: 'submission-repeatable', tenant_id: 'tenant-a', form_id: 'form-repeatable',
      submission_data: {
        rows: [
          { relationship: 'repeatable-record' },
          { relationship: ['repeatable-record-two', 'not-requested'] },
        ],
      },
    }],
    form: [{
      id: 'form-repeatable', tenant_id: 'tenant-a',
      fields: [{
        id: 'rows', type: 'repeatable_row',
        repeatable_row: { children: [{ id: 'relationship', type: 'relationship_dropdown' }] },
      }],
    }],
  });

  assert.deepEqual(
    await resolveSubmissionBoundRelationshipRecordIds(
      repeatableDb,
      'tenant-a',
      ['submission-repeatable'],
      ['repeatable-record', 'repeatable-record-two', 'arbitrary-record'],
    ),
    ['repeatable-record', 'repeatable-record-two'],
  );
});

test('tenant label loader resolves core names and preserves custom-object collision precedence', async () => {
  const labels = await loadTenantRelationshipDisplayLabels(fakeSupabase({
    organization: [
      { id: 'organization-id', tenant_id: 'tenant-a', name: 'Organization name' },
      { id: 'other-organization', tenant_id: 'tenant-b', name: 'Other tenant organization' },
      { id: 'shared-id', tenant_id: 'tenant-a', name: 'Organization collision' },
    ],
    organization_group: [
      { id: 'group-id', tenant_id: 'tenant-a', name: 'Group name' },
      { id: 'other-group', tenant_id: 'tenant-b', name: 'Other tenant group' },
      { id: 'shared-id', tenant_id: 'tenant-a', name: 'Group collision' },
    ],
    custom_object_record: [
      { id: 'shared-id', tenant_id: 'tenant-a', custom_object_id: 'object-id', archived_at: null, data: { title: 'Custom collision' } },
      { id: 'archived-record', tenant_id: 'tenant-a', custom_object_id: 'object-id', archived_at: '2026-01-01', data: { title: 'Archived' } },
      { id: 'other-record', tenant_id: 'tenant-b', custom_object_id: 'object-id', archived_at: null, data: { title: 'Other tenant' } },
    ],
    custom_object_definition: [{
      id: 'object-id', tenant_id: 'tenant-a', status: 'active', archived_at: null,
      primary_display_field_id: 'title-field',
    }],
    preference_field: [{
      id: 'title-field', tenant_id: 'tenant-a', custom_object_id: 'object-id',
      entity_scope: 'custom_object', is_active: true, name: 'title', field_type: 'text',
    }],
  }), 'tenant-a', [
    'organization-id', 'group-id', 'shared-id', 'archived-record',
    'other-organization', 'other-group', 'other-record',
  ]);

  assert.deepEqual(labels, {
    'organization-id': 'Organization name',
    'group-id': 'Group name',
    'shared-id': 'Custom collision',
  });
});

test('only submission-bound IDs are passed to the label resolver', async () => {
  let resolverIds = null;
  const labels = await loadSubmissionScopedRelationshipDisplayLabels(
    db,
    'tenant-a',
    ['submission-a'],
    ['allowed-record', 'arbitrary-record'],
    async (_db, _tenantId, ids) => {
      resolverIds = ids;
      return { 'allowed-record': 'Allowed label' };
    },
  );

  assert.deepEqual(resolverIds, ['allowed-record']);
  assert.deepEqual(labels, { 'allowed-record': 'Allowed label' });
});

test('review context only authorizes submissions backed by tenant due diligence records', async () => {
  assert.deepEqual(
    await resolveReviewSubmissionIds(db, 'tenant-a', ['submission-a', 'submission-b']),
    ['submission-a'],
  );
});

test('members excluded from either page context cannot resolve labels, while an authorized reviewer can', () => {
  assert.equal(
    canAccessRelationshipLabelContext(['page_FormSubmissions'], 'form-submissions'),
    false,
  );
  assert.equal(
    canAccessRelationshipLabelContext(['page_ReviewSubmission'], 'review-submission'),
    false,
  );
  assert.equal(canAccessRelationshipLabelContext([], 'review-submission'), true);
  assert.equal(canAccessRelationshipLabelContext([], 'unknown-context'), false);
});