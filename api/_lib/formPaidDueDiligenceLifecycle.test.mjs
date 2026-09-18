import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  finalizeFormSubmission,
  formPaymentCompletionStatus,
  queueFormPaymentCompletion,
} from './formPaymentFinalize.js';
import { initializePaidFormDueDiligence } from './formDueDiligence.js';
import { reconcileFormPayments } from './formPaymentReconciliation.js';

const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

function oneOffFinalizationDb({
  dueDiligenceClaimError = null,
  dueDiligenceReadyError = null,
  pipelineOperation = null,
} = {}) {
  const row = {
    id: 'one-off-submission',
    tenant_id: 'tenant-1',
    payment_status: 'paid',
    payment_meta: {},
    submission_data: {},
  };
  const rpcNames = [];
  const fromCalls = [];
  return {
    row,
    rpcNames,
    fromCalls,
    async rpc(name, args) {
      rpcNames.push(name);
      if (name === 'observe_or_begin_form_paid_pipeline_operation' && pipelineOperation) {
        return { data: pipelineOperation, error: null };
      }
      if (name === 'claim_form_due_diligence_initialization') {
        return dueDiligenceClaimError
          ? { data: null, error: dueDiligenceClaimError }
          : { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      }
      if (name === 'record_form_due_diligence_claim_failure') {
        return { data: { recorded: true }, error: null };
      }
      if (name === 'mark_one_off_form_due_diligence_ready') {
        return dueDiligenceReadyError
          ? { data: null, error: dueDiligenceReadyError }
          : { data: true, error: null };
      }
      if (name === 'patch_form_submission_payment_meta') {
        row.payment_meta = { ...row.payment_meta, ...structuredClone(args.p_patch) };
        return { data: row.payment_meta, error: null };
      }
      if (name === 'queue_form_payment_completion') {
        row.payment_meta = {
          ...row.payment_meta,
          completion: row.payment_meta?.completion || {
            version: 1, status: 'queued', queued_at: new Date().toISOString(), attempts: 0,
          },
        };
        return { data: row.payment_meta, error: null };
      }
      if (name === 'finish_form_payment_completion') {
        const completion = row.payment_meta?.completion;
        if (completion?.status !== 'processing' || completion.owner_token !== args.p_owner_token) {
          return { data: false, error: null };
        }
        row.payment_meta.completion = {
          ...completion,
          status: args.p_status,
          ...(args.p_stage ? { stage: args.p_stage } : {}),
        };
        return { data: true, error: null };
      }
      if (name === 'finish_form_payment_completion_retry') {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table) {
      fromCalls.push(table);
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

test('queued Stripe completion has a truthful non-terminal receipt and does not reopen historical payments', async () => {
  const db = oneOffFinalizationDb();
  const queuedMeta = await queueFormPaymentCompletion(db, db.row);
  assert.equal(queuedMeta.completion.status, 'queued');
  assert.equal(formPaymentCompletionStatus({ payment_meta: queuedMeta }), 'finalizing');
  assert.equal(formPaymentCompletionStatus({
    payment_meta: { completion: { version: 1, status: 'retryable', stage: 'accounting' } },
  }), 'accounting_pending');
  assert.equal(formPaymentCompletionStatus({ payment_meta: { completion: { version: 1, status: 'done' } } }), 'paid');
  assert.equal(formPaymentCompletionStatus({
    payment_meta: { completion: { version: 1, status: 'attention' } },
  }), 'attention');
  assert.equal(formPaymentCompletionStatus({ payment_meta: { finalized: true } }), 'paid');
  assert.equal(
    formPaymentCompletionStatus({ payment_status: 'paid', payment_meta: {} }),
    'finalizing',
    'receiptless paid rows without legacy finalization evidence must remain retryable',
  );
  assert.equal(
    formPaymentCompletionStatus({ payment_status: 'paid', payment_meta: { finalized: false } }),
    'finalizing',
  );
});

test('a bounded completion records done only after durable stages, while a fresh owner is not duplicated', async () => {
  const db = oneOffFinalizationDb();
  db.row.payment_meta = {
    completion: { version: 1, status: 'queued', attempts: 0 },
  };
  const result = await finalizeFormSubmission({
    supabase: db,
    submission: structuredClone(db.row),
    form: { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] },
    baseUrl: '',
    deadlineAt: Date.now() + 60_000,
  });
  assert.equal(result.finalized, true);
  assert.equal(db.row.payment_meta.completion.status, 'done');
  const freshOwner = {
    ...db.row,
    payment_meta: {
      ...db.row.payment_meta,
      completion: { version: 1, status: 'processing', claimed_at: new Date().toISOString() },
    },
  };
  const before = db.rpcNames.length;
  const inProgress = await finalizeFormSubmission({
    supabase: db,
    submission: freshOwner,
    form: { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] },
    baseUrl: '',
  });
  assert.deepEqual(inProgress, { finalized: false, inProgress: true });
  assert.equal(db.rpcNames.length, before, 'a fresh lease must not replay durable stages');
});

test('a transient DD readiness write prevents a v1 completion from being marked done', async () => {
  const db = oneOffFinalizationDb({
    dueDiligenceReadyError: { message: 'ready write temporarily unavailable' },
  });
  db.row.payment_meta = { completion: { version: 1, status: 'queued', attempts: 0 } };
  const result = await finalizeFormSubmission({
    supabase: db,
    submission: structuredClone(db.row),
    form: { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] },
    baseUrl: '',
    deadlineAt: Date.now() + 60_000,
  });
  assert.equal(result.finalized, false);
  assert.equal(result.retryable, true);
  assert.equal(db.row.payment_meta.completion.status, 'retryable');
  assert.equal(db.rpcNames.includes('claim_form_due_diligence_initialization'), false);
});

test('done receipt restores DD readiness without re-running a primary pipeline', async () => {
  const db = oneOffFinalizationDb({
    dueDiligenceClaimError: { message: 'DD initialization temporarily unavailable' },
  });
  db.row.payment_meta = { completion: { version: 1, status: 'done', attempts: 1 } };
  const result = await finalizeFormSubmission({
    supabase: db,
    submission: structuredClone(db.row),
    form: {
      id: 'form-1',
      fields: [],
      entity_pipelines: { members: [{ id: 'primary', isPrimary: true }] },
      submission_emails: [],
    },
    baseUrl: '',
  });
  assert.equal(result.finalized, true);
  assert.equal(result.alreadyFinalized, true);
  assert.equal(result.dueDiligencePending, true);
  assert.deepEqual(db.rpcNames, [
    'mark_one_off_form_due_diligence_ready',
    'claim_form_due_diligence_initialization',
    'record_form_due_diligence_claim_failure',
  ]);
  assert.equal(db.fromCalls.length, 0, 'done fast path must not re-run the primary pipeline');
});

test('a different active pipeline owner fences completion before membership, DD, and email effects', async () => {
  const previousAppUrl = process.env.APP_URL;
  const db = oneOffFinalizationDb({
    pipelineOperation: {
      status: 'processing',
      reason: 'processor operation is already owned by another worker',
    },
  });
  db.row.payment_meta = {
    completion: { version: 1, status: 'queued', attempts: 0 },
    membership: { quote: { target: 'member' } },
  };
  process.env.APP_URL = 'https://internal.example.test';
  try {
    const result = await finalizeFormSubmission({
      supabase: db,
      submission: structuredClone(db.row),
      form: {
        id: 'form-1',
        fields: [],
        entity_pipelines: { members: [{ id: 'primary', isPrimary: true }] },
        submission_emails: [],
      },
      baseUrl: 'https://tenant.example.test',
      deadlineAt: Date.now() + 60_000,
    });
    assert.equal(result.finalized, false);
    assert.equal(result.requiresAttention, true);
    assert.equal(db.row.payment_meta.completion.status, 'attention');
    assert.equal(db.rpcNames.includes('mark_one_off_form_due_diligence_ready'), false);
    assert.equal(db.rpcNames.includes('claim_form_due_diligence_initialization'), false);
    // Only the completion claim/result writes are allowed; an email guard or
    // membership path would issue additional submission table work.
    assert.equal(db.fromCalls.length, 1);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test('a bounded operation wait stays on the retry queue and fences all downstream effects', async () => {
  const previousAppUrl = process.env.APP_URL;
  const db = oneOffFinalizationDb({ pipelineOperation: { status: 'waiting' } });
  db.row.payment_meta = {
    completion: { version: 1, status: 'retryable', attempts: 1 },
    membership: { quote: { target: 'member' } },
  };
  process.env.APP_URL = 'https://internal.example.test';
  try {
    const result = await finalizeFormSubmission({
      supabase: db, submission: structuredClone(db.row),
      form: { id: 'f', fields: [], entity_pipelines: { members: [{ id: 'p' }] }, submission_emails: [] },
      deadlineAt: Date.now() + 60_000,
    });
    assert.equal(result.retryable, true);
    assert.equal(result.requiresAttention, undefined);
    assert.equal(db.row.payment_meta.completion.status, 'retryable');
    assert.equal(db.rpcNames.includes('finish_form_payment_completion_retry'), true);
    assert.equal(db.rpcNames.includes('mark_one_off_form_due_diligence_ready'), false);
    assert.equal(db.fromCalls.length, 1, 'no membership or email writes during observation');
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test('a known partial entity result stops downstream effects and remains retryable', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  const db = oneOffFinalizationDb({
    pipelineOperation: { status: 'claimed' },
  });
  db.row.payment_meta = {
    completion: { version: 1, status: 'queued', attempts: 0 },
    membership: { quote: { target: 'member' } },
  };
  process.env.APP_URL = 'https://internal.example.test';
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      retryable: true,
      code: 'STRUCTURED_ACTIONS_INCOMPLETE',
      structured_actions: { success: false },
    }),
  });
  try {
    const result = await finalizeFormSubmission({
      supabase: db,
      submission: structuredClone(db.row),
      form: {
        id: 'form-1',
        fields: [],
        entity_pipelines: { members: [{ id: 'primary', isPrimary: true }] },
        submission_emails: [],
      },
      baseUrl: 'https://tenant.example.test',
      deadlineAt: Date.now() + 60_000,
    });
    assert.equal(result.finalized, false);
    assert.equal(result.retryable, true);
    assert.equal(db.row.payment_meta.completion.status, 'retryable');
    assert.equal(db.rpcNames.includes('mark_one_off_form_due_diligence_ready'), false);
    assert.equal(db.rpcNames.includes('claim_form_due_diligence_initialization'), false);
    assert.equal(db.fromCalls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test('an exhausted worker records a resumable outcome before beginning another completion stage', async () => {
  const db = oneOffFinalizationDb();
  db.row.payment_meta = { completion: { version: 1, status: 'queued', attempts: 0 } };
  const result = await finalizeFormSubmission({
    supabase: db,
    submission: structuredClone(db.row),
    form: { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] },
    baseUrl: '',
    deadlineAt: Date.now() + 1,
  });
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.retryable, true);
  assert.equal(db.row.payment_meta.completion.status, 'retryable');
});

test('a successful pipeline that leaves less than the stage reserve defers membership and email as budget work', async () => {
  const db = oneOffFinalizationDb({ pipelineOperation: { status: 'claimed' } });
  db.row.payment_meta = {
    completion: { version: 1, status: 'queued', attempts: 0 },
    membership: { quote: { target: 'member' } },
  };
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  const realNow = Date.now;
  let clock = 3_000_000;
  process.env.APP_URL = 'https://internal.example.test';
  Date.now = () => clock;
  globalThis.fetch = async () => {
    clock += 31_000;
    return { ok: true, json: async () => ({ success: true }) };
  };
  try {
    const result = await finalizeFormSubmission({
      supabase: db,
      submission: structuredClone(db.row),
      form: {
        id: 'form-1',
        fields: [],
        entity_pipelines: { members: [{ id: 'primary', isPrimary: true }] },
        submission_emails: [],
      },
      baseUrl: 'https://tenant.example.test',
      deadlineAt: clock + 40_000,
    });
    assert.equal(result.finalized, false);
    assert.equal(result.retryable, true);
    assert.equal(result.budgetExhausted, true);
    assert.deepEqual(result.budgetDeferredStages, ['membership', 'submission_emails']);
    assert.equal(db.row.payment_meta.completion.status, 'retryable');
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = realNow;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test('a later completion attempt reuses the successful pipeline checkpoint', async () => {
  const db = oneOffFinalizationDb({ pipelineOperation: { status: 'claimed' } });
  db.row.payment_meta = { completion: { version: 1, status: 'queued', attempts: 0 } };
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  const realNow = Date.now;
  const originalRpc = db.rpc.bind(db);
  let operationDone = false;
  let pipelineCalls = 0;
  let clock = 4_000_000;
  db.rpc = async (name, args) => {
    if (name === 'observe_or_begin_form_paid_pipeline_operation') {
      return { data: { status: operationDone ? 'done' : 'claimed' }, error: null };
    }
    return originalRpc(name, args);
  };
  process.env.APP_URL = 'https://internal.example.test';
  Date.now = () => clock;
  globalThis.fetch = async () => {
    pipelineCalls += 1;
    clock += 31_000;
    operationDone = true;
    return { ok: true, json: async () => ({ success: true }) };
  };
  try {
    const options = {
      supabase: db,
      form: {
        id: 'form-1',
        fields: [],
        entity_pipelines: { members: [{ id: 'primary', isPrimary: true }] },
        submission_emails: [],
      },
      baseUrl: 'https://tenant.example.test',
      deadlineAt: clock + 40_000,
    };
    const first = await finalizeFormSubmission({
      ...options,
      submission: structuredClone(db.row),
    });
    assert.equal(first.budgetExhausted, true);
    clock = 5_000_000;
    const second = await finalizeFormSubmission({
      ...options,
      submission: structuredClone(db.row),
      deadlineAt: clock + 40_000,
    });
    assert.equal(second.finalized, true);
    assert.equal(pipelineCalls, 1, 'the checkpointed pipeline must not be called again');
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = realNow;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test('a real DD failure remains an error when a later email stage is budget-deferred', async () => {
  const db = oneOffFinalizationDb({
    pipelineOperation: { status: 'claimed' },
    dueDiligenceReadyError: { message: 'readiness temporarily unavailable' },
  });
  db.row.payment_meta = { completion: { version: 1, status: 'queued', attempts: 0 } };
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  const realNow = Date.now;
  let clock = 6_000_000;
  process.env.APP_URL = 'https://internal.example.test';
  Date.now = () => clock;
  globalThis.fetch = async () => {
    clock += 25_000;
    return { ok: true, json: async () => ({ success: true }) };
  };
  try {
    const result = await finalizeFormSubmission({
      supabase: db,
      submission: structuredClone(db.row),
      form: {
        id: 'form-1',
        fields: [],
        entity_pipelines: { members: [{ id: 'primary', isPrimary: true }] },
        submission_emails: [],
      },
      baseUrl: 'https://tenant.example.test',
      deadlineAt: clock + 40_000,
    });
    assert.equal(result.finalized, false);
    assert.equal(result.retryable, true);
    assert.equal(result.budgetExhausted, undefined);
    assert.equal(result.budgetDeferredStages?.includes('submission_emails'), true);
    assert.equal(db.row.payment_meta.completion.status, 'retryable');
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = realNow;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test('attention is terminal and finalization does not reclaim or replay it', async () => {
  const db = oneOffFinalizationDb();
  db.row.payment_meta = { completion: { version: 1, status: 'attention', attempts: 1 } };
  const result = await finalizeFormSubmission({
    supabase: db,
    submission: structuredClone(db.row),
    form: { id: 'form-1', fields: [], entity_pipelines: {}, submission_emails: [] },
    baseUrl: '',
  });
  assert.deepEqual(result, { finalized: false, requiresAttention: true, terminal: true });
  assert.deepEqual(db.rpcNames, []);
});

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
      if (name === 'claim_form_payment_reconciliation_work') return { data: [], error: null };
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
    entry.scope === 'due-diligence-readiness-recovery'
      && entry.code === 'stage-failed'
      && entry.error === 'Reconciliation stage failed.'));
});

test('a slow pending-provider row cannot starve Stripe address capture or its paid completion', async () => {
  const events = [];
  const completionRow = {
    id: 'paid-completion', tenant_id: 'tenant-1', form_id: 'form-1',
    payment_provider: 'stripe', payment_status: 'paid', payment_reference: 'pi_address', submission_data: {},
    payment_meta: {
      membership: true,
      completion: {
        version: 1, status: 'queued', owner_token: '11111111-1111-4111-8111-111111111111', attempts: 0,
      },
    },
  };
  const pendingRow = {
    id: 'slow-pending', tenant_id: 'tenant-1', form_id: 'form-1',
    payment_provider: 'stripe', payment_status: 'pending', payment_reference: 'pi_slow',
    payment_meta: {}, created_date: new Date(0).toISOString(),
  };
  const form = { id: 'form-1', tenant_id: 'tenant-1', fields: [], entity_pipelines: {}, submission_emails: [] };
  let managedAddressClaimed = false;
  let managedCompletionClaimed = false;
  const db = {
    async rpc(name, args) {
      if (name === 'claim_form_payment_reconciliation_work') {
        if (managedAddressClaimed) {
          if (managedCompletionClaimed) return { data: [], error: null };
          managedCompletionClaimed = true;
          events.push('claim-completion');
          assert.ok(completionRow.payment_meta.stripe_billing_address, 'completion must receive captured address');
          return {
            data: [{ work_kind: 'completion', submission: completionRow, lease_token: null }],
            error: null,
          };
        }
        managedAddressClaimed = true;
        events.push('claim-address');
        return {
          data: [{
            work_kind: 'address',
            submission: completionRow,
            lease_token: '22222222-2222-4222-8222-222222222222',
          }],
          error: null,
        };
      }
      if (name === 'capture_form_stripe_billing_address_once') {
        events.push('capture-address');
        completionRow.payment_meta = {
          ...completionRow.payment_meta,
          stripe_billing_address: args.p_address,
        };
        return { data: completionRow.payment_meta, error: null };
      }
      if (name === 'finish_form_stripe_address_mapping_retry') {
        events.push('finish-address');
        return { data: null, error: null };
      }
      if (name === 'finish_form_payment_completion') {
        events.push('finish-completion');
        completionRow.payment_meta.completion = {
          ...completionRow.payment_meta.completion,
          status: args.p_status,
        };
        return { data: true, error: null };
      }
      if (name === 'finish_form_payment_completion_retry') return { data: true, error: null };
      if (name === 'mark_one_off_form_due_diligence_ready') return { data: true, error: null };
      if (name === 'claim_form_due_diligence_initialization') return { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      if (name === 'mark_expired_missing_one_off_form_due_diligence_ready_attention'
          || name === 'claim_missing_one_off_form_due_diligence_ready'
          || name === 'mark_expired_paid_form_due_diligence_attention'
          || name === 'list_form_due_diligence_paid_initialization_work') return { data: [], error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table) {
      const filters = [];
      let updatePayload = null;
      const query = {
        select() { return query; },
        update(value) { updatePayload = value; return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        not() { return query; }, gte() { return query; }, lte() { return query; },
        filter() { return query; }, or() { return query; }, order() { return query; },
        in() { return query; },
        limit() {
          const pending = filters.some(([column, value]) => column === 'payment_status' && value === 'pending');
          return Promise.resolve({ data: table === 'form_submission' && pending ? [pendingRow] : [], error: null });
        },
        maybeSingle: async () => {
          if (table === 'form') return { data: form, error: null };
          if (table === 'form_submission' && updatePayload) {
            Object.assign(completionRow, structuredClone(updatePayload));
          }
          return { data: completionRow, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    retrievePaymentIntent: async (_tenantId, _feature, intentId) => {
      if (intentId === 'pi_address') {
        events.push('address-provider-started');
        return {
          paymentIntent: {
            id: 'pi_address',
            status: 'succeeded',
            latest_charge: 'ch_address',
            customer: 'cus_address',
            metadata: {
              type: 'form_payment',
              form_submission_id: completionRow.id,
              tenant_id: completionRow.tenant_id,
            },
          },
          stripe: {
            charges: {
              retrieve: async () => ({
                billing_details: {
                  address: {
                    line1: '10 High Street',
                    city: 'Leeds',
                    postal_code: 'LS1 1AA',
                    country: 'GB',
                  },
                },
              }),
            },
            customers: { update: async () => ({}) },
          },
        };
      }
      events.push('pending-provider-started');
      await new Promise(resolve => setTimeout(resolve, 20));
      return { paymentIntent: { id: 'pi_slow', status: 'processing', metadata: {} } };
    },
  });
  assert.equal(completionRow.payment_meta.completion.status, 'done');
  assert.ok(
    events.indexOf('capture-address') > -1
      && events.indexOf('finish-completion') > events.indexOf('capture-address')
      && events.indexOf('finish-completion') < events.indexOf('pending-provider-started'),
    `address capture and paid completion must precede slow pending provider work: ${events.join(', ')}`,
  );
});

test('full reconciliation keeps v1 partial and other-owner membership rows inside completion lifecycle', async () => {
  const partial = {
    id: 'managed-partial', tenant_id: 'tenant-1', form_id: 'form-1',
    payment_status: 'paid', payment_provider: 'stripe', submission_data: {},
    payment_meta: {
      finalized: true,
      completion: { version: 1, status: 'retryable' },
      membership: { quote: { target: 'member' } },
      structured_actions_pending: true,
    },
  };
  const processing = {
    ...structuredClone(partial),
    id: 'managed-processing',
    payment_meta: {
      ...structuredClone(partial.payment_meta),
      completion: { version: 1, status: 'processing' },
    },
  };
  const done = {
    ...structuredClone(partial),
    id: 'managed-done',
    payment_meta: {
      ...structuredClone(partial.payment_meta),
      completion: { version: 1, status: 'done' },
    },
  };
  const attention = {
    ...structuredClone(partial),
    id: 'managed-attention',
    payment_meta: {
      ...structuredClone(partial.payment_meta),
      completion: { version: 1, status: 'attention' },
    },
  };
  const rowsById = new Map([
    [partial.id, partial],
    [processing.id, processing],
    [attention.id, attention],
    [done.id, done],
  ]);
  const effects = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.notFilters = [];
      this.ors = [];
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    not(...args) { this.notFilters.push(args); return this; }
    filter() { return this; }
    or(value) { this.ors.push(value); return this; }
    gte() { return this; }
    lte() { return this; }
    order() { return this; }
    in() { return this; }
    update() { effects.push(`update:${this.table}`); return this; }
    maybeSingle = async () => {
      const id = this.filters.find(([column]) => column === 'id')?.[1];
      return { data: rowsById.get(id) || null, error: null };
    };
    limit() {
      const isMembershipSweep = this.table === 'form_submission'
        && this.notFilters.some(([column]) => column === 'payment_meta->membership->quote');
      // Deliberately return managed rows despite the SQL predicate to prove
      // the loop's defense-in-depth guard prevents independent effects.
      return Promise.resolve({ data: isMembershipSweep ? [partial, processing, attention, done] : [], error: null });
    }
    then(resolve, reject) { return this.limit().then(resolve, reject); }
  }
  const db = {
    from(table) {
      if (table !== 'form_submission') effects.push(`read:${table}`);
      return new Query(table);
    },
    async rpc(name) {
      if (name === 'claim_form_payment_reconciliation_work'
          || name === 'mark_expired_missing_one_off_form_due_diligence_ready_attention'
          || name === 'claim_missing_one_off_form_due_diligence_ready'
          || name === 'mark_expired_paid_form_due_diligence_attention') {
        return { data: [], error: null };
      }
      if (name === 'list_form_due_diligence_paid_initialization_work') {
        return {
          data: partial.id && [
            { form_submission_id: partial.id, tenant_id: partial.tenant_id },
            { form_submission_id: processing.id, tenant_id: processing.tenant_id },
            { form_submission_id: attention.id, tenant_id: attention.tenant_id },
            { form_submission_id: done.id, tenant_id: done.tenant_id },
          ],
          error: null,
        };
      }
      if (name === 'claim_form_due_diligence_initialization') {
        effects.push(`rpc:${name}`);
        return { data: { claimed: false, code: 'ALREADY_COMPLETED' }, error: null };
      }
      effects.push(`rpc:${name}`);
      return { data: [], error: null };
    },
  };
  const result = await reconcileFormPayments(db, {
    baseUrl: 'https://tenant.example.test',
    timeBudgetMs: 60_000,
  });
  assert.equal(result.finalized, 0);
  assert.equal(effects.some(effect => (
    /membership|submission_email|accounting/i.test(effect)
  )), false, `managed rows must not trigger downstream effects: ${effects.join(', ')}`);
  assert.equal(
    effects.filter(effect => effect === 'rpc:claim_form_due_diligence_initialization').length,
    1,
    'only durable done may enter the independent DD retry lifecycle',
  );
  assert.equal(effects.includes('read:form'), false, 'membership loop must skip before loading a form');
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
  const dueSweepAt = reconciliation.indexOf('reconcilePaidFormDueDiligence({');
  const readinessRecoveryAt = reconciliation.indexOf('recoverMissingOneOffDueDiligenceReadiness(supabase, {');
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

test('completion attention is terminal and every paid retry surface excludes it', () => {
  const reconciliation = source('formPaymentReconciliation.js');
  const payment = source('../public/form-payment.js');
  const migration = source('../../supabase/migrations/20261028_form_payment_completion_retry_and_pipeline_operation.sql');
  assert.match(payment, /status !== 'paid' && !requiresAttention/);
  assert.match(reconciliation, /claim_form_payment_reconciliation_work/);
  assert.match(reconciliation, /payment_meta->completion->>status\.neq\.attention/);
  assert.match(migration, /COALESCE\(s\.payment_meta->'completion'->>'status', ''\) <> 'attention'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_form_payment_completion_retries\(INTEGER\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_form_payment_completion_retries\(INTEGER\) TO service_role/);
  assert.match(migration, /finish_form_stripe_address_mapping_retry\(UUID, UUID, UUID, BOOLEAN, TEXT\)/);
});

test('email attention cannot be promoted to a completed paid receipt after a retry', () => {
  const finalizer = source('formPaymentFinalize.js');
  assert.match(finalizer, /emailResult\?\.requiresAttention === true/);
  assert.match(finalizer, /&& emailCompleted\s*&& !emailRequiresAttention/);
  assert.match(finalizer, /emailRequiresAttention\) \? 'attention' : 'retryable'/);
});