import {
  assertStructuredMutationAuthorized,
  StructuredActionAuthorizationError,
} from './formStructuredActions.js';
import { normalizeStripeBillingAddress } from './stripeInvoiceAddress.js';
import {
  stripeAddressMappingConflictErrors,
  validateStripeAddressTargetResolution,
} from '../../shared/formStripeAddressMappings.js';
import { getCountryByCode, resolveCountryToIso2 } from '../../shared/countries.js';
import { runFormEntityPipelines } from './formEntityPipelines.js';

export const STRIPE_ADDRESS_MAPPING_SOURCES = Object.freeze([
  'line1', 'line2', 'city', 'state', 'postal_code', 'country', 'formatted',
]);

const STRIPE_PROVIDERS = new Set(['stripe', 'stripe_monthly_card']);
const MEMBER_CORE_FIELDS = new Set([
  // No member core address destination is currently exposed by the persisted
  // config contract. Member address mappings must target compatible custom
  // fields.
]);
const ORGANIZATION_CORE_FIELDS = new Set([
  'invoicing_address',
]);

export class StripeAddressMappingError extends Error {
  constructor(message, code = 'STRIPE_ADDRESS_MAPPING_INVALID', status = 400) {
    super(message);
    this.name = 'StripeAddressMappingError';
    this.code = code;
    this.status = status;
  }
}

export async function patchFormSubmissionPaymentMeta({
  db,
  tenantId,
  submissionId,
  patch,
}) {
  const { data, error } = await db.rpc('patch_form_submission_payment_meta', {
    p_tenant_id: tenantId,
    p_submission_id: submissionId,
    p_patch: patch,
  });
  if (error) throw new StripeAddressMappingError(
    `Unable to save payment metadata: ${error.message}`,
    'PAYMENT_META_PATCH_FAILED',
    503,
  );
  return data;
}

const plainObject = value => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : null
);

function normalizedMappings(config) {
  if (!config) return [];
  if (!plainObject(config) || Number(config.version) !== 1 || !Array.isArray(config.mappings)) {
    throw new StripeAddressMappingError('The persisted Stripe address mapping snapshot is invalid');
  }
  return config.mappings.map((mapping) => {
    const source = String(mapping?.source || '').trim();
    const targetEntity = String(mapping?.target_entity || '').trim();
    const targetType = String(mapping?.target_type || '').trim();
    const targetField = String(mapping?.target_field || '').trim();
    if (!STRIPE_ADDRESS_MAPPING_SOURCES.includes(source)
      || !['member', 'organization'].includes(targetEntity)
      || !['core', 'custom'].includes(targetType)
      || !targetField) {
      throw new StripeAddressMappingError('A persisted Stripe address mapping is invalid');
    }
    if (targetType === 'core') {
      const allowed = targetEntity === 'member' ? MEMBER_CORE_FIELDS : ORGANIZATION_CORE_FIELDS;
      if (!allowed.has(targetField)) {
        throw new StripeAddressMappingError(`Stripe address mapping cannot write core field ${targetField}`);
      }
    }
    return {
      source,
      target_entity: targetEntity,
      target_type: targetType,
      target_field: targetField,
    };
  });
}

function normalizedAddress(value) {
  if (!plainObject(value)) {
    throw new StripeAddressMappingError(
      'The immutable Stripe billing address snapshot is unavailable',
      'STRIPE_BILLING_ADDRESS_REQUIRED',
      409,
    );
  }
  try {
    const normalized = normalizeStripeBillingAddress(value);
    const countryCode = resolveCountryToIso2(normalized.country);
    const country = getCountryByCode(countryCode)?.name;
    if (!countryCode || !country) {
      throw new Error('Stripe billing address country is not recognized');
    }
    return { ...normalized, country_code: countryCode, country };
  } catch (error) {
    throw new StripeAddressMappingError(
      error.message,
      error.code || 'STRIPE_BILLING_ADDRESS_REQUIRED',
      409,
    );
  }
}

