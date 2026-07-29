// Shared form submission-email sender (Task #3190).
//
// Historically the configured `submission_emails` on a form were only sent
// when the BROWSER made a follow-up call to /api/forms/send-submission-email
// after submitting. If that call was lost (redirect, ad-blocker, embed, JS
// error) no email was sent and nothing recorded the failure. This module is
// the single implementation used by:
//   - api/public/form-submission.js  (server-side send at submission creation)
//   - api/forms/send-submission-email.js  (retained legacy client call)
//   - api/entities/[entity]/index.js  (generic entity-API FormSubmission insert)
//
// Exactly-once: the sender CLAIMS the submission row first via an atomic
// compare-and-set on the new `form_submission.submission_email_state` jsonb
// column (update ... where submission_email_state is null). Whichever path
// claims first sends; every other path sees the existing state and skips.
// The final outcome (sent / skipped / failed, per configured email) is then
// persisted into the same column so admins can diagnose "no email" cases on
// the Form Submissions page instead of them being silent.

import { sendEmail } from './emailService.js';
import { getAccountingProvider } from './accountingProvider.js';
import { generatePasswordSetupUrl } from './passwordSetupUrl.js';

const isMissingColumnError = (err) =>
  err && (err.code === '42703' || /submission_email_state/.test(err.message || ''));

/**
 * Atomically claim the right to send this submission's emails.
 * Returns:
 *   { claimed: true }                       — caller must send + record outcome
 *   { claimed: false, existingState }       — another path already claimed/sent
 *   { claimed: false, guardUnavailable }    — column missing (stale dev DB);
 *                                             caller decides (we send WITHOUT a
 *                                             guard only from the legacy client
 *                                             endpoint to preserve old behaviour).
 */
