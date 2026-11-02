import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAffiliationReviewStage } from './affiliationReviewStage.js';

function fixture(overrides = {}) {
  const calls = [];
  const config = {
    workflow_stages: [{ id: 'new' }, { id: 'yes' }, { id: 'no' }],
    affiliation_review: { version: 1, enabled: true, approved_stage_id: 'yes', rejected_stage_id: 'no' },
  };
  const review = { id: 'review', tenant_id: 'tenant', due_diligence_submission_id: 'case',
    review_form_submission_id: 'sub', snapshot_id: 'snapshot', member_id: 'member' };
  const db = {
    from(table) {
      calls.push(table);
      const q = { select() { return q; }, eq(k, v) { calls.push([k, v]); return q; },
        maybeSingle: async () => ({ data: overrides.review === undefined ? review : overrides.review, error: overrides.readError }) };
      return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return overrides.rpcResult || { data: { status: 'applied' } };
    },
  };
  return { calls, input: { db, config, stageId: 'yes', tenantId: 'tenant', actor: 'admin',
    occurrenceId: 'occurrence', submission: { id: 'case', tenant_id: 'tenant', form_submission_id: 'sub' } } };
}
test('ordinary and explicitly disabled workflows perform zero review queries', async () => {
  for (const config of [{ workflow_stages: [] }, { affiliation_review: { enabled: false } }]) {
    const { input, calls } = fixture(); input.config = config;
    assert.equal(await executeAffiliationReviewStage(input), null);
    assert.deepEqual(calls, []);
  }
});
test('explicit approval routes only the verified review to the decision transaction', async () => {
  const { input, calls } = fixture();
  const result = await executeAffiliationReviewStage(input);
  assert.equal(result.stage_actions_results[0].status, 'success');
  assert.deepEqual(calls.at(-1), { name: 'decide_form_member_affiliation_review', args: {
    p_tenant_id: 'tenant', p_review_id: 'review', p_due_diligence_submission_id: 'case',
    p_stage_id: 'yes', p_occurrence_id: 'occurrence', p_actor: 'admin', p_decision: 'approve',
  } });
});
test('intermediate review stage performs no mutation', async () => {
  const { input, calls } = fixture(); input.stageId = 'new';
  assert.equal((await executeAffiliationReviewStage(input)).stage_actions_results[0].status, 'skipped');
  assert.equal(calls.some(c => c.name), false);
});
test('missing case, lookup failure and malformed opt-in return handled errors, not legacy fallback', async () => {
  for (const options of [{ review: null }, { readError: { message: 'offline' } }]) {
    const { input, calls } = fixture(options);
    assert.equal((await executeAffiliationReviewStage(input)).stage_actions_results[0].status, 'error');
    assert.equal(calls.some(c => c.name), false);
  }
  const { input } = fixture(); input.config.affiliation_review.version = 99;
  assert.equal((await executeAffiliationReviewStage(input)).stage_actions_results[0].status, 'error');
});
test('RPC errors and unproven outcomes never report success', async () => {
  for (const rpcResult of [{ error: { message: 'function missing' } }, { data: { ok: true } }, { data: { status: 'rejected' } }]) {
    const { input } = fixture({ rpcResult });
    assert.equal((await executeAffiliationReviewStage(input)).stage_actions_results[0].status, 'error');
  }
});
test('rejection accepts only a confirmed rejection outcome', async () => {
  const { input } = fixture({ rpcResult: { data: { status: 'already_rejected' } } });
  input.stageId = 'no';
  assert.equal((await executeAffiliationReviewStage(input)).stage_actions_results[0].status, 'success');
});