async function monthlyFirstPaymentSucceeded(db, submission) {
  const agreementId = submission.payment_meta?.monthly_card?.agreement_id;
  if (!agreementId || submission.payment_status !== 'setup_complete') return false;
  const { data, error } = await db
    .from('membership_payment_plans')
    .select('metadata')
    .eq('billing_agreement_id', agreementId)
    .maybeSingle();
  if (error) throw new StripeAddressMappingError(
    `Unable to verify the first monthly Stripe payment: ${error.message}`,
    'STRIPE_FIRST_PAYMENT_UNVERIFIED',
    503,
  );
  return Array.isArray(data?.metadata?.paid_invoice_ids)
    && data.metadata.paid_invoice_ids.length > 0;
}

async function loadCreationProvenance(db, submissionId) {
  const { data, error } = await db
    .from('form_submission_entity_creation')
    .select('entity_type, entity_id')
    .eq('form_submission_id', submissionId);
  if (error) throw new StripeAddressMappingError(
    `Unable to verify entity creation provenance: ${error.message}`,
    'STRIPE_ADDRESS_PROVENANCE_UNAVAILABLE',
    503,
  );
  return new Set((data || []).map(row => `${row.entity_type}:${row.entity_id}`));
}

/**
 * Apply payment-time Stripe billing address mappings once. The database RPC
 * performs all target writes and inserts the completion ledger in one
 * transaction, so a crash can never leave replayable writes without a ledger.
 *
 * Returns pending for a monthly Checkout until its first invoice is actually
 * paid. Callers may safely invoke this independently of payment_meta.finalized.
 */
