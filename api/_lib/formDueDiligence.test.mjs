import test from 'node:test';
import assert from 'node:assert/strict';
import { __testables } from './formDueDiligence.js';

test('due-diligence checkpoint keys are stable per configured action', () => {
  assert.equal(__testables.actionCheckpointKey({ action: 'send_email_template', email_action_id: 'email-1' }), 'email:email-1');
  assert.equal(__testables.actionCheckpointKey({ action: 'field_mapping', field_mapping_action_id: 'map-1' }), 'field_mapping:map-1');
  assert.equal(__testables.actionCheckpointKey({ action: 'send_contract', field_id: 'field-1' }), 'contract:field-1');
});

test('nested stage-action failures prevent a lifecycle success checkpoint', () => {
  assert.equal(__testables.hasFailure([{ action: 'field_mapping', status: 'success', mappings: [{ status: 'error' }] }]), true);
  assert.equal(__testables.hasFailure([{ action: 'send_email_template', status: 'success' }]), false);
  assert.deepEqual(
    __testables.completedActionKeys([
      { action: 'send_email_template', email_action_id: 'a', status: 'success' },
      { action: 'send_meeting_request', meeting_request_id: 'b', status: 'error' },
      { action: 'field_mapping', field_mapping_action_id: 'c', status: 'partial' },
    ]),
    ['email:a'],
  );
});

test('paid initializer never throws when its database dependency fails', async () => {
  const { initializePaidFormDueDiligence } = await import('./formDueDiligence.js');
  const outcome = await initializePaidFormDueDiligence({
    db: { rpc: async () => { throw new Error('database unavailable'); } },
    submissionId: 'submission',
    tenantId: 'tenant',
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'CLAIM_FAILED');
});

test('unknown claim RPC response fails closed without loading or acting on DD', async () => {
  let fromCalled = false;
  const { initializeFormDueDiligence } = await import('./formDueDiligence.js');
  const outcome = await initializeFormDueDiligence({
    db: {
      rpc: async () => ({ data: { claimed: false, code: 'UNRECOGNIZED_RPC_STATE' }, error: null }),
      from: () => { fromCalled = true; throw new Error('must not read checkpoints'); },
    },
    submissionId: 'submission',
    tenantId: 'tenant',
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'INVALID_CLAIM_RESPONSE');
  assert.equal(fromCalled, false);
});

test('reconciliation surfaces expired work as attention without reexecuting it', async () => {
  const rpcNames = [];
  const { reconcilePaidFormDueDiligence } = await import('./formDueDiligence.js');
  const outcome = await reconcilePaidFormDueDiligence({
    db: {
      rpc: async (name) => {
        rpcNames.push(name);
        if (name === 'mark_expired_paid_form_due_diligence_attention') {
          return { data: [{ form_submission_id: 'expired', tenant_id: 'tenant', last_error: 'ambiguous' }], error: null };
        }
        if (name === 'list_form_due_diligence_paid_initialization_work') {
          return { data: [], error: null };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.processed, 0);
  assert.equal(outcome.requiresAttention.length, 1);
  assert.deepEqual(rpcNames, [
    'mark_expired_paid_form_due_diligence_attention',
    'list_form_due_diligence_paid_initialization_work',
  ]);
});

test('successful action is checkpointed before lifecycle completion', async () => {
  const calls = [];
  const checkpointQuery = {
    eq() { return this; },
    then(resolve) { return resolve({ data: [], error: null }); },
  };
  const db = {
    from: () => ({ select: () => checkpointQuery }),
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      if (fn === 'claim_form_due_diligence_initialization') {
        return {
          data: {
            claimed: true,
            form_id: 'form',
            initial_stage_id: 'new',
            dd_submission: { id: 'dd', form_submission_id: 'submission', workflow_status: 'new' },
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  const { initializeFormDueDiligence } = await import('./formDueDiligence.js');
  const result = await initializeFormDueDiligence({
    db,
    submissionId: 'submission',
    tenantId: 'tenant',
    executeActions: async (_stage, _dd, _tenant, _actor, options) => {
      await options.onActionCompleted('email:configured-action');
      return { stage_actions_results: [{ action: 'send_email_template', email_action_id: 'configured-action', status: 'success' }] };
    },
  });
  assert.equal(result.ok, true);
  const checkpointAt = calls.findIndex(([fn]) => fn === 'checkpoint_form_due_diligence_actions');
  const finishAt = calls.findIndex(([fn]) => fn === 'finish_form_due_diligence_initialization');
  assert.ok(checkpointAt > -1 && checkpointAt < finishAt);
});

test('checkpoint read failure is a retryable lifecycle failure before effects', async () => {
  const calls = [];
  const failingQuery = {
    eq() { return this; },
    then(resolve) { return resolve({ data: null, error: { message: 'read failed' } }); },
  };
  const db = {
    from: () => ({ select: () => failingQuery }),
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      if (fn === 'claim_form_due_diligence_initialization') {
        return { data: { claimed: true, dd_submission: { id: 'dd', workflow_status: 'new' } }, error: null };
      }
      return { data: null, error: null };
    },
  };
  const { initializeFormDueDiligence } = await import('./formDueDiligence.js');
  const result = await initializeFormDueDiligence({ db, submissionId: 'submission', tenantId: 'tenant' });
  assert.equal(result.code, 'CHECKPOINT_READ_FAILED');
  const finish = calls.find(([fn]) => fn === 'finish_form_due_diligence_initialization');
  assert.equal(finish[1].p_ambiguous, false);
});