/**
 * POST /api/public/form-payment (Task #3483)
 *
 * Generic form Payment field endpoints, modelled on the job-posting payment
 * pattern:
 *
 *  action: 'create'  — validates the submitted answers against the STORED
 *    form (submit-control rules, hidden payment field, server-derived
 *    amount — the client NEVER supplies an amount), creates/reuses a
 *    pending form_submission row, then creates a Stripe PaymentIntent or a
 *    GoCardless billing request + hosted flow with metadata tying it to
 *    the tenant/form/submission.
 *
 *  action: 'confirm' — verifies the provider-side payment (status, amount,
 *    tenant/form metadata) before finalising the submission via a
 *    race-proof CAS; the winner runs post-submission processing exactly
 *    once (pipelines + guarded emails).
 *
 * Pending rows are excluded from admin listings and all normal side
 * effects until paid. Succeeded-but-unconfirmed Stripe payments are swept
 * by api/cron/reconcile-form-payments.js.
 */
import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getTenantTrustedBaseUrl } from '../_lib/publicBaseUrl.js';
import { resolveSubmitControl } from '../_lib/formSubmitControl.js';
import { rulesUseLmicOperators } from '../_lib/formLmicConditions.js';
import { loadTenantLmicCodes } from '../_lib/tenantLmicCodes.js';
import { getStripeCredentials, getStripeIntegrationCredentials, retrieveTenantPaymentIntent } from '../_lib/stripeCredentials.js';
import { gocardlessForTenant, buildIdempotencyKey } from '../_lib/gocardless.js';
import { computeHiddenFieldIds, findPaymentField, derivePaymentAmount } from '../_lib/formFieldVisibility.js';
import { markFormSubmissionPaid, finalizeFormSubmission } from '../_lib/formPaymentFinalize.js';
import {
  FORM_NOT_LISTED_LABELS_KEY,
  normalizeFormPrefillOrganizationId,
  snapshotFormNotListedLabels,
} from '../../shared/formNotListedChoice.js';
import { resolveMembershipAction, buildMembershipFieldOverrides } from '../_lib/formMembershipAction.js';
import { quoteMembershipForNewApplicant, quoteFromSimulationResult } from '../_lib/membershipQuote.js';
import {
  buildCardAgreementSnapshot,
  CARD_PLAN_KIND,
  processStripeCardPlanEvent,
} from '../_lib/stripeMonthlyCard.js';
import {
  claimFormMonthlyCardMembership,
  claimFormMonthlyCardApplicantAgreement,
  findFormMonthlyCardAgreement,
  findExistingFormApplicantMember,
  formMonthlyCardApplicantAgreementKey,
  formMonthlyCardSubmissionKey,
  legacyFormMonthlyCardSubmissionKey,
  formMonthlyCardSubmissionMatchesApplicant,
  persistMonthlyCheckoutLink,
  releaseExpiredFormMonthlyCardCheckout,
} from '../_lib/formMonthlyCardCheckout.js';
import {
  claimFormMonthlyDirectDebitApplicantAgreement,
  findFormMonthlyDirectDebitAgreement,
  formMonthlyDirectDebitApplicantAgreementKey,
  persistMonthlyDirectDebitLink,
} from '../_lib/formMonthlyDirectDebitCheckout.js';
import {
  attachMonthlyConsentFlow,
  buildAgreementSnapshot,
  buildMonthlyBillingRequest,
  classifyMonthlyConsentAgreement,
  monthlyBillingRequestFingerprint,
  monthlyConsentReplacementKey,
  rotateStaleMonthlyConsentAgreement,
} from '../_lib/gocardlessDirectDebit.js';
import { processGocardlessEvent } from '../_lib/gocardlessWebhookProcessor.js';
import { resolveFormAccess, sendFormAccessDenied } from '../_lib/formAccessPolicy.js';
import { withFormPaymentAccessProof } from '../_lib/formPaymentAccess.js';
import { inspectPriorFormStripeIntent } from '../_lib/formStripeIntentRetry.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { createFormRelationshipService, FormRelationshipError } from '../_lib/formRelationshipOptions.js';
import {
  validateFormOrganisationGroupAnswers,
  validateOrganisationGroupDependentOrganizationAnswers,
} from '../_lib/formOrganisationGroups.js';
import { validateRepeatableRowSubmission } from '../_lib/formRepeatableRowValidation.js';
import { invalidRequiredAddressLookupFields } from '../_lib/idealPostcodes.js';
import { getSessionMember } from '../_lib/session.js';
import { capturePaymentIntentBillingAddress } from '../_lib/stripeInvoiceAddress.js';
import { validateFormStripeAddressMappingConfig } from '../_lib/formStripeAddressMappingConfig.js';
import {
  patchFormSubmissionPaymentMeta,
  retryPersistedStripeAddressMappings,
} from '../_lib/formStripeAddressMappingProcessing.js';
import { buildStripeAddressTargetResolution } from '../../shared/formStripeAddressMappings.js';
import {
  monthlyConfirmLifecycle,
  verifiedStripeMonthlyCollection,
} from '../_lib/formMonthlyConfirmLifecycle.js';
const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

const FORM_COLUMNS = 'id, name, tenant_id, require_authentication, access_policy, fields, pages, visibility_rules, entity_pipelines, structured_actions, field_mappings, application_level, auto_create_entity, create_entity_type, entity_action, member_entity_action, organization_entity_action, additional_member_creations, default_member_role_id, deactivate_at, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type';

async function acceptedStripeAddressConfig(supabase, tenantId, form, paymentField) {
  const validation = await validateFormStripeAddressMappingConfig({
    supabase,
    tenantId,
    form,
  });
  if (!validation.ok) return validation;
  const mappings = Array.isArray(paymentField?.stripe_billing_address_mappings)
    ? paymentField.stripe_billing_address_mappings.map(mapping => ({
        source: mapping.source,
        target_entity: mapping.target_entity,
        target_type: mapping.target_type,
        target_field: mapping.target_field,
      }))
    : [];
  if (mappings.length === 0) {
    return { ok: true, config: null };
  }
  return {
    ok: true,
    config: {
      version: 1,
      mappings,
      target_resolution: buildStripeAddressTargetResolution(form, mappings),
    },
  };
}

export function submissionRequiresStripeBillingAddress(submission) {
  const meta = submission?.payment_meta || {};
  return !!meta.membership
    || (Array.isArray(meta.stripe_address_mapping_config?.mappings)
      && meta.stripe_address_mapping_config.mappings.length > 0);
}

function sanitizeReturnPath(p) {
  if (typeof p !== 'string') return '/';
  if (!p.startsWith('/') || p.startsWith('//')) return '/';
  // strip any fragment; keep path + query
  return p.split('#')[0] || '/';
}

function extractSubmitterEmail(form, data) {
  const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  for (const field of (form.fields || [])) {
    if (!field?.id) continue;
    const idLower = (field.id || '').toLowerCase();
    const labelLower = (field.label || '').toLowerCase();
    const looksLikeEmail = field.type === 'email'
      || idLower.includes('email') || labelLower.includes('email');
    if (!looksLikeEmail) continue;
    const val = (data || {})[field.id];
    if (isEmail(val)) return val.trim().toLowerCase();
  }
  for (const value of Object.values(data || {})) {
    if (isEmail(value)) return value.trim().toLowerCase();
  }
  return null;
}

function extractMemberPipelineEmail(form, data) {
  const memberPipelines = Array.isArray(form?.entity_pipelines?.members)
    ? form.entity_pipelines.members : [];
  const primary = memberPipelines.find((pipeline) => pipeline?.isPrimary)
    || memberPipelines[0]
    || null;
  const emailMapping = (primary?.mappings || []).find((mapping) => (
    mapping?.source_type === 'field'
    && mapping?.target_type === 'core'
    && mapping?.target_field === 'email'
    && mapping?.source_field_id
  ));
  const mappedValue = emailMapping ? data?.[emailMapping.source_field_id] : null;
  if (typeof mappedValue === 'string'
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mappedValue.trim())) {
    return mappedValue.trim().toLowerCase();
  }
  return extractSubmitterEmail(form, data);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    req.body = {
      ...(req.body || {}),
      prefill_organization_id: normalizeFormPrefillOrganizationId(
        req.body?.prefill_organization_id,
      ),
    };
    const tenantData = await resolveTenantFromRequest(req);
    if (!tenantData) return res.status(404).json({ error: 'Tenant not found' });

    const { action } = req.body || {};
    if (action === 'create') return await handleCreate(req, res, supabase, tenantData);
    if (action === 'create_monthly_card') return await handleCreateMonthlyCard(req, res, supabase, tenantData);
    if (action === 'confirm') return await handleConfirm(req, res, supabase, tenantData);
    if (action === 'quote') return await handleQuote(req, res, supabase, tenantData);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[form-payment] Error:', err);
    return res.status(500).json({ error: err.message || 'Payment request failed' });
  }
}

async function loadForm(supabase, formId, tenantId) {
  const { data: form, error } = await supabase
    .from('form')
    .select(FORM_COLUMNS)
    .eq('id', formId)
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .single();
  if (error || !form) return null;
  if (!isFormScheduleAvailable(form)) return null;
  return form;
}

async function authorizePaymentStart(req, res, supabase, tenantData, form) {
  const access = await resolveFormAccess({
    supabase, req, tenantId: tenantData.id, policy: form.access_policy,
  });
  if (!access.allowed) {
    sendFormAccessDenied(res, access);
    return null;
  }
  let verifiedSubmitterMemberId = null;
  let verifiedAdminAccess = false;
  try {
    const member = await getSessionMember(req);
    const memberTenantId = member?.tenant_id || member?.organization?.tenant_id || null;
    if (member?.id && memberTenantId === tenantData.id) {
      verifiedSubmitterMemberId = member.id;
    }
  } catch {
    // Unrestricted forms remain available to anonymous submitters.
  }
  try {
    const tenantContext = await getTenantContext(req);
    verifiedAdminAccess = tenantContext?.tenantId === tenantData.id
      && await hasAdminAccess(tenantContext);
  } catch {
    verifiedAdminAccess = false;
  }
  return { ...access, verifiedSubmitterMemberId, verifiedAdminAccess };
}