export async function claimSubmissionEmailSend(supabase, submissionId, trigger) {
  if (!supabase || !submissionId) {
    return { claimed: false, guardUnavailable: true };
  }
  const claimState = {
    status: 'processing',
    trigger: trigger || 'unknown',
    claimed_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('form_submission')
    .update({ submission_email_state: claimState })
    .eq('id', submissionId)
    .is('submission_email_state', null)
    .select('id');

  if (error) {
    if (isMissingColumnError(error)) {
      // Pre-migration environment: the column genuinely doesn't exist.
      console.warn('[SubmissionEmails] submission_email_state column missing — idempotency guard unavailable');
      return { claimed: false, guardUnavailable: true };
    }
    // Any OTHER claim error (transient DB failure, permissions, network) is
    // NOT the same as "guard missing": the server-side path may already have
    // sent, so sending here could double-send. Fail closed.
    console.error('[SubmissionEmails] Claim update failed:', error);
    return { claimed: false, claimError: error.message || 'Claim update failed' };
  }

  if (data && data.length > 0) {
    return { claimed: true };
  }

  // No row matched: either already claimed or the id doesn't exist.
  const { data: row, error: readErr } = await supabase
    .from('form_submission')
    .select('id, submission_email_state')
    .eq('id', submissionId)
    .maybeSingle();
  if (readErr) {
    // The claim UPDATE succeeded but matched no row, and we can't read back
    // why. Either the row vanished or the read transiently failed — in both
    // cases sending would risk a duplicate, so fail closed.
    console.error('[SubmissionEmails] Claim read-back failed:', readErr);
    return { claimed: false, claimError: readErr.message || 'Claim read-back failed' };
  }
  if (!row) {
    // Submission id does not exist — nothing to guard against, nothing to send for.
    return { claimed: false, claimError: 'Submission row not found' };
  }
  return { claimed: false, existingState: row.submission_email_state || null };
}

/**
 * Task #3194: atomically re-claim an ALREADY-PROCESSED submission for a
 * deliberate admin resend. Unlike claimSubmissionEmailSend this matches rows
 * whose state exists, but refuses to steal a claim that is still
 * 'processing' (a concurrent send in flight). The prior outcome is preserved
 * by appending it to a `history` array carried on the new state, so
 * exactly-once diagnostics survive resends.
 * Returns { claimed: true, history } or { claimed: false, reason }.
 */
export async function claimSubmissionEmailResend(supabase, submissionId, trigger, existingState) {
  if (!supabase || !submissionId) {
    return { claimed: false, reason: 'No submission to claim' };
  }
  const prior = existingState && typeof existingState === 'object'
    ? (() => { const { history, ...rest } = existingState; return rest; })()
    : null;
  // Bounded: keep only the most recent prior outcomes so repeated resends
  // can't grow the jsonb state without limit.
  const HISTORY_LIMIT = 10;
  const history = [
    ...(Array.isArray(existingState?.history) ? existingState.history : []),
    ...(prior ? [prior] : []),
  ].slice(-HISTORY_LIMIT);
  const claimState = {
    status: 'processing',
    trigger: trigger || 'unknown',
    resend: true,
    claimed_at: new Date().toISOString(),
    history,
  };
  const { data, error } = await supabase
    .from('form_submission')
    .update({ submission_email_state: claimState })
    .eq('id', submissionId)
    .neq('submission_email_state->>status', 'processing')
    .select('id');
  if (error) {
    console.error('[SubmissionEmails] Resend claim failed:', error);
    return { claimed: false, reason: error.message || 'Resend claim failed' };
  }
  if (!data || data.length === 0) {
    return { claimed: false, reason: 'A send is already in progress for this submission' };
  }
  return { claimed: true, history };
}

async function recordOutcome(supabase, submissionId, state) {
  if (!supabase || !submissionId) return;
  const { error } = await supabase
    .from('form_submission')
    .update({ submission_email_state: state })
    .eq('id', submissionId);
  if (error && !isMissingColumnError(error)) {
    console.error('[SubmissionEmails] Failed to record email outcome:', error);
  }
}

/**
 * Resolve the list of configured submission emails for a form.
 * Supports the new `submission_emails` array with fallback to the legacy
 * single-email fields.
 */
export function resolveConfiguredEmails(form) {
  if (form.submission_emails && Array.isArray(form.submission_emails) && form.submission_emails.length > 0) {
    return form.submission_emails.filter((e) => e.template_id && e.recipient);
  }
  if (form.submission_email_template_id && form.submission_email_recipient) {
    return [{
      id: 'legacy',
      template_id: form.submission_email_template_id,
      recipient: form.submission_email_recipient,
      cc: form.submission_email_cc || '',
      bcc: form.submission_email_bcc || '',
      field_mapping: form.submission_email_field_mapping || {},
    }];
  }
  return [];
}

/**
 * Send the configured submission emails for a form submission.
 * This is the full extraction of the logic that previously lived only in
 * api/forms/send-submission-email.js (multi-email format, conditions,
 * field-reference recipients, placeholder replacement, invoice attachment).
 *
 * Does NOT itself claim — callers use sendSubmissionEmailsGuarded (below) or
 * pre-claim explicitly. Returns { success, skipped?, reason?, emails }.
 */
export async function sendSubmissionEmails({
  supabase,
  form,               // full form row (or at least email config + fields + tenant_id + name)
  formValues,         // submission values keyed by field id
  fields,             // form field definitions (fallback: form.fields)
  submissionId = null,
  createdMemberId = null,
  createdOrganizationId = null,
  baseUrl = '',
}) {
  const form_values = formValues || {};
  const effectiveFields = (Array.isArray(fields) && fields.length > 0) ? fields : (form.fields || []);
  const tenantId = form.tenant_id;

  const emailsToSend = resolveConfiguredEmails(form);
  if (emailsToSend.length === 0) {
    return { success: true, skipped: true, reason: 'No emails configured', emails: [] };
  }

  // Resolve member / organization context. Priority: explicit ids passed by
  // the caller, then the submission row's own columns.
  let memberIdToUse = createdMemberId;
  let organizationIdToUse = createdOrganizationId;

  if (!memberIdToUse && !organizationIdToUse && submissionId) {
    const { data: submission } = await supabase
      .from('form_submission')
      .select('created_member_id, created_organization_id, member_id, organization_id')
      .eq('id', submissionId)
      .single();
    if (submission) {
      memberIdToUse = submission.created_member_id || submission.member_id;
      organizationIdToUse = submission.created_organization_id || submission.organization_id;
    }
  }

  let memberData = null;
  let organizationData = null;

  if (memberIdToUse) {
    // Retry logic to handle race condition where member was just created
    let retries = 3;
    let delay = 500;
    while (retries > 0 && !memberData) {
      const { data, error } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, organization_id')
        .eq('id', memberIdToUse)
        .single();
      if (error) {
        console.error('[SubmissionEmails] Error fetching member:', error.message, 'code:', error.code);
      }
      if (data) {
        memberData = data;
      } else if (retries > 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
      retries--;
    }
    if (!organizationIdToUse && memberData?.organization_id) {
      organizationIdToUse = memberData.organization_id;
    }
  }

  if (organizationIdToUse) {
    const { data } = await supabase
      .from('organization')
      .select('id, name, invoicing_email, phone')
      .eq('id', organizationIdToUse)
      .single();
    organizationData = data;
  }

  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Resolve an email address from a {{field_id}} reference or static value.
  const resolveEmailAddress = (value) => {
    if (!value) return '';
    if (value.startsWith('{{') && value.endsWith('}}')) {
      const fieldId = value.slice(2, -2);
      const fieldValue = form_values?.[fieldId];
      console.log('[SubmissionEmails] Resolved field reference', fieldId, 'to:', fieldValue);
      return fieldValue || '';
    }
    return value;
  };

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const orgNameCache = {};
  const resolveOrgName = async (uuid) => {
    if (!uuid || !supabase || !uuidRegex.test(uuid)) return uuid;
    if (uuid in orgNameCache) return orgNameCache[uuid];
    try {
      const { data: org } = await supabase
        .from('organization')
        .select('name')
        .eq('id', uuid)
        .single();
      orgNameCache[uuid] = org?.name || uuid;
      return orgNameCache[uuid];
    } catch {}
    orgNameCache[uuid] = uuid;
    return uuid;
  };

  const orgDropdownFieldIds = new Set(
    (effectiveFields || []).filter((f) => f.type === 'organisation_dropdown').map((f) => f.id)
  );

  const resolveFieldValue = async (fieldId, rawValue) => {
    if (orgDropdownFieldIds.has(fieldId) && rawValue) {
      if (typeof rawValue === 'string') {
        return await resolveOrgName(rawValue);
      }
    }
    return Array.isArray(rawValue) ? rawValue.join(', ') : (rawValue || '');
  };

  const replacePlaceholders = async (text, emailConfig) => {
    if (!text) return '';
    let result = text;
    const fieldMapping = emailConfig.field_mapping || {};

    for (const [placeholder, fieldId] of Object.entries(fieldMapping)) {
      if (fieldId && form_values) {
        const fieldValue = form_values[fieldId];
        const displayValue = await resolveFieldValue(fieldId, fieldValue);
        const placeholderPattern = `{{${placeholder}}}`;
        result = result.replace(new RegExp(escapeRegex(placeholderPattern), 'g'), displayValue);
      }
    }

    if (form_values && effectiveFields) {
      for (const field of effectiveFields) {
        const fieldValue = form_values[field.id];
        const placeholder = `{{${field.id}}}`;
        const labelPlaceholder = field.label ? `{{${field.label}}}` : null;
        const displayValue = await resolveFieldValue(field.id, fieldValue);
        result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), displayValue);
        if (labelPlaceholder) {
          result = result.replace(new RegExp(escapeRegex(labelPlaceholder), 'g'), displayValue);
        }
      }
    }

    const dbPlaceholders = {
      'member.id': memberData?.id || '',
      'member.first_name': memberData?.first_name || '',
      'member.last_name': memberData?.last_name || '',
      'member.full_name': `${memberData?.first_name || ''} ${memberData?.last_name || ''}`.trim(),
      'member.email': memberData?.email || '',
      'organization.id': organizationData?.id || '',
      'organization.name': organizationData?.name || '',
      'organization.invoicing_email': organizationData?.invoicing_email || '',
      'organization.phone': organizationData?.phone || '',
    };
    for (const [key, value] of Object.entries(dbPlaceholders)) {
      result = result.replace(new RegExp(escapeRegex(`[[${key}]]`), 'g'), value);
    }

    const systemPlaceholders = {
      'form.name': form.name || '',
      'submission.date': new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
      ...dbPlaceholders,
    };
    for (const [key, value] of Object.entries(systemPlaceholders)) {
      result = result.replace(new RegExp(escapeRegex(`{{${key}}}`), 'g'), value);
    }

    // {{set_password_url}} — generate password setup URL for the member.
    const hasSetPasswordPlaceholder = /\{\{\s*set_password_url\s*\}\}/i.test(result);
    if (hasSetPasswordPlaceholder && memberData?.id && memberData?.email && baseUrl) {
      const passwordUrl = await generatePasswordSetupUrl(memberData.id, memberData.email, baseUrl);
      if (passwordUrl) {
        const passwordLink = `<a href="${passwordUrl}" style="color: #0066cc; text-decoration: underline;">Set your password</a>`;
        result = result.replace(/\{\{\s*set_password_url\s*\}\}/gi, passwordLink);
      } else {
        console.warn('[SubmissionEmails] Failed to generate password setup URL');
      }
    } else if (hasSetPasswordPlaceholder) {
      console.warn('[SubmissionEmails] {{set_password_url}} placeholder found but missing member data or baseUrl');
    }

    return result;
  };

  const evaluateCondition = (condition) => {
    if (!condition || !condition.field_id) return true;
    const fieldValue = form_values?.[condition.field_id];
    const conditionValue = condition.value ?? '';
    const operator = condition.operator || 'equals';
    const normalizedFieldValue = (Array.isArray(fieldValue)
      ? fieldValue.join(', ')
      : (fieldValue ?? '')).toString().trim();
    const normalizedConditionValue = conditionValue.toString().trim();
    switch (operator) {
      case 'equals':
        return normalizedFieldValue.toLowerCase() === normalizedConditionValue.toLowerCase();
      case 'not_equals':
        return normalizedFieldValue.toLowerCase() !== normalizedConditionValue.toLowerCase();
      case 'contains':
        return normalizedFieldValue.toLowerCase().includes(normalizedConditionValue.toLowerCase());
      case 'not_contains':
        return !normalizedFieldValue.toLowerCase().includes(normalizedConditionValue.toLowerCase());
      case 'is_empty':
        return !normalizedFieldValue || normalizedFieldValue.length === 0;
      case 'is_not_empty':
        return normalizedFieldValue && normalizedFieldValue.length > 0;
      default:
        return true;
    }
  };

  const results = [];

  for (const emailConfig of emailsToSend) {
    console.log('[SubmissionEmails] Processing email:', emailConfig.id, 'template:', emailConfig.template_id);

    if (emailConfig.condition && !evaluateCondition(emailConfig.condition)) {
      results.push({ id: emailConfig.id, success: true, skipped: true, reason: 'Condition not met' });
      continue;
    }

    const { data: template, error: templateError } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', emailConfig.template_id)
      .single();

    if (templateError || !template) {
      console.log('[SubmissionEmails] Email template not found:', emailConfig.template_id, templateError);
      results.push({ id: emailConfig.id, success: false, error: 'Template not found' });
      continue;
    }

    const toEmail = resolveEmailAddress(emailConfig.recipient);
    const ccEmail = emailConfig.cc ? resolveEmailAddress(emailConfig.cc) : '';
    const bccEmail = emailConfig.bcc ? resolveEmailAddress(emailConfig.bcc) : '';

    if (!toEmail) {
      console.log('[SubmissionEmails] No valid recipient email resolved');
      results.push({ id: emailConfig.id, success: false, error: 'No valid recipient email' });
      continue;
    }

    const emailSubject = await replacePlaceholders(template.subject || 'Form Submission', emailConfig);
    const emailBody = await replacePlaceholders(template.body || '', emailConfig);

    let emailAttachments = null;
    if (emailConfig.attach_invoice && supabase) {
      try {
        const paymentField = (effectiveFields || []).find((f) => f.type === 'membership_payment');
        const paymentValue = paymentField ? form_values?.[paymentField.id] : null;
        const paymentIntentId = paymentValue?.paymentIntentId;

        let invoiceRecord = null;
        if (paymentIntentId) {
          const { data: memberHistory } = await supabase
            .from('member_membership_history')
            .select('xero_invoice_id, xero_invoice_number')
            .eq('stripe_payment_intent_id', paymentIntentId)
            .eq('tenant_id', tenantId)
            .not('xero_invoice_id', 'is', null)
            .maybeSingle();
          if (memberHistory) invoiceRecord = memberHistory;

          if (!invoiceRecord) {
            const { data: orgHistory } = await supabase
              .from('organisation_membership_history')
              .select('xero_invoice_id, xero_invoice_number')
              .eq('stripe_payment_intent_id', paymentIntentId)
              .eq('tenant_id', tenantId)
              .not('xero_invoice_id', 'is', null)
              .maybeSingle();
            if (orgHistory) invoiceRecord = orgHistory;
          }
        } else {
          if (memberIdToUse) {
            const { data: memberHistory } = await supabase
              .from('member_membership_history')
              .select('xero_invoice_id, xero_invoice_number')
              .eq('member_id', memberIdToUse)
              .eq('tenant_id', tenantId)
              .not('xero_invoice_id', 'is', null)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (memberHistory) invoiceRecord = memberHistory;
          }
          if (!invoiceRecord && organizationIdToUse) {
            const { data: orgHistory } = await supabase
              .from('organisation_membership_history')
              .select('xero_invoice_id, xero_invoice_number')
              .eq('organization_id', organizationIdToUse)
              .eq('tenant_id', tenantId)
              .not('xero_invoice_id', 'is', null)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (orgHistory) invoiceRecord = orgHistory;
          }
        }

        if (invoiceRecord?.xero_invoice_id) {
          const _provider = await getAccountingProvider(tenantId);
          const pdfBuffer = await _provider.fetchInvoicePdf(invoiceRecord.accounting_invoice_id || invoiceRecord.xero_invoice_id, tenantId);
          emailAttachments = [{
            filename: `Invoice-${invoiceRecord.xero_invoice_number || 'document'}.pdf`,
            data: pdfBuffer,
            contentType: 'application/pdf',
          }];
        }
      } catch (attachErr) {
        console.warn('[SubmissionEmails] Failed to attach invoice PDF (non-fatal):', attachErr.message);
      }
    }

    console.log('[SubmissionEmails] Sending email to:', toEmail, 'subject:', emailSubject);
    const emailResult = await sendEmail({
      to: toEmail,
      subject: emailSubject,
      html: emailBody,
      cc: ccEmail || undefined,
      bcc: bccEmail || undefined,
      tenantId,
      attachments: emailAttachments,
    });

    results.push({
      id: emailConfig.id,
      success: emailResult.success,
      messageId: emailResult.messageId,
      to: toEmail,
      error: emailResult.error,
    });
  }

  return { success: results.every((r) => r.success), emails: results };
}

