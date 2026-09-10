/**
 * Durable, lease-guarded finalization of a form-originated GoCardless DD
 * Billing Request. Subscription creation intentionally remains in the webhook.
 */
import { randomUUID } from 'node:crypto';
import { runFormEntityPipelines } from './formEntityPipelines.js';
import { sendSubmissionEmailsGuarded } from './formSubmissionEmails.js';
import { hasFormPaymentAccessProof } from './formPaymentAccess.js';

export const FINALIZE_CLAIM_TTL_MS = 15 * 60 * 1000;
export const FORM_COLUMNS = 'id, name, tenant_id, access_policy, fields, pages, visibility_rules, entity_pipelines, form_type, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, application_level, field_mappings, structured_actions, create_entity_type, entity_action, member_entity_action, organization_entity_action, additional_member_creations';

async function readState(db, id) {
  const { data, error } = await db.from('form_submission').select('payment_status,payment_meta,processing_notes')
    .eq('id', id).maybeSingle();
  if (error) return { state: null, meta: {}, paymentStatus: null, error };
  if (!data) return {
    state: null,
    meta: {},
    paymentStatus: null,
    error: new Error('form submission claim state not found'),
  };
  const meta = data.payment_meta && typeof data.payment_meta === 'object' ? data.payment_meta : {};
  return {
    state: meta.monthly_dd_state || null,
    meta,
    paymentStatus: data.payment_status,
    processingNotes: data.processing_notes || null,
    error: null,
  };
}

async function lease(db, id, meta, stale = null) {
  const token = randomUUID();
  const claimedAt = new Date().toISOString();
  let q = db.from('form_submission').update({
    payment_meta: { ...meta, monthly_dd_state: { status: 'processing', claimed_at: claimedAt, owner_token: token } },
  }).eq('id', id).eq('payment_status', 'setup_complete');
  q = stale ? q.filter('payment_meta->monthly_dd_state->>claimed_at', 'eq', stale)
    : q.filter('payment_meta->monthly_dd_state', 'is', null);
  const { data, error } = await q.select('id').maybeSingle();
  return { claimed: !error && !!data, token };
}

async function stamp(db, id, token, done, detail = null) {
  const {
    state, meta, processingNotes, error: stateError,
  } = await readState(db, id);
  if (stateError) return false;
  if (state?.owner_token !== token) return false;
  const next = { ...meta };
  if (done) next.monthly_dd_state = { status: 'done', done_at: new Date().toISOString() };
  else delete next.monthly_dd_state;
  const { data, error } = await db.from('form_submission').update({
    payment_meta: next,
    ...(detail ? {
      processing_notes: [processingNotes, detail].filter(Boolean).join('\n'),
    } : {}),
  }).eq('id', id).filter('payment_meta->monthly_dd_state->>owner_token', 'eq', token).select('id');
  return !error && (Array.isArray(data) ? data.length > 0 : !!data);
}

async function renewLease(db, id, token) {
  const { state, meta, error: stateError } = await readState(db, id);
  if (stateError || state?.status !== 'processing' || state.owner_token !== token) {
    return false;
  }
  const { data, error } = await db
    .from('form_submission')
    .update({
      payment_meta: {
        ...meta,
        monthly_dd_state: {
          ...state,
          claimed_at: new Date().toISOString(),
        },
      },
    })
    .eq('id', id)
    .filter('payment_meta->monthly_dd_state->>owner_token', 'eq', token)
    .select('id');
  if (error) return false;
  return Array.isArray(data) ? data.length > 0 : !!data;
}

async function bindMembership(db, args) {
  const { data, error } = await db.rpc('bind_form_monthly_direct_debit_membership', {
    p_agreement_id: args.agreementId, p_submission_id: args.submissionId,
    p_member_id: args.memberId, p_history: args.history || {},
  });
  if (error) return { ok: false, retryable: true, detail: `membership binding failed: ${error.message}` };
  return {
    ok: data?.ok === true, conflict: data?.conflict === true, retryable: data?.conflict !== true,
    code: data?.code, detail: data?.detail || 'membership binding did not complete',
    historyId: data?.history_id || null, idempotent: data?.idempotent === true,
  };
}

