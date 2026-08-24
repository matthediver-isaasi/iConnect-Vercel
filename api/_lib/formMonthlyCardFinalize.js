/**
 * Form monthly-card checkout finalisation (Task #3680).
 *
 * When a form submission was created for a monthly-card (Stripe subscription)
 * membership agreement, the Stripe checkout.session.completed event triggers
 * this module BEFORE ensureCardPlanForCheckout runs. It:
 *
 *  1. Idempotently marks the form_submission as setup-complete (CAS
 *     pending → setup_complete).
 *
 *  2. Claims a processing lease (stamped in payment_meta.monthly_card_state)
 *     with a timestamp so:
 *       - exactly one concurrent caller runs the side effects at a time,
 *       - a process crash is recovered after FINALIZE_CLAIM_TTL_MS by any
 *         subsequent caller (webhook retry, reconciliation cron),
 *       - a known failure releases the claim back to retryable.
 *
 *  3. Runs the form entity pipelines exactly once to create/resolve the
 *     member. If the member is still unresolved the lease is released and
 *     the caller receives { retryable: true }.
 *
 *  4. Attaches member_id to the billing agreement (idempotent).
 *
 *  5. Creates exactly one member_membership_history row:
 *       billing_period:   'monthly_card'
 *       payment_method:   'card_monthly'
 *       payment_status:   'unpaid'
 *       status:           'pending_payment_setup'
 *       billing_agreement_id: agreement.id
 *     Immutable snapshot values from agreement.metadata.card. No annual
 *     invoice; no paid workflow.
 *
 *  6. Sends configured form submission emails via sendSubmissionEmailsGuarded
 *     (exactly-once via the shared submission_email_state CAS).
 *
 *  7. Stamps monthly_card_state = { status: 'done' } ONLY after all the
 *     above obligations complete.
 *
 * Claim state machine (payment_meta.monthly_card_state):
 *   absent / null        → no prior attempt, or claim released after failure
 *   { status:'processing', claimed_at: ISO } → active lease (TTL-bounded)
 *   { status:'done' }    → all obligations complete (terminal)
 *
 * Concurrent callers:
 *   - See 'processing' with a fresh claimed_at → return { retryable: true }
 *     (the active holder will stamp 'done' or release to pending on failure).
 *   - See 'processing' with a stale claimed_at (> TTL) → re-claim the lease
 *     (CAS on the exact stale timestamp) and resume.
 *   - See 'done' → { handled: true, alreadyFinalized: true }.
 *
 * Never throws on Supabase write errors — all DB errors are checked and
 * returned as { retryable } so the caller decides.
 */

import { runFormEntityPipelines } from './formEntityPipelines.js';
import { sendSubmissionEmailsGuarded } from './formSubmissionEmails.js';
import { claimFormMonthlyCardMembership } from './formMonthlyCardCheckout.js';
import { randomUUID } from 'node:crypto';
import { hasFormPaymentAccessProof } from './formPaymentAccess.js';

// A processing lease older than this may be re-claimed by any subsequent
// caller (webhook retry, reconciliation cron). Mirrors WORKFLOW_CLAIM_TTL_MS.
export const FINALIZE_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Full form columns needed for entity pipelines + submission emails.
export const FORM_COLUMNS = 'id, name, tenant_id, access_policy, fields, pages, visibility_rules, entity_pipelines, field_mappings, application_level, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type';

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * CAS pending -> setup_complete on the form_submission row.
 * Returns { updated, row, error }.
 */
async function markFormSubmissionSetupComplete(db, submissionId) {
  const { data, error } = await db
    .from('form_submission')
    .update({
      payment_status: 'setup_complete',
      payment_paid_at: new Date().toISOString(),
    })
    .eq('id', submissionId)
    .eq('payment_status', 'pending')
    .select()
    .maybeSingle();
  if (error) {
    return { updated: false, row: null, error: `CAS update failed: ${error.message}` };
  }
  return { updated: !!data, row: data || null, error: null };
}

/**
 * Read the current monthly_card_state from a fresh DB read.
 * Returns { state, meta } or { state: null } on error.
 */
