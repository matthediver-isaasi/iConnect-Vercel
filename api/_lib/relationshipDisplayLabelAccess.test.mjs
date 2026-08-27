import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccessRelationshipLabelContext,
  loadSubmissionScopedRelationshipDisplayLabels,
  resolveReviewSubmissionIds,
  resolveSubmissionBoundRelationshipRecordIds,
} from './relationshipDisplayLabelAccess.js';

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