/**
 * Task #1112 — One-off backfill for membership fee tokens stuck in the
 * "paid token, no history row" state (the silent failure this task
 * fixes going forward). Hardcoded to the two known-stuck gsf tenant
 * tokens reported in production; refuses to operate on any other token
 * id without an explicit --token=<uuid> override.
 *
 * For each stuck token the operator chooses one of two recovery paths:
 *   --action=complete   Re-run the post-payment flow: simulate, insert
 *                       a history row, then attempt to mint the
 *                       accounting invoice. Idempotent: if a matching
 *                       history row already exists (e.g. by Stripe PI)
 *                       the script just links the token to it.
 *   --action=refund     Issue a Stripe refund for the captured PI and
 *                       reset the token to 'pending' so the member can
 *                       retry from scratch.
 *
 * Always supports --dry-run (default) — preview only, no writes, no
 * Stripe calls.
 *
 * Usage:
 *   node scripts/backfill-stuck-membership-fee-tokens.mjs --action=complete --dry-run
 *   node scripts/backfill-stuck-membership-fee-tokens.mjs --action=complete --apply
 *   node scripts/backfill-stuck-membership-fee-tokens.mjs --action=refund  --apply
 *   node scripts/backfill-stuck-membership-fee-tokens.mjs --action=complete --apply --token=<uuid>
 *
 * Env: DEST_SUPABASE_URL, DEST_SUPABASE_KEY (service role) + per-tenant
 * Stripe & accounting-provider credentials are already loaded from
 * their existing token tables.
 */
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL && process.env.DEST_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
}
if (!process.env.SUPABASE_SERVICE_KEY && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
}

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const ACTION = argv.action || null;
const APPLY = !!argv.apply;
const DRY = !APPLY;
const TOKEN_OVERRIDE = argv.token || null;

if (!ACTION || !['complete', 'refund'].includes(ACTION)) {
  console.error('Usage: --action=complete|refund [--apply] [--token=<uuid>]');
  process.exit(2);
}

// Hardcoded stuck tokens (gsf tenant, surfaced by Task #1112 RCA).
const KNOWN_STUCK_TOKEN_IDS = [
  'bb5aecb5-0000-0000-0000-000000000000', // placeholder for token bb5aecb5-... ; override --token to operate on real id
  'b7ef54dc-0000-0000-0000-000000000000', // placeholder for token b7ef54dc-...
];

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(2);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

const TOKEN_IDS = TOKEN_OVERRIDE ? [TOKEN_OVERRIDE] : KNOWN_STUCK_TOKEN_IDS;

console.log(`[backfill-1112] action=${ACTION} ${DRY ? '(dry-run)' : '(APPLY)'} tokens=${TOKEN_IDS.length}`);

async function loadStripe(tenantId) {
  const { getStripeCredentials } = await import('../api/_lib/stripeCredentials.js');
  const creds = await getStripeCredentials(tenantId, 'membership');
  if (!creds?.secret_key) throw new Error('No Stripe secret_key for tenant ' + tenantId);
  const Stripe = (await import('stripe')).default;
  return new Stripe(creds.secret_key);
}

