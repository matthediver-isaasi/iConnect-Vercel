import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDueDiligenceReferenceProjection,
  resolveDueDiligenceSubmissionReferences,
} from './submissionReferences.js';

function createDb(rowsByTable, calls) {
  return {
    from(table) {
      const state = { table, filters: [] };
      const query = {
        select() {
          return query;
        },
        eq(column, value) {
          state.filters.push(['eq', column, value]);
          return query;
        },
        in(column, values) {
          state.filters.push(['in', column, values]);
          return query;
        },
        then(resolve, reject) {
          calls.push(state);
          try {
            let rows = [...(rowsByTable[table] || [])];
            for (const [kind, column, expected] of state.filters) {
              rows = rows.filter((row) => kind === 'eq'
                ? String(row[column]) === String(expected)
                : expected.map(String).includes(String(row[column])));
            }
            resolve({ data: rows, error: null });
          } catch (error) {
            if (reject) reject(error);
          }
        },
      };
      return query;
    },
  };
}

test('resolves member and organisation independently with tenant scoping', async () => {
  const calls = [];
  const memberId = 'member-1';
  const organizationId = 'org-1';
  const references = await resolveDueDiligenceSubmissionReferences({
    tenantId: 'tenant-1',
    db: createDb({
      form_submission_pipeline_entity: [],
      member: [{
        id: memberId,
        first_name: 'Ada',
        last_name: 'Lovelace',
        tenant_id: 'tenant-1',
      }],
      organization: [{
        id: organizationId,
        name: 'Analytical Engines Ltd',
        tenant_id: 'tenant-1',
      }],
    }, calls),
    formSubmissions: [{
      id: 'submission-1',
      created_member_id: memberId,
      organization_id: organizationId,
    }],
  });

  assert.equal(references['submission-1'].member.full_name, undefined);
  assert.equal(references['submission-1'].memberName, 'Ada Lovelace');
  assert.equal(references['submission-1'].organization.name, 'Analytical Engines Ltd');
  assert.deepEqual(
    getDueDiligenceReferenceProjection(
      { id: 'submission-1' },
      references,
    ),
    {
      member_name: 'Ada Lovelace',
      organization_name: 'Analytical Engines Ltd',
      reference_name: 'Ada Lovelace',
    },
  );
  assert.equal(
    getDueDiligenceReferenceProjection(
      { id: 'submission-1' },
      references,
      { applicationLevel: 'organization', applicationUid: 'DD-1' },
    ).reference_name,
    'Analytical Engines Ltd',
  );
  const memberCall = calls.find((call) => call.table === 'member');
  const organizationCall = calls.find((call) => call.table === 'organization');
  assert.deepEqual(memberCall.filters.find(([kind, column]) => kind === 'eq' && column === 'tenant_id'), [
    'eq',
    'tenant_id',
    'tenant-1',
  ]);
  assert.deepEqual(organizationCall.filters.find(([kind, column]) => kind === 'in' && column === 'id'), [
    'in',
    'id',
    [organizationId],
  ]);
  assert.equal(
    organizationCall.filters.some(([, column, value]) => column === 'id' && String(value) === memberId),
    false,
  );
});

test('typed member pipeline reference resolves without an organisation and missing member stays null', async () => {
  const calls = [];
  const memberId = 'deleted-member';
  const references = await resolveDueDiligenceSubmissionReferences({
    tenantId: 'tenant-1',
    db: createDb({
      form_submission_pipeline_entity: [{
        form_submission_id: 'submission-1',
        entity_type: 'member',
        entity_id: memberId,
        tenant_id: 'tenant-1',
      }],
      member: [],
      organization: [],
    }, calls),
    formSubmissions: [{ id: 'submission-1' }],
  });

  assert.equal(references['submission-1'].memberId, memberId);
  assert.equal(references['submission-1'].member, null);
  assert.equal(references['submission-1'].organizationId, null);
  assert.equal(
    calls.find((call) => call.table === 'organization'),
    undefined,
    'a member-only reference must not be looked up as an organisation',
  );
});