/**
 * Claim + send + durably record the outcome for one submission.
 *
 * trigger: 'server' | 'client' | 'entity-api' (recorded for diagnosis).
 *
 * If another path already claimed the submission, returns
 * { success: true, skipped: true, alreadyProcessed: true, state } without
 * sending anything (exactly-once).
 *
 * If the idempotency column is unavailable (stale dev DB), sends WITHOUT a
 * guard only when allowUnguarded=true (legacy client endpoint keeps its old
 * behaviour there); server-side paths skip instead so they can never cause a
 * double send in a mis-migrated environment.
 */
export async function sendSubmissionEmailsGuarded(options) {
  const {
    supabase, submissionId, trigger = 'unknown', allowUnguarded = false,
    // Task #3194: deliberate admin resend — bypasses the already-processed
    // skip via an atomic re-claim that preserves prior outcomes in `history`.
    // Callers MUST gate this server-side (tenant admin only).
    forceResend = false,
  } = options;

  // Task #3202: harden against partial form selects. If the caller passed a
  // form object that lacks the `submission_emails` key entirely (a partial
  // SELECT that never included the email-config columns), re-fetch just the
  // email columns so a future partial select degrades to a correct send
  // instead of a durable "No emails configured" skip.
  let form = options.form;
  if (form && form.id && !('submission_emails' in form)) {
    console.warn('[SubmissionEmails] form object missing submission_emails key (partial select?) — re-fetching email config for form', form.id);
    const { data: emailCols, error: emailColsError } = await supabase
      .from('form')
      .select('submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping')
      .eq('id', form.id)
      .single();
    if (!emailColsError && emailCols) {
      form = { ...form, ...emailCols };
      options = { ...options, form };
    } else if (emailColsError) {
      console.error('[SubmissionEmails] Failed to re-fetch email config for form', form.id, '-', emailColsError.message);
    }
  }

  // Fast path: nothing configured → record a durable 'skipped' outcome so the
  // admin view can show WHY no email exists, then return.
  const configured = resolveConfiguredEmails(form);

  // When set, the outcome recorded at the end carries the resend marker and
  // the preserved history of previous sends.
  let resendState = null;

  const claim = await claimSubmissionEmailSend(supabase, submissionId, trigger);
  if (!claim.claimed) {
    if (claim.claimError) {
      // Operational DB error while claiming (NOT a missing column): the
      // server path may already have sent, so never send here regardless of
      // allowUnguarded — that would break exactly-once. Surface a
      // deterministic failure so callers/logs can diagnose it.
      console.error('[SubmissionEmails] Claim failed — refusing to send (trigger:', trigger + '):', claim.claimError);
      return {
        success: false,
        skipped: true,
        reason: `Idempotency claim failed: ${claim.claimError}`,
        error: claim.claimError,
        emails: [],
      };
    }
    if (claim.guardUnavailable) {
      // Guard genuinely unavailable: column missing (pre-migration DB) or
      // caller supplied no submission id to claim against. Only the legacy
      // client endpoint is allowed to proceed unguarded here.
      if (!allowUnguarded) {
        console.warn('[SubmissionEmails] Guard unavailable and unguarded send not allowed — skipping (trigger:', trigger + ')');
        return { success: true, skipped: true, reason: 'Idempotency guard unavailable', emails: [] };
      }
      // Legacy behaviour: send without guard (pre-migration environments).
    } else if (forceResend) {
      // Task #3194: admin-requested resend of an already-processed
      // submission. Re-claim atomically (refuses if a send is in flight)
      // and carry the prior outcome forward as history.
      const reclaim = await claimSubmissionEmailResend(supabase, submissionId, trigger, claim.existingState);
      if (!reclaim.claimed) {
        console.warn('[SubmissionEmails] Resend re-claim refused for', submissionId, '—', reclaim.reason);
        return {
          success: false,
          skipped: true,
          alreadyProcessed: true,
          reason: reclaim.reason || 'Resend claim failed',
          error: reclaim.reason || 'Resend claim failed',
          state: claim.existingState || null,
          emails: claim.existingState?.emails || [],
        };
      }
      console.log('[SubmissionEmails] Resend claimed for submission', submissionId, '(trigger:', trigger + ')');
      resendState = { resend: true, history: reclaim.history };
    } else {
      console.log('[SubmissionEmails] Submission', submissionId, 'already claimed — skipping (trigger:', trigger + ')');
      return {
        success: true,
        skipped: true,
        alreadyProcessed: true,
        reason: 'Emails already processed for this submission',
        state: claim.existingState || null,
        emails: claim.existingState?.emails || [],
      };
    }
  }

  const finishedAt = () => new Date().toISOString();
  const baseState = { trigger, processed_at: finishedAt(), ...(resendState || {}) };

  if (configured.length === 0) {
    // Task #3202: about to durably record "No emails configured" — log the
    // form's email-related keys so a partial-select regression is diagnosable.
    console.warn('[SubmissionEmails] No emails configured for form', form?.id, '— email config keys:', JSON.stringify({
      has_submission_emails_key: !!form && ('submission_emails' in form),
      submission_emails_count: Array.isArray(form?.submission_emails) ? form.submission_emails.length : null,
      legacy_template_id: form?.submission_email_template_id || null,
      legacy_recipient: form?.submission_email_recipient || null,
    }));
    const state = { ...baseState, status: 'skipped', reason: 'No emails configured', emails: [] };
    await recordOutcome(supabase, submissionId, state);
    return { success: true, skipped: true, reason: 'No emails configured', emails: [] };
  }

  try {
    const result = await sendSubmissionEmails(options);
    const anySent = (result.emails || []).some((e) => e.success && !e.skipped);
    const allOk = result.success;
    const state = {
      ...baseState,
      processed_at: finishedAt(),
      status: result.skipped ? 'skipped' : (allOk ? (anySent ? 'sent' : 'skipped') : 'failed'),
      reason: result.reason || (allOk && !anySent ? 'All emails skipped by conditions' : null),
      emails: result.emails || [],
    };
    await recordOutcome(supabase, submissionId, state);
    return result;
  } catch (err) {
    console.error('[SubmissionEmails] Send failed:', err);
    const state = { ...baseState, processed_at: finishedAt(), status: 'failed', reason: err.message || 'Unknown error', emails: [] };
    await recordOutcome(supabase, submissionId, state);
    return { success: false, error: err.message || 'Failed to send submission emails', emails: [] };
  }
}