export async function validatePaymentRelationships(res, supabase, tenantData, form, values, visibilityOptions = null) {
  try {
    const evalOptions = visibilityOptions || {};
    if (!visibilityOptions && rulesUseLmicOperators(form.visibility_rules)) {
      evalOptions.lmicCodes = await loadTenantLmicCodes(supabase, tenantData.id);
    }
    const hiddenFieldIds = computeHiddenFieldIds(form, values, evalOptions);
    const invalidAddressFields = invalidRequiredAddressLookupFields(
      form.fields || [],
      values,
      hiddenFieldIds,
    );
    if (invalidAddressFields.length) {
      res.status(400).json({
        error: 'Required address information is missing',
        code: 'ADDRESS_COMPONENTS_REQUIRED',
        fields: invalidAddressFields,
      });
      return false;
    }
    await validateRepeatableRowSubmission({
      db: supabase,
      tenantId: tenantData.id,
      form,
      submissionData: values,
      visibilityOptions: evalOptions,
      hiddenFieldIds,
    });
    const service = createFormRelationshipService({
      db: supabase,
      tenantId: tenantData.id,
    });
    await service.validateSubmission({
      form, submissionData: values, hiddenFieldIds, visibilityOptions: evalOptions,
    });
    await validateFormOrganisationGroupAnswers({
      db: supabase,
      tenantId: tenantData.id,
      fields: form.fields || [],
      submissionData: values,
      hiddenFieldIds,
    });
    await validateOrganisationGroupDependentOrganizationAnswers({
      db: supabase,
      tenantId: tenantData.id,
      fields: form.fields || [],
      submissionData: values,
      hiddenFieldIds,
    });
    return true;
  } catch (error) {
    if (error instanceof FormRelationshipError && error.status < 500) {
      res.status(400).json(error.details
        ? { error: 'Invalid repeatable row submission', code: error.code, details: error.details }
        : { error: 'Invalid relationship selection' });
      return false;
    }
    if (error?.code === 'INVALID_ORGANISATION_GROUP') {
      res.status(400).json({ error: 'Invalid organisation group selection' });
      return false;
    }
    if (error?.code === 'INVALID_ORGANISATION_GROUP_ORGANISATION') {
      res.status(400).json({ error: 'Invalid organisation selection for the selected group' });
      return false;
    }
    console.error('[form-payment] Relationship validation failed:', error);
    res.status(500).json({ error: 'Failed to validate relationship selections' });
    return false;
  }
}

export function membershipAllowsPaymentProvider(provider, membershipMeta) {
  return provider !== 'gocardless'
    || !membershipMeta
    || membershipMeta.quote?.direct_debit_allowed === true;
}

/**
 * Shared by 'create' and 'quote' (Task #3498): resolve the payable charge
 * for the current answers. The amount is ALWAYS derived server-side — from
 * the membership quote when a conditional membership action matched,
 * otherwise from the price-source answer.
 *
 * Returns { error: { status, body } } or
 * { membershipMeta, amount, currency, evalOptions }.
 */
async function resolvePayableCharge({ supabase, tenantData, form, paymentField, values, prefill_organization_id, evalOptions: presetEvalOptions = null }) {
  // LMIC options shared by submit-control AND visibility evaluation.
  const evalOptions = presetEvalOptions || {};
  if (!presetEvalOptions && rulesUseLmicOperators(form.visibility_rules)) {
    evalOptions.lmicCodes = await loadTenantLmicCodes(supabase, tenantData.id);
  }

  // Hidden payment field ⇒ payment is not part of this submission; the
  // client must use the normal submit path.
  const hiddenIds = computeHiddenFieldIds(form, values, evalOptions);
  if (hiddenIds.has(paymentField.id)) {
    return { error: { status: 400, body: { error: 'Payment is not required for these answers', code: 'PAYMENT_NOT_REQUIRED' } } };
  }

  // Conditional-logic membership action (Task #3489): when a matched rule
  // selects a membership structure, the charge amount is the server-derived
  // membership fee for that structure and the paid submission will create
  // the membership record at finalisation.
  let membershipMeta = null;
  const membershipAction = resolveMembershipAction(form.visibility_rules, values, evalOptions);
  if (membershipAction) {
    // Resolve the config's scope FIRST — it decides which entity the
    // membership targets and how the fee is derived.
    // Lifecycle-aware resolution: a persisted form rule can outlive its
    // structure, so only configs effective TODAY may be quoted/charged
    // (expired, future-scheduled, or otherwise out-of-window configs are
    // rejected before any charge exists).
    const { getAllActiveConfigs } = await import('../_lib/membershipConfigResolver.js');
    const activeConfigs = await getAllActiveConfigs(tenantData.id);
    const fieldOverrides = buildMembershipFieldOverrides(membershipAction.fieldMappings, values);
    let membershipConfig = null;
    if (membershipAction.autoResolve) {
      // Auto-resolve mode (Task #3659): the concrete structure is chosen by
      // matching the mapped answer against each active member-scoped
      // structure's match value — never a £0 / price-source fallback.
      const { autoResolveMembershipConfig } = await import('../_lib/formMembershipAction.js');
      const autoResolved = autoResolveMembershipConfig(activeConfigs, fieldOverrides, { scope: 'member' });
      if (autoResolved.error) {
        return { error: { status: 400, body: { error: autoResolved.error, code: 'MEMBERSHIP_QUOTE_FAILED' } } };
      }
      membershipConfig = autoResolved.config;
    } else {
      membershipConfig = (activeConfigs || []).find(c => c.id === membershipAction.configId);
      if (!membershipConfig) {
        return { error: { status: 400, body: { error: 'The selected membership structure is not currently in effect. Ask the administrator to update the form.', code: 'MEMBERSHIP_QUOTE_FAILED' } } };
      }
    }
    const membershipConfigId = membershipConfig.id;
    const membershipTarget = membershipConfig.structure_scope_type === 'member' ? 'member' : 'organization';

    // Scope-to-pipeline validation BEFORE any charge is created: the form's
    // processing must be able to resolve the target entity after payment,
    // otherwise we'd take money and have nowhere to attach the membership.
    const hasMemberPipeline = (form.entity_pipelines?.members?.length || 0) > 0;
    const hasOrgPipeline = (form.entity_pipelines?.organisations?.length || 0) > 0;
    if (membershipTarget === 'member' && !hasMemberPipeline) {
      return { error: { status: 400, body: {
        error: 'This form cannot create a member membership: it has no member-creating processing pipeline. Ask the administrator to fix the form configuration.',
        code: 'MEMBERSHIP_TARGET_UNRESOLVABLE',
      } } };
    }
    if (membershipTarget === 'organization' && !hasOrgPipeline && !prefill_organization_id) {
      return { error: { status: 400, body: {
        error: 'This form cannot create an organisation membership: it has no organisation-creating processing pipeline. Ask the administrator to fix the form configuration.',
        code: 'MEMBERSHIP_TARGET_UNRESOLVABLE',
      } } };
    }

    let quote = null;
    if (membershipTarget === 'organization' && prefill_organization_id) {
      // An existing organisation is already known: use the full simulation
      // (honours go-live date, existing records, overrides, stored values).
      const { simulateMembershipForOrg } = await import('../_lib/membershipSimulation.js');
      const simResult = await simulateMembershipForOrg(tenantData.id, prefill_organization_id, {
        source: 'form-payment', mode: 'manual', configId: membershipConfigId, fieldOverrides,
      });
      if (!simResult.success) {
        return { error: { status: 400, body: { error: simResult.error || 'The membership fee could not be calculated', code: 'MEMBERSHIP_QUOTE_FAILED' } } };
      }
      if (simResult.existingRecord) {
        return { error: { status: 400, body: { error: `A membership record for ${simResult.membershipYear?.label} already exists for this organisation`, code: 'MEMBERSHIP_EXISTS' } } };
      }
      quote = quoteFromSimulationResult(simResult, 'organization');
    } else {
      // New applicant (member- or organisation-scoped): detached quote from
      // the form answers alone. A member-scoped structure keeps this path
      // even when prefill_organization_id is present — the membership
      // belongs to the member the pipeline creates, not the organisation.
      const quoted = await quoteMembershipForNewApplicant({
        tenantId: tenantData.id, configId: membershipConfigId, fieldOverrides,
      });
      if (!quoted.success) {
        return { error: { status: 400, body: { error: quoted.error || 'The membership fee could not be calculated', code: 'MEMBERSHIP_QUOTE_FAILED' } } };
      }
      quote = quoted.quote;
    }
    membershipMeta = { rule_id: membershipAction.ruleId, action_id: membershipAction.actionId, quote };
  }

  const amount = membershipMeta
    ? (membershipMeta.quote.total_with_vat || membershipMeta.quote.final_cost)
    : derivePaymentAmount(paymentField, values);
  const currency = membershipMeta
    ? (membershipMeta.quote.currency || 'GBP').toUpperCase()
    : (paymentField.payment_currency || 'GBP').toUpperCase();

  return { membershipMeta, amount, currency, evalOptions };
}

/**
 * Task #3498: display-only fee quote for the public form client. Resolves
 * the SAME server-derived charge the 'create' action would use (membership
 * fee when a conditional membership rule matches, price-source answer
 * otherwise) without creating anything. The client uses it to show the real
 * amount due and to decide whether a payment step is required — the quoted
 * amount is never sent back or trusted at charge time.
 */
async function handleQuote(req, res, supabase, tenantData) {
  const { form_id, submission_data, prefill_organization_id } = req.body || {};
  if (!form_id) return res.status(400).json({ error: 'Form ID is required' });

  const form = await loadForm(supabase, form_id, tenantData.id);
  if (!form) return res.status(404).json({ error: 'Form not found' });
  const access = await authorizePaymentStart(req, res, supabase, tenantData, form);
  if (!access) return;
  if (form.form_type === 'survey') {
    return res.status(400).json({ error: 'Payment fields are not supported on surveys' });
  }
  const paymentField = findPaymentField(form);
  if (!paymentField) return res.status(400).json({ error: 'This form has no payment field' });
  const evalOptions = rulesUseLmicOperators(form.visibility_rules)
    ? { lmicCodes: await loadTenantLmicCodes(supabase, tenantData.id) } : {};
  if (!await validatePaymentRelationships(
    res, supabase, tenantData, form, submission_data || {}, evalOptions,
  )) return;

  const resolved = await resolvePayableCharge({
    supabase, tenantData, form, paymentField,
    values: submission_data || {},
    prefill_organization_id,
    evalOptions,
  });
  if (resolved.error) {
    // A hidden payment field just means the normal submit path applies —
    // not an error for a display-only quote.
    if (resolved.error.body?.code === 'PAYMENT_NOT_REQUIRED') {
      return res.status(200).json({ required: false, code: 'PAYMENT_NOT_REQUIRED' });
    }
    return res.status(resolved.error.status).json(resolved.error.body);
  }

  const { membershipMeta, amount, currency } = resolved;
  if (!(amount > 0)) {
    return res.status(200).json({ required: false, code: 'NO_PAYMENT_REQUIRED' });
  }
  let monthlyCard = null;
  let directDebit = null;
  // Only advertise the recurring offer when the tenant can actually launch a
  // subscription checkout. The offer itself remains server-derived.
  const enabledProviders = Array.isArray(paymentField.payment_providers) ? paymentField.payment_providers : [];
  if (enabledProviders.includes('stripe')
      && membershipMeta?.quote?.target === 'member'
      && membershipMeta.quote.monthly_card_offer) {
    const creds = await getStripeCredentials(tenantData.id, 'membership');
    if (creds?.secret_key && creds.is_enabled !== false) {
      monthlyCard = membershipMeta.quote.monthly_card_offer;
    }
  }
  if (enabledProviders.includes('gocardless')
      && membershipMeta?.quote?.target === 'member'
      && membershipMeta.quote.direct_debit_offer) {
    const gc = await gocardlessForTenant(tenantData.id);
    if (gc.isConfigured()) directDebit = membershipMeta.quote.direct_debit_offer;
  }
  return res.status(200).json({
    required: true,
    amount,
    currency,
    membership: membershipMeta ? {
      config_name: membershipMeta.quote.config_name || null,
      membership_year: membershipMeta.quote.membership_year || null,
      tier_label: membershipMeta.quote.tier_label || null,
      monthly_card: monthlyCard,
      direct_debit: directDebit,
      direct_debit_allowed: directDebit !== null,
    } : null,
  });
}

