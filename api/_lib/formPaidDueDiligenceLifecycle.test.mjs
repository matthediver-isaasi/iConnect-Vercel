import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalizeFormSubmission } from './formPaymentFinalize.js';
import { initializePaidFormDueDiligence } from './formDueDiligence.js';
import { reconcileFormPayments } from './formPaymentReconciliation.js';

const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

function oneOffFinalizationDb({ dueDiligenceClaimError = null } = {}) {
  const row = {
    id: 'one-off-submission',
    tenant_id: 'tenant-1',
    payment_status: 'paid',
    payment_meta: {},
    submission_data: {},
  };
  const rpcNames = [];
  return {
    row,
    rpcNames,
    async rpc(name) {
      rpcNames.push(name);
      if (name === 'claim_form_due_diligence_initialization') {
        return dueDiligenceClaimError
          ? { data: null, error: dueDiligenceClaimError }
          : { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      }
      if (name === 'record_form_due_diligence_claim_failure') {
        return { data: { recorded: true }, error: null };
      }
      if (name === 'mark_one_off_form_due_diligence_ready') {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table) {
      assert.equal(table, 'form_submission');
      let update = null;
      const query = {
        update(value) { update = value; return query; },
        eq() { return query; },
        filter() { return query; },
        or() { return query; },
        select() { return query; },
        maybeSingle: async () => {
          if (update) Object.assign(row, structuredClone(update));
          return { data: { id: row.id }, error: null };
        },
        then(resolve, reject) {
          if (update) Object.assign(row, structuredClone(update));
          return Promise.resolve({ data: [{ id: row.id }], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test('one-off DD failures do not undo the paid finalization claim', async () => {
  const db = oneOffFinalizationDb({
    dueDiligenceClaimError: { message: 'DD claim temporarily unavailable' },
  });
  const submission = structuredClone(db.row);
  const result = await finalizeFormSubmission({
    supabase: db,
    submission,
    form: { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] },
    baseUrl: '',
  });

  assert.equal(result.finalized, true);
  assert.equal(db.row.payment_meta.finalized, true);
  assert.deepEqual(db.rpcNames, [
    'mark_one_off_form_due_diligence_ready',
    'claim_form_due_diligence_initialization',
    'record_form_due_diligence_claim_failure',
  ]);
});

test('already-finalized but unready one-off reruns prerequisites before DD recovery', async () => {
  const db = oneOffFinalizationDb();
  db.row.payment_meta = { finalized: true };
  let claims = 0;
  const originalRpc = db.rpc.bind(db);
  db.rpc = async (name, args) => {
    if (name === 'claim_form_due_diligence_initialization') {
      db.rpcNames.push(name);
      claims += 1;
      return claims === 1
        ? { data: { claimed: false, code: 'ONE_OFF_NOT_READY' }, error: null }
        : { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
    }
    return originalRpc(name, args);
  };
  const result = await finalizeFormSubmission({
    supabase: db,
    submission: structuredClone(db.row),
    form: { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] },
    baseUrl: '',
  });
  assert.equal(result.finalized, true);
  assert.equal(result.retriedUnreadyFinalization, true);
  assert.deepEqual(db.rpcNames, [
    'claim_form_due_diligence_initialization',
    'mark_one_off_form_due_diligence_ready',
    'claim_form_due_diligence_initialization',
  ]);
});

test('readiness recovery finish-RPC error is surfaced to reconciliation monitoring', async () => {
  const submission = {
    id: 'recovery-submission', tenant_id: 'tenant-1', form_id: 'form-1',
    payment_status: 'paid', payment_meta: { finalized: true }, submission_data: {},
  };
  const db = {
    async rpc(name) {
      if (name === 'mark_expired_missing_one_off_form_due_diligence_ready_attention') return { data: [], error: null };
      if (name === 'claim_missing_one_off_form_due_diligence_ready') {
        return { data: [{ form_submission_id: submission.id, tenant_id: submission.tenant_id, lease_token: 'lease' }], error: null };
      }
      if (name === 'claim_form_due_diligence_initialization') return { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      if (name === 'finish_missing_one_off_form_due_diligence_ready') return { data: null, error: { message: 'finish write failed' } };
      if (name === 'mark_expired_paid_form_due_diligence_attention') return { data: [], error: null };
      if (name === 'list_form_due_diligence_paid_initialization_work') return { data: [], error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table) {
      const data = table === 'form_submission' ? submission
        : table === 'form' ? { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] }
          : { form_submission_id: submission.id };
      const query = {
        select() { return query; }, eq() { return query; }, maybeSingle: async () => ({ data, error: null }),
      };
      return query;
    },
  };
  const result = await reconcileFormPayments(db, { limit: 1 });
  assert.ok(result.__heartbeatFailures.some(entry =>
    entry.scope === 'due-diligence-readiness-recovery' && entry.error.includes('finish write failed')));
});

test('historical paid submissions are excluded by the trigger-owned eligibility claim', async () => {
  const calls = [];
  const outcome = await initializePaidFormDueDiligence({
    db: {
      async rpc(name, args) {
        calls.push({ name, args });
        // This is the database response for a pre-trigger historical row:
        // it has no prospective paid-DD eligibility marker to claim.
        return { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      },
      from() {
        throw new Error('historical ineligible rows must not run DD actions');
      },
    },
    submissionId: 'historical-submission',
    tenantId: 'tenant-1',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.claimed, false);
  assert.equal(outcome.code, 'NOT_ELIGIBLE');
  assert.deepEqual(calls, [{
    name: 'claim_form_due_diligence_initialization',
    args: {
      p_tenant_id: 'tenant-1',
      p_submission_id: 'historical-submission',
      p_lease_token: calls[0].args.p_lease_token,
      p_paid_only: true,
    },
  }]);
});

test('one-off finalization marks readiness after finances before initializing paid DD', () => {
  const finalizer = source('formPaymentFinalize.js');
  assert.match(finalizer, /import\s*\{\s*initializePaidFormDueDiligence\s*\}\s*from '\.\/formDueDiligence\.js'/);
  assert.match(finalizer, /await initializePaidFormDueDiligence\(\{[\s\S]*?submissionId: submission\.id,[\s\S]*?tenantId: submission\.tenant_id,/);

  const pipelineAt = finalizer.indexOf('runFormEntityPipelines(');
  const readyAt = finalizer.lastIndexOf('markOneOffDueDiligenceReady(supabase, submission)');
  const dueDiligenceAt = finalizer.lastIndexOf('initializeDueDiligenceSafely(supabase, submission)');
  const emailsAt = finalizer.indexOf('sendSubmissionEmailsGuarded(');
  assert.ok(pipelineAt > -1 && readyAt > pipelineAt && dueDiligenceAt > readyAt,
    'DD initialization must follow successful pipeline work and durable readiness');
  assert.ok(emailsAt > dueDiligenceAt,
    'DD initialization must precede submission emails');
  assert.match(finalizer, /if \(ddOutcome\?\.code !== 'ONE_OFF_NOT_READY'\)[\s\S]*?alreadyFinalized: true/);
  assert.match(finalizer, /const pipelineSucceeded = !pipelineResult\.failed && !pipelineResult\.partial/);
  assert.match(finalizer, /membershipResult\?\.created === true \|\| membershipResult\?\.alreadyProcessed === true/);
});

test('monthly finalizers initialize after their completed-checkout stamp and cannot block financial done stamps', () => {
  const card = source('formMonthlyCardFinalize.js');
  const directDebit = source('formMonthlyDirectDebitFinalize.js');

  for (const finalizer of [card, directDebit]) {
    assert.match(finalizer, /import\s*\{\s*initializePaidFormDueDiligence\s*\}\s*from '\.\/formDueDiligence\.js'/);
    assert.match(finalizer, /async function initializeDueDiligenceSafely[\s\S]*?try \{[\s\S]*?initializePaidFormDueDiligence[\s\S]*?\} catch/);
    assert.match(finalizer, /due_diligence_required/);
    assert.match(finalizer, /survey_settings/);
  }

  assert.ok(card.indexOf('claimFormMonthlyCardMembership(')
    < card.lastIndexOf('initializeDueDiligenceSafely(db, currentRow)'));
  assert.ok(card.indexOf('writeClaimResult(db, formSubmissionId, { done: true, ownerToken })')
    < card.lastIndexOf('initializeDueDiligenceSafely(db, currentRow)'));
  assert.match(card, /currentState\?\.status === 'done'\) \{[\s\S]*?initializeDueDiligenceSafely\(db, currentRow\)[\s\S]*?alreadyFinalized: true/);

  assert.ok(directDebit.indexOf('bindMembership(')
    < directDebit.lastIndexOf('initializeDueDiligenceSafely(db, submission)'));
  assert.ok(directDebit.indexOf('await stamp(db, submissionId, token, true)')
    < directDebit.lastIndexOf('initializeDueDiligenceSafely(db, submission)'));
  assert.match(directDebit, /current\.state\?\.status === 'done'\) \{[\s\S]*?initializeDueDiligenceSafely\(db, submission\)[\s\S]*?alreadyFinalized: true/);
});

test('paid-DD reconciliation is independent from provider sweeps and paid form projections include DD configuration', () => {
  const reconciliation = source('formPaymentReconciliation.js');
  const publicPayment = source('../public/form-payment.js');
  const gcWebhook = source('gocardlessWebhookProcessor.js');

  assert.match(reconciliation, /import\s*\{\s*reconcilePaidFormDueDiligence\s*\}\s*from '\.\/formDueDiligence\.js'/);
  const dueSweepAt = reconciliation.indexOf('reconcilePaidFormDueDiligence({ db: supabase, limit })');
  const readinessRecoveryAt = reconciliation.indexOf('recoverMissingOneOffDueDiligenceReadiness(supabase, { resolveBaseUrl, limit })');
  const pendingSweepAt = reconciliation.indexOf(".eq('payment_status', 'pending')");
  assert.ok(readinessRecoveryAt > -1 && readinessRecoveryAt < dueSweepAt,
    'missing one-off readiness must recover before the DD sweep can claim it');
  assert.ok(dueSweepAt > -1 && dueSweepAt < pendingSweepAt,
    'DD reconciliation must run even when the pending-provider sweep fails');
  assert.match(reconciliation, /Due diligence sweep failed/);
  assert.match(reconciliation, /if \(!dueDiligenceResult\?\.ok\)/);

  for (const projection of [reconciliation, publicPayment, gcWebhook]) {
    assert.match(projection, /due_diligence_required/);
    assert.match(projection, /survey_settings/);
  }
});