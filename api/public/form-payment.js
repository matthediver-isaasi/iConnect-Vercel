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

  // LMIC options shared by submit-control AND visibility evaluation.
  const evalOptions = {};
  if (rulesUseLmicOperators(form.visibility_rules)) {
    evalOptions.lmicCodes = await loadTenantLmicCodes(supabase, tenantData.id);
  }

  // Hidden payment field ⇒ payment is not part of this submission; the
  // client must use the normal submit path.
  const hiddenIds = computeHiddenFieldIds(form, values, evalOptions);
  if (hiddenIds.has(paymentField.id)) {
    return res.status(400).json({ error: 'Payment is not required for these answers', code: 'PAYMENT_NOT_REQUIRED' });
  }

  // Conditional-logic submit control: a matched disable rule blocks
  // STARTING a payment exactly as it blocks a normal submit.
  const submitControl = resolveSubmitControl(form.visibility_rules, values, evalOptions);
  if (submitControl.disabled) {
    return res.status(400).json({
      error: submitControl.message || 'This form cannot be submitted with the current answers.',
      code: 'SUBMIT_DISABLED_BY_RULE',
    });
  }

  // Amount is ALWAYS derived server-side from the price-source answer.
  const amount = derivePaymentAmount(paymentField, values);
  if (!(amount > 0)) {
    return res.status(400).json({ error: 'No payment is due for these answers', code: 'NO_PAYMENT_REQUIRED' });
  }
  const currency = (paymentField.payment_currency || 'GBP').toUpperCase();
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
    await supabase
      .from('form_submission')
      .update({ payment_reference: paymentIntent.id })
      .eq('id', submissionRow.id)
      .eq('payment_status', 'pending');
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
        gc_flow_id: flow.id || null,
      },
    })
    .eq('id', submissionRow.id)
    .eq('payment_status', 'pending');

  return res.status(200).json({
    provider: 'gocardless',
    submissionId: submissionRow.id,
    authorisationUrl: flow.authorisation_url,
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