async function readClaimState(db, submissionId) {
  const { data, error } = await db
    .from('form_submission')
    .select('payment_status, payment_meta')
    .eq('id', submissionId)
    .maybeSingle();
  if (error || !data) return { state: null, meta: {} };
  const meta = (data.payment_meta && typeof data.payment_meta === 'object') ? data.payment_meta : {};
  const state = (meta.monthly_card_state && typeof meta.monthly_card_state === 'object')
    ? meta.monthly_card_state : null;
  return { state, meta, paymentStatus: data.payment_status };
}

/**
 * Try to write a new 'processing' lease via a CAS filter.
 *
 * expectedCurrentStatus is one of:
 *   'absent'    — filter: monthly_card_state IS NULL (first claim)
 *   'stale'     — filter: monthly_card_state->>claimed_at = staleTimestamp
 *
 * Returns { claimed: boolean, claimedAt: ISO | null }.
 */
async function writeClaim(db, submissionId, meta, { expectedCurrentStatus, staleTimestamp = null }) {
  const claimedAt = new Date().toISOString();
  const ownerToken = randomUUID();
  const newMeta = {
    ...meta,
    monthly_card_state: {
      status: 'processing',
      claimed_at: claimedAt,
      owner_token: ownerToken,
    },
  };

  let query = db
    .from('form_submission')
    .update({ payment_meta: newMeta })
    .eq('id', submissionId)
    .eq('payment_status', 'setup_complete');

  if (expectedCurrentStatus === 'absent') {
    query = query.filter('payment_meta->monthly_card_state', 'is', null);
  } else {
    // Stale re-claim: must match exact stale timestamp.
    query = query.filter(
      'payment_meta->monthly_card_state->>claimed_at',
      'eq',
      staleTimestamp,
    );
  }

  const { data: updated, error } = await query.select('id').maybeSingle();
  if (error) return { claimed: false, claimedAt: null, ownerToken: null };
  return {
    claimed: !!updated,
    claimedAt: updated ? claimedAt : null,
    ownerToken: updated ? ownerToken : null,
  };
}

/**
 * Write the terminal 'done' stamp, or release the lease back to absent so
 * the next caller retries. The owner-token filter prevents an expired worker
 * from clearing or completing a lease that a newer worker has reclaimed.
 */
async function writeClaimResult(db, submissionId, { done, ownerToken }) {
  const { state, meta } = await readClaimState(db, submissionId);
  if (!ownerToken || state?.status !== 'processing' || state.owner_token !== ownerToken) {
    return false;
  }
  const nextMeta = { ...meta };
  if (done) {
    nextMeta.monthly_card_state = {
      status: 'done',
      done_at: new Date().toISOString(),
    };
  } else {
    // Delete the key entirely. JSONB {"monthly_card_state": null} is JSON
    // null, not SQL NULL, so PostgREST's `->monthly_card_state IS NULL`
    // claim/sweep predicate would never see it as released.
    delete nextMeta.monthly_card_state;
  }
  try {
    const { data, error } = await db
      .from('form_submission')
      .update({ payment_meta: nextMeta })
      .eq('id', submissionId)
      .filter('payment_meta->monthly_card_state->>owner_token', 'eq', ownerToken)
      .select('id');
    if (error) {
      console.error('[formMonthlyCardFinalize] writeClaimResult failed:', error.message);
      return false;
    }
    return Array.isArray(data) ? data.length > 0 : !!data;
  } catch (err) {
    console.error('[formMonthlyCardFinalize] writeClaimResult threw:', err?.message);
    return false;
  }
}

