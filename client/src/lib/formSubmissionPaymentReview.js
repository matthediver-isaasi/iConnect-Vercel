const GC_REASONS = {
  agreement_environment_mismatch: 'The Direct Debit belongs to a different provider environment and cannot be verified safely.',
  origin_context_unknown: 'The original Direct Debit account could not be verified safely.',
  current_context_unavailable: 'The Direct Debit account is currently unavailable for verification.',
  origin_environment_mismatch: 'The Direct Debit belongs to a different provider environment and cannot be verified safely.',
  origin_account_mismatch: 'The Direct Debit belongs to a different provider account and cannot be verified safely.',
  provider_resource_not_found: 'The Direct Debit payment could not be found after repeated checks.',
  provider_lookup_unavailable: 'The Direct Debit payment status could not be confirmed after repeated checks.',
};

const MEMBERSHIP_REASONS = {
  MEMBERSHIP_TARGET_INVALID: 'The membership target is invalid.',
  MEMBERSHIP_ENTITY_TENANT_INVALID: 'The linked membership record does not belong to this account.',
  MEMBERSHIP_ENTITY_LINK_MISMATCH: 'The linked member or organisation does not match the record created by this submission.',
  MEMBERSHIP_AUTHORITATIVE_LINK_MISSING: 'The member or organisation created by this submission could not be linked safely.',
  MEMBERSHIP_HISTORY_LINK_MISMATCH: 'The membership history does not match the member or organisation created by this submission.',
  MEMBERSHIP_HISTORY_TABLE_MISMATCH: 'The membership history was recorded against an unexpected record type.',
  MEMBERSHIP_HISTORY_LINK_MISSING: 'The expected membership history link could not be found.',
  MEMBERSHIP_PROCESSOR_TARGET_MISSING: 'The membership record expected from processing could not be found.',
  MEMBERSHIP_ENTITY_WAIT_EXHAUSTED: 'The membership record was not created after repeated checks.',
  MEMBERSHIP_PROCESSOR_LINK_MISMATCH: 'The application processor returned a different member or organisation from the one linked to this submission.',
  MEMBERSHIP_PROCESSOR_REVIEW_REQUIRED: 'The application processor could not verify the linked member or organisation safely.',
  MEMBERSHIP_PAYMENT_LINK_INVALID: 'The payment is not linked to this membership submission safely.',
  MEMBERSHIP_ACCOUNTING_PROVIDER_MISSING: 'No accounting provider is configured for this membership payment.',
  MEMBERSHIP_ACCOUNTING_PROVIDER_MISMATCH: 'The membership invoice belongs to a different accounting provider.',
  MEMBERSHIP_ACCOUNTING_CONTEXT_MISMATCH: 'The membership invoice belongs to a different accounting account.',
  MEMBERSHIP_ACCOUNTING_CONTEXT_MISSING: 'The accounting account used to create the membership invoice could not be verified.',
  MEMBERSHIP_ACCOUNTING_INVOICE_MISSING: 'The expected membership invoice could not be found.',
  MEMBERSHIP_PAYMENT_REFERENCE_MISSING: 'The payment reference needed to verify this membership is missing.',
  MEMBERSHIP_PAYMENT_REFERENCE_MISMATCH: 'The payment reference does not match this membership submission.',
  MEMBERSHIP_PAYMENT_NOT_SUCCEEDED: 'The payment provider has not confirmed a successful payment.',
  MEMBERSHIP_PAYMENT_METADATA_MISMATCH: 'The confirmed payment details do not match this membership submission.',
  MEMBERSHIP_PAYMENT_AMOUNT_MISMATCH: 'The confirmed payment amount does not match the membership amount.',
  MEMBERSHIP_PAYMENT_TIMESTAMP_MISSING: 'The successful payment does not include the confirmation time required for membership processing.',
};

const BLOCKED_MEMBERSHIP_STATES = [
  'status',
  'integrity_state',
  'invoice_state',
  'settlement_state',
  'workflow_state',
];

const PROCESSING_NOTE_DISPLAY_KEYS = new Set([
  'level',
  'kind',
  'stage',
  'message',
  'at',
  'entity_scope',
  'field_id',
]);

const SENSITIVE_DETAIL_KEYS = new Set([
  'accountfingerprint',
  'credential',
  'credentials',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'apisecret',
  'clientsecret',
  'webhooksecret',
  'authorization',
  'paymentmeta',
  'gcprovidercontext',
  'providerbody',
  'providerpayload',
  'providerresponse',
  'rawproviderbody',
  'rawproviderpayload',
  'rawproviderresponse',
  'requestbody',
  'responsebody',
]);

function isSensitiveDetailKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_DETAIL_KEYS.has(normalized)
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('refreshtoken')
    || normalized.endsWith('accountfingerprint');
}

function redactProcessingNoteValue(value) {
  if (Array.isArray(value)) return value.map(redactProcessingNoteValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveDetailKey(key))
      .map(([key, child]) => [key, redactProcessingNoteValue(child)]),
  );
}

/**
 * Preserve existing structured diagnostics while excluding provider and
 * credential material at any nesting depth.
 */
export function getSafeProcessingNoteDetails(note) {
  if (!note || typeof note !== 'object') return {};
  return redactProcessingNoteValue(Object.fromEntries(
    Object.entries(note).filter(([key]) => !PROCESSING_NOTE_DISPLAY_KEYS.has(key)),
  ));
}

/**
 * Returns an intentionally small, safe admin-facing projection. Raw provider
 * metadata is never returned because it may contain credential fingerprints or
 * provider response details.
 */
export function getFormSubmissionPaymentReview(submission) {
  const meta = submission?.payment_meta;
  if (!meta || typeof meta !== 'object') return null;

  const membership = meta.membership_result;
  if (membership && typeof membership === 'object'
      && BLOCKED_MEMBERSHIP_STATES.some((field) => membership[field] === 'blocked')) {
    return {
      source: 'membership',
      reason: MEMBERSHIP_REASONS[membership.integrity_error_code]
        || 'Membership processing was stopped because its linked records could not be verified safely.',
      blocksRerun: true,
    };
  }

  const reconciliation = meta.gc_reconciliation;
  if (reconciliation && typeof reconciliation === 'object'
      && (reconciliation.requires_review === true || reconciliation.status === 'blocked')) {
    return {
      source: 'gocardless',
      reason: GC_REASONS[reconciliation.reason]
        || 'The Direct Debit payment needs administrator review before processing can continue.',
      blocksRerun: reconciliation.status === 'blocked',
    };
  }

  return null;
}

export function isVisibleFormSubmission(submission) {
  return !submission?.payment_status
    || submission.payment_status === 'paid'
    || (submission.payment_provider === 'stripe_monthly_card'
      && submission.payment_status === 'setup_complete')
    || Boolean(getFormSubmissionPaymentReview(submission));
}