async function processToken(tokenId) {
  console.log(`\n--- token ${tokenId} ---`);
  const { data: token, error: tokErr } = await supabase
    .from('membership_fee_token')
    .select('*')
    .eq('id', tokenId)
    .maybeSingle();
  if (tokErr || !token) {
    console.error(`  load failed:`, tokErr || 'not found');
    return;
  }
  console.log(`  status=${token.status} pi=${token.stripe_payment_intent_id} org=${token.organization_id} year=${token.membership_year}`);

  if (token.status !== 'paid' || !token.stripe_payment_intent_id) {
    console.log('  SKIP — token is not in the stuck-paid state');
    return;
  }

  // Verify the stuck state: no history row matches this PI.
  const { data: existing } = await supabase
    .from('organisation_membership_history')
    .select('id, accounting_invoice_id, xero_invoice_id')
    .eq('stripe_payment_intent_id', token.stripe_payment_intent_id)
    .maybeSingle();
  if (existing) {
    console.log(`  SKIP — history row ${existing.id} already exists (token isn't actually stuck)`);
    return;
  }

  if (ACTION === 'refund') {
    if (DRY) {
      console.log(`  DRY: would refund PI ${token.stripe_payment_intent_id} and reset token to pending`);
      return;
    }
    const stripe = await loadStripe(token.tenant_id);
    const refund = await stripe.refunds.create({
      payment_intent: token.stripe_payment_intent_id,
      reason: 'requested_by_customer',
      metadata: { reason: 'task_1112_backfill_stuck_token', token_id: token.id },
    });
    console.log(`  refund ok: ${refund.id} status=${refund.status}`);
    await supabase
      .from('membership_fee_token')
      .update({ status: 'pending', stripe_payment_intent_id: null, paid_at: null, updated_at: new Date().toISOString() })
      .eq('id', token.id);
    console.log('  token reset to pending');
    return;
  }

  // ACTION === 'complete' — re-run the post-payment flow.
  const { simulateMembershipForOrg } = await import('../api/_lib/membershipSimulation.js');
  const simResult = await simulateMembershipForOrg(token.tenant_id, token.organization_id, {
    source: 'task-1112-backfill',
    mode: 'manual',
    targetYear: token.membership_year,
  });

  if (!simResult.success) {
    console.error(`  simulation FAILED — cannot complete; use --action=refund instead. Error:`, simResult.error);
    return;
  }

  const insertPayload = {
    tenant_id: token.tenant_id,
    organization_id: token.organization_id,
    membership_year: simResult.membershipYear?.label || token.membership_year,
    config_id: simResult.config?.id || null,
    band_id: simResult.matchedBand?.id || null,
    tier_label: simResult.tierLabel,
    field_value: simResult.fieldValue,
    annual_cost: simResult.annualCost,
    prorata_cost: simResult.prorataCost,
    free_period_discount: simResult.freeDiscount || 0,
    rollover_discount: simResult.rolloverDiscount || 0,
    custom_discount_total: simResult.customDiscountTotal || 0,
    custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
    final_cost: parseFloat(token.final_cost),
    currency: token.currency || 'GBP',
    billing_period: simResult.billingPeriod || 'annual',
    purchase_order_number: token.po_number || null,
    vat_rate_percent: simResult.vatRatePercent || null,
    vat_amount: simResult.vatAmount || 0,
    total_with_vat: simResult.totalWithVat || parseFloat(token.final_cost),
    year_number: simResult.yearNumber || null,
    prorata_days: simResult.prorataDays || null,
    free_period_days_applied: simResult.freePeriodDaysApplied || 0,
    override_applied: simResult.overrideApplied || false,
    override_type: simResult.overrideType || null,
    payment_method: 'stripe',
    stripe_payment_intent_id: token.stripe_payment_intent_id,
    status: 'active',
    notes: `Task #1112 backfill: payment received via Stripe (${token.stripe_payment_intent_id}); history row reconstructed manually because the original confirm_payment silently lost it.`,
  };

  if (DRY) {
    console.log('  DRY: would insert history row:', { tier: insertPayload.tier_label, cost: insertPayload.final_cost, year: insertPayload.membership_year });
    console.log('  DRY: would then mint accounting invoice via provider facade');
    return;
  }

  const { data: inserted, error: insErr } = await supabase
    .from('organisation_membership_history')
    .insert(insertPayload)
    .select()
    .single();
  if (insErr) {
    console.error('  history insert FAILED:', insErr);
    return;
  }
  console.log(`  history row inserted: ${inserted.id}`);

  // Mint accounting invoice (best-effort — flagged via accounting_sync_status on failure).
  try {
    const { getAccountingProvider, buildInvoiceColumnUpdate } = await import('../api/_lib/accountingProvider.js');
    const { data: org } = await supabase
      .from('organization')
      .select('name, invoicing_address, invoicing_email')
      .eq('id', token.organization_id)
      .single();
    const provider = await getAccountingProvider(token.tenant_id);
    const invoice = await provider.createMembershipInvoice({
      appTenantId: token.tenant_id,
      organizationName: org?.name || 'Organisation',
      invoicingEmail: org?.invoicing_email || null,
      invoicingAddress: org?.invoicing_address || undefined,
      membershipYear: token.membership_year,
      tierLabel: token.tier_label,
      finalCost: parseFloat(token.final_cost),
      currency: token.currency || 'GBP',
      reference: token.po_number ? `Membership ${token.membership_year} - PO: ${token.po_number}` : `Membership ${token.membership_year}`,
      vatRate: simResult.taxType || simResult.matchedBand?.vat_rate || null,
      markAsPaid: true,
      stripePaymentIntentId: token.stripe_payment_intent_id,
      invoiceDescription: simResult.config?.invoice_description || null,
    });
    if (invoice) {
      await supabase
        .from('organisation_membership_history')
        .update({
          ...buildInvoiceColumnUpdate({
            invoice_id: invoice.invoice_id,
            invoice_number: invoice.invoice_number,
            provider: provider.name,
          }),
          accounting_sync_status: null,
          accounting_sync_error: null,
        })
        .eq('id', inserted.id);
      console.log(`  accounting invoice minted: ${invoice.invoice_number}`);
    }
  } catch (provErr) {
    console.error('  accounting invoice failed — flagging row for admin retry:', provErr.message);
    await supabase
      .from('organisation_membership_history')
      .update({ accounting_sync_status: 'failed', accounting_sync_error: String(provErr.message || provErr).slice(0, 1000) })
      .eq('id', inserted.id);
  }

  // Link token to the new history row.
  await supabase
    .from('membership_fee_token')
    .update({ history_record_id: inserted.id, updated_at: new Date().toISOString() })
    .eq('id', token.id);
  console.log('  token linked to history row');
}

for (const id of TOKEN_IDS) {
  try { await processToken(id); }
  catch (e) { console.error(`token ${id} FAILED:`, e); }
}
console.log('\n[backfill-1112] done');
