// Task #3633 — optional invoice-per-instalment for monthly memberships.
//
// A membership tier's monthly settings carry an invoicing mode
// (membership_tier_config.dd_invoicing_mode):
//   'annual'         (default) one annual invoice; monthly collections are
//                    applied to it as part-payments (existing behaviour).
//   'per_instalment' every confirmed monthly collection (GoCardless DD or
//                    Stripe monthly card) mints its own small paid invoice
//                    through the accounting provider facade; NO annual
//                    invoice is raised for that membership year.
//
// The mode is snapshotted onto the billing agreement at consent
// (metadata.dd.invoicing_mode / metadata.card.invoicing_mode) and never
// re-read from live config, so mode changes only affect newly started plans.
//
// Idempotency & correctness model (three layers):
//   1. Atomic claim — before any provider call the local row's
//      accounting_sync_status is CAS-claimed to 'posting'
//      (null/pending/failed/invoice_unpaid → posting). Concurrent webhook
//      deliveries / reconcile runs race on that single UPDATE; only the
//      winner talks to the provider. A crashed claim ('posting' left
//      behind) is only reclaimable by the reconcile cron once stale.
//   2. Provider-side idempotency — invoice creation passes a deterministic
//      key derived from the payment identifier (Xero Idempotency-Key
//      header / QBO requestid), so a crash AFTER the provider created the
//      invoice but BEFORE the linkage write cannot mint a second invoice
//      on retry.
//   3. Linkage before re-create — a row that already carries an
//      accounting_invoice_id never creates again; retries only re-apply
//      the payment.
//
// 'posted' means invoice created AND provider payment recorded. An invoice
// created whose payment could not be recorded (e.g. bank account setting
// missing) is stamped 'invoice_unpaid' with the linkage kept; retries
// re-apply the payment against the existing invoice.
//
// Every supabase write's { error } is inspected (see replit.md).

import { supabase } from './database.js';
import { getAccountingProvider, PROVIDER_NONE, PROVIDER_XERO } from './accountingProvider.js';
import { resolveInvoiceAddress } from './invoiceAddressResolver.js';
import { stripeInvoiceAddressFromMetadata } from './stripeInvoiceAddress.js';

export const INVOICING_MODES = ['annual', 'per_instalment'];

/** Normalize a raw config value to a valid mode (default 'annual'). */
export function normalizeInvoicingMode(value) {
  return value === 'per_instalment' ? 'per_instalment' : 'annual';
}

/** The snapshotted invoicing mode on a billing agreement (dd or card). */
export function agreementInvoicingMode(agreement) {
  const snap = agreement?.metadata?.dd || agreement?.metadata?.card || null;
  return normalizeInvoicingMode(snap?.invoicing_mode);
}

export function isPerInstalmentAgreement(agreement) {
  return agreementInvoicingMode(agreement) === 'per_instalment';
}

// Postgres codes meaning the agreements table/column predates this feature —
// the ONLY condition allowed to preserve legacy (annual-invoice) behaviour.
const PRE_MIGRATION_CODES = new Set(['42P01', '42703']);

/**
 * Should an ANNUAL membership invoice be suppressed for this history row?
 * True when the row is linked to a billing agreement whose snapshot says
 * per-instalment invoicing.
 *
 * FAIL-CLOSED: any operational failure (query error, missing agreement row)
 * THROWS — callers must treat that as "do not invoice now" (skip/5xx), never
 * as permission to raise an annual invoice, because a wrongly-raised annual
 * invoice double-charges a per-instalment member and is not self-healing.
 * The single explicitly-recognised exception is a pre-migration schema
 * (42P01/42703), where per-instalment mode cannot exist yet → false.
 */
export async function shouldSuppressAnnualInvoice(row, { db: dbArg } = {}) {
  const db = dbArg || supabase;
  const agreementId = row?.billing_agreement_id;
  if (!agreementId) return false;
  const { data: agreement, error } = await db
    .from('membership_billing_agreements')
    .select('id, metadata')
    .eq('id', agreementId)
    .maybeSingle();
  if (error) {
    if (PRE_MIGRATION_CODES.has(error.code)) return false;
    throw new Error(`per-instalment suppression check failed: ${error.message}`);
  }
  if (!agreement) {
    throw new Error(`per-instalment suppression check failed: billing agreement ${agreementId} not found`);
  }
  return isPerInstalmentAgreement(agreement);
}

