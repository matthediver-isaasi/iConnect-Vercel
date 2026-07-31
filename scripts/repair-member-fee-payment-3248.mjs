/**
 * Task #3248 — Repair member membership history rows whose card payment
 * succeeded but whose Xero invoice was never marked paid because the
 * public fee confirm path passed `invoiceId` (not `xeroInvoiceId`) to the
 * Xero facade ("xeroInvoiceId is required").
 *
 * For each victim row (accounting_sync_status='failed' with the arg-shape
 * error, a Stripe PI, and a linked invoice):
 *   1. Check the invoice's current status at the provider; only apply the
 *      Stripe payment if the invoice is not already paid (idempotent).
 *   2. Clear accounting_sync_status/error on the row.
 *   3. Run the shared reconcileMembershipInvoicePayment helper so the row
 *      flips to paid and the membership-paid workflow fires exactly once
 *      (the helper is a no-op for rows already in a terminal state).
 *
 * Targets the DEST/prod DB via DEST_SUPABASE_URL / DEST_SUPABASE_KEY.
 *
 * Usage:
 *   node scripts/repair-member-fee-payment-3248.mjs --dry-run
 *   node scripts/repair-member-fee-payment-3248.mjs
 *   node scripts/repair-member-fee-payment-3248.mjs --record=<uuid> --table=member_membership_history
 */

// Mirror DEST env vars BEFORE importing any api/_lib module (their shared
// Supabase client reads SUPABASE_URL / SUPABASE_SERVICE_KEY, which in this
// workspace point at the stale SOURCE project).
if (process.env.DEST_SUPABASE_URL) process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
if (process.env.DEST_SUPABASE_KEY) process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const DRY_RUN = !!args['dry-run'];
const ONLY_RECORD = args.record || null;
const TABLES = args.table ? [args.table] : ['member_membership_history', 'organisation_membership_history'];

const { supabase } = await import('../api/_lib/database.js');
const { getAccountingProvider } = await import('../api/_lib/accountingProvider.js');
const { reconcileMembershipInvoicePayment } = await import('../api/_lib/membershipPaymentReconciliation.js');

const totals = { scanned: 0, paymentsApplied: 0, alreadyPaidRemote: 0, reconciled: 0, errors: 0, skipped: 0 };

for (const table of TABLES) {
  let query = supabase
    .from(table)
    .select('*')
    .eq('accounting_sync_status', 'failed')
    .not('stripe_payment_intent_id', 'is', null);
  if (ONLY_RECORD) query = query.eq('id', ONLY_RECORD);
  const { data: rows, error } = await query;
  if (error) {
    console.error(`Failed to load ${table}: ${error.message}`);
    totals.errors++;
    continue;
  }

  for (const row of rows || []) {
    totals.scanned++;
    const invoiceId = row.accounting_invoice_id || row.xero_invoice_id;
    const label = `${table}#${row.id}`;
    if (!invoiceId) {
      console.log(`  [skip] ${label}: no linked invoice (needs invoice mint retry, not payment apply)`);
      totals.skipped++;
      continue;
    }
    // Only repair the known failure signature unless explicitly targeted.
    if (!ONLY_RECORD && !/xeroInvoiceId is required/i.test(row.accounting_sync_error || '')) {
      console.log(`  [skip] ${label}: different failure (${row.accounting_sync_error})`);
      totals.skipped++;
      continue;
    }

    console.log(`\n${label} — invoice ${invoiceId} (${row.accounting_invoice_number || row.xero_invoice_number}), PI ${row.stripe_payment_intent_id}, payment_status=${row.payment_status}`);

    try {
      const provider = await getAccountingProvider(row.tenant_id);
      const snapshot = await provider.fetchInvoiceStatus(invoiceId, row.tenant_id);
      console.log(`  remote invoice status: ${snapshot?.status}`);

      if (DRY_RUN) {
        console.log(`  [dry] would ${snapshot?.status === 'paid' ? 'skip payment apply (already paid)' : 'apply Stripe payment'}, clear sync flags, reconcile`);
        continue;
      }

      if (snapshot?.status !== 'paid') {
        await provider.applyStripePaymentToInvoice({
          appTenantId: row.tenant_id,
          invoiceId,
          xeroInvoiceId: invoiceId,
          stripePaymentIntentId: row.stripe_payment_intent_id,
        });
        totals.paymentsApplied++;
        console.log('  Stripe payment applied to invoice.');
      } else {
        totals.alreadyPaidRemote++;
      }

      const { error: updErr } = await supabase
        .from(table)
        .update({ accounting_sync_status: null, accounting_sync_error: null })
        .eq('id', row.id);
      if (updErr) throw new Error(`clearing sync flags failed: ${updErr.message}`);

      const result = await reconcileMembershipInvoicePayment({ table, recordId: row.id });
      console.log('  reconcile:', JSON.stringify(result));
      if (result.transitioned) totals.reconciled++;
    } catch (err) {
      totals.errors++;
      console.error(`  [error] ${label}: ${err.message}`);
    }
  }
}

console.log('\n=== Summary ===');
console.log(JSON.stringify(totals, null, 2));
if (DRY_RUN) console.log('(dry-run — no changes made)');