export async function finalizeFormMonthlyDirectDebit({ db, agreement, billingRequestId = null, formSubmissionId = null, baseUrl = '' }) {
  const submissionId = formSubmissionId || agreement?.metadata?.form_submission_id || null;
  if (!submissionId) return { handled: false, detail: 'no form_submission_id on agreement metadata' };
  if (!agreement?.tenant_id || agreement.provider !== 'gocardless' || agreement.agreement_type !== 'member'
    || String(agreement.metadata?.form_submission_id || '') !== String(submissionId)) {
    return { handled: false, conflict: true, retryable: false, code: 'INVALID_AGREEMENT', detail: 'invalid Direct Debit agreement' };
  }
  if (billingRequestId && agreement.gocardless_billing_request_id
    && billingRequestId !== agreement.gocardless_billing_request_id) {
    return { handled: false, conflict: true, retryable: false, code: 'BILLING_REQUEST_MISMATCH', detail: 'Billing Request does not match agreement' };
  }
  const loaded = await db.from('form_submission').select('*').eq('id', submissionId).maybeSingle();
  if (loaded.error) return { handled: false, retryable: true, detail: `load form_submission failed: ${loaded.error.message}` };
  if (!loaded.data) return { handled: false, retryable: true, detail: 'form_submission not found' };
  let submission = loaded.data;
  if (submission.tenant_id !== agreement.tenant_id
    || submission.payment_provider !== 'gocardless_monthly_dd') {
    return { handled: false, conflict: true, retryable: false, code: 'TENANT_OR_PROVIDER_MISMATCH', detail: 'submission tenant or provider differs from agreement' };
  }
  if (!['pending', 'setup_complete'].includes(submission.payment_status)) return { handled: false, detail: 'submission is not pending or setup_complete' };
  const formResult = await db.from('form').select(FORM_COLUMNS).eq('id', submission.form_id)
    .eq('tenant_id', agreement.tenant_id).maybeSingle();
  if (formResult.error) return { handled: false, retryable: true, detail: `form could not be loaded: ${formResult.error.message}` };
  if (!formResult.data) return { handled: false, retryable: true, detail: 'form could not be loaded: form not found' };
  if (!hasFormPaymentAccessProof(submission, formResult.data)) {
    return { handled: false, retryable: false, code: 'FORM_ACCESS_NOT_AUTHORIZED', detail: 'form submission has no trusted form-access authorization' };
  }
  if (submission.payment_status === 'pending') {
    const cas = await db.from('form_submission').update({
      payment_status: 'setup_complete', payment_paid_at: new Date().toISOString(),
    }).eq('id', submissionId).eq('payment_status', 'pending').select().maybeSingle();
    if (cas.error) return { handled: false, retryable: true, detail: `setup CAS failed: ${cas.error.message}` };
    if (cas.data) submission = cas.data;
    else {
      const reread = await db.from('form_submission').select('*').eq('id', submissionId).maybeSingle();
      if (reread.error || !reread.data) return { handled: false, retryable: true, detail: 'setup CAS re-read failed' };
      submission = reread.data;
    }
  }
  const current = await readState(db, submissionId);
  if (current.error) {
    return {
      handled: false,
      retryable: true,
      detail: `load finalization state failed: ${current.error.message}`,
    };
  }
  if (current.state?.status === 'done') return { handled: true, alreadyFinalized: true, detail: 'already finalized' };
  if (current.state?.status === 'conflict') return { handled: false, conflict: true, retryable: false, ...current.state };
  let acquired;
  if (current.state?.status === 'processing') {
    if (Date.now() - new Date(current.state.claimed_at || 0).getTime() < FINALIZE_CLAIM_TTL_MS) {
      return { handled: false, retryable: true, detail: 'finalization in progress' };
    }
    acquired = await lease(db, submissionId, current.meta, current.state.claimed_at);
  } else acquired = await lease(db, submissionId, current.meta);
  if (!acquired.claimed) return { handled: false, retryable: true, detail: 'finalization lease lost' };
  const token = acquired.token;
  let memberId = submission.created_member_id || null;
  const leaseHeartbeat = setInterval(() => {
    renewLease(db, submissionId, token).catch((error) => {
      console.warn('[formMonthlyDirectDebitFinalize] Lease renewal failed:', error?.message);
    });
  }, Math.max(30_000, Math.floor(FINALIZE_CLAIM_TTL_MS / 3)));
  leaseHeartbeat.unref?.();
  try {
    const result = await runFormEntityPipelines({
      supabase: db,
      submission,
      form: formResult.data,
      baseUrl,
      completionDescription: 'Payment setup completed',
    });
    memberId = result.memberId || memberId;
    if (result.failed || result.partial) {
      await stamp(db, submissionId, token, false);
      return {
        handled: false,
        retryable: true,
        detail: result.detail || 'application processing incomplete',
      };
    }
  } catch (error) {
    console.error('[formMonthlyDirectDebitFinalize] Pipeline error:', error?.message);
    await stamp(db, submissionId, token, false);
    return { handled: false, retryable: true, detail: 'application processing errored' };
  } finally {
    clearInterval(leaseHeartbeat);
  }
  const freshSubmission = await db.from('form_submission').select('created_member_id').eq('id', submissionId).maybeSingle();
  if (freshSubmission.error) {
    await stamp(db, submissionId, token, false, `member resolution read failed: ${freshSubmission.error.message}`);
    return { handled: false, retryable: true, detail: 'member resolution read failed' };
  }
  memberId = memberId || freshSubmission.data?.created_member_id || null;
  const ownershipRenewed = await renewLease(db, submissionId, token);
  if (!ownershipRenewed) return { handled: false, retryable: true, detail: 'finalization lease ownership was lost' };
  if (!memberId) {
    await stamp(db, submissionId, token, false);
    return { handled: false, retryable: true, detail: 'member not yet resolved' };
  }
  const snapshot = agreement.metadata?.dd;
  if (!snapshot || snapshot.kind !== 'monthly_direct_debit') {
    await stamp(db, submissionId, token, false);
    return { handled: false, retryable: false, code: 'MISSING_DD_SNAPSHOT', detail: 'agreement has no DD snapshot' };
  }
  const beforeBind = await readState(db, submissionId);
  if (beforeBind.error
      || beforeBind.state?.owner_token !== token
      || beforeBind.state?.status !== 'processing') {
    return { handled: false, retryable: true, detail: 'finalization lease ownership was lost before membership binding' };
  }
  const claim = await bindMembership(db, {
    agreementId: agreement.id, submissionId, memberId, history: snapshot,
  });
  if (!claim.ok) {
    if (claim.conflict) {
      const {
        state, meta, processingNotes, error: conflictReadError,
      } = await readState(db, submissionId);
      if (conflictReadError || state?.owner_token !== token) {
        return {
          handled: false,
          retryable: true,
          detail: 'membership conflict was detected but its terminal state could not be claimed',
        };
      }
      const conflictState = { status: 'conflict', code: claim.code || 'MEMBERSHIP_YEAR_CONFLICT',
        detail: claim.detail, detected_at: new Date().toISOString() };
      const { data: conflictSaved, error: conflictSaveError } = await db.from('form_submission').update({
        payment_meta: { ...meta, monthly_dd_state: conflictState },
        processing_notes: [processingNotes, claim.detail].filter(Boolean).join('\n'),
      }).eq('id', submissionId).filter('payment_meta->monthly_dd_state->>owner_token', 'eq', token).select('id');
      if (conflictSaveError || !(Array.isArray(conflictSaved) ? conflictSaved.length : conflictSaved)) {
        return {
          handled: false,
          retryable: true,
          detail: 'membership conflict was detected but its terminal state could not be saved',
        };
      }
    } else await stamp(db, submissionId, token, false, claim.detail);
    return { handled: false, conflict: claim.conflict, retryable: claim.retryable, code: claim.code, detail: claim.detail };
  }
  try {
    await sendSubmissionEmailsGuarded({
      supabase: db, form: formResult.data, formValues: submission.submission_data || {},
      fields: formResult.data.fields || [], submissionId, createdMemberId: memberId,
      createdOrganizationId: null, baseUrl, trigger: 'form_payment_confirm', allowUnguarded: false,
    });
  } catch { /* guarded email sender persists its own result */ }
  if (!await stamp(db, submissionId, token, true)) return { handled: false, retryable: true, detail: 'terminal state could not be saved' };
  return { handled: true, historyId: claim.historyId, detail: 'Direct Debit membership finalized' };
}

export function isFormMonthlyDirectDebitFinalized(submission) {
  return submission?.payment_status === 'setup_complete'
    && submission?.payment_meta?.monthly_dd_state?.status === 'done';
}
export function isFormMonthlyDirectDebitProcessing(submission) {
  const state = submission?.payment_meta?.monthly_dd_state;
  return submission?.payment_status === 'setup_complete' && state?.status === 'processing'
    && Date.now() - new Date(state.claimed_at || 0).getTime() < FINALIZE_CLAIM_TTL_MS;
}