/**
 * Resolve the address for an annual membership invoice. Stripe monthly-card
 * rows use the immutable Checkout snapshot (canonical metadata root, with
 * validated support for the legacy card namespace); other payment methods
 * retain the existing configurable entity-field resolver.
 */
export async function resolveMembershipInvoiceAddress({
  row,
  config,
  entityId,
  entityType,
  db: dbArg,
}) {
  const db = dbArg || supabase;
  const stripeAddress = await resolveStripeAgreementInvoiceAddress(row, { db });
  if (stripeAddress) return stripeAddress;
  return config ? resolveInvoiceAddress(db, config, entityId, entityType) : null;
}

export async function resolveStripeAgreementInvoiceAddress(row, { db: dbArg } = {}) {
  if (!row?.billing_agreement_id) return null;
  const db = dbArg || supabase;
  const { data: agreement, error } = await db
    .from('membership_billing_agreements')
    .select('provider, metadata')
    .eq('id', row.billing_agreement_id)
    .maybeSingle();
  if (error) throw new Error(`billing agreement address lookup failed: ${error.message}`);
  if (!agreement) throw new Error(`billing agreement ${row.billing_agreement_id} not found`);
  if (agreement.provider !== 'stripe') return null;
  return stripeInvoiceAddressFromMetadata(agreement.metadata);
}

/**
 * Non-throwing wrapper for annual-invoice paths that must fail closed but
 * cannot let an exception escape (e.g. after a card charge has already
 * succeeded). Returns { suppress, indeterminate?, error? } — an
 * indeterminate check ALWAYS suppresses; the caller records the error for
 * later reconciliation instead of raising an invoice it can't justify.
 */
export async function annualInvoiceSuppressionDecision(row, { db } = {}) {
  if (!row?.billing_agreement_id) return { suppress: false };
  try {
    return { suppress: await shouldSuppressAnnualInvoice(row, { db }) };
  } catch (err) {
    return { suppress: true, indeterminate: true, error: err.message };
  }
}

/**
 * Resolve everything the accounting provider needs to mint one small paid
 * instalment invoice for a monthly plan agreement: contact, VAT, nominal
 * code, description. Reads the tier config/band referenced by the IMMUTABLE
 * snapshot (config_id/band_id) — mirrors what the annual invoice paths pass.
 */
