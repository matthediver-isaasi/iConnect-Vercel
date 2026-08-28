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
  findFormMonthlyCardAgreement,
  findExistingFormApplicantMember,
  formMonthlyCardApplicantAgreementKey,
  persistMonthlyCheckoutLink,
  releaseExpiredFormMonthlyCardCheckout,
} from '../_lib/formMonthlyCardCheckout.js';
import { resolveFormAccess, sendFormAccessDenied } from '../_lib/formAccessPolicy.js';
import { withFormPaymentAccessProof } from '../_lib/formPaymentAccess.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { createFormRelationshipService, FormRelationshipError } from '../_lib/formRelationshipOptions.js';
import { validateFormOrganisationGroupAnswers } from '../_lib/formOrganisationGroups.js';

const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

const FORM_COLUMNS = 'id, name, tenant_id, require_authentication, access_policy, fields, pages, visibility_rules, entity_pipelines, field_mappings, application_level, deactivate_at, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type';

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
  return access;
}

async function validatePaymentRelationships(res, supabase, tenantData, form, values) {
  try {
    const service = createFormRelationshipService({
      db: supabase,
      tenantId: tenantData.id,
    });
    await service.validateSubmission({ form, submissionData: values });
    await validateFormOrganisationGroupAnswers({
      db: supabase,
      tenantId: tenantData.id,
      fields: form.fields || [],
      submissionData: values,
    });
    return true;
  } catch (error) {
    if (error instanceof FormRelationshipError && error.status < 500) {
      res.status(400).json({ error: 'Invalid relationship selection' });
      return false;
    }
    if (error?.code === 'INVALID_ORGANISATION_GROUP') {
      res.status(400).json({ error: 'Invalid organisation group selection' });
      return false;
    }
    console.error('[form-payment] Relationship validation failed:', error);
    res.status(500).json({ error: 'Failed to validate relationship selections' });
    return false;
  }
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

  const resolved = await resolvePayableCharge({
    supabase, tenantData, form, paymentField,
    values: submission_data || {},
    prefill_organization_id,
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
  return res.status(200).json({
    required: true,
    amount,
    currency,
    membership: membershipMeta ? {
      config_name: membershipMeta.quote.config_name || null,
      membership_year: membershipMeta.quote.membership_year || null,
      tier_label: membershipMeta.quote.tier_label || null,
      monthly_card: monthlyCard,
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
  const enabledProviders = Array.isArray(paymentField.payment_providers) ? paymentField.payment_providers : [];
  if (!enabledProviders.includes('stripe')) {
    return res.status(400).json({ error: 'Monthly card payment is not enabled for this form' });
  }
  const values = submission_data || {};
  const evalOptions = rulesUseLmicOperators(form.visibility_rules)
    ? { lmicCodes: await loadTenantLmicCodes(supabase, tenantData.id) } : {};
  const submitControl = resolveSubmitControl(form.visibility_rules, values, evalOptions);
  if (submitControl.disabled) return res.status(400).json({ error: submitControl.message || 'This form cannot be submitted with the current answers.' });
  if (!await validatePaymentRelationships(res, supabase, tenantData, form, values)) return;
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
  const idemKey = typeof idempotency_key === 'string' && idempotency_key.trim()
    ? `monthly-card:${idempotency_key.trim()}`.slice(0, 120) : null;
  if (!idemKey) {
    return res.status(400).json({ error: 'A payment attempt identifier is required. Refresh the form and try again.' });
  }
  let submission = null;
  if (idemKey) {
    const { data, error } = await supabase.from('form_submission').select('*').eq('tenant_id', tenantData.id).eq('form_id', form.id).eq('idempotency_key', idemKey).maybeSingle();
    if (error) return res.status(500).json({ error: 'Failed to prepare payment' });
    submission = data || null;
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
        membership: resolved.membershipMeta, monthly_card: {
          offer,
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
    email: submission.submitted_by_email || applicantEmail,
    membershipYear: quote.membership_year,
  });
  let { data: prior, error: priorErr } = await supabase.from('membership_billing_agreements').select('*').eq('idempotency_key', agreementKey).maybeSingle();
  if (priorErr) return res.status(500).json({ error: 'Failed to prepare card plan set-up' });
  if (prior && prior.metadata?.form_submission_id !== String(submission.id)) {
    return res.status(409).json({
      error: 'A monthly card membership checkout is already in progress for this email and membership year.',
      code: 'MEMBERSHIP_PAYMENT_IN_PROGRESS',
    });
  }
  if (!prior) {
    const { data: insertedAgreement, error: agreementErr } = await supabase.from('membership_billing_agreements').insert({
      tenant_id: tenantData.id, agreement_type: 'member', provider: 'stripe',
      member_id: existingApplicant?.id || null,
      status: 'payment_setup_required', idempotency_key: agreementKey, environment,
      metadata: {
        card: snapshot,
        form_submission_id: submission.id,
        applicant_identity: agreementKey.replace('form-card-applicant:', ''),
      },
    }).select().single();
    if (agreementErr?.code === '23505') {
      const { data: winner, error: winnerErr } = await supabase.from('membership_billing_agreements').select('*')
        .eq('idempotency_key', agreementKey).maybeSingle();
      if (winnerErr || !winner) return res.status(500).json({ error: 'Failed to prepare card plan set-up' });
      prior = winner;
    } else if (agreementErr) {
      return res.status(500).json({ error: 'Failed to prepare card plan set-up' });
    } else {
      prior = insertedAgreement;
    }
  }
  if (prior.metadata?.form_submission_id !== String(submission.id)) {
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
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: submission.submitted_by_email || undefined,
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
        cancel_at: (() => {
          const d = new Date();
          d.setUTCMonth(d.getUTCMonth() + (offer.instalmentCount - 1));
          d.setUTCDate(d.getUTCDate() + 15);
          return Math.floor(d.getTime() / 1000);
        })(),
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
  if (!await validatePaymentRelationships(res, supabase, tenantData, form, values)) return;

  const resolved = await resolvePayableCharge({
    supabase, tenantData, form, paymentField, values,
    prefill_organization_id, evalOptions,
  });
  if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);
  const { membershipMeta, amount, currency } = resolved;

  if (!(amount > 0)) {
    return res.status(400).json({ error: 'No payment is due for these answers', code: 'NO_PAYMENT_REQUIRED' });
  }
  if (provider === 'stripe' && amount < (STRIPE_MINIMUMS[currency] || 0.5)) {
    return res.status(400).json({ error: `The amount is below the minimum for card payment (${currency}).`, code: 'AMOUNT_TOO_SMALL' });
  }
  const amountMinor = Math.round(amount * 100);

  const submitterEmail = extractSubmitterEmail(form, values);

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
        const sameCharge = Number(existing.payment_amount) === Number(amount)
          && String(existing.payment_currency || '').toLowerCase() === String(currency || '').toLowerCase()
          && existing.payment_provider === provider
          && (storedMembership?.quote?.config_id || null) === (membershipMeta?.quote?.config_id || null)
          && Number(storedMembership?.quote?.total_with_vat ?? -1) === Number(membershipMeta?.quote?.total_with_vat ?? -1);
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
          payment_amount: amount,
          payment_currency: currency,
          payment_provider: provider,
          submitted_by_email: submitterEmail,
          payment_meta: withFormPaymentAccessProof({
            ...(existing.payment_meta || {}),
            price_field_id: paymentField.price_field_id || null,
            prefill_organization_id: prefill_organization_id || null,
            role_id: role_id || null,
            membership: membershipMeta,
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
      payment_provider: provider,
      payment_amount: amount,
      payment_currency: currency,
      payment_meta: withFormPaymentAccessProof({
        price_field_id: paymentField.price_field_id || null,
        prefill_organization_id: prefill_organization_id || null,
        role_id: role_id || null,
        membership: membershipMeta,
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
    const creds = await getStripeCredentials(tenantData.id, 'forms');
    if (!creds || creds.is_enabled === false || !creds.secret_key || !creds.publishable_key) {
      return res.status(400).json({ error: 'Card payment is not configured for this organisation' });
    }
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(creds.secret_key);

    // Same-key retry with an existing intent: REUSE it — never create a
    // second payable intent for the same submission (duplicate-charge
    // risk). Only a cancelled/failed prior intent is replaced, and it is
    // cancelled first so at most one payable intent exists at any time.
    const priorStripeReference = (submissionRow.payment_reference && submissionRow.payment_provider === 'stripe')
      ? submissionRow.payment_reference : null;
    if (priorStripeReference) {
      try {
        const existingIntent = await stripe.paymentIntents.retrieve(priorStripeReference);
        if (existingIntent) {
          if (existingIntent.status === 'succeeded') {
            return res.status(200).json({ alreadyPaid: true, submissionId: submissionRow.id });
          }
          const reusable = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(existingIntent.status);
          if (reusable && existingIntent.amount === amountMinor
              && existingIntent.currency === currency.toLowerCase()) {
            return res.status(200).json({
              provider: 'stripe',
              submissionId: submissionRow.id,
              clientSecret: existingIntent.client_secret,
              publishableKey: creds.publishable_key,
              amount,
              currency,
            });
          }
          // Not reusable (cancelled, or amount drifted on an unreferenced
          // refresh): invalidate before replacing so it can never be paid.
          if (existingIntent.status !== 'canceled') {
            try { await stripe.paymentIntents.cancel(existingIntent.id); }
            catch (cancelErr) {
              console.error('[form-payment] Could not cancel superseded intent', existingIntent.id, cancelErr?.message);
              return res.status(409).json({ error: 'An earlier payment attempt is still open. Please try again shortly.', code: 'PAYMENT_ALREADY_INITIATED' });
            }
          }
        }
      } catch (err) {
        // Intent id not found on this account (e.g. mode flip) — fall
        // through and create a fresh one.
        if (err?.code !== 'resource_missing') {
          console.error('[form-payment] Failed to retrieve existing intent:', err?.message);
          return res.status(500).json({ error: 'Failed to prepare payment' });
        }
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: currency.toLowerCase(),
      receipt_email: submitterEmail || undefined,
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
              amount,
              currency,
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
      amount,
      currency,
    });
  }

  // GoCardless: billing request (mandate + one-off payment) + hosted flow.
  const gc = await gocardlessForTenant(tenantData.id);
  if (!gc.isConfigured()) {
    return res.status(400).json({ error: 'Direct Debit is not configured for this organisation' });
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
    const paymentMeta = withFormPaymentAccessProof(row.payment_meta, {
      accessPolicyRequired: access.restricted,
    });
    const { data: authorizedRow, error: authorizationError } = await supabase
      .from('form_submission')
      .update({ payment_meta: paymentMeta })
      .eq('id', row.id)
      .eq('tenant_id', tenantData.id)
      .select('*')
      .maybeSingle();
    if (authorizationError || !authorizedRow) {
      console.error('[form-payment] Failed to persist live access authorization:', authorizationError);
      return res.status(500).json({
        error: 'Payment access was confirmed but could not be recorded. Please try confirming again.',
      });
    }
    row = authorizedRow;
  }

  if (row.payment_status === 'paid') {
    // Idempotent: ensure finalisation ran (e.g. earlier confirm crashed
    // between CAS and side effects).
    if (form) await finalizeFormSubmission({ supabase, submission: row, form, baseUrl });
    return res.status(200).json({ success: true, submissionId: row.id, status: 'paid' });
  }
  const resumableMonthlySetup = row.payment_provider === 'stripe_monthly_card'
    && row.payment_status === 'setup_complete';
  if (row.payment_status !== 'pending' && !resumableMonthlySetup) {
    return res.status(400).json({ error: 'This payment is no longer pending' });
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
      return res.status(400).json({ error: 'Card checkout does not match this submission' });
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
        return res.status(500).json({ error: 'Card checkout was found but could not be linked. It will be reconciled automatically.' });
      }
    }
    const allCreds = await getStripeIntegrationCredentials(tenantData.id);
    const keys = [...new Set([allCreds?.secret_key, allCreds?.test_secret_key].filter(Boolean))];
    if (keys.length === 0) return res.status(400).json({ error: 'Card payment is not configured' });
    const Stripe = (await import('stripe')).default;
    let session = null;
    let stripeForSession = null;
    for (const key of keys) {
      const stripe = new Stripe(key);
      try {
        session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
        stripeForSession = stripe;
        break;
      } catch (err) {
        const missing = err?.code === 'resource_missing' || err?.statusCode === 404;
        if (!missing) throw err;
      }
    }
    if (!session) return res.status(400).json({ error: 'Card checkout could not be found' });
    if (session.status !== 'complete' || !session.subscription) {
      return res.status(200).json({ success: false, pending: true, submissionId: row.id, status: session.status || 'pending' });
    }
    const outcome = await processStripeCardPlanEvent({
      id: `form-confirm-${session.id}`,
      type: 'checkout.session.completed',
      data: { object: session },
    }, {
      db: supabase,
      getStripe: async () => stripeForSession,
      baseUrl,
    });
    if (outcome.retryable) {
      return res.status(200).json({ success: false, pending: true, submissionId: row.id, status: 'finalizing' });
    }
    if (outcome.conflict) {
      return res.status(409).json({
        success: false,
        error: outcome.detail || 'Membership for this year is already recorded. The duplicate payment was reversed.',
        code: 'MEMBERSHIP_YEAR_CONFLICT',
        refunded: outcome.refunded === true,
        submissionId: row.id,
      });
    }
    if (!outcome.handled) {
      return res.status(400).json({ error: outcome.detail || 'Monthly card set-up could not be completed' });
    }
    return res.status(200).json({ success: true, submissionId: row.id, status: 'setup_complete' });
  }

  if (row.payment_provider === 'stripe') {
    const piId = payment_intent_id || row.payment_reference;
    if (!piId) return res.status(400).json({ error: 'payment_intent_id is required' });
    const found = await retrieveTenantPaymentIntent(tenantData.id, 'forms', piId);
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
    const finalRow = paidRow || { ...row, payment_status: 'paid' };
    if (form) await finalizeFormSubmission({ supabase, submission: finalRow, form, baseUrl });
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
