/**
 * Targeted recovery for one paid Stripe form submission.
 *
 * This is intentionally not a queue worker.  It reads one authoritative
 * submission, applies the same eligibility gates as the payment completion
 * worker, and then delegates all mutations to finalizeFormSubmission.  In
 * particular, this module must never mark a row paid, write a retry row, or
 * manufacture a billing address.
 */
import { finalizeFormSubmission, FORM_PAYMENT_COMPLETION_BUDGET_MS } from './formPaymentFinalize.js';
import { hasFormPaymentAccessProof } from './formPaymentAccess.js';
import { getTrustedBaseUrlForTenant } from './publicBaseUrl.js';

const FORM_COLUMNS = [
  'id', 'name', 'tenant_id', 'access_policy', 'fields', 'pages',
  'visibility_rules', 'entity_pipelines', 'structured_actions',
  'field_mappings', 'application_level', 'auto_create_entity',
  'create_entity_type', 'entity_action', 'member_entity_action',
  'organization_entity_action', 'additional_member_creations',
  'default_member_role_id', 'submission_emails',
  'submission_email_template_id', 'submission_email_recipient',
  'submission_email_cc', 'submission_email_bcc',
  'submission_email_field_mapping', 'form_type', 'due_diligence_required',
  'survey_settings',
].join(', ');

// These messages are deliberately constants.  Database, processor, and URL
// resolver errors can contain credentials, personal data, or query details.
const SAFE_MESSAGES = Object.freeze({
  invalidSubmissionId: 'A submission id is required.',
  submissionNotFound: 'The requested form submission was not found.',
  submissionLookupFailed: 'The requested form submission could not be read.',
  formNotFound: 'The form associated with this submission was not found.',
  formLookupFailed: 'The form associated with this submission could not be read.',
  unsupportedProvider: 'Targeted recovery supports Stripe payments only.',
  paymentNotPaid: 'Targeted recovery requires a paid Stripe submission.',
  accessProofMissing: 'Durable payment access proof is not available.',
  addressMissing: 'Stripe billing address prerequisite is not available.',
  baseUrlUnavailable: 'The trusted tenant URL could not be resolved.',
  budgetExhausted: 'Worker budget was exhausted before this stage could run.',
  inProgress: 'Completion is currently owned by another worker.',
  retryable: 'Completion remains retryable after an incomplete stage.',
  attention: 'Completion requires administrator review.',
  finalizerFailed: 'The completion finalizer did not complete.',
});

function createResult(submissionId) {
  return {
    scope: 'submission',
    submissionId: submissionId ?? null,
    checked: 0,
    paid: 0,
    failed: 0,
    finalized: 0,
    errors: [],
    issues: [],
    completion: {
      claimed: 0,
      attempted: 0,
      completed: 0,
      waitingForAddress: 0,
      waitingForAccess: 0,
      failed: 0,
    },
    partial: false,
    budgetExhausted: false,
  };
}

function addIssue(result, code, message, {
  failed = false,
  error = false,
} = {}) {
  const issue = {
    submissionId: result.submissionId,
    code,
    message,
  };
  result.issues.push(issue);
  if (error) result.errors.push(issue);
  if (failed) result.failed += 1;
  result.partial = true;
  return result;
}

function clockNow(clock) {
  if (typeof clock === 'function') return Number(clock());
  if (clock && typeof clock.now === 'function') return Number(clock.now());
  return Date.now();
}

function dependenciesFrom(options) {
  // `testdeps` is the documented injection point.  Accepting the dependency
  // names at the top level as well keeps this helper convenient for small
  // unit-test harnesses without changing its production API.
  return {
    ...(options?.testdeps || {}),
    ...Object.fromEntries(
      ['finalizeFormSubmission', 'finalize', 'clock', 'resolveBaseUrl', 'hasFormPaymentAccessProof']
        .filter((key) => options?.[key] !== undefined)
        .map((key) => [key, options[key]]),
    ),
  };
}

/**
 * Recover exactly one paid Stripe form submission.
 *
 * @param {object} db Supabase-compatible database client.
 * @param {object} options
 * @param {string} options.submissionId The sole submission to inspect.
 * @param {number} [options.timeBudgetMs=40000] Wall-clock budget.
 * @param {object} [options.testdeps] Optional test-only dependency overrides:
 *   finalizeFormSubmission, clock, resolveBaseUrl, hasFormPaymentAccessProof.
 */