async function handleCreateMonthlyCard(req, res, supabase, tenantData) {
  const { form_id, submission_data, idempotency_key, prefill_organization_id, role_id, return_path } = req.body || {};
  if (!form_id) return res.status(400).json({ error: 'Form ID is required' });
  const form = await loadForm(supabase, form_id, tenantData.id);
  if (!form || form.form_type === 'survey') return res.status(404).json({ error: 'Form not found' });
  const access = await authorizePaymentStart(req, res, supabase, tenantData, form);
  if (!access) return;
  const paymentField = findPaymentField(form);
  if (!paymentField) return res.status(400).json({ error: 'This form has no payment field' });
  const addressConfigResult = await acceptedStripeAddressConfig(
    supabase, tenantData.id, form, paymentField,
  );
  if (!addressConfigResult.ok) {
    return res.status(400).json({
      error: addressConfigResult.error,
      code: addressConfigResult.code,
      details: addressConfigResult.details,
    });
  }
  const stripeAddressMappingConfig = addressConfigResult.config;
  const enabledProviders = Array.isArray(paymentField.payment_providers) ? paymentField.payment_providers : [];
  if (!enabledProviders.includes('stripe')) {
    return res.status(400).json({ error: 'Monthly card payment is not enabled for this form' });
  }
  const values = submission_data || {};
  const evalOptions = rulesUseLmicOperators(form.visibility_rules)
    ? { lmicCodes: await loadTenantLmicCodes(supabase, tenantData.id) } : {};
  const submitControl = resolveSubmitControl(form.visibility_rules, values, evalOptions);
  if (submitControl.disabled) return res.status(400).json({ error: submitControl.message || 'This form cannot be submitted with the current answers.' });
  if (!await validatePaymentRelationships(
    res, supabase, tenantData, form, values, evalOptions,
  )) return;
  const resolved = await resolvePayableCharge({ supabase, tenantData, form, paymentField, values, prefill_organization_id, evalOptions });
  if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);
  const quote = resolved.membershipMeta?.quote;
  const offer = quote?.target === 'member' ? quote.monthly_card_offer : null;
  if (!offer) return res.status(400).json({ error: 'Monthly card payment is not available for this membership' });
  const applicantEmail = extractMemberPipelineEmail(form, values);
  if (!applicantEmail) {
    return res.status(400).json({
      error: 'An email address is required to set up monthly card membership',
      code: 'MEMBERSHIP_EMAIL_REQUIRED',
    });
  }
  const { data: existingApplicant, error: applicantLookupErr } = await findExistingFormApplicantMember(
    supabase,
    { tenantId: tenantData.id, email: applicantEmail },
  );
  if (applicantLookupErr) {
    console.error('[form-payment] Monthly-card applicant lookup failed:', applicantLookupErr.message);
    return res.status(500).json({ error: 'Could not safely verify the membership applicant. Please try again.' });
  }
  const creds = await getStripeCredentials(tenantData.id, 'membership');
  if (!creds?.secret_key || creds.is_enabled === false) {
    return res.status(400).json({ error: 'Card payment is not available for this organisation' });
  }
  const browserAttemptKey = typeof idempotency_key === 'string' ? idempotency_key.trim() : '';
  if (!browserAttemptKey) {
    return res.status(400).json({ error: 'A payment attempt identifier is required. Refresh the form and try again.' });
  }
  const idemKey = formMonthlyCardSubmissionKey({
    browserKey: browserAttemptKey,
    email: applicantEmail,
    membershipYear: quote.membership_year,
  });
  const legacyIdemKey = legacyFormMonthlyCardSubmissionKey(browserAttemptKey);
  let submission = null;
  const { data: currentAttempt, error: currentAttemptErr } = await supabase.from('form_submission').select('*')
    .eq('tenant_id', tenantData.id).eq('form_id', form.id).eq('idempotency_key', idemKey).maybeSingle();
  if (currentAttemptErr) return res.status(500).json({ error: 'Failed to prepare payment' });
  submission = currentAttempt || null;
  if (!submission && legacyIdemKey) {
    const { data: legacyAttempt, error: legacyAttemptErr } = await supabase.from('form_submission').select('*')
      .eq('tenant_id', tenantData.id).eq('form_id', form.id).eq('idempotency_key', legacyIdemKey).maybeSingle();
    if (legacyAttemptErr) return res.status(500).json({ error: 'Failed to prepare payment' });
    // Legacy per-fill rows are recoverable only for the identity that created
    // them. A changed applicant gets an independent v2 row and agreement.
    if (formMonthlyCardSubmissionMatchesApplicant(legacyAttempt, applicantEmail)) {
      submission = legacyAttempt;
    }
  }
  if (!submission) {
    const { data, error } = await supabase.from('form_submission').insert({
      form_id: form.id,
      form_name: form.name,
      tenant_id: tenantData.id,
      submission_data: snapshotFormNotListedLabels(form.fields || [], values),
      submitted_by_email: applicantEmail, created_date: new Date().toISOString(),
      payment_status: 'pending', payment_provider: 'stripe_monthly_card',
      payment_amount: offer.monthlyAmount, payment_currency: offer.currency,
      payment_meta: withFormPaymentAccessProof({ prefill_organization_id: prefill_organization_id || null, role_id: role_id || null,
        verified_submitter_member_id: access.verifiedSubmitterMemberId || null,
        verified_admin_access: access.verifiedAdminAccess === true,
        membership: resolved.membershipMeta,
        ...(stripeAddressMappingConfig
          ? { stripe_address_mapping_config: stripeAddressMappingConfig }
          : {}),
        monthly_card: {
          offer,
           applicant_email: applicantEmail,
          pre_resolved_member_id: existingApplicant?.id || null,
        } }, { accessPolicyRequired: access.restricted }), ...(idemKey && { idempotency_key: idemKey }),
    }).select().single();
    if (error?.code === '23505' && idemKey) {
      const { data: winner, error: winnerErr } = await supabase.from('form_submission').select('*')
        .eq('tenant_id', tenantData.id).eq('form_id', form.id).eq('idempotency_key', idemKey).maybeSingle();
      if (winnerErr || !winner) return res.status(500).json({ error: 'Failed to prepare payment' });
      submission = winner;
    } else if (error) {
      return res.status(500).json({ error: 'Failed to prepare payment' });
    } else {
      submission = data;
    }
  }
  if (submission.payment_provider !== 'stripe_monthly_card') {
    return res.status(409).json({ error: 'This submission already has a different payment in progress' });
  }
  if (submission.payment_status !== 'pending') {
    return res.status(409).json({ error: 'This monthly card checkout has already completed' });
  }
  if (!formMonthlyCardSubmissionMatchesApplicant(submission, applicantEmail)) {
    return res.status(409).json({
      error: 'The applicant email changed after this payment attempt was prepared. Please start the monthly card payment again.',
      code: 'MONTHLY_CARD_APPLICANT_CHANGED',
      retryable: true,
    });
  }
  const storedQuote = submission.payment_meta?.membership?.quote;
  const sameOffer = storedQuote?.config_id === quote.config_id
    && storedQuote?.band_id === quote.band_id
    && storedQuote?.membership_year === quote.membership_year
    && Number(submission.payment_meta?.monthly_card?.offer?.monthlyAmountMinor) === Number(offer.monthlyAmountMinor)
    && Number(submission.payment_meta?.monthly_card?.offer?.instalmentCount) === Number(offer.instalmentCount);
  if (!sameOffer) {
    return res.status(409).json({
      error: 'A monthly card checkout for this submission was already prepared with different membership terms. Please start a new payment attempt.',
      code: 'PAYMENT_ALREADY_INITIATED',
    });
  }
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(creds.secret_key);
  const environment = creds.secret_key.startsWith('sk_test_') ? 'test' : 'live';
  const snapshot = buildCardAgreementSnapshot({ offer, simResult: {
    membershipYear: { label: quote.membership_year, start: quote.membership_year_start },
    config: { id: quote.config_id }, matchedBand: quote.band_id ? { id: quote.band_id } : null,
    tierLabel: quote.tier_label, fieldValue: quote.field_value,
    annualCost: quote.annual_cost, finalCost: quote.final_cost,
    vatRatePercent: quote.vat_rate_percent, vatAmount: quote.vat_amount,
    totalWithVat: quote.total_with_vat,
  } });
  const agreementKey = formMonthlyCardApplicantAgreementKey({
    tenantId: tenantData.id,
    email: applicantEmail,
    membershipYear: quote.membership_year,
  });
  let { data: prior, error: priorErr } = await claimFormMonthlyCardApplicantAgreement(supabase, {
    tenantId: tenantData.id,
    submissionId: submission.id,
    applicantEmail,
    membershipYear: quote.membership_year,
    agreementKey,
    environment,
    cardSnapshot: snapshot,
    memberId: existingApplicant?.id || null,
  });
  if (priorErr) {
    console.error('[form-payment] Monthly-card applicant agreement claim failed:', priorErr.message);
    return res.status(500).json({ error: 'Failed to prepare card plan set-up' });
  }
  if (prior && prior.metadata?.form_submission_id !== String(submission.id)) {
    return res.status(409).json({
      error: 'A monthly card membership checkout is already in progress for this email and membership year.',
      code: 'MEMBERSHIP_PAYMENT_IN_PROGRESS',
    });
  }

  // Verify/release an old Checkout before trying to reserve the returning
  // member's year again. An expired attempt must not be converted into a
  // membership-year conflict merely because its own reservation is still
  // attached.
  if (prior.redirect_url && prior.stripe_checkout_session_id) {
    let existingSession = null;
    try {
      existingSession = await stripe.checkout.sessions.retrieve(prior.stripe_checkout_session_id);
    } catch (err) {
      console.error('[form-payment] Failed to verify saved monthly Checkout:', err);
      return res.status(500).json({
        error: 'Could not verify the existing card checkout. Please try again rather than starting another payment.',
      });
    }
    if (existingSession.status !== 'expired') {
      try {
        submission = await persistMonthlyCheckoutLink(supabase, submission, offer, prior);
      } catch (err) {
        console.error('[form-payment] Failed to repair monthly checkout link:', err);
        return res.status(500).json({ error: 'Card checkout was prepared but could not be linked. Please try again.' });
      }
      return res.json({ checkoutUrl: prior.redirect_url, submissionId: submission.id, resumed: true });
    }
    const released = await releaseExpiredFormMonthlyCardCheckout(supabase, {
      agreementId: prior.id,
      checkoutSessionId: prior.stripe_checkout_session_id,
    });
    if (!released.ok) {
      return res.status(500).json({ error: 'Could not renew the expired card checkout. Please try again.' });
    }
    // The release retires the applicant/year idempotency key and the old
    // agreement atomically. Re-enter once to create a fresh agreement/session
    // from the same still-pending form submission.
    return handleCreateMonthlyCard(req, res, supabase, tenantData);
  }

  // Returning applicants can be identified before Checkout. Reserve their
  // membership year atomically before Stripe can charge. New applicants are
  // claimed by the same RPC after the verified Checkout creates/resolves them.
  const preResolvedMemberId = prior.member_id
    || existingApplicant?.id
    || submission.payment_meta?.monthly_card?.pre_resolved_member_id
    || null;
  if (preResolvedMemberId) {
    const claim = await claimFormMonthlyCardMembership(supabase, {
      agreementId: prior.id,
      submissionId: submission.id,
      memberId: preResolvedMemberId,
      history: snapshot,
      reserveOnly: true,
    });
    if (!claim.ok) {
      if (!claim.conflict) {
        return res.status(500).json({ error: 'Could not safely reserve this membership. Please try again.' });
      }
      const conflictMessage = claim.code === 'OPEN_MEMBERSHIP_AGREEMENT_EXISTS'
        ? 'A monthly payment plan is already set up for this membership year.'
        : 'Membership for this year is already recorded for this member.';
      const failureMeta = {
        ...(submission.payment_meta || {}),
        monthly_card: {
          ...(submission.payment_meta?.monthly_card || {}),
          conflict_code: claim.code,
        },
      };
      const [agreementFailure, submissionFailure] = await Promise.all([
        supabase.from('membership_billing_agreements').update({
          status: 'expired',
          attention_reason: conflictMessage,
          updated_at: new Date().toISOString(),
        }).eq('id', prior.id),
        supabase.from('form_submission').update({
          payment_status: 'failed',
          payment_meta: failureMeta,
          processing_notes: conflictMessage,
        }).eq('id', submission.id).eq('payment_status', 'pending'),
      ]);
      if (agreementFailure.error || submissionFailure.error) {
        console.error(
          '[form-payment] Failed to persist pre-checkout membership conflict:',
          agreementFailure.error?.message || submissionFailure.error?.message,
        );
      }
      return res.status(409).json({
        error: conflictMessage,
        code: claim.code || 'MEMBERSHIP_YEAR_CONFLICT',
      });
    }
    prior = { ...prior, member_id: preResolvedMemberId };
  }
  const baseUrl = getTenantTrustedBaseUrl(req, tenantData);
  const returnPath = sanitizeReturnPath(return_path);
  const withParams = (entries) => {
    const url = new URL(returnPath, baseUrl);
    for (const [key, value] of entries) url.searchParams.set(key, value);
    return url.toString();
  };
  let session;
  try {
    const { findOrCreateStripeCustomer } = await import('../_lib/stripeCredentials.js');
    const customer = await findOrCreateStripeCustomer(stripe, {
      email: applicantEmail,
      metadata: { tenant_id: tenantData.id, form_submission_id: submission.id },
    });
    if (!customer?.id) {
      return res.status(502).json({ error: 'Could not prepare a secure Stripe customer for this membership checkout.' });
    }
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      // Membership dues are not a Managed Payments digital product. Keep this
      // session on the tenant's direct Stripe subscription integration even
      // when Managed Payments is enabled by default on the Stripe account.
      managed_payments: { enabled: false },
      customer: customer.id,
      billing_address_collection: 'required',
      customer_update: { address: 'auto' },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: offer.currency.toLowerCase(),
          unit_amount: offer.monthlyAmountMinor,
          recurring: { interval: 'month' },
          product_data: {
            name: `Membership ${quote.membership_year}`,
            description: `${offer.instalmentCount} monthly instalments`,
          },
        },
      }],
      metadata: {
        kind: CARD_PLAN_KIND,
        tenant_id: tenantData.id,
        agreement_id: prior.id,
        form_submission_id: submission.id,
        membership_year: quote.membership_year || '',
      },
      subscription_data: {
        metadata: {
          kind: CARD_PLAN_KIND,
          tenant_id: tenantData.id,
          agreement_id: prior.id,
          form_submission_id: submission.id,
          membership_year: quote.membership_year || '',
        },
      },
      success_url: withParams([
        ['form_payment_submission', submission.id],
        ['form_payment_provider', 'stripe_monthly_card'],
      ]),
      cancel_url: withParams([
        ['form_payment_submission', submission.id],
        ['form_payment_provider', 'stripe_monthly_card'],
        ['form_payment_cancelled', '1'],
      ]),
    }, { idempotencyKey: `form-card-session:${prior.id}` });
  } catch (err) {
    console.error('[form-payment] Monthly card checkout creation failed:', err);
    return res.status(502).json({ error: 'Could not start card checkout. Please try again.' });
  }
  const { error: agreementUpdateErr } = await supabase.from('membership_billing_agreements').update({
    stripe_checkout_session_id: session.id, redirect_url: session.url, updated_at: new Date().toISOString(),
  }).eq('id', prior.id);
  if (agreementUpdateErr) return res.status(500).json({ error: 'Card checkout was prepared but could not be saved. Please try again.' });
  prior = { ...prior, stripe_checkout_session_id: session.id, redirect_url: session.url };
  try {
    submission = await persistMonthlyCheckoutLink(supabase, submission, offer, prior);
  } catch (err) {
    console.error('[form-payment] Failed to persist monthly checkout link:', err);
    return res.status(500).json({ error: 'Card checkout was prepared but could not be saved. Please try again.' });
  }
  return res.json({ checkoutUrl: session.url, submissionId: submission.id });
}