async function writeConflictState(db, submissionId, {
  ownerToken,
  code,
  detail,
  memberId,
}) {
  const { state, meta } = await readClaimState(db, submissionId);
  if (!ownerToken || state?.status !== 'processing' || state.owner_token !== ownerToken) {
    return false;
  }
  const conflictState = {
    status: 'conflict',
    code: code || 'MEMBERSHIP_YEAR_CONFLICT',
    detail: detail || 'Membership for this year is already recorded',
    member_id: memberId || null,
    detected_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('form_submission')
    .update({
      payment_meta: { ...meta, monthly_card_state: conflictState },
      processing_notes: `${conflictState.detail}. The Stripe subscription will be cancelled and any successful payment refunded automatically.`,
    })
    .eq('id', submissionId)
    .filter('payment_meta->monthly_card_state->>owner_token', 'eq', ownerToken)
    .select('id');
  if (error) return false;
  return Array.isArray(data) ? data.length > 0 : !!data;
}

/**
 * Extend an active lease while process-application is running. The owner token
 * is stable; only its holder can renew. If renewal loses ownership, the old
 * worker is allowed to finish its idempotent pipeline call but cannot attach,
 * release, or stamp the submission afterward.
 */
async function renewClaimLease(db, submissionId, ownerToken) {
  const { state, meta } = await readClaimState(db, submissionId);
  if (state?.status !== 'processing' || state.owner_token !== ownerToken) return false;
  const renewedState = {
    ...state,
    claimed_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('form_submission')
    .update({ payment_meta: { ...meta, monthly_card_state: renewedState } })
    .eq('id', submissionId)
    .filter('payment_meta->monthly_card_state->>owner_token', 'eq', ownerToken)
    .select('id');
  if (error) return false;
  return Array.isArray(data) ? data.length > 0 : !!data;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Main entrypoint. Called from processStripeCardPlanEvent BEFORE
 * ensureCardPlanForCheckout when the checkout session belongs to a
 * form-originated agreement.
 *
 * @param {object} params
 * @param {object} params.db            - Supabase client (injected)
 * @param {object} params.agreement     - The billing agreement row (already loaded)
 * @param {object} params.session       - The Stripe checkout.session object
 * @param {string} params.baseUrl       - Tenant-trusted base URL for pipeline calls
 * @returns {Promise<{ handled: boolean, retryable?: boolean, alreadyFinalized?: boolean, detail: string }>}
 */
export async function finalizeFormMonthlyCardCheckout({ db, agreement, session, baseUrl = '' }) {
  const formSubmissionId = agreement?.metadata?.form_submission_id
    || session?.metadata?.form_submission_id
    || null;

  if (!formSubmissionId) {
    return { handled: false, detail: 'no form_submission_id on agreement metadata' };
  }

  const tenantId = agreement.tenant_id;

  // ── Load the form_submission row ─────────────────────────────────────────
  const { data: submission, error: subErr } = await db
    .from('form_submission')
    .select('*')
    .eq('id', formSubmissionId)
    .maybeSingle();
  if (subErr) {
    return { handled: false, retryable: true, detail: `load form_submission failed: ${subErr.message}` };
  }
  if (!submission) {
    return { handled: false, retryable: true, detail: `form_submission ${formSubmissionId} not found` };
  }
  if (submission.payment_status !== 'pending' && submission.payment_status !== 'setup_complete') {
    return { handled: false, detail: `form_submission ${formSubmissionId} is ${submission.payment_status}, not setup_complete` };
  }

  // Webhooks and reconciliation jobs do not carry a member session. Load the
  // form before changing payment state and require payment-start proof for a
  // restricted policy. Unrestricted legacy rows remain compatible.
  const { data: form, error: formErr } = await db
    .from('form')
    .select(FORM_COLUMNS)
    .eq('id', submission.form_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (formErr || !form) {
    return {
      handled: false,
      retryable: true,
      detail: `load form failed: ${formErr?.message || 'form not found'}`,
    };
  }
  if (!hasFormPaymentAccessProof(submission, form)) {
    return {
      handled: false,
      retryable: false,
      code: 'FORM_ACCESS_NOT_AUTHORIZED',
      detail: `form_submission ${formSubmissionId} has no trusted form-access authorization`,
    };
  }

  // ── CAS pending → setup_complete ─────────────────────────────────────────
  let currentRow = submission;
  if (submission.payment_status === 'pending') {
    const cas = await markFormSubmissionSetupComplete(db, formSubmissionId);
    if (cas.error) {
      return { handled: false, retryable: true, detail: cas.error };
    }
    if (cas.updated && cas.row) {
      currentRow = cas.row;
    } else {
      // Another caller won the CAS; re-read the fresh row.
      const { data: freshRow, error: freshErr } = await db
        .from('form_submission')
        .select('*')
        .eq('id', formSubmissionId)
        .maybeSingle();
      if (freshErr || !freshRow) {
        return { handled: false, retryable: true, detail: `re-read after CAS race failed: ${freshErr?.message || 'not found'}` };
      }
      currentRow = freshRow;
    }
  }

  if (currentRow.payment_status !== 'setup_complete') {
    return { handled: false, detail: `form_submission ${formSubmissionId} is ${currentRow.payment_status}, not setup_complete` };
  }

  // ── Inspect / acquire processing lease ───────────────────────────────────
  const { state: currentState, meta: currentMeta } = await readClaimState(db, formSubmissionId);
  let ownerToken = null;

  if (currentState?.status === 'done') {
    return { handled: true, alreadyFinalized: true, detail: `form_submission ${formSubmissionId} already finalized` };
  }
  if (currentState?.status === 'conflict') {
    return {
      handled: false,
      conflict: true,
      retryable: false,
      code: currentState.code || 'MEMBERSHIP_YEAR_CONFLICT',
      memberId: currentState.member_id || null,
      detail: currentState.detail || 'Membership for this year is already recorded',
    };
  }

  if (currentState?.status === 'processing') {
    const age = Date.now() - new Date(currentState.claimed_at || 0).getTime();
    if (age < FINALIZE_CLAIM_TTL_MS) {
      // Fresh active lease — another caller is running; let Stripe retry.
      return {
        handled: false,
        retryable: true,
        detail: `form_submission ${formSubmissionId} finalization in progress (lease age ${Math.round(age / 1000)}s)`,
      };
    }
    // Stale lease — re-claim it.
    const reClaim = await writeClaim(db, formSubmissionId, currentMeta, {
      expectedCurrentStatus: 'stale',
      staleTimestamp: currentState.claimed_at,
    });
    if (!reClaim.claimed) {
      // Lost the re-claim race to a concurrent caller.
      return {
        handled: false,
        retryable: true,
        detail: `form_submission ${formSubmissionId} stale lease re-claimed by concurrent caller`,
      };
    }
    ownerToken = reClaim.ownerToken;
  } else {
    // No prior state — first claim.
    const firstClaim = await writeClaim(db, formSubmissionId, currentMeta, {
      expectedCurrentStatus: 'absent',
    });
    if (!firstClaim.claimed) {
      // Lost to a concurrent first-claimer.
      return {
        handled: false,
        retryable: true,
        detail: `form_submission ${formSubmissionId} claim lost to concurrent caller`,
      };
    }
    ownerToken = firstClaim.ownerToken;
  }

  // ── We hold the lease — run side effects ─────────────────────────────────
  // On any failure: release the lease (set state back to null) so the next
  // caller retries from scratch. On success: stamp 'done'.

  // ── Entity pipelines ─────────────────────────────────────────────────────
  let pipelineMemberId = null;
  const leaseHeartbeat = setInterval(() => {
    renewClaimLease(db, formSubmissionId, ownerToken).catch((err) => {
      console.warn('[formMonthlyCardFinalize] Lease renewal failed:', err?.message);
    });
  }, Math.max(30_000, Math.floor(FINALIZE_CLAIM_TTL_MS / 3)));
  leaseHeartbeat.unref?.();
  try {
    const pipelineResult = await runFormEntityPipelines({
      supabase: db,
      submission: currentRow,
      form,
      baseUrl,
    });
    pipelineMemberId = pipelineResult.memberId || null;
  } catch (err) {
    console.error('[formMonthlyCardFinalize] Pipeline error for submission', formSubmissionId, err?.message);
  } finally {
    clearInterval(leaseHeartbeat);
  }
  const stillOwnsLease = await renewClaimLease(db, formSubmissionId, ownerToken);
  if (!stillOwnsLease) {
    return {
      handled: false,
      retryable: true,
      detail: `form_submission ${formSubmissionId} finalization lease ownership was lost`,
    };
  }

  // ── Resolve member_id ─────────────────────────────────────────────────────
  let memberId = pipelineMemberId || currentRow.created_member_id || null;
  if (!memberId) {
    const { data: freshSub } = await db
      .from('form_submission')
      .select('created_member_id')
      .eq('id', formSubmissionId)
      .maybeSingle();
    memberId = freshSub?.created_member_id || null;
  }

  if (!memberId) {
    // Release the lease so the next retry re-runs the pipeline.
    await writeClaimResult(db, formSubmissionId, { done: false, ownerToken });
    console.warn('[formMonthlyCardFinalize] member not yet resolved for submission', formSubmissionId, '— releasing lease for retry');
    return {
      handled: false,
      retryable: true,
      detail: `member not yet resolved for form_submission ${formSubmissionId}`,
    };
  }

  // ── Atomically attach member + reserve/create membership-year history ────
  const snapshot = agreement.metadata?.card;
  if (!snapshot) {
    await writeClaimResult(db, formSubmissionId, { done: false, ownerToken });
    return {
      handled: false,
      retryable: true,
      detail: `billing agreement ${agreement.id} has no monthly-card snapshot`,
    };
  }
  const claim = await claimFormMonthlyCardMembership(db, {
    agreementId: agreement.id,
    submissionId: formSubmissionId,
    memberId,
    history: snapshot,
  });
  if (!claim.ok && claim.conflict) {
    const conflictMeta = {
      ...(agreement.metadata || {}),
      form_conflict_resolution: {
        status: 'pending',
        detected_at: new Date().toISOString(),
        code: claim.code || 'MEMBERSHIP_YEAR_CONFLICT',
        detail: claim.detail || null,
        member_id: memberId,
      },
    };
    const { error: conflictAgreementErr } = await db
      .from('membership_billing_agreements')
      .update({
        metadata: conflictMeta,
        needs_attention: false,
        attention_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agreement.id);
    if (conflictAgreementErr) {
      await writeClaimResult(db, formSubmissionId, { done: false, ownerToken });
      return {
        handled: false,
        retryable: true,
        detail: `membership conflict detected but compensation could not be queued: ${conflictAgreementErr.message}`,
      };
    }
    const conflictSaved = await writeConflictState(db, formSubmissionId, {
      ownerToken,
      code: claim.code,
      detail: claim.detail,
      memberId,
    });
    if (!conflictSaved) {
      return {
        handled: false,
        retryable: true,
        detail: `membership conflict detected but could not be saved for ${formSubmissionId}`,
      };
    }
    return {
      handled: false,
      conflict: true,
      retryable: false,
      code: claim.code || 'MEMBERSHIP_YEAR_CONFLICT',
      memberId,
      detail: claim.detail,
    };
  }
  if (!claim.ok) {
    await writeClaimResult(db, formSubmissionId, { done: false, ownerToken });
    return {
      handled: false,
      retryable: true,
      detail: claim.detail || 'membership-year claim failed',
    };
  }
  const historyId = claim.historyId;
  if (!historyId) {
    await writeClaimResult(db, formSubmissionId, { done: false, ownerToken });
    return {
      handled: false,
      retryable: true,
      detail: `membership history could not be confirmed for billing agreement ${agreement.id}`,
    };
  }

  // ── Submission emails (exactly-once via sendSubmissionEmailsGuarded) ──────
  try {
    await sendSubmissionEmailsGuarded({
      supabase: db,
      form,
      formValues: currentRow.submission_data || {},
      fields: form.fields || [],
      submissionId: formSubmissionId,
      createdMemberId: memberId,
      createdOrganizationId: null,
      baseUrl,
      trigger: 'form_payment_confirm',
      allowUnguarded: false,
    });
  } catch (emailErr) {
    // Log but do not fail — the sender persists its terminal result and its
    // own CAS prevents duplicates.
    console.error('[formMonthlyCardFinalize] Submission emails failed for', formSubmissionId, emailErr?.message);
  }

  // ── Stamp done AFTER all obligations ─────────────────────────────────────
  const stampedDone = await writeClaimResult(db, formSubmissionId, { done: true, ownerToken });
  if (!stampedDone) {
    return {
      handled: false,
      retryable: true,
      detail: `monthly-card finalization completed but the terminal state could not be saved for ${formSubmissionId}`,
    };
  }

  return {
    handled: true,
    historyId,
    detail: `form_submission ${formSubmissionId} setup_complete, member ${memberId} attached, history row ${historyId} created`,
  };
}

/**
 * Returns true when the submission has a terminal 'done' state — used by
 * the fourth reconciliation sweep to skip rows that are already complete.
 */
export function isFormMonthlyCardFinalized(submission) {
  if (!submission) return false;
  if (submission.payment_status !== 'setup_complete') return false;
  const state = submission.payment_meta?.monthly_card_state;
  return state?.status === 'done';
}

/**
 * Returns true when the submission has an active (non-stale) processing lease.
 * Used by the fourth sweep to decide whether to include a row.
 */
export function isFormMonthlyCardProcessing(submission) {
  if (!submission) return false;
  if (submission.payment_status !== 'setup_complete') return false;
  const state = submission.payment_meta?.monthly_card_state;
  if (state?.status !== 'processing') return false;
  const age = Date.now() - new Date(state.claimed_at || 0).getTime();
  return age < FINALIZE_CLAIM_TTL_MS;
}