export async function resolveInstalmentInvoiceContext({ agreement, snapshot, db: dbArg } = {}) {
  const db = dbArg || supabase;
  if (!agreement || !snapshot) throw new Error('agreement and snapshot are required');

  // Contact: member (name/email) or organisation (name/invoicing_email).
  let contactName = null;
  let invoicingEmail = null;
  let entityId = null;
  let entityType = null;
  if (agreement.member_id) {
    const { data: m, error } = await db
      .from('member')
      .select('first_name, last_name, email')
      .eq('id', agreement.member_id)
      .maybeSingle();
    if (error) throw new Error(`load member failed: ${error.message}`);
    contactName = [m?.first_name, m?.last_name].filter(Boolean).join(' ') || 'Member';
    invoicingEmail = m?.email || null;
    entityId = agreement.member_id;
    entityType = 'member';
  } else if (agreement.organization_id) {
    const { data: org, error } = await db
      .from('organization')
      .select('name, invoicing_email')
      .eq('id', agreement.organization_id)
      .maybeSingle();
    if (error) throw new Error(`load organization failed: ${error.message}`);
    contactName = org?.name || 'Organisation';
    invoicingEmail = org?.invoicing_email || null;
    entityId = agreement.organization_id;
    entityType = 'organization';
  } else {
    throw new Error('agreement has neither member nor organisation');
  }

  // Tier config referenced by the snapshot (VAT / nominal / description /
  // invoice-address field). Best-effort: a deleted config falls back to
  // provider defaults rather than blocking the posting.
  let config = null;
  const collectionPrice = snapshot.collection_price_snapshot;
  if (collectionPrice) {
    config = collectionPrice.config;
    if (!config || !Object.hasOwn(collectionPrice, 'vat_rate')
      || !Object.hasOwn(collectionPrice, 'nominal_code')) {
      throw new Error('Dynamic instalment invoice requires immutable tax and nominal-code evidence');
    }
  } else if (snapshot.config_id) {
    const { data } = await db
      .from('membership_tier_config')
      .select('*')
      .eq('id', snapshot.config_id)
      .maybeSingle();
    config = data || null;
  }

  let vatRate = null;
  let nominalCode = null;
  if (collectionPrice) {
    vatRate = collectionPrice.vat_rate;
    nominalCode = collectionPrice.nominal_code;
  } else if ((config?.pricing_model || 'tiered') === 'flat') {
    vatRate = config?.flat_vat_rate || null;
    nominalCode = (typeof config?.nominal_code === 'string' && config.nominal_code.trim()) || null;
  } else if (snapshot.band_id) {
    try {
      const { data: band } = await db
        .from('membership_tier_band')
        .select('*')
        .eq('id', snapshot.band_id)
        .maybeSingle();
      vatRate = band?.vat_rate || null;
      nominalCode = (typeof band?.nominal_code === 'string' && band.nominal_code.trim())
        || (typeof config?.nominal_code === 'string' && config.nominal_code.trim()) || null;
    } catch { /* band gone — provider defaults apply */ }
  }
  if (!nominalCode && !collectionPrice) {
    try {
      const { data: setting } = await db
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'membership_nominal_ledger')
        .eq('tenant_id', agreement.tenant_id)
        .maybeSingle();
      nominalCode = (setting?.setting_value || '').trim() || null;
    } catch { /* provider default */ }
  }

  let invoicingAddress = null;
  if (agreement.provider === 'stripe') {
    invoicingAddress = stripeInvoiceAddressFromMetadata(agreement.metadata);
  } else {
    try {
      invoicingAddress = config ? await resolveInvoiceAddress(db, config, entityId, entityType) : null;
    } catch { /* non-fatal */ }
  }

  return {
    contactName,
    invoicingEmail,
    invoicingAddress,
    vatRate,
    nominalCode,
    tierLabel: snapshot.tier_label || null,
    membershipYear: snapshot.membership_year || null,
    currency: snapshot.currency || 'GBP',
  };
}

/**
 * Mint ONE small paid invoice for a monthly instalment through the provider
 * facade. Returns the provider's normalized invoice shape. `idempotencyKey`
 * is forwarded to the provider (Xero Idempotency-Key / QBO requestid) so a
 * repeat of the same key can never create a second invoice.
 */
export const isStripePaymentIntentId = (value) => /^pi_[A-Za-z0-9]+$/.test(String(value || ''));

/**
 * The arrears fan-out keeps its historic unique local key as
 * `<Stripe invoice id>:arrears:<period id>`. Only this exact durable format
 * may be mapped back to the source invoice for a read-only evidence lookup.
 */
export function stripeInvoiceIdForPaymentEvidence(externalPaymentId) {
  const value = String(externalPaymentId || '');
  const arrearsMatch = /^(in_[A-Za-z0-9]+):arrears:[^:]+$/.exec(value);
  return arrearsMatch ? arrearsMatch[1] : value;
}

function paymentIntentValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.payment_intent || value.id || null;
  }
  return null;
}

/**
 * Extract genuine PaymentIntent IDs from the documented Stripe Invoice shapes.
 * Invoice IDs, charges, and arbitrary metadata are deliberately not candidates:
 * they are not interchangeable payment identities.
 */
export function stripeInvoicePaymentIntentIds(invoice) {
  const candidates = [];
  const add = (value) => {
    const id = paymentIntentValue(value);
    if (isStripePaymentIntentId(id)) candidates.push(id);
  };
  if (!invoice || typeof invoice !== 'object') return [];
  add(invoice.payment_intent);
  add(invoice.payment?.payment_intent);
  add(invoice.charge?.payment_intent);
  add(invoice.latest_charge?.payment_intent);
  const payments = Array.isArray(invoice.payments)
    ? invoice.payments
    : invoice.payments?.data;
  for (const invoicePayment of payments || []) {
    add(invoicePayment?.payment_intent);
    add(invoicePayment?.payment?.payment_intent);
    // Some Stripe API versions expose a PaymentRecord whose nested payment
    // object is itself the PaymentIntent rather than a wrapper.
    if (invoicePayment?.payment?.type === 'payment_intent') add(invoicePayment.payment);
  }
  return [...new Set(candidates)];
}

const stripeObjectId = (value) => (typeof value === 'string' ? value : value?.id || null);
const normalizeCurrency = (value) => String(value || '').trim().toUpperCase();

/**
 * Prove the paid invoice belongs to the monthly plan before using any payment
 * identity from it. The Stripe client is tenant-scoped by the caller; invoice
 * metadata, when present, is an additional tenant assertion rather than a
 * substitute for that scoped client.
 *
 * An arrears collection may pay several periods in one source invoice, so its
 * accounting row amount is required to be no greater than amount_paid rather
 * than exactly equal to it.
 */
export function assertStripeInvoicePaymentEvidence({
  stripeInvoiceId, invoice, agreement = null, plan = null, amountMinor = null, currency = null,
} = {}) {
  if (!invoice || invoice.id !== stripeInvoiceId) {
    throw new Error(`Stripe payment evidence does not match invoice ${stripeInvoiceId}`);
  }
  if (agreement?.tenant_id && plan?.tenant_id && agreement.tenant_id !== plan.tenant_id) {
    throw new Error(`Stripe payment evidence plan tenant does not match the membership agreement`);
  }
  if (invoice.status !== 'paid' && invoice.paid !== true) {
    throw new Error(`Stripe invoice ${stripeInvoiceId} is not confirmed paid`);
  }
  const expectedCurrency = normalizeCurrency(currency || agreement?.metadata?.card?.currency);
  if (expectedCurrency && normalizeCurrency(invoice.currency) !== expectedCurrency) {
    throw new Error(`Stripe invoice ${stripeInvoiceId} currency does not match the membership agreement`);
  }
  if (Number.isInteger(amountMinor) && amountMinor > 0) {
    if (!Number.isInteger(invoice.amount_paid) || invoice.amount_paid < amountMinor) {
      throw new Error(`Stripe invoice ${stripeInvoiceId} paid amount does not cover the accounting instalment`);
    }
  }
  if (invoice.metadata?.tenant_id && invoice.metadata.tenant_id !== agreement?.tenant_id) {
    throw new Error(`Stripe invoice ${stripeInvoiceId} tenant metadata does not match the membership agreement`);
  }

  const assertRelationship = (label, actual, expected) => {
    if (!expected.length) return;
    if (!actual || expected.some((id) => id !== actual)) {
      throw new Error(`Stripe invoice ${stripeInvoiceId} ${label} does not match the membership plan`);
    }
  };
  const expectedCustomerIds = [
    stripeObjectId(plan?.stripe_customer_id),
    stripeObjectId(agreement?.stripe_customer_id),
  ].filter(Boolean);
  const expectedSubscriptionIds = [
    stripeObjectId(plan?.stripe_subscription_id),
    stripeObjectId(agreement?.stripe_subscription_id),
  ].filter(Boolean);
  if ((agreement || plan) && (!expectedCustomerIds.length || !expectedSubscriptionIds.length)) {
    throw new Error(`Stripe invoice ${stripeInvoiceId} cannot be bound to a Stripe customer and subscription`);
  }
  assertRelationship('customer', stripeObjectId(invoice.customer), expectedCustomerIds);
  assertRelationship(
    'subscription',
    stripeObjectId(invoice.subscription || invoice.parent?.subscription_details?.subscription),
    expectedSubscriptionIds,
  );
  return invoice;
}

/**
 * Resolve a Stripe monthly invoice's actual PaymentIntent from tenant-scoped
 * Stripe evidence. A signed webhook invoice can be used directly. Reconciliation
 * retries re-read the invoice (and newer invoice-payment list when available).
 * Never manufacture an identity from an `in_` ID or accept a guessed PI.
 */