async function handleCreate(req, res, supabase, tenantData) {
  const {
    form_id, provider, submission_data, idempotency_key,
    prefill_organization_id, role_id, return_path,
  } = req.body || {};

  if (!form_id) return res.status(400).json({ error: 'Form ID is required' });
  if (!provider || !['stripe', 'gocardless'].includes(provider)) {
    return res.status(400).json({ error: 'Invalid payment provider' });
  }

  const form = await loadForm(supabase, form_id, tenantData.id);
  if (!form) return res.status(404).json({ error: 'Form not found' });
  const access = await authorizePaymentStart(req, res, supabase, tenantData, form);
  if (!access) return;
  if (form.form_type === 'survey') {
    return res.status(400).json({ error: 'Payment fields are not supported on surveys' });
  }

  const paymentField = findPaymentField(form);
  if (!paymentField) return res.status(400).json({ error: 'This form has no payment field' });
  let stripeAddressMappingConfig = null;
  if (provider === 'stripe') {
    const addressConfigResult = await acceptedStripeAddressConfig(
      supabase, tenantData.id, form, paymentField,
    );
    if (!addressConfigResult.ok) {
      return res.status(400).json({
        error: addressConfigResult.error,
        code: addressConfigResult.code,
        details: addressConfigResult.details,
      });
    }
    stripeAddressMappingConfig = addressConfigResult.config;
  }

  const enabledProviders = Array.isArray(paymentField.payment_providers) ? paymentField.payment_providers : [];
  if (!enabledProviders.includes(provider)) {
    return res.status(400).json({ error: 'This payment method is not enabled for this form' });
  }
  const values = submission_data || {};

  // Conditional-logic submit control FIRST (pre-existing ordering): a
  // matched disable rule blocks STARTING a payment exactly as it blocks a
  // normal submit — before any membership resolution runs.
  const evalOptions = {};
  if (rulesUseLmicOperators(form.visibility_rules)) {
    evalOptions.lmicCodes = await loadTenantLmicCodes(supabase, tenantData.id);
  }
  const submitControl = resolveSubmitControl(form.visibility_rules, values, evalOptions);
  if (submitControl.disabled) {
    return res.status(400).json({
      error: submitControl.message || 'This form cannot be submitted with the current answers.',
      code: 'SUBMIT_DISABLED_BY_RULE',
    });
  }
  if (!await validatePaymentRelationships(
    res, supabase, tenantData, form, values, evalOptions,
  )) return;

  const resolved = await resolvePayableCharge({
    supabase, tenantData, form, paymentField, values,
    prefill_organization_id, evalOptions,
  });
  if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);
  const { membershipMeta, amount, currency } = resolved;
  const monthlyDirectDebitOffer = provider === 'gocardless'
    && membershipMeta?.quote?.target === 'member'
    ? membershipMeta.quote.direct_debit_offer || null
    : null;
  const storedPaymentProvider = monthlyDirectDebitOffer
    ? 'gocardless_monthly_dd'
    : provider;
  const storedPaymentAmount = monthlyDirectDebitOffer?.monthlyAmount ?? amount;
  const stripeFeature = membershipMeta ? 'membership' : 'forms';

  if (!membershipAllowsPaymentProvider(provider, membershipMeta)) {
    return res.status(400).json({
      error: 'Direct Debit is not available for this membership',
      code: 'MEMBERSHIP_DIRECT_DEBIT_NOT_ALLOWED',
    });
  }

  if (!(amount > 0)) {
    return res.status(400).json({ error: 'No payment is due for these answers', code: 'NO_PAYMENT_REQUIRED' });
  }
  if (provider === 'stripe' && amount < (STRIPE_MINIMUMS[currency] || 0.5)) {
    return res.status(400).json({ error: `The amount is below the minimum for card payment (${currency}).`, code: 'AMOUNT_TOO_SMALL' });
  }
  const amountMinor = Math.round(amount * 100);

  const submitterEmail = extractSubmitterEmail(form, values);
  const monthlyDirectDebitApplicantEmail = monthlyDirectDebitOffer
    ? extractMemberPipelineEmail(form, values)
    : null;
  if (monthlyDirectDebitOffer && !monthlyDirectDebitApplicantEmail) {
    return res.status(400).json({
      error: 'An email address is required to set up monthly Direct Debit membership',
      code: 'MEMBERSHIP_EMAIL_REQUIRED',
    });
  }
  const monthlyDirectDebitMeta = monthlyDirectDebitOffer ? {
    monthly_direct_debit: {
      offer: monthlyDirectDebitOffer,
      applicant_email: monthlyDirectDebitApplicantEmail,
    },
  } : {};

  // Namespaced idempotency key: never collides with a normal submit's key,
  // so an abandoned payment can still fall back to a plain submission.
  const idemKey = (typeof idempotency_key === 'string' && idempotency_key.trim())
    ? `pay:${idempotency_key.trim()}`.slice(0, 120)
    : null;

  // Reuse an existing pending row for the same key (retry / second tab).
  let submissionRow = null;
  if (idemKey) {
    const { data: existing } = await supabase
      .from('form_submission')
      .select('*')
      .eq('form_id', form.id)
      .eq('tenant_id', tenantData.id)
      .eq('idempotency_key', idemKey)
      .maybeSingle();
    if (existing) {
      if (existing.payment_status === 'paid') {
        return res.status(200).json({ alreadyPaid: true, submissionId: existing.id });
      }
      // Payment-integrity guard: once a provider payment reference exists,
      // the pending row is IMMUTABLE — refreshing the amount/answers/quote
      // under the same key could let the client pay the original provider
      // amount while fulfilment reads an overwritten quote. A same-key
      // retry must match the stored charge exactly; anything that changes
      // the charge or the membership target requires a new payment attempt
      // (fresh idempotency key).
      if (existing.payment_reference) {
        const storedMembership = existing.payment_meta?.membership || null;
        const storedDirectDebit = existing.payment_meta?.monthly_direct_debit || null;
        const sameDirectDebitTerms = !monthlyDirectDebitOffer || (
          String(storedDirectDebit?.applicant_email || '').trim().toLowerCase()
            === monthlyDirectDebitApplicantEmail
          && Number(storedDirectDebit?.offer?.monthlyAmountMinor)
            === Number(monthlyDirectDebitOffer.monthlyAmountMinor)
          && Number(storedDirectDebit?.offer?.instalmentCount)
            === Number(monthlyDirectDebitOffer.instalmentCount)
          && Number(storedDirectDebit?.offer?.planTotal)
            === Number(monthlyDirectDebitOffer.planTotal)
        );
        const sameCharge = Number(existing.payment_amount) === Number(storedPaymentAmount)
          && String(existing.payment_currency || '').toLowerCase() === String(currency || '').toLowerCase()
          && existing.payment_provider === storedPaymentProvider
          && (storedMembership?.quote?.config_id || null) === (membershipMeta?.quote?.config_id || null)
          && Number(storedMembership?.quote?.total_with_vat ?? -1) === Number(membershipMeta?.quote?.total_with_vat ?? -1)
          && sameDirectDebitTerms;
        if (!sameCharge) {
          return res.status(409).json({
            error: 'A payment for this submission is already in progress with a different amount or membership. Please start a new payment attempt.',
            code: 'PAYMENT_ALREADY_INITIATED',
          });
        }
        // Same charge: reuse the row untouched and issue fresh
        // continuation details below (provider idempotency keys are
        // derived from the submission id, so GoCardless returns the same
        // billing request; a replacement Stripe intent carries the same
        // amount and supersedes the reference).
        submissionRow = existing;
      } else {
      // Refresh the stored answers/amount so the payment reflects the
      // CURRENT form state (user may have edited values before retrying).
      const reusablePaymentMeta = { ...(existing.payment_meta || {}) };
      if (provider !== 'stripe') {
        delete reusablePaymentMeta.stripe_address_mapping_config;
        delete reusablePaymentMeta.stripe_billing_address;
      }
      const { data: refreshed, error: refreshErr } = await supabase
        .from('form_submission')
        .update({
          submission_data: {
            ...snapshotFormNotListedLabels(form.fields || [], values),
            ...(existing.submission_data?.[FORM_NOT_LISTED_LABELS_KEY]
              ? {
                  [FORM_NOT_LISTED_LABELS_KEY]: {
                    ...(snapshotFormNotListedLabels(form.fields || [], values)[FORM_NOT_LISTED_LABELS_KEY] || {}),
                    ...existing.submission_data[FORM_NOT_LISTED_LABELS_KEY],
                  },
                }
              : {}),
          },
          payment_amount: storedPaymentAmount,
          payment_currency: currency,
          payment_provider: storedPaymentProvider,
          submitted_by_email: submitterEmail,
          payment_meta: withFormPaymentAccessProof({
            ...reusablePaymentMeta,
            price_field_id: paymentField.price_field_id || null,
            prefill_organization_id: prefill_organization_id || null,
            role_id: role_id || null,
            verified_submitter_member_id: access.verifiedSubmitterMemberId || null,
            verified_admin_access: access.verifiedAdminAccess === true,
            membership: membershipMeta,
            stripe_feature: stripeFeature,
            ...(stripeAddressMappingConfig
              ? { stripe_address_mapping_config: stripeAddressMappingConfig }
              : {}),
            ...monthlyDirectDebitMeta,
          }, { accessPolicyRequired: access.restricted }),
        })
        .eq('id', existing.id)
        .eq('payment_status', 'pending')
        .select()
        .maybeSingle();
      if (refreshErr) {
        console.error('[form-payment] Failed to refresh pending row:', refreshErr);
        return res.status(500).json({ error: 'Failed to prepare payment' });
      }
      submissionRow = refreshed || existing;
      }
    }
  }

  if (!submissionRow) {
    const insertRecord = {
      form_id: form.id,
      form_name: form.name,
      tenant_id: tenantData.id,
      submission_data: snapshotFormNotListedLabels(form.fields || [], values),
      submitted_by_email: submitterEmail,
      created_date: new Date().toISOString(),
      payment_status: 'pending',
      payment_provider: storedPaymentProvider,
      payment_amount: storedPaymentAmount,
      payment_currency: currency,
      payment_meta: withFormPaymentAccessProof({
        price_field_id: paymentField.price_field_id || null,
        prefill_organization_id: prefill_organization_id || null,
        role_id: role_id || null,
        verified_submitter_member_id: access.verifiedSubmitterMemberId || null,
        verified_admin_access: access.verifiedAdminAccess === true,
        membership: membershipMeta,
        stripe_feature: stripeFeature,
        ...(stripeAddressMappingConfig
          ? { stripe_address_mapping_config: stripeAddressMappingConfig }
          : {}),
        ...monthlyDirectDebitMeta,
      }, { accessPolicyRequired: access.restricted }),
      ...(idemKey && { idempotency_key: idemKey }),
    };
    const { data: inserted, error: insertError } = await supabase
      .from('form_submission')
      .insert(insertRecord)
      .select()
      .single();
    if (insertError) {
      // Concurrent duplicate on the idempotency unique index: fetch winner.
      if (insertError.code === '23505' && idemKey) {
        const { data: winner } = await supabase
          .from('form_submission')
          .select('*')
          .eq('form_id', form.id)
          .eq('tenant_id', tenantData.id)
          .eq('idempotency_key', idemKey)
          .maybeSingle();
        if (winner) {
          submissionRow = winner;
        }
      }
      if (!submissionRow) {
        console.error('[form-payment] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to prepare payment' });
      }
    } else {
      submissionRow = inserted;
    }
  }

  const description = (paymentField.payment_label || paymentField.label || form.name || 'Form payment').slice(0, 100);

  if (provider === 'stripe') {
    const creds = await getStripeCredentials(tenantData.id, stripeFeature);
    if (!creds || creds.is_enabled === false || !creds.secret_key || !creds.publishable_key) {
      return res.status(400).json({
        error: creds?.configuration_error || 'Card payment is not configured for this organisation',
        code: 'STRIPE_CONFIGURATION_ERROR',
      });
    }
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(creds.secret_key);
    let stripeCustomer = null;
    let stripeReceiptEmail = submitterEmail || undefined;
    if (membershipMeta) {
      const { prepareRequiredStripeCustomer } = await import('../_lib/stripeCredentials.js');
      const customerResult = await prepareRequiredStripeCustomer(stripe, {
        email: submitterEmail,
        idempotencyKey: `form-membership-customer:${tenantData.id}:${submissionRow.id}`,
        metadata: {
          tenant_id: tenantData.id,
          form_submission_id: submissionRow.id,
        },
      });
      if (!customerResult.ok) {
        return res.status(customerResult.status).json({
          error: 'Could not prepare a secure Stripe customer for this membership payment.',
          code: customerResult.code,
        });
      }
      stripeCustomer = customerResult.customer;
      stripeReceiptEmail = customerResult.email || undefined;
    }

    // Same-key retry with an existing intent: REUSE it — never create a
    // second payable intent for the same submission (duplicate-charge
    // risk). Only a cancelled/failed prior intent is replaced, and it is
    // cancelled first so at most one payable intent exists at any time.
    const priorStripeReference = (submissionRow.payment_reference && submissionRow.payment_provider === 'stripe')
      ? submissionRow.payment_reference : null;
    if (priorStripeReference) {
      try {
        const prior = await inspectPriorFormStripeIntent({
          tenantId: tenantData.id,
          stripeFeature,
          paymentIntentId: priorStripeReference,
          amountMinor,
          currency,
          requireCustomer: !!membershipMeta,
        });
        if (prior.kind === 'succeeded') {
          return res.status(200).json({ alreadyPaid: true, submissionId: submissionRow.id });
        }
        if (prior.kind === 'reusable') {
          return res.status(200).json({
            provider: 'stripe',
            submissionId: submissionRow.id,
            clientSecret: prior.intent.client_secret,
            publishableKey: prior.publishableKey,
            mode: prior.publishableKey?.startsWith('pk_test_') ? 'test' : 'live',
            amount,
            currency,
            requiresBillingAddress: submissionRequiresStripeBillingAddress(submissionRow),
          });
        }
        if (prior.kind === 'blocked') {
          console.error('[form-payment] Could not cancel superseded intent', prior.intent.id, prior.error?.message);
          return res.status(409).json({ error: 'An earlier payment attempt is still open. Please try again shortly.', code: 'PAYMENT_ALREADY_INITIATED' });
        }
      } catch (err) {
        console.error('[form-payment] Failed to retrieve existing intent:', err?.message);
        return res.status(500).json({ error: 'Failed to prepare payment' });
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: currency.toLowerCase(),
      customer: stripeCustomer?.id || undefined,
      receipt_email: stripeReceiptEmail,
      description,
      metadata: {
        type: 'form_payment',
        form_submission_id: String(submissionRow.id),
        form_id: String(form.id),
        tenant_id: String(tenantData.id),
      },
    });
    // Atomic publication: the reference update is conditional on the row
    // still carrying the reference we started from (null for a fresh row,
    // the superseded id after a cancel). Under a concurrent same-key race
    // exactly one request wins this CAS; the loser cancels its own intent
    // before responding and returns the winner's, so at most one payable
    // intent ever exists per submission.
    let claimQuery = supabase
      .from('form_submission')
      .update({ payment_reference: paymentIntent.id })
      .eq('id', submissionRow.id)
      .eq('payment_status', 'pending');
    claimQuery = priorStripeReference
      ? claimQuery.eq('payment_reference', priorStripeReference)
      : claimQuery.is('payment_reference', null);
    const { data: claimedRow, error: claimError } = await claimQuery.select('id').maybeSingle();
    if (claimError || !claimedRow) {
      // Lost the race (or row left pending): our intent must never be paid.
      try { await stripe.paymentIntents.cancel(paymentIntent.id); }
      catch (cancelErr) { console.error('[form-payment] Failed to cancel losing intent', paymentIntent.id, cancelErr?.message); }
      if (claimError) {
        console.error('[form-payment] Intent claim failed:', claimError);
        return res.status(500).json({ error: 'Failed to prepare payment' });
      }
      // Return the winner's intent if it is compatible.
      const { data: winnerRow } = await supabase
        .from('form_submission')
        .select('payment_reference, payment_status')
        .eq('id', submissionRow.id)
        .maybeSingle();
      if (winnerRow?.payment_status === 'paid') {
        return res.status(200).json({ alreadyPaid: true, submissionId: submissionRow.id });
      }
      if (winnerRow?.payment_reference) {
        try {
          const winnerIntent = await stripe.paymentIntents.retrieve(winnerRow.payment_reference);
          if (winnerIntent && winnerIntent.amount === amountMinor
              && winnerIntent.currency === currency.toLowerCase()
              && ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(winnerIntent.status)) {
            return res.status(200).json({
              provider: 'stripe',
              submissionId: submissionRow.id,
              clientSecret: winnerIntent.client_secret,
              publishableKey: creds.publishable_key,
              mode: creds.mode,
              amount,
              currency,
              requiresBillingAddress: submissionRequiresStripeBillingAddress(submissionRow),
            });
          }
        } catch { /* fall through */ }
      }
      return res.status(409).json({ error: 'A payment for this submission is already in progress. Please try again.', code: 'PAYMENT_ALREADY_INITIATED' });
    }
    return res.status(200).json({
      provider: 'stripe',
      submissionId: submissionRow.id,
      clientSecret: paymentIntent.client_secret,
      publishableKey: creds.publishable_key,
      mode: creds.mode,
      amount,
      currency,
      requiresBillingAddress: submissionRequiresStripeBillingAddress(submissionRow),
    });
  }

  // GoCardless: billing request (mandate + one-off payment) + hosted flow.
  const gc = await gocardlessForTenant(tenantData.id);
  if (!gc.isConfigured()) {
    return res.status(400).json({ error: 'Direct Debit is not configured for this organisation' });
  }
  if (monthlyDirectDebitOffer) {
    return handleCreateMonthlyDirectDebit({
      req,
      res,
      supabase,
      tenantData,
      form,
      submissionRow,
      membershipMeta,
      offer: monthlyDirectDebitOffer,
      applicantEmail: monthlyDirectDebitApplicantEmail,
      returnPath: return_path,
      gc,
    });
  }
  const trustedBase = getTenantTrustedBaseUrl(req, tenantData);
  const returnPath = sanitizeReturnPath(return_path);
  const sep = returnPath.includes('?') ? '&' : '?';
  const redirectUri = `${trustedBase}${returnPath}${sep}form_payment_submission=${encodeURIComponent(submissionRow.id)}&form_payment_provider=gocardless`;
  const exitUri = `${trustedBase}${returnPath}${sep}form_payment_cancelled=1`;

  const billingRequest = await gc.createBillingRequest({
    idempotencyKey: buildIdempotencyKey('form-payment-br', submissionRow.id),
    currency,
    paymentAmountMinor: amountMinor,
    paymentDescription: description,
    metadata: {
      type: 'form_payment',
      tenant_id: String(tenantData.id),
      form_submission_id: String(submissionRow.id),
    },
  });
  const flow = await gc.createBillingRequestFlow({
    billingRequestId: billingRequest.id,
    redirectUri,
    exitUri,
    idempotencyKey: buildIdempotencyKey('form-payment-flow', submissionRow.id),
  });
  await supabase
    .from('form_submission')
    .update({
      payment_reference: billingRequest.id,
      payment_meta: {
        ...(submissionRow.payment_meta || {}),
        price_field_id: paymentField.price_field_id || null,
        prefill_organization_id: prefill_organization_id || null,
        role_id: role_id || null,
        membership: membershipMeta,
        gc_flow_id: flow.id || null,
      },
    })
    .eq('id', submissionRow.id)
    .eq('payment_status', 'pending');

  return res.status(200).json({
    provider: 'gocardless',
    submissionId: submissionRow.id,
    authorisationUrl: flow.authorisation_url,
    flowId: flow.id || null,
    environment: gc.getGocardlessEnvironment(),
    amount,
    currency,
  });
}

