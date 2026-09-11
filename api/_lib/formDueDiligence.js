import { randomUUID } from 'node:crypto';
import { executeStageActions } from '../due-diligence/_stageActions.js';

// The database owns the eligibility marker, lease and lifecycle state.  In
// particular, do not infer paid eligibility here: payment code must be able to
// call this helper without ever making a DD policy decision.
function actionCheckpointKey(result) {
  if (!result || typeof result !== 'object') return null;
  const id = result.field_id
    || result.meeting_request_id
    || result.email_action_id
    || result.member_action_id
    || result.field_mapping_action_id
    || result.action_id;
  if (!id) return null;
  const prefix = {
    send_contract: 'contract',
    send_meeting_request: 'meeting',
    send_email_template: 'email',
    create_member: 'member',
    field_mapping: 'field_mapping',
    zoho_crm_create: 'zoho',
  }[result.action];
  return prefix ? `${prefix}:${id}` : null;
}

function hasFailure(value) {
  if (Array.isArray(value)) return value.some(hasFailure);
  if (!value || typeof value !== 'object') return false;
  if (['error', 'failed', 'partial'].includes(String(value.status || '').toLowerCase())) return true;
  if (Array.isArray(value.custom_field_errors) && value.custom_field_errors.length > 0) return true;
  return Object.values(value).some(hasFailure);
}

function completedActionKeys(results) {
  return (Array.isArray(results) ? results : [])
    .filter((result) => (
      ['success', 'skipped', 'noop'].includes(String(result?.status || '').toLowerCase())
      && !hasFailure(result)
    ))
    .map(actionCheckpointKey)
    .filter(Boolean);
}

async function rpc(db, fn, args) {
  const result = await db.rpc(fn, args);
  if (result?.error) throw new Error(`${fn}: ${result.error.message || 'database error'}`);
  return result?.data;
}

/**
 * Create and initialise ordinary DD submissions.  The claim RPC performs the
 * tenant-bound form/submission validation and creates the DD row atomically.
 * It deliberately leaves an interrupted lease unreplayable: after an
 * external stage effect starts we cannot know whether the provider accepted
 * it, so automatic replay would be less safe than requiring intervention.
 */