export async function resolveStripeInvoicePaymentIntent({
  stripeInvoiceId,
  stripeInvoice = null,
  stripe = null,
  agreement = null,
  plan = null,
  amountMinor = null,
  currency = null,
} = {}) {
  if (!stripeInvoiceId) throw new Error('Stripe invoice id is required to resolve payment evidence');
  if (!stripe?.invoices?.retrieve || !stripe?.paymentIntents?.retrieve) {
    throw new Error(`tenant-scoped Stripe invoice and PaymentIntent retrieval are required for invoice ${stripeInvoiceId}`);
  }
  const candidates = new Set();
  const addInvoiceEvidence = (invoice) => {
    assertStripeInvoicePaymentEvidence({
      stripeInvoiceId, invoice, agreement, plan, amountMinor, currency,
    });
    for (const id of stripeInvoicePaymentIntentIds(invoice)) candidates.add(id);
  };
  // A webhook payload is useful corroborating evidence, but never the sole
  // authority for settlement. Re-read the invoice and then the resulting PI
  // through the tenant's Stripe client before any accounting write.
  // Retain the signed event's PI candidate for newer API shapes, but bind all
  // financial/relationship assertions to the authoritative tenant-scoped
  // invoice reread below. A historical retry may only have a skeletal event
  // object, which must not prevent that recovery read.
  if (stripeInvoice?.id === stripeInvoiceId) {
    for (const id of stripeInvoicePaymentIntentIds(stripeInvoice)) candidates.add(id);
  }
  const evidence = await stripe.invoices.retrieve(stripeInvoiceId);
  addInvoiceEvidence(evidence);

  // Stripe's newer Invoice Payment API keeps the PI below
  // invoice_payment.payment.payment_intent. It is tenant-scoped because it is
  // queried with the same Stripe client which retrieved the invoice.
  if (stripe?.invoicePayments?.list) {
    const result = await stripe.invoicePayments.list({ invoice: stripeInvoiceId, limit: 100 });
    if (result?.has_more) {
      throw new Error(`Stripe Invoice Payment evidence is truncated for invoice ${stripeInvoiceId}; refusing ambiguous settlement`);
    }
    for (const payment of result?.data || []) {
      const status = payment?.status || payment?.payment?.status || null;
      if (!['paid', 'succeeded'].includes(status)) {
        throw new Error(`Stripe Invoice Payment evidence is ${status || 'unknown'} for invoice ${stripeInvoiceId}; refusing settlement`);
      }
      for (const id of stripeInvoicePaymentIntentIds({ payments: [payment] })) candidates.add(id);
    }
  }
  const ids = [...candidates];
  if (ids.length > 1) throw new Error(`ambiguous Stripe PaymentIntent evidence for invoice ${stripeInvoiceId}`);
  if (ids.length !== 1) {
    throw new Error(`Stripe PaymentIntent evidence is missing for paid invoice ${stripeInvoiceId}; accounting posting can be retried after Stripe evidence is available`);
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(ids[0]);
  if (!paymentIntent || paymentIntent.id !== ids[0] || paymentIntent.status !== 'succeeded') {
    throw new Error(`Stripe PaymentIntent ${ids[0]} is not confirmed succeeded for invoice ${stripeInvoiceId}`);
  }
  if (!Number.isInteger(evidence.amount_paid) || !Number.isInteger(paymentIntent.amount)
      || paymentIntent.amount !== evidence.amount_paid) {
    throw new Error(`Stripe PaymentIntent ${ids[0]} amount does not match invoice ${stripeInvoiceId}`);
  }
  if (!normalizeCurrency(evidence.currency) || !normalizeCurrency(paymentIntent.currency)
      || normalizeCurrency(paymentIntent.currency) !== normalizeCurrency(evidence.currency)) {
    throw new Error(`Stripe PaymentIntent ${ids[0]} currency does not match invoice ${stripeInvoiceId}`);
  }
  if (!stripeObjectId(evidence.customer) || !stripeObjectId(paymentIntent.customer)
      || stripeObjectId(paymentIntent.customer) !== stripeObjectId(evidence.customer)) {
    throw new Error(`Stripe PaymentIntent ${ids[0]} customer does not match invoice ${stripeInvoiceId}`);
  }
  if (paymentIntent.metadata?.tenant_id && paymentIntent.metadata.tenant_id !== agreement?.tenant_id) {
    throw new Error(`Stripe PaymentIntent ${ids[0]} tenant metadata does not match the membership agreement`);
  }
  return ids[0];
}

export async function createInstalmentInvoice({ provider, tenantId, context, amount, reference, paymentReference = null, stripePaymentIntentId = null, bankAccountSettingKey = null, strictBankAccount = false, idempotencyKey = null }) {
  return provider.createMembershipInvoice({
    appTenantId: tenantId,
    organizationName: context.contactName,
    invoicingEmail: context.invoicingEmail,
    invoicingAddress: context.invoicingAddress || undefined,
    membershipYear: context.membershipYear,
    tierLabel: context.tierLabel,
    finalCost: amount,
    currency: context.currency,
    reference,
    vatRate: context.vatRate,
    nominalCode: context.nominalCode,
    markAsPaid: true,
    // `paymentReference` is an accounting-facing provider reference (and may
    // be a Stripe Invoice or GoCardless ID). It is never a PaymentIntent.
    paymentReference,
    stripePaymentIntentId,
    invoiceDescription: 'Monthly membership instalment ({year})',
    bankAccountSettingKey,
    // strict: never fall back to the Stripe bank account for another rail —
    // an unresolvable account must surface as payment_recorded=false.
    strictBankAccount,
    idempotencyKey,
    // The payment is a separate provider request with its own idempotency
    // key, so crash-after-payment can't double-pay on retry.
    paymentIdempotencyKey: idempotencyKey ? `${idempotencyKey}-pay` : null,
  });
}

/** True when a provider result says the payment was actually recorded. */
export function invoicePaymentRecorded(result) {
  return result?.payment_recorded === true || result?.raw?.payment_recorded === true;
}

/**
 * Mint the instalment invoice — or, when the row is already linked to one,
 * only (re-)apply the payment against it. Returns
 * { invoiceId, invoiceNumber, paymentRecorded }.
 */
export async function mintOrPayInstalmentInvoice({ provider, agreement, snapshot, amountMinor, reference, paymentReference, stripePaymentIntentId = null, existingInvoiceId = null, existingInvoiceNumber = null, idempotencyKey, bankAccountSettingKey, strictBankAccount = false, db }) {
  if (existingInvoiceId) {
    const result = await provider.applyStripePaymentToInvoice({
      appTenantId: agreement.tenant_id,
      invoiceId: existingInvoiceId,
      xeroInvoiceId: existingInvoiceId,
      amount: amountMinor / 100,
      reference: paymentReference,
      paymentReference,
      stripePaymentIntentId,
      bankAccountSettingKey,
      strictBankAccount,
      // Same deterministic per-collection payment key as the create path —
      // retries after a crash-after-payment replay instead of double-paying.
      idempotencyKey: idempotencyKey ? `${idempotencyKey}-pay` : null,
    });
    return {
      invoiceId: existingInvoiceId,
      invoiceNumber: result?.invoice_number || existingInvoiceNumber || null,
      paymentRecorded: invoicePaymentRecorded(result),
    };
  }
  const context = await resolveInstalmentInvoiceContext({ agreement, snapshot, db });
  const invoice = await createInstalmentInvoice({
    provider,
    tenantId: agreement.tenant_id,
    context,
    amount: amountMinor / 100,
    reference,
    paymentReference,
    stripePaymentIntentId,
    bankAccountSettingKey,
    strictBankAccount,
    idempotencyKey,
  });
  if (!invoice?.invoice_id) throw new Error('provider returned no invoice payload');
  return {
    invoiceId: invoice.invoice_id,
    invoiceNumber: invoice.invoice_number || null,
    paymentRecorded: invoicePaymentRecorded(invoice),
  };
}

/**
 * Build the status/linkage patch for a mint/pay outcome. 'posted' ONLY when
 * the provider recorded the payment; otherwise 'invoice_unpaid' with the
 * linkage kept so the retry sweep re-applies the payment (never re-creates).
 */
export function buildInstalmentOutcomePatch({ providerName, invoiceId, invoiceNumber, paymentRecorded }) {
  const patch = {
    accounting_provider: providerName,
    accounting_invoice_id: invoiceId,
    accounting_invoice_number: invoiceNumber || null,
    accounting_sync_status: paymentRecorded ? 'posted' : 'invoice_unpaid',
    accounting_sync_error: paymentRecorded
      ? null
      : 'invoice created but payment not recorded (check the bank account setting for this payment rail)',
    accounting_synced_at: paymentRecorded ? new Date().toISOString() : null,
  };
  if (providerName === PROVIDER_XERO) {
    patch.xero_invoice_id = invoiceId;
    patch.xero_invoice_number = invoiceNumber || null;
  }
  return patch;
}

// Statuses a poster may claim from. 'posting' (a crashed in-flight claim) is
// claimable only via reclaimStale — used by the reconcile crons, which query
// stale 'posting' rows by updated_at before reclaiming.
export const CLAIMABLE_SYNC_STATUSES = ['pending', 'failed', 'invoice_unpaid'];
export function claimableStatuses({ reclaimStale = false } = {}) {
  return reclaimStale ? [...CLAIMABLE_SYNC_STATUSES, 'posting'] : CLAIMABLE_SYNC_STATUSES;
}

// ---------------------------------------------------------------------------
// Stripe monthly card — per-instalment posting store
// ---------------------------------------------------------------------------

const STRIPE_BANK_SETTING_KEYS = {
  xero: 'xero_stripe_bank_account_code',
  quickbooks: 'quickbooks_stripe_bank_account_id',
};

async function updateInstalmentRow(db, rowId, patch) {
  const { error } = await db
    .from('membership_instalment_invoices')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', rowId);
  if (error) console.error('[instalmentInvoicing] update instalment row failed:', error.message);
}

/**
 * Post one paid Stripe monthly-card instalment as its own accounting
 * invoice. Idempotent via membership_instalment_invoices UNIQUE
 * (provider, external_payment_id) — safe under webhook redelivery and the
 * reconcile cron's synthetic invoice.paid replays.
 *
 * @returns {Promise<{status:'posted'|'skipped'|'failed', reason?:string}>}
 */
export async function postStripeInstalmentInvoice({
  agreement, plan, stripeInvoiceId, stripeInvoice = null,
  // Arrears period rows deliberately append their period ID to the local
  // ledger key. Keep that historical uniqueness key separate from the Stripe
  // invoice that supplies payment evidence.
  stripePaymentEvidenceInvoiceId = null,
  amountMinor, currency = null,
}, deps = {}) {
  const db = deps.db || supabase;
  const getProvider = deps.getProvider || getAccountingProvider;
  const reclaimStale = deps.reclaimStale === true;

  if (!agreement || !stripeInvoiceId) return { status: 'skipped', reason: 'missing agreement or invoice id' };
  if (!isPerInstalmentAgreement(agreement)) return { status: 'skipped', reason: 'agreement is not per-instalment' };

  const snapshot = agreement.metadata?.card;
  const amt = Number.isInteger(amountMinor) && amountMinor > 0
    ? amountMinor
    : (snapshot?.monthly_amount_minor || null);
  if (!amt) return { status: 'failed', reason: 'no positive instalment amount' };

  // Durable idempotency/claim row FIRST. A successful insert IS the claim
  // (row is born in 'posting'); on conflict the CAS below decides ownership.
  const insertRow = {
    tenant_id: agreement.tenant_id,
    plan_id: plan?.id || null,
    billing_agreement_id: agreement.id,
    provider: 'stripe',
    external_payment_id: stripeInvoiceId,
    amount_minor: amt,
    currency: currency || snapshot?.currency || 'GBP',
    accounting_sync_status: 'posting',
  };
  const { error: insErr } = await db
    .from('membership_instalment_invoices')
    .insert(insertRow);
  if (insErr && insErr.code !== '23505') {
    // Pre-migration (42P01) or drift — loud, retryable, never silent.
    console.error('[instalmentInvoicing] insert instalment row failed:', insErr.message);
    return { status: 'failed', reason: `instalment row insert failed: ${insErr.message}` };
  }

  let row = null;
  if (insErr) {
    // A prior inner instalment post may have succeeded just before an arrears
    // fan-out crash. Return its durable linkage as an explicit posted replay,
    // never as an unverified generic `skipped` result, so the outer arrears
    // row can be repaired without minting another provider invoice.
    const { data: existing, error: existingErr } = await db
      .from('membership_instalment_invoices')
      .select('*')
      .eq('provider', 'stripe')
      .eq('external_payment_id', stripeInvoiceId)
      .maybeSingle();
    if (existingErr) return { status: 'failed', reason: `load existing instalment row failed: ${existingErr.message}` };
    if (existing?.accounting_sync_status === 'posted') {
      if (!existing.accounting_invoice_id) {
        return { status: 'failed', reason: 'posted instalment row has no accounting invoice linkage' };
      }
      return {
        status: 'posted',
        replayed: true,
        invoiceId: existing.accounting_invoice_id,
        invoiceNumber: existing.accounting_invoice_number || null,
      };
    }
    // Row already existed — atomically claim it. Only one concurrent caller
    // wins this CAS; losers (and already-posted rows) bail out here.
    const { data: claimed, error: claimErr } = await db
      .from('membership_instalment_invoices')
      .update({ accounting_sync_status: 'posting', updated_at: new Date().toISOString() })
      .eq('provider', 'stripe')
      .eq('external_payment_id', stripeInvoiceId)
      .in('accounting_sync_status', claimableStatuses({ reclaimStale }))
      .select('*');
    if (claimErr) return { status: 'failed', reason: `claim failed: ${claimErr.message}` };
    row = claimed?.[0] || null;
    if (!row) return { status: 'skipped', reason: 'already posted or another worker is posting' };
  } else {
    const { data, error: selErr } = await db
      .from('membership_instalment_invoices')
      .select('*')
      .eq('provider', 'stripe')
      .eq('external_payment_id', stripeInvoiceId)
      .maybeSingle();
    if (selErr || !data) return { status: 'failed', reason: `load instalment row failed: ${selErr?.message || 'not found'}` };
    row = data;
  }

  try {
    // A Stripe invoice ID is the ledger/idempotency identity, not a PI. Resolve
    // the latter only from the tenant's signed invoice evidence before any
    // accounting-provider write. Legacy failed rows can therefore recover
    // safely, while missing/ambiguous evidence remains visibly retryable.
    const stripe = deps.stripe || (deps.getStripe ? await deps.getStripe() : null);
    const paymentEvidenceInvoiceId = stripePaymentEvidenceInvoiceId || stripeInvoice?.id || stripeInvoiceId;
    const stripePaymentIntentId = await resolveStripeInvoicePaymentIntent({
      stripeInvoiceId: paymentEvidenceInvoiceId,
      stripeInvoice,
      stripe,
      agreement,
      plan,
      amountMinor: amt,
      currency: currency || snapshot?.currency || 'GBP',
    });
    const provider = await getProvider(agreement.tenant_id);
    if (!provider || provider.name === PROVIDER_NONE) {
      await updateInstalmentRow(db, row.id, { accounting_sync_status: 'skipped', accounting_sync_error: 'no accounting provider connected' });
      return { status: 'skipped', reason: 'no accounting provider connected' };
    }
    const outcome = await mintOrPayInstalmentInvoice({
      provider,
      agreement,
      snapshot,
      amountMinor: amt,
      reference: `Membership ${snapshot?.membership_year || ''} - card instalment ${stripeInvoiceId}`.trim(),
      paymentReference: `Stripe invoice: ${paymentEvidenceInvoiceId}`,
      stripePaymentIntentId,
      existingInvoiceId: row.accounting_invoice_id || null,
      existingInvoiceNumber: row.accounting_invoice_number || null,
      idempotencyKey: `mii-stripe-${stripeInvoiceId}`,
      bankAccountSettingKey: STRIPE_BANK_SETTING_KEYS[provider.name] || null,
      db,
    });
    await updateInstalmentRow(db, row.id, buildInstalmentOutcomePatch({ providerName: provider.name, ...outcome }));
    return outcome.paymentRecorded
      ? { status: 'posted', invoiceId: outcome.invoiceId, invoiceNumber: outcome.invoiceNumber }
      : {
        status: 'invoice_unpaid',
        invoiceId: outcome.invoiceId,
        invoiceNumber: outcome.invoiceNumber,
        reason: 'invoice created but payment not recorded',
      };
  } catch (err) {
    console.error('[instalmentInvoicing] stripe instalment posting failed:', err.message);
    await updateInstalmentRow(db, row.id, {
      accounting_sync_status: 'failed',
      accounting_sync_error: String(err.message || err).slice(0, 500),
    });
    return { status: 'failed', reason: err.message };
  }
}