async function handleCreateMonthlyDirectDebit({
  req,
  res,
  supabase,
  tenantData,
  form,
  submissionRow,
  membershipMeta,
  offer,
  applicantEmail,
  returnPath,
  gc,
}) {
  const quote = membershipMeta?.quote;
  if (!quote || quote.target !== 'member' || !offer) {
    return res.status(400).json({
      error: 'Monthly Direct Debit is not available for this membership',
      code: 'MEMBERSHIP_DIRECT_DEBIT_NOT_ALLOWED',
    });
  }
  if (submissionRow.payment_provider !== 'gocardless_monthly_dd'
      || submissionRow.payment_status !== 'pending') {
    return res.status(409).json({
      error: 'This submission already has a different payment in progress',
      code: 'PAYMENT_ALREADY_INITIATED',
    });
  }

  const snapshot = {
    ...buildAgreementSnapshot({
      offer,
      simResult: {
        membershipYear: {
          label: quote.membership_year,
          start: quote.membership_year_start,
        },
        config: { id: quote.config_id },
        matchedBand: quote.band_id ? { id: quote.band_id } : null,
        tierLabel: quote.tier_label,
        fieldValue: quote.field_value,
        annualCost: quote.annual_cost,
        finalCost: quote.final_cost,
      },
      includeBillingRequestPayment: false,
      billingRequestMode: 'mandate_only',
    }),
    vat_rate_percent: quote.vat_rate_percent ?? null,
    vat_amount: quote.vat_amount ?? 0,
    total_with_vat: quote.total_with_vat ?? quote.final_cost,
  };
  const agreementKey = formMonthlyDirectDebitApplicantAgreementKey({
    tenantId: tenantData.id,
    email: applicantEmail,
    membershipYear: quote.membership_year,
  });
  const replacementKey = monthlyConsentReplacementKey(agreementKey);

  const { data: replacementAgreement, error: replacementError } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('tenant_id', tenantData.id)
    .eq('idempotency_key', replacementKey)
    .maybeSingle();
  if (replacementError) {
    console.error('[form-payment] Monthly-DD replacement agreement lookup failed:', replacementError.message);
    return res.status(500).json({ error: 'Failed to prepare Direct Debit set-up' });
  }

  let agreement = replacementAgreement || null;
  if (!agreement) {
    const claim = await claimFormMonthlyDirectDebitApplicantAgreement(supabase, {
      tenantId: tenantData.id,
      submissionId: submissionRow.id,
      applicantEmail,
      membershipYear: quote.membership_year,
      agreementKey,
      environment: gc.getGocardlessEnvironment(),
      ddSnapshot: snapshot,
    });
    if (claim.error) {
      console.error('[form-payment] Monthly-DD applicant agreement claim failed:', claim.error.message);
      return res.status(500).json({ error: 'Failed to prepare Direct Debit set-up' });
    }
    agreement = claim.data;
  }

  if (agreement.metadata?.form_submission_id !== String(submissionRow.id)) {
    return res.status(409).json({
      error: 'A monthly Direct Debit membership set-up is already in progress for this email and membership year.',
      code: 'MEMBERSHIP_PAYMENT_IN_PROGRESS',
    });
  }

  let consent = classifyMonthlyConsentAgreement(agreement);
  if (consent.rotatable) {
    try {
      agreement = await rotateStaleMonthlyConsentAgreement({
        db: supabase,
        agreement,
        replacementIdempotencyKey: replacementKey,
        snapshot,
        gc,
      });
      consent = classifyMonthlyConsentAgreement(agreement);
    } catch (error) {
      console.error('[form-payment] Monthly-DD stale consent rotation failed:', error.message);
      return res.status(500).json({
        error: 'Could not safely renew the Direct Debit set-up. Please try again.',
      });
    }
  }
  const savedFingerprint = monthlyBillingRequestFingerprint(agreement.metadata?.dd || {});
  const currentFingerprint = monthlyBillingRequestFingerprint(snapshot);
  if (savedFingerprint !== currentFingerprint) {
    if (consent.kind !== 'current_unstarted') {
      return res.status(409).json({
        error: 'This Direct Debit set-up was prepared with different membership terms. Please start a new payment attempt.',
        code: 'PAYMENT_ALREADY_INITIATED',
      });
    }
    const { data: refreshedAgreement, error: refreshError } = await supabase
      .from('membership_billing_agreements')
      .update({
        metadata: {
          ...(agreement.metadata || {}),
          dd: snapshot,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', agreement.id)
      .eq('status', 'payment_setup_required')
      .is('gocardless_billing_request_id', null)
      .select()
      .maybeSingle();
    if (refreshError || !refreshedAgreement) {
      return res.status(409).json({
        error: 'The membership terms changed while Direct Debit was being prepared. Please start a new payment attempt.',
        code: 'PAYMENT_ALREADY_INITIATED',
      });
    }
    agreement = refreshedAgreement;
    consent = classifyMonthlyConsentAgreement(agreement);
  }

  if (consent.resumable) {
    try {
      submissionRow = await persistMonthlyDirectDebitLink(
        supabase,
        submissionRow,
        offer,
        agreement,
      );
    } catch (error) {
      console.error('[form-payment] Monthly-DD continuation repair failed:', error.message);
      return res.status(500).json({
        error: 'Direct Debit set-up was prepared but could not be linked. Please try again.',
      });
    }
    return res.status(200).json({
      provider: 'gocardless',
      submissionId: submissionRow.id,
      authorisationUrl: agreement.redirect_url,
      flowId: agreement.gocardless_billing_request_flow_id,
      environment: agreement.environment || gc.getGocardlessEnvironment(),
      amount: offer.monthlyAmount,
      currency: offer.currency,
      directDebit: offer,
      resumed: true,
    });
  }

  if (consent.kind !== 'current_unstarted') {
    return res.status(409).json({
      error: 'This monthly Direct Debit membership set-up has already progressed and cannot be restarted.',
      code: 'PAYMENT_ALREADY_INITIATED',
    });
  }

  const trustedBase = getTenantTrustedBaseUrl(req, tenantData);
  const safeReturnPath = sanitizeReturnPath(returnPath);
  const withParams = (entries) => {
    const url = new URL(safeReturnPath, trustedBase);
    for (const [key, value] of entries) url.searchParams.set(key, value);
    return url.toString();
  };

  let billingRequest;
  let flow;
  try {
    billingRequest = await gc.createBillingRequest({
      idempotencyKey: buildIdempotencyKey(
        'form-monthly-dd-br',
        tenantData.id,
        agreement.id,
        quote.membership_year,
        monthlyBillingRequestFingerprint(snapshot),
      ),
      ...buildMonthlyBillingRequest({
        snapshot,
        metadata: {
          type: 'form_monthly_direct_debit',
          agreement_id: String(agreement.id),
          form_submission_id: String(submissionRow.id),
        },
      }),
    });
    flow = await gc.createBillingRequestFlow({
      billingRequestId: billingRequest.id,
      redirectUri: withParams([
        ['form_payment_submission', submissionRow.id],
        ['form_payment_provider', 'gocardless_monthly_dd'],
      ]),
      exitUri: withParams([
        ['form_payment_submission', submissionRow.id],
        ['form_payment_provider', 'gocardless_monthly_dd'],
        ['form_payment_cancelled', '1'],
      ]),
      prefilledCustomer: {
        email: applicantEmail,
      },
      idempotencyKey: buildIdempotencyKey(
        'form-monthly-dd-flow',
        agreement.id,
        billingRequest.id,
      ),
    });
    agreement = await attachMonthlyConsentFlow({
      db: supabase,
      agreement,
      billingRequest,
      flow,
    });
    submissionRow = await persistMonthlyDirectDebitLink(
      supabase,
      submissionRow,
      offer,
      agreement,
    );
  } catch (error) {
    console.error('[form-payment] Monthly-DD Billing Request creation failed:', error);
    return res.status(502).json({
      error: 'Could not start Direct Debit set-up. Please try again.',
    });
  }

  return res.status(200).json({
    provider: 'gocardless',
    submissionId: submissionRow.id,
    authorisationUrl: agreement.redirect_url,
    flowId: agreement.gocardless_billing_request_flow_id,
    environment: agreement.environment || gc.getGocardlessEnvironment(),
    amount: offer.monthlyAmount,
    currency: offer.currency,
    directDebit: offer,
  });
}

async function handleConfirm(req, res, supabase, tenantData) {
  const { submission_id, payment_intent_id } = req.body || {};
  if (!submission_id) return res.status(400).json({ error: 'submission_id is required' });

  let { data: row, error: rowErr } = await supabase
    .from('form_submission')
    .select('*')
    .eq('id', submission_id)
    .eq('tenant_id', tenantData.id)
    .maybeSingle();
  if (rowErr || !row) return res.status(404).json({ error: 'Submission not found' });
  if (!row.payment_provider || !row.payment_status) {
    return res.status(400).json({ error: 'This submission has no payment attached' });
  }

  const form = await loadFormForFinalize(supabase, row.form_id, tenantData.id);
  const baseUrl = getTenantTrustedBaseUrl(req, tenantData);

  // A pending payment carries a server-written proof that access was granted
  // before money was taken. Do not revoke finalisation if membership changes
  // while the provider is completing. Legacy rows without that proof are
  // checked against the live policy and fail closed.
  if (!row.payment_meta?.access_authorized_at) {
    if (!form) return res.status(404).json({ error: 'Form not found' });
    const access = await authorizePaymentStart(req, res, supabase, tenantData, form);
    if (!access) return;
    const paymentMeta = withFormPaymentAccessProof({
      ...(row.payment_meta || {}),
      verified_submitter_member_id: access.verifiedSubmitterMemberId || null,
      verified_admin_access: access.verifiedAdminAccess === true,
    }, {
      accessPolicyRequired: access.restricted,
    });
    let authorizedMeta;
    try {
      authorizedMeta = await patchFormSubmissionPaymentMeta({
        db: supabase,
        tenantId: tenantData.id,
        submissionId: row.id,
        patch: {
          access_authorized_at: paymentMeta.access_authorized_at,
          access_policy_required: paymentMeta.access_policy_required,
          verified_submitter_member_id: paymentMeta.verified_submitter_member_id,
          verified_admin_access: paymentMeta.verified_admin_access,
        },
      });
    } catch (authorizationError) {
      console.error('[form-payment] Failed to persist live access authorization:', authorizationError);
      return res.status(500).json({
        error: 'Payment access was confirmed but could not be recorded. Please try confirming again.',
      });
    }
    row = { ...row, payment_meta: authorizedMeta };
  }

  if (row.payment_status === 'paid') {
    // Idempotent: ensure finalisation ran (e.g. earlier confirm crashed
    // between CAS and side effects).
    const needsStripeAddress = row.payment_provider === 'stripe' && (
      !!row.payment_meta?.membership
      || row.payment_meta?.stripe_address_mapping_config?.mappings?.length > 0
    );
    if (needsStripeAddress && !row.payment_meta?.stripe_billing_address) {
      try {
        const stripeFeature = row.payment_meta?.stripe_feature
          || (row.payment_meta?.membership ? 'membership' : 'forms');
        const found = await retrieveTenantPaymentIntent(
          tenantData.id, stripeFeature, row.payment_reference,
        );
        const intent = found?.paymentIntent;
        const metadataMatches = intent?.metadata?.type === 'form_payment'
          && intent.metadata.form_submission_id === String(row.id)
          && intent.metadata.tenant_id === String(tenantData.id);
        if (!found || intent.status !== 'succeeded'
            || (!metadataMatches && intent.id !== row.payment_reference)) {
          throw new Error('The verified Stripe payment could not be reloaded');
        }
        const address = await capturePaymentIntentBillingAddress({
          stripe: found.stripe,
          paymentIntent: intent,
          requireCustomer: !!row.payment_meta?.membership,
        });
        const savedMeta = await patchFormSubmissionPaymentMeta({
          db: supabase,
          tenantId: tenantData.id,
          submissionId: row.id,
          patch: { stripe_billing_address: address },
        });
        row = { ...row, payment_meta: savedMeta };
      } catch (addressErr) {
        return res.status(503).json({
          error: 'Your payment succeeded, but Stripe billing address details are still being recovered. We will retry automatically; please do not pay again.',
          paymentSucceeded: true,
          retryable: true,
          code: addressErr.code || 'STRIPE_BILLING_ADDRESS_REQUIRED',
        });
      }
    }
    if (form) await finalizeFormSubmission({ supabase, submission: row, form, baseUrl });
    try {
      await retryPersistedStripeAddressMappings({
        db: supabase,
        submissionId: row.id,
        tenantId: tenantData.id,
      });
    } catch (addressErr) {
      return res.status(503).json({
        error: 'Your payment succeeded, but its billing address updates are still being completed. We will retry automatically; please do not pay again.',
        paymentSucceeded: true,
        retryable: true,
        code: addressErr.code || 'STRIPE_ADDRESS_MAPPING_RETRY',
      });
    }
    return res.status(200).json({ success: true, submissionId: row.id, status: 'paid' });
  }
  const resumableMonthlySetup = ['stripe_monthly_card', 'gocardless_monthly_dd'].includes(row.payment_provider)
    && row.payment_status === 'setup_complete';
  if (row.payment_status !== 'pending' && !resumableMonthlySetup) {
    return res.status(400).json({ error: 'This payment is no longer pending' });
  }

  if (row.payment_provider === 'gocardless_monthly_dd') {
    const agreementId = row.payment_meta?.monthly_direct_debit?.agreement_id || null;
    const { data: agreement, error: agreementError } = await findFormMonthlyDirectDebitAgreement(
      supabase,
      {
        tenantId: tenantData.id,
        submissionId: row.id,
        agreementId,
      },
    );
    const billingRequestId = row.payment_reference
      || row.payment_meta?.monthly_direct_debit?.billing_request_id
      || agreement?.gocardless_billing_request_id
      || null;
    if (agreementError || !agreement
        || agreement.metadata?.form_submission_id !== String(row.id)
        || !billingRequestId
        || (agreement.gocardless_billing_request_id
          && agreement.gocardless_billing_request_id !== billingRequestId)) {
      return res.status(400).json({
        error: 'Direct Debit request does not match this submission',
      });
    }
    const gc = await gocardlessForTenant(tenantData.id);
    if (!gc.isConfigured()) {
      return res.status(400).json({ error: 'Direct Debit is not configured' });
    }
    const billingRequest = await gc.getBillingRequest(billingRequestId);
    const billingRequestMeta = billingRequest?.metadata || {};
    if (billingRequestMeta.type !== 'form_monthly_direct_debit'
        || billingRequestMeta.form_submission_id !== String(row.id)
        || billingRequestMeta.agreement_id !== String(agreement.id)) {
      return res.status(400).json({
        error: 'Direct Debit request does not match this submission',
      });
    }
    if (billingRequest.status === 'fulfilled') {
      const outcome = await processGocardlessEvent({
        id: `form-confirm-${billingRequest.id}`,
        resource_type: 'billing_requests',
        action: 'fulfilled',
        links: {
          billing_request: billingRequest.id,
          mandate_request_mandate: billingRequest.links?.mandate_request_mandate || null,
          customer: billingRequest.links?.customer || null,
          payment_request_payment: billingRequest.links?.payment_request_payment || null,
        },
      }, {
        db: supabase,
        gc,
        baseUrl,
      });
      if (outcome.conflict) {
        return res.status(409).json(monthlyConfirmLifecycle({
          provider: 'gocardless',
          stage: 'blocked',
          submissionId: row.id,
          detail: outcome.detail || 'Membership for this year is already recorded.',
          code: outcome.code || 'MEMBERSHIP_YEAR_CONFLICT',
        }));
      }
      if (outcome.blocked) {
        return res.status(409).json(monthlyConfirmLifecycle({
          provider: 'gocardless',
          stage: 'blocked',
          submissionId: row.id,
          detail: outcome.detail || 'The Direct Debit membership could not be finalized.',
          code: outcome.code || 'MEMBERSHIP_SETUP_BLOCKED',
        }));
      }
      if (!outcome.handled || outcome.retryable) {
        return res.status(200).json(monthlyConfirmLifecycle({
          provider: 'gocardless',
          stage: 'finalizing',
          submissionId: row.id,
          detail: outcome.detail,
        }));
      }
      return res.status(200).json(monthlyConfirmLifecycle({
        provider: 'gocardless',
        stage: 'setup_complete',
        submissionId: row.id,
      }));
    }
    if (billingRequest.status === 'cancelled' || billingRequest.status === 'failed') {
      await supabase
        .from('form_submission')
        .update({ payment_status: 'failed' })
        .eq('id', row.id)
        .in('payment_status', ['pending', 'setup_complete']);
      await supabase
        .from('membership_billing_agreements')
        .update({
          needs_attention: true,
          attention_reason: `Form Billing Request ${billingRequest.status}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', agreement.id);
      return res.status(400).json({
        error: 'The Direct Debit set-up was not completed',
        code: 'PAYMENT_FAILED',
      });
    }
    return res.status(200).json(monthlyConfirmLifecycle({
      provider: 'gocardless',
      stage: 'pending',
      submissionId: row.id,
    }));
  }

  if (row.payment_provider === 'stripe_monthly_card') {
    const agreementId = row.payment_meta?.monthly_card?.agreement_id || null;
    const { data: agreement, error: agreementErr } = await findFormMonthlyCardAgreement(supabase, {
      tenantId: tenantData.id,
      submissionId: row.id,
      agreementId,
    });
    const checkoutSessionId = row.payment_meta?.monthly_card?.checkout_session_id
      || agreement?.stripe_checkout_session_id
      || null;
    if (agreementErr || !agreement
        || agreement.metadata?.form_submission_id !== String(row.id)
        || !checkoutSessionId
        || (agreement.stripe_checkout_session_id
          && agreement.stripe_checkout_session_id !== checkoutSessionId)) {
      return res.status(409).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'blocked',
        submissionId: row.id,
        code: 'PROVIDER_OWNERSHIP_MISMATCH',
      }));
    }
    if (row.payment_status === 'pending'
        && (!agreementId || !row.payment_meta?.monthly_card?.checkout_session_id)) {
      try {
        await persistMonthlyCheckoutLink(
          supabase,
          row,
          row.payment_meta?.monthly_card?.offer || agreement.metadata?.card || {},
          agreement,
        );
      } catch (err) {
        console.error('[form-payment] Failed to repair monthly checkout link during confirm:', err);
        return res.status(503).json(monthlyConfirmLifecycle({
          provider: 'stripe',
          stage: 'finalizing',
          submissionId: row.id,
        }));
      }
    }
    let allCreds;
    try {
      allCreds = await getStripeIntegrationCredentials(tenantData.id);
    } catch {
      return res.status(503).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'finalizing',
        submissionId: row.id,
      }));
    }
    const keys = [...new Set([allCreds?.secret_key, allCreds?.test_secret_key].filter(Boolean))];
    if (keys.length === 0) {
      return res.status(409).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'blocked',
        submissionId: row.id,
        code: 'STRIPE_CONFIGURATION_ERROR',
      }));
    }
    const Stripe = (await import('stripe')).default;
    let session = null;
    let stripeForSession = null;
    for (const key of keys) {
      const stripe = new Stripe(key);
      try {
        session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
          expand: ['subscription.latest_invoice'],
        });
        stripeForSession = stripe;
        break;
      } catch (err) {
        const missing = err?.code === 'resource_missing' || err?.statusCode === 404;
        if (!missing) {
          return res.status(503).json(monthlyConfirmLifecycle({
            provider: 'stripe',
            stage: 'finalizing',
            submissionId: row.id,
          }));
        }
      }
    }
    if (!session) {
      return res.status(409).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'blocked',
        submissionId: row.id,
        code: 'CHECKOUT_NOT_FOUND',
      }));
    }
    const expectedLiveMode = agreement.environment === 'live';
    const sessionIdentityMatches = session.mode === 'subscription'
      && session.metadata?.kind === CARD_PLAN_KIND
      && session.metadata?.tenant_id === String(tenantData.id)
      && session.metadata?.agreement_id === String(agreement.id)
      && session.metadata?.form_submission_id === String(row.id);
    if (!sessionIdentityMatches || session.livemode !== expectedLiveMode) {
      return res.status(409).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'blocked',
        submissionId: row.id,
        detail: 'The verified Stripe checkout identity or mode does not match this membership submission.',
        code: 'PROVIDER_OWNERSHIP_MISMATCH',
      }));
    }
    const latestInvoice = typeof session.subscription?.latest_invoice === 'object'
      ? session.subscription.latest_invoice
      : null;
    const paymentVerified = verifiedStripeMonthlyCollection({
      session,
      invoice: latestInvoice,
      tenantId: tenantData.id,
      agreementId: agreement.id,
      submissionId: row.id,
      environment: agreement.environment,
    });

    // Checkout completion initializes the finite monthly plan. Address
    // mapping itself remains gated by the verified paid-invoice ledger in
    // processPersistedStripeAddressMappings.
    if (session.status === 'expired') {
      return res.status(409).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'blocked',
        submissionId: row.id,
        code: 'CHECKOUT_EXPIRED',
      }));
    }
    if (session.status !== 'complete' || !session.subscription) {
      return res.status(200).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'pending',
        submissionId: row.id,
        paymentVerified,
      }));
    }
    let outcome;
    try {
      outcome = await processStripeCardPlanEvent({
        id: `form-confirm-${session.id}`,
        type: 'checkout.session.completed',
        data: { object: session },
      }, {
        db: supabase,
        getStripe: async () => stripeForSession,
        baseUrl,
      });
    } catch {
      return res.status(503).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'finalizing',
        submissionId: row.id,
        paymentVerified,
      }));
    }
    if (outcome.retryable) {
      return res.status(200).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'finalizing',
        submissionId: row.id,
        paymentVerified,
        detail: outcome.detail,
      }));
    }
    if (outcome.conflict) {
      return res.status(409).json({
        ...monthlyConfirmLifecycle({
          provider: 'stripe',
          stage: 'blocked',
          submissionId: row.id,
          paymentVerified,
          detail: outcome.detail || 'Membership for this year is already recorded.',
          code: outcome.code || 'MEMBERSHIP_YEAR_CONFLICT',
        }),
        refunded: outcome.refunded === true,
      });
    }
    if (!outcome.handled || outcome.blocked) {
      return res.status(409).json(monthlyConfirmLifecycle({
        provider: 'stripe',
        stage: 'blocked',
        submissionId: row.id,
        paymentVerified,
        detail: outcome.detail || 'Monthly card set-up could not be completed.',
        code: outcome.code,
      }));
    }
    try {
      await retryPersistedStripeAddressMappings({
        db: supabase,
        submissionId: row.id,
        tenantId: tenantData.id,
      });
    } catch (addressErr) {
      const stage = paymentVerified ? 'accounting_pending' : 'finalizing';
      return res.status(503).json({
        ...monthlyConfirmLifecycle({
          provider: 'stripe',
          stage,
          submissionId: row.id,
          paymentVerified,
          detail: paymentVerified
            ? 'Your first card payment was verified, but its billing address updates are still being completed. Please do not pay again.'
            : 'Your card setup completed, but its billing address updates are still being completed.',
        }),
        code: addressErr.code || 'STRIPE_ADDRESS_MAPPING_RETRY',
        retryable: true,
      });
    }
    let accountingPending = false;
    if (paymentVerified && agreement.metadata?.card?.invoicing_mode === 'per_instalment') {
      const { data: accountingRow, error: accountingError } = await supabase
        .from('membership_instalment_invoices')
        .select('accounting_sync_status')
        .eq('tenant_id', tenantData.id)
        .eq('billing_agreement_id', agreement.id)
        .eq('external_payment_id', latestInvoice.id)
        .maybeSingle();
      accountingPending = !!accountingError
        || !accountingRow
        || accountingRow.accounting_sync_status !== 'posted';
    }
    const stage = accountingPending
      ? 'accounting_pending'
      : (paymentVerified ? 'paid' : 'setup_complete');
    return res.status(200).json(monthlyConfirmLifecycle({
      provider: 'stripe',
      stage,
      submissionId: row.id,
      paymentVerified,
    }));
  }

  if (row.payment_provider === 'stripe') {
    const piId = payment_intent_id || row.payment_reference;
    if (!piId) return res.status(400).json({ error: 'payment_intent_id is required' });
    const stripeFeature = row.payment_meta?.stripe_feature
      || (row.payment_meta?.membership ? 'membership' : 'forms');
    const found = await retrieveTenantPaymentIntent(tenantData.id, stripeFeature, piId);
    if (!found) return res.status(400).json({ error: 'Card payment is not configured' });
    const pi = found.paymentIntent;
    const metadataMatches = pi.metadata?.type === 'form_payment'
      && pi.metadata?.form_submission_id === String(row.id)
      && pi.metadata?.tenant_id === String(tenantData.id);
    const storedMatches = row.payment_reference && row.payment_reference === pi.id;
    if (!metadataMatches && !storedMatches) {
      return res.status(400).json({ error: 'Payment does not match this submission' });
    }
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment has not completed (status: ${pi.status})`, code: 'PAYMENT_NOT_SUCCEEDED' });
    }
    const expectedMinor = Math.round(Number(row.payment_amount || 0) * 100);
    const receivedMinor = pi.amount_received ?? pi.amount;
    if (expectedMinor > 0 && receivedMinor < expectedMinor) {
      return res.status(400).json({ error: 'Payment amount does not match the amount due' });
    }
    if (row.payment_currency && pi.currency && pi.currency.toUpperCase() !== row.payment_currency.toUpperCase()) {
      return res.status(400).json({ error: 'Payment currency does not match' });
    }
    const { updated, row: paidRow } = await markFormSubmissionPaid(supabase, row.id, {
      amount: receivedMinor != null ? receivedMinor / 100 : null,
      reference: pi.id,
    });
    // The charge is authoritative before any address retrieval/write. A
    // provider or database failure below must therefore remain recoverable
    // without ever asking the submitter to pay a second time.
    row = paidRow || { ...row, payment_status: 'paid', payment_reference: pi.id };
    const needsStripeAddress = !!row.payment_meta?.membership
      || (row.payment_meta?.stripe_address_mapping_config?.mappings?.length > 0);
    if (needsStripeAddress && !row.payment_meta?.stripe_billing_address) {
      let stripeBillingAddress;
      try {
        stripeBillingAddress = await capturePaymentIntentBillingAddress({
          stripe: found.stripe,
          paymentIntent: pi,
          requireCustomer: !!row.payment_meta?.membership,
        });
      } catch (addressErr) {
        return res.status(503).json({
          error: 'Your payment succeeded, but Stripe billing address details could not be verified. We will retry automatically; please do not pay again.',
          paymentSucceeded: true,
          retryable: true,
          code: addressErr.code || 'STRIPE_BILLING_ADDRESS_REQUIRED',
        });
      }
      let savedMeta;
      try {
        savedMeta = await patchFormSubmissionPaymentMeta({
          db: supabase,
          tenantId: tenantData.id,
          submissionId: row.id,
          patch: { stripe_billing_address: stripeBillingAddress },
        });
      } catch {
        return res.status(503).json({
          error: 'Your payment succeeded, but its billing address could not be saved. We will retry automatically; please do not pay again.',
          paymentSucceeded: true,
          retryable: true,
        });
      }
      row = { ...row, payment_meta: savedMeta };
    }
    const finalRow = row;
    if (form) await finalizeFormSubmission({ supabase, submission: finalRow, form, baseUrl });
    try {
      await retryPersistedStripeAddressMappings({
        db: supabase,
        submissionId: row.id,
        tenantId: tenantData.id,
      });
    } catch (addressErr) {
      return res.status(503).json({
        error: 'Your payment succeeded, but its billing address updates are still being completed. We will retry automatically; please do not pay again.',
        paymentSucceeded: true,
        retryable: true,
        code: addressErr.code || 'STRIPE_ADDRESS_MAPPING_RETRY',
      });
    }
    return res.status(200).json({ success: true, submissionId: row.id, status: 'paid', reconciled: !updated });
  }

  // GoCardless: verify the billing request server-side.
  const gc = await gocardlessForTenant(tenantData.id);
  if (!gc.isConfigured()) return res.status(400).json({ error: 'Direct Debit is not configured' });
  if (!row.payment_reference) return res.status(400).json({ error: 'No Direct Debit request found for this submission' });
  const br = await gc.getBillingRequest(row.payment_reference);
  const brMeta = br?.metadata || {};
  if (brMeta.type !== 'form_payment' || brMeta.form_submission_id !== String(row.id)) {
    return res.status(400).json({ error: 'Direct Debit request does not match this submission' });
  }
  if (br.status === 'fulfilled') {
    const { row: paidRow } = await markFormSubmissionPaid(supabase, row.id, { reference: br.id });
    const finalRow = paidRow || { ...row, payment_status: 'paid' };
    if (form) await finalizeFormSubmission({ supabase, submission: finalRow, form, baseUrl });
    return res.status(200).json({ success: true, submissionId: row.id, status: 'paid' });
  }
  if (br.status === 'cancelled' || br.status === 'failed') {
    await supabase
      .from('form_submission')
      .update({ payment_status: 'failed' })
      .eq('id', row.id)
      .eq('payment_status', 'pending');
    return res.status(400).json({ error: 'The Direct Debit set-up was not completed', code: 'PAYMENT_FAILED' });
  }
  return res.status(200).json({ success: false, pending: true, submissionId: row.id, status: br.status });
}

async function loadFormForFinalize(supabase, formId, tenantId) {
  const { data: form } = await supabase
    .from('form')
    .select(FORM_COLUMNS)
    .eq('id', formId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return form || null;
}