export async function initializeFormDueDiligence({
  db,
  submissionId,
  tenantId,
  paidOnly = false,
  executeActions = executeStageActions,
}) {
  if (!db || !submissionId || !tenantId) {
    return { ok: false, code: 'INVALID_ARGUMENT' };
  }

  const leaseToken = randomUUID();
  let claim;
  try {
    claim = await rpc(db, 'claim_form_due_diligence_initialization', {
      p_tenant_id: tenantId,
      p_submission_id: submissionId,
      p_lease_token: leaseToken,
      p_paid_only: paidOnly,
    });
  } catch (error) {
    // A trigger-marked paid row already has a durable lifecycle row even when
    // its claim transaction aborts. Back it off so a poison claim cannot take
    // every reconciliation batch. This has no effect on unmarked/historical
    // rows and never makes a payment-policy decision in JavaScript.
    try {
      await rpc(db, 'record_form_due_diligence_claim_failure', {
        p_tenant_id: tenantId,
        p_submission_id: submissionId,
        p_error: error.message || 'Could not claim due-diligence initialization',
      });
    } catch (recordError) {
      console.error('[Form DD] Could not persist claim failure backoff:', recordError);
    }
    return { ok: false, code: 'CLAIM_FAILED', error: error.message };
  }

  if (!claim?.claimed) {
    const code = claim?.code;
    const knownNonClaims = new Set([
      'SUBMISSION_NOT_FOUND',
      'NOT_ELIGIBLE',
      'ONE_OFF_NOT_READY',
      'FORM_NOT_ELIGIBLE',
      'ANONYMOUS_SUBMISSION',
      'NOT_PROSPECTIVELY_MARKED',
      'PAYMENT_NOT_SUCCESSFUL',
      'PAYMENT_LIFECYCLE_REQUIRES_MARKER',
      'ALREADY_COMPLETED',
      'RETRY_NOT_DUE',
      'REQUIRES_ATTENTION',
    ]);
    if (!knownNonClaims.has(code)) {
      return { ok: false, claimed: false, code: 'INVALID_CLAIM_RESPONSE' };
    }
    return { ok: true, claimed: false, code };
  }

  const ddSubmission = claim.dd_submission;
  const stageId = claim.initial_stage_id || ddSubmission?.workflow_status || 'new';
  let completed;
  try {
    const checkpointResult = await db
      .from('form_due_diligence_action_checkpoint')
      .select('action_key')
      .eq('form_submission_due_diligence_id', ddSubmission.id)
      .eq('tenant_id', tenantId)
      .eq('status', 'completed');
    if (checkpointResult.error) throw new Error(checkpointResult.error.message);
    completed = new Set((checkpointResult.data || []).map((row) => row.action_key));
  } catch (error) {
    // No effect has started yet. This is a known database failure, so release
    // the claim into its durable retry/backoff state rather than declaring it
    // ambiguous.
    try {
      await rpc(db, 'finish_form_due_diligence_initialization', {
        p_tenant_id: tenantId,
        p_submission_id: submissionId,
        p_lease_token: leaseToken,
        p_succeeded: false,
        p_error: `Could not read action checkpoints: ${error.message}`,
        p_ambiguous: false,
      });
    } catch (finishError) {
      console.error('[Form DD] Could not persist retryable checkpoint-read failure:', finishError);
    }
    return { ok: false, claimed: true, code: 'CHECKPOINT_READ_FAILED', error: error.message };
  }

  try {
    const actionResult = await executeActions(
      stageId,
      { ...ddSubmission, form_id: claim.form_id },
      tenantId,
      'system_init',
      {
        completedActionKeys: completed,
        // Each executor awaits this callback before it begins its next
        // configured action. Thus a known later failure can retry without
        // replaying already completed effects.
        onActionCompleted: async (actionKey) => {
          await rpc(db, 'checkpoint_form_due_diligence_actions', {
            p_tenant_id: tenantId,
            p_submission_id: submissionId,
            p_lease_token: leaseToken,
            p_action_keys: [actionKey],
          });
          completed.add(actionKey);
        },
      },
    );
    const results = actionResult?.stage_actions_results || [];
    const keys = completedActionKeys(results).filter((key) => !completed.has(key));
    if (keys.length) {
      await rpc(db, 'checkpoint_form_due_diligence_actions', {
        p_tenant_id: tenantId,
        p_submission_id: submissionId,
        p_lease_token: leaseToken,
        p_action_keys: keys,
      });
    }

    const failure = hasFailure(results);
    await rpc(db, 'finish_form_due_diligence_initialization', {
      p_tenant_id: tenantId,
      p_submission_id: submissionId,
      p_lease_token: leaseToken,
      p_succeeded: !failure,
      p_error: failure ? 'One or more initial due-diligence actions failed' : null,
      p_ambiguous: false,
    });
    return { ok: !failure, claimed: true, ddRecordId: ddSubmission.id, stageActionsResults: results };
  } catch (error) {
    // A thrown action may have reached an external provider before its result
    // was persisted.  Keep this lease in an explicit attention state rather
    // than replaying potentially completed work on a later payment retry.
    try {
      await rpc(db, 'finish_form_due_diligence_initialization', {
        p_tenant_id: tenantId,
        p_submission_id: submissionId,
        p_lease_token: leaseToken,
        p_succeeded: false,
        p_error: error.message || 'Initial due-diligence action interrupted',
        // Configuration/read failures are known before an effect runs and can
        // use normal retry backoff. Provider/action throws and checkpoint
        // write failures remain ambiguous by default.
        p_ambiguous: !error.ddKnownQueryFailure,
      });
    } catch (finishError) {
      console.error('[Form DD] Could not persist interrupted lifecycle:', finishError);
    }
    return {
      ok: false,
      claimed: true,
      code: error.ddKnownQueryFailure ? 'STAGE_ACTION_QUERY_FAILED' : 'INITIALIZATION_INTERRUPTED',
      error: error.message,
    };
  }
}

// Financial callers must never receive a DD exception or make DD eligibility
// decisions.  The INSERT trigger is the sole prospective eligibility marker.
export async function initializePaidFormDueDiligence({ db, submissionId, tenantId }) {
  try {
    return await initializeFormDueDiligence({ db, submissionId, tenantId, paidOnly: true });
  } catch (error) {
    console.error('[Form DD] Paid initialization unexpectedly threw:', error);
    return { ok: false, code: 'INITIALIZATION_INTERRUPTED', error: error.message };
  }
}

// This intentionally scans only trigger-marked work.  It does not inspect
// payment status, form settings, or any other financial state.
export async function reconcilePaidFormDueDiligence({ db, limit = 20 }) {
  if (!db) return { ok: false, code: 'INVALID_ARGUMENT', processed: 0 };
  try {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    // Expired leases are deliberately not reclaimed: the prior worker could
    // have completed an external effect before it died. Surface these bounded
    // rows for manual review before processing known-safe queued retries.
    const requiresAttention = await rpc(db, 'mark_expired_paid_form_due_diligence_attention', {
      p_limit: boundedLimit,
    });
    const rows = await rpc(db, 'list_form_due_diligence_paid_initialization_work', {
      p_limit: boundedLimit,
    });
    const outcomes = [];
    for (const row of rows || []) {
      outcomes.push(await initializePaidFormDueDiligence({
        db,
        submissionId: row.form_submission_id,
        tenantId: row.tenant_id,
      }));
    }
    return {
      ok: outcomes.every((outcome) => outcome.ok) && (requiresAttention || []).length === 0,
      processed: outcomes.filter((outcome) => outcome.claimed).length,
      outcomes,
      requiresAttention: requiresAttention || [],
    };
  } catch (error) {
    return { ok: false, code: 'RECONCILIATION_FAILED', processed: 0, error: error.message };
  }
}

export const __testables = { actionCheckpointKey, completedActionKeys, hasFailure };