export async function processPersistedStripeAddressMappings({
  db,
  submission,
  tenantId,
  memberId = null,
  organizationId = null,
  authorization = {},
  currentRunCreated = { member: new Set(), organization: new Set() },
  currentForm = undefined,
}) {
  const config = submission?.payment_meta?.stripe_address_mapping_config;
  if (!config) return { configured: false, applied: false };
  if (!submission?.id || String(submission.tenant_id) !== String(tenantId)) {
    throw new StripeAddressMappingError('Stripe address mapping submission tenant mismatch', 'TENANT_MISMATCH', 403);
  }
  const mappings = normalizedMappings(config);
  // Empty mapping snapshots are equivalent to the feature being absent and
  // must preserve the pre-feature path (including no ledger dependency).
  if (mappings.length === 0) return { configured: true, applied: false, empty: true };
  // Completion is immutable. Short-circuit before re-evaluating payment,
  // snapshot, target, or ownership state that may legitimately have drifted
  // since the atomic application committed.
  const { data: completed, error: completedError } = await db
    .from('form_stripe_address_mapping_ledger')
    .select('form_submission_id')
    .eq('form_submission_id', submission.id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (completedError) throw new StripeAddressMappingError(
    `Unable to check Stripe address mapping completion: ${completedError.message}`,
    'STRIPE_ADDRESS_LEDGER_UNAVAILABLE',
    503,
  );
  if (completed) return { configured: true, applied: false, alreadyApplied: true };
  if (!STRIPE_PROVIDERS.has(submission.payment_provider)) {
    throw new StripeAddressMappingError('Stripe address mappings cannot run for another payment provider', 'PAYMENT_PROVIDER_INVALID', 409);
  }
  let form = currentForm;
  if (form === undefined) {
    if (!submission.form_id) {
      throw new StripeAddressMappingError(
        'Unable to validate persisted Stripe mappings against the current form',
        'STRIPE_ADDRESS_CURRENT_FORM_UNAVAILABLE',
        409,
      );
    }
    const { data: loadedForm, error: formError } = await db
      .from('form')
      .select('fields, field_mappings, entity_pipelines, application_level, auto_create_entity, create_entity_type, entity_action, member_entity_action, organization_entity_action, additional_member_creations, default_member_role_id')
      .eq('id', submission.form_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (formError || !loadedForm) {
      throw new StripeAddressMappingError(
        formError?.message || 'The current form is unavailable',
        'STRIPE_ADDRESS_CURRENT_FORM_UNAVAILABLE',
        formError ? 503 : 409,
      );
    }
    form = loadedForm;
  }
  const targetResolution = validateStripeAddressTargetResolution(
    form,
    config.target_resolution,
  );
  if (!targetResolution.valid) {
    throw new StripeAddressMappingError(
      targetResolution.error,
      'STRIPE_ADDRESS_TARGET_RESOLUTION_CHANGED',
      409,
    );
  }
  const currentConflicts = stripeAddressMappingConflictErrors({ form, mappings });
  if (currentConflicts.length > 0) {
    throw new StripeAddressMappingError(
      currentConflicts[0],
      'STRIPE_ADDRESS_MAPPING_CONFLICT',
      409,
    );
  }
  const address = normalizedAddress(submission.payment_meta?.stripe_billing_address);

  if (submission.payment_provider === 'stripe') {
    if (submission.payment_status !== 'paid') {
      return { configured: true, applied: false, pending: true, reason: 'payment_not_paid' };
    }
  } else if (!(await monthlyFirstPaymentSucceeded(db, submission))) {
    return { configured: true, applied: false, pending: true, reason: 'first_payment_not_paid' };
  }

  const targets = { member: memberId, organization: organizationId };
  const provenance = await loadCreationProvenance(db, submission.id);
  for (const entity of new Set(mappings.map(mapping => mapping.target_entity))) {
    const recordId = targets[entity];
    if (!recordId) {
      throw new StripeAddressMappingError(`Stripe address mapping target ${entity} is unresolved`, 'STRIPE_ADDRESS_TARGET_UNRESOLVED', 409);
    }
    const createdNow = currentRunCreated?.[entity]?.has?.(String(recordId)) === true;
    const createdPersisted = provenance.has(`${entity}:${recordId}`);
    if (!createdNow && !createdPersisted) {
      assertStructuredMutationAuthorized({
        action: { target: { kind: entity } },
        recordId,
        authorization,
      });
    }
  }

  const { data, error } = await db.rpc('apply_form_stripe_address_mappings', {
    p_tenant_id: tenantId,
    p_submission_id: submission.id,
    p_member_id: memberId,
    p_organization_id: organizationId,
    p_mappings: mappings,
    p_address: address,
  });
  if (error) {
    throw new StripeAddressMappingError(
      `Stripe billing address mappings failed: ${error.message}`,
      'STRIPE_ADDRESS_MAPPING_WRITE_FAILED',
      500,
    );
  }
  if (!data?.ok) {
    const status = data?.code === 'ALREADY_APPLIED' ? 200 : 409;
    if (status !== 200) throw new StripeAddressMappingError(
      data?.detail || 'Stripe billing address mappings were rejected',
      data?.code || 'STRIPE_ADDRESS_MAPPING_REJECTED',
      status,
    );
  }
  return {
    configured: true,
    applied: data?.applied === true,
    alreadyApplied: data?.code === 'ALREADY_APPLIED',
  };
}

/**
 * Retry entry point for webhook/reconciliation code. It reloads all authority
 * from persisted rows; callers provide identity/authorization, never mappings
 * or target IDs.
 */
export async function retryPersistedStripeAddressMappings({
  db,
  submissionId,
  tenantId,
}) {
  let { data: submission, error } = await db
    .from('form_submission')
    .select('id, form_id, tenant_id, submitted_by_email, payment_provider, payment_status, payment_meta, created_member_id, created_organization_id, organization_id')
    .eq('id', submissionId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !submission) throw new StripeAddressMappingError(
    error?.message || 'Persisted form submission was not found',
    'SUBMISSION_NOT_FOUND',
    404,
  );
  const mappings = normalizedMappings(submission.payment_meta?.stripe_address_mapping_config);
  if (mappings.length > 0) {
    const { data: completed, error: completedError } = await db
      .from('form_stripe_address_mapping_ledger')
      .select('form_submission_id')
      .eq('form_submission_id', submissionId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (completedError) throw new StripeAddressMappingError(
      `Unable to check Stripe address mapping completion: ${completedError.message}`,
      'STRIPE_ADDRESS_LEDGER_UNAVAILABLE',
      503,
    );
    if (completed) return { configured: true, applied: false, alreadyApplied: true };
  }
  const targetEntities = new Set(mappings.map(mapping => mapping.target_entity));
  const loadCheckpoints = async () => {
    const { data, error: checkpointError } = await db
      .from('form_stripe_address_mapping_target')
      .select('entity_type, entity_id')
      .eq('form_submission_id', submissionId)
      .eq('tenant_id', tenantId);
    if (checkpointError) throw new StripeAddressMappingError(
      `Unable to reload Stripe address targets: ${checkpointError.message}`,
      'STRIPE_ADDRESS_TARGET_UNAVAILABLE',
      503,
    );
    return Object.fromEntries((data || []).map(row => [row.entity_type, row.entity_id]));
  };
  let checkpoints = mappings.length > 0 ? await loadCheckpoints() : {};
  let memberId = submission.created_member_id || checkpoints.member || null;
  let organizationId = submission.created_organization_id
    || submission.organization_id
    || checkpoints.organization
    || null;
  const targetsMissing = (targetEntities.has('member') && !memberId)
    || (targetEntities.has('organization') && !organizationId);
  let currentForm;
  if (targetsMissing) {
    const { data: form, error: formError } = await db
      .from('form')
      .select('id, tenant_id, pages, visibility_rules, fields, field_mappings, application_level, auto_create_entity, create_entity_type, entity_action, member_entity_action, organization_entity_action, additional_member_creations, entity_pipelines, default_member_role_id')
      .eq('id', submission.form_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (formError || !form) throw new StripeAddressMappingError(
      formError?.message || 'The current form is unavailable',
      'STRIPE_ADDRESS_CURRENT_FORM_UNAVAILABLE',
      formError ? 503 : 409,
    );
    currentForm = form;
    await runFormEntityPipelines({ supabase: db, submission, form });
    const { data: reloaded, error: reloadError } = await db
      .from('form_submission')
      .select('id, form_id, tenant_id, submitted_by_email, payment_provider, payment_status, payment_meta, created_member_id, created_organization_id, organization_id')
      .eq('id', submissionId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (reloadError || !reloaded) throw new StripeAddressMappingError(
      reloadError?.message || 'Persisted form submission was not found after recovery',
      'SUBMISSION_NOT_FOUND',
      reloadError ? 503 : 404,
    );
    submission = reloaded;
    checkpoints = await loadCheckpoints();
    memberId = submission.created_member_id || checkpoints.member || null;
    organizationId = submission.created_organization_id
      || submission.organization_id
      || checkpoints.organization
      || null;
  }
  const persistedMemberId = submission.payment_meta?.verified_submitter_member_id || null;
  let verifiedMember = null;
  if (persistedMemberId) {
    const { data: member, error: memberError } = await db
      .from('member')
      .select('id, tenant_id, email, organization_id')
      .eq('id', persistedMemberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (memberError) throw new StripeAddressMappingError(
      `Unable to reload persisted processing identity: ${memberError.message}`,
      'PROCESSING_IDENTITY_UNAVAILABLE',
      503,
    );
    if (String(member?.email || '').trim().toLowerCase()
      === String(submission.submitted_by_email || '').trim().toLowerCase()) {
      verifiedMember = member;
    }
  }
  return processPersistedStripeAddressMappings({
    db,
    submission,
    tenantId,
    memberId,
    organizationId,
    authorization: {
      isAdmin: submission.payment_meta?.verified_admin_access === true,
      verifiedMemberId: verifiedMember?.id || null,
      verifiedOrganizationId: verifiedMember?.organization_id || null,
    },
    currentForm,
  });
}

export { StructuredActionAuthorizationError };