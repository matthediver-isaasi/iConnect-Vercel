import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityForm, submitThroughRealProcessor, TENANT_ID } from './formSubmissionCompatibility.helpers.mjs';

const member = { id: 'verified-member', tenant_id: TENANT_ID, email: 'member@example.test' };
const form = () => ({
  ...compatibilityForm(), form_type: 'standard', require_authentication: true,
  mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
  member_affiliation_enabled: true,
  fields: [{ id: 'feedback', type: 'text' }],
  organization_entity_action: 'none', entity_pipelines: { members: [], organisations: [] },
});
test('real submission binds affiliation handling to the signed-in member, not request identity', async () => {
  const calls = [];
  const result = await submitThroughRealProcessor({
    form: form(), sessionMember: member, idempotencyKey: 'affiliation-submit-1',
    submissionData: { feedback: 'renew', __member_affiliation_snapshot: 'opaque-token' },
    requestBodyOverrides: { prefill_member_id: 'attacker', created_member_id: 'attacker' },
    publicDependencies: {
      prepareMemberAffiliations: async context => { calls.push(['prepare', context.memberId]); },
      completeMemberAffiliations: async context => {
        calls.push(['complete', context.memberId]);
        assert.equal(context.submission.created_member_id, member.id);
        assert.equal(context.submission.tenant_id, TENANT_ID);
        return { status: 'awaiting_review', organizationId: null };
      },
    },
  });
  assert.equal(result.response.statusCode, 201, JSON.stringify(result.response.body));
  assert.deepEqual(calls, [['prepare', member.id], ['complete', member.id]]);
  assert.equal(result.insertedSubmissions.length, 1);
  assert.equal(result.response.body.member_affiliations.status, 'awaiting_review');
});
test('failed affiliation preflight saves no submission and runs no application actions', async () => {
  const result = await submitThroughRealProcessor({
    form: form(), sessionMember: member, idempotencyKey: 'affiliation-submit-2',
    submissionData: { feedback: 'renew' },
    publicDependencies: { prepareMemberAffiliations: async () => { throw new Error('Snapshot expired'); } },
  });
  assert.equal(result.response.statusCode, 409, JSON.stringify(result.response.body));
  assert.deepEqual(result.insertedSubmissions, []);
  assert.deepEqual(result.handoffs, []);
});
test('failure after submission persistence is retryable and not represented as applied', async () => {
  const result = await submitThroughRealProcessor({
    form: form(), sessionMember: member, idempotencyKey: 'affiliation-submit-3',
    submissionData: { feedback: 'renew' },
    publicDependencies: { prepareMemberAffiliations: async () => {},
      completeMemberAffiliations: async () => { throw new Error('Database unavailable'); } },
  });
  assert.equal(result.response.statusCode, 503, JSON.stringify(result.response.body));
  assert.equal(result.response.body.retryable, true);
  assert.equal(result.insertedSubmissions.length, 1);
  assert.equal(result.response.body.member_affiliations, undefined);
});
