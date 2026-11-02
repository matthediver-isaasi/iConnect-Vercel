import test from 'node:test';
import assert from 'node:assert/strict';
import { affiliationDueDiligenceContract, affiliationReviewStageDecision } from './affiliationDueDiligenceContract.js';

const config = () => ({
  workflow_stages: [{ id: 'assessment' }, { id: 'accepted' }, { id: 'declined' }],
  affiliation_review: { version: 1, enabled: true, approved_stage_id: 'accepted', rejected_stage_id: 'declined' },
});
const args = () => ({
  config: config(), tenantId: 'tenant', stageId: 'accepted',
  submission: { id: 'case', tenant_id: 'tenant', form_submission_id: 'review-form-submission' },
  review: { tenant_id: 'tenant', due_diligence_submission_id: 'case',
    review_form_submission_id: 'review-form-submission', snapshot_id: 'snapshot', member_id: 'member' },
});
test('ordinary configurations and disabled opt-in are untouched', () => {
  for (const cfg of [{ workflow_stages: [{ id: 'approved', create_member: true }] },
    { affiliation_review: { enabled: false } }]) {
    const original = structuredClone(cfg);
    assert.equal(affiliationDueDiligenceContract(cfg), null);
    assert.deepEqual(affiliationReviewStageDecision({ config: cfg }), { handled: false });
    assert.deepEqual(cfg, original);
  }
});
test('approval requires explicit configured stage and atomic resolved-record application', () => {
  const input = args(), original = structuredClone(input);
  assert.deepEqual(affiliationReviewStageDecision(input), {
    handled: true, outcome: 'approve', runLegacyActions: false,
    blocksRenewal: false, requiresAtomicApplication: true, requiresResolvedRecords: true,
  });
  assert.deepEqual(input, original);
});
test('rejection and review do not apply affiliations or hold renewal', () => {
  for (const stageId of ['assessment', 'declined']) {
    const result = affiliationReviewStageDecision({ ...args(), stageId });
    assert.equal(result.requiresAtomicApplication, false);
    assert.equal(result.runLegacyActions, false);
    assert.equal(result.blocksRenewal, false);
  }
});
test('cross-tenant, unrelated case and missing ownership evidence fail closed', () => {
  for (const change of [
    input => { input.tenantId = 'other'; },
    input => { input.review.due_diligence_submission_id = 'other'; },
    input => { input.review.review_form_submission_id = 'other'; },
    input => { input.review.snapshot_id = null; },
    input => { input.review = null; },
  ]) {
    const input = args(); change(input);
    assert.throws(() => affiliationReviewStageDecision(input));
  }
});
test('stage labels alone cannot approve, and malformed opt-ins are rejected', () => {
  assert.throws(() => affiliationReviewStageDecision({ ...args(), stageId: 'approved' }));
  for (const patch of [{ version: 2 }, { approved_stage_id: 'missing' }, { rejected_stage_id: 'accepted' }]) {
    const cfg = config(); Object.assign(cfg.affiliation_review, patch);
    assert.throws(() => affiliationDueDiligenceContract(cfg));
  }
});