export async function reconcileFormPaymentSubmission(db, {
  submissionId,
  timeBudgetMs = FORM_PAYMENT_COMPLETION_BUDGET_MS,
  testdeps = {},
  ...dependencyOptions
} = {}) {
  const result = createResult(submissionId);
  const options = { testdeps, ...dependencyOptions };
  const deps = dependenciesFrom(options);
  const finalize = deps.finalizeFormSubmission || deps.finalize || finalizeFormSubmission;
  const accessProof = deps.hasFormPaymentAccessProof || hasFormPaymentAccessProof;
  const now = () => clockNow(deps.clock);
  const startedAt = now();
  const budget = Number(timeBudgetMs);
  const deadlineAt = startedAt + (Number.isFinite(budget) ? Math.max(0, budget) : FORM_PAYMENT_COMPLETION_BUDGET_MS);
  const hasBudget = () => now() < deadlineAt;

  if (!submissionId) {
    return addIssue(result, 'invalid-submission-id', SAFE_MESSAGES.invalidSubmissionId, { failed: true, error: true });
  }
  if (!db || typeof db.from !== 'function') {
    return addIssue(result, 'submission-lookup-failed', SAFE_MESSAGES.submissionLookupFailed, { failed: true, error: true });
  }

  let submission;
  try {
    // Do not add a queue predicate, age predicate, or repeated-field filter:
    // this endpoint is authorized to inspect only the requested id.
    const response = await db
      .from('form_submission')
      .select('*')
      .eq('id', submissionId)
      .maybeSingle();
    if (response?.error) {
      return addIssue(result, 'submission-lookup-failed', SAFE_MESSAGES.submissionLookupFailed, { failed: true, error: true });
    }
    submission = response?.data || null;
  } catch {
    return addIssue(result, 'submission-lookup-failed', SAFE_MESSAGES.submissionLookupFailed, { failed: true, error: true });
  }
  if (!submission) {
    return addIssue(result, 'submission-not-found', SAFE_MESSAGES.submissionNotFound, { failed: true, error: true });
  }
  result.checked = 1;

  let form;
  try {
    const response = await db
      .from('form')
      .select(FORM_COLUMNS)
      .eq('id', submission.form_id)
      .eq('tenant_id', submission.tenant_id)
      .maybeSingle();
    if (response?.error) {
      return addIssue(result, 'form-lookup-failed', SAFE_MESSAGES.formLookupFailed, { failed: true, error: true });
    }
    form = response?.data || null;
  } catch {
    return addIssue(result, 'form-lookup-failed', SAFE_MESSAGES.formLookupFailed, { failed: true, error: true });
  }
  if (!form) {
    return addIssue(result, 'form-not-found', SAFE_MESSAGES.formNotFound, { failed: true, error: true });
  }

  if (submission.payment_provider !== 'stripe') {
    return addIssue(result, 'payment-provider-unsupported', SAFE_MESSAGES.unsupportedProvider);
  }
  if (submission.payment_status !== 'paid') {
    return addIssue(result, 'payment-status-not-paid', SAFE_MESSAGES.paymentNotPaid);
  }
  // Preserve the shared counter's meaning: newly verified payments, not
  // already-paid rows inspected. This path never changes payment status.
  result.paymentStatus = 'paid';

  let hasAccess;
  try {
    hasAccess = accessProof(submission, form);
  } catch {
    hasAccess = false;
  }
  if (!hasAccess) {
    result.completion.waitingForAccess += 1;
    return addIssue(result, 'payment-access-proof-missing', SAFE_MESSAGES.accessProofMissing);
  }

  // An address is a prerequisite, not a best-effort finalizer tail.  Never
  // retrieve from Stripe or otherwise alter the row from this helper.
  const addressRequired = !!submission.payment_meta?.membership
    || (submission.payment_meta?.stripe_address_mapping_config?.mappings?.length || 0) > 0;
  if (addressRequired && !submission.payment_meta?.stripe_billing_address) {
    result.completion.waitingForAddress += 1;
    return addIssue(result, 'address-prerequisite-missing', SAFE_MESSAGES.addressMissing);
  }

  if (!hasBudget()) {
    result.budgetExhausted = true;
    return addIssue(result, 'budget-exhausted', SAFE_MESSAGES.budgetExhausted);
  }

  let baseUrl;
  try {
    const resolveBaseUrl = deps.resolveBaseUrl
      || ((tenantId) => getTrustedBaseUrlForTenant(null, db, tenantId));
    baseUrl = await resolveBaseUrl(submission.tenant_id);
  } catch {
    return addIssue(result, 'base-url-unavailable', SAFE_MESSAGES.baseUrlUnavailable, { failed: true, error: true });
  }

  result.completion.attempted += 1;
  let outcome;
  try {
    outcome = await finalize({
      supabase: db,
      db,
      submission,
      form,
      baseUrl,
      deadlineAt,
    });
  } catch {
    result.completion.failed += 1;
    return addIssue(result, 'completion-finalizer-failed', SAFE_MESSAGES.finalizerFailed, { failed: true, error: true });
  }

  if (!outcome?.alreadyFinalized && !outcome?.inProgress && !outcome?.requiresAttention) {
    result.completion.claimed += 1;
  }
  if (outcome?.finalized || outcome?.alreadyFinalized) {
    result.completion.completed += 1;
    if (outcome.finalized && !outcome.alreadyFinalized) result.finalized += 1;
    if (outcome.dueDiligencePending) {
      addIssue(result, 'completion-retryable', SAFE_MESSAGES.retryable);
    } else {
      result.partial = false;
    }
    return result;
  }
  if (outcome?.inProgress) {
    return addIssue(result, 'completion-in-progress', SAFE_MESSAGES.inProgress);
  }
  if (outcome?.budgetExhausted) {
    result.budgetExhausted = true;
    result.completion.failed += 1;
    return addIssue(result, 'budget-exhausted', SAFE_MESSAGES.budgetExhausted);
  }
  if (outcome?.requiresAttention) {
    result.completion.failed += 1;
    return addIssue(result, 'completion-attention', SAFE_MESSAGES.attention, { failed: true, error: true });
  }
  if (outcome?.retryable) {
    result.completion.failed += 1;
    return addIssue(result, 'completion-retryable', SAFE_MESSAGES.retryable);
  }
  result.completion.failed += 1;
  return addIssue(result, 'completion-finalizer-failed', SAFE_MESSAGES.finalizerFailed, { failed: true, error: true });
}
