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
import { getStripeCredentials, retrieveTenantPaymentIntent } from '../_lib/stripeCredentials.js';
import { gocardlessForTenant, buildIdempotencyKey } from '../_lib/gocardless.js';
import { computeHiddenFieldIds, findPaymentField, derivePaymentAmount } from '../_lib/formFieldVisibility.js';
import { markFormSubmissionPaid, finalizeFormSubmission } from '../_lib/formPaymentFinalize.js';
import { resolveMembershipAction, buildMembershipFieldOverrides } from '../_lib/formMembershipAction.js';
import { quoteMembershipForNewApplicant, quoteFromSimulationResult } from '../_lib/membershipQuote.js';

const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

const FORM_COLUMNS = 'id, name, tenant_id, require_authentication, fields, pages, visibility_rules, entity_pipelines, field_mappings, application_level, deactivate_at, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type';

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
  if (form.deactivate_at) {
    const t = new Date(form.deactivate_at).getTime();
    if (!Number.isNaN(t) && t <= Date.now()) return null;
  }
  return form;
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
    const membershipConfig = (activeConfigs || []).find(c => c.id === membershipAction.configId);
    if (!membershipConfig) {
      return { error: { status: 400, body: { error: 'The selected membership structure is not currently in effect. Ask the administrator to update the form.', code: 'MEMBERSHIP_QUOTE_FAILED' } } };
    }
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

    const fieldOverrides = buildMembershipFieldOverrides(membershipAction.fieldMappings, values);
    let quote = null;
    if (membershipTarget === 'organization' && prefill_organization_id) {
      // An existing organisation is already known: use the full simulation
      // (honours go-live date, existing records, overrides, stored values).
      const { simulateMembershipForOrg } = await import('../_lib/membershipSimulation.js');
      const simResult = await simulateMembershipForOrg(tenantData.id, prefill_organization_id, {
        source: 'form-payment', mode: 'manual', configId: membershipAction.configId, fieldOverrides,
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
        tenantId: tenantData.id, configId: membershipAction.configId, fieldOverrides,
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
  return res.status(200).json({
    required: true,
    amount,
    currency,
    membership: membershipMeta ? {
      config_name: membershipMeta.quote.config_name || null,
      membership_year: membershipMeta.quote.membership_year || null,
      tier_label: membershipMeta.quote.tier_label || null,
    } : null,
  });
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
          submission_data: values,
          payment_amount: amount,
          payment_currency: currency,
          payment_provider: provider,
          submitted_by_email: submitterEmail,
          payment_meta: {
            ...(existing.payment_meta || {}),
            price_field_id: paymentField.price_field_id || null,
            prefill_organization_id: prefill_organization_id || null,
            role_id: role_id || null,
            membership: membershipMeta,
          },
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
      submission_data: values,
      submitted_by_email: submitterEmail,
      created_date: new Date().toISOString(),
      payment_status: 'pending',
      payment_provider: provider,
      payment_amount: amount,
      payment_currency: currency,
      payment_meta: {
        price_field_id: paymentField.price_field_id || null,
        prefill_organization_id: prefill_organization_id || null,
        role_id: role_id || null,
        membership: membershipMeta,
      },
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

  const { data: row, error: rowErr } = await supabase
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

  if (row.payment_status === 'paid') {
    // Idempotent: ensure finalisation ran (e.g. earlier confirm crashed
    // between CAS and side effects).
    if (form) await finalizeFormSubmission({ supabase, submission: row, form, baseUrl });
    return res.status(200).json({ success: true, submissionId: row.id, status: 'paid' });
  }
  if (row.payment_status !== 'pending') {
    return res.status(400).json({ error: 'This payment is no longer pending' });
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
