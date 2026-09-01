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
import { stripeInvoiceAddressFromSnapshot } from './stripeInvoiceAddress.js';

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
 * rows use the immutable Checkout snapshot; other payment methods retain the
 * existing configurable entity-field resolver.
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
  return stripeInvoiceAddressFromSnapshot(agreement.metadata?.card?.billing_address);
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
  if (snapshot.config_id) {
    const { data } = await db
      .from('membership_tier_config')
      .select('*')
      .eq('id', snapshot.config_id)
      .maybeSingle();
    config = data || null;
  }

  let vatRate = null;
  let nominalCode = null;
  if ((config?.pricing_model || 'tiered') === 'flat') {
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
  if (!nominalCode) {
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
    invoicingAddress = stripeInvoiceAddressFromSnapshot(snapshot.billing_address);
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
export async function createInstalmentInvoice({ provider, tenantId, context, amount, reference, paymentReference = null, bankAccountSettingKey = null, strictBankAccount = false, idempotencyKey = null }) {
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
    stripePaymentIntentId: paymentReference,
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
export async function mintOrPayInstalmentInvoice({ provider, agreement, snapshot, amountMinor, reference, paymentReference, existingInvoiceId = null, existingInvoiceNumber = null, idempotencyKey, bankAccountSettingKey, strictBankAccount = false, db }) {
  if (existingInvoiceId) {
    const result = await provider.applyStripePaymentToInvoice({
      appTenantId: agreement.tenant_id,
      invoiceId: existingInvoiceId,
      xeroInvoiceId: existingInvoiceId,
      amount: amountMinor / 100,
      reference: paymentReference,
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
export async function postStripeInstalmentInvoice({ agreement, plan, stripeInvoiceId, amountMinor, currency = null }, deps = {}) {
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
      paymentReference: stripeInvoiceId,
      existingInvoiceId: row.accounting_invoice_id || null,
      existingInvoiceNumber: row.accounting_invoice_number || null,
      idempotencyKey: `mii-stripe-${stripeInvoiceId}`,
      bankAccountSettingKey: STRIPE_BANK_SETTING_KEYS[provider.name] || null,
      db,
    });
    await updateInstalmentRow(db, row.id, buildInstalmentOutcomePatch({ providerName: provider.name, ...outcome }));
    return outcome.paymentRecorded
      ? { status: 'posted' }
      : { status: 'invoice_unpaid', reason: 'invoice created but payment not recorded' };
  } catch (err) {
    console.error('[instalmentInvoicing] stripe instalment posting failed:', err.message);
    await updateInstalmentRow(db, row.id, {
      accounting_sync_status: 'failed',
      accounting_sync_error: String(err.message || err).slice(0, 500),
    });
    return { status: 'failed', reason: err.message };
  }
}
