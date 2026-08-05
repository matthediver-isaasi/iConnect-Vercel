/**
 * Task #1017 — One-off backfill: silently mark historic membership invoices
 * as paid/voided based on the provider's current view, WITHOUT firing the
 * workflow engine. Run once after the 20260525_membership_history_payment_status
 * migration has been applied, BEFORE the reconcile-membership-invoice-payments
 * cron is enabled in production.
 *
 * Behaviour:
 *   - For each `organisation_membership_history` / `member_membership_history`
 *     row with `payment_status='unpaid'` AND an accounting_invoice_id (or
 *     legacy xero_invoice_id), call the row's accounting provider for status.
 *   - Update `payment_status` + `paid_at` directly via Supabase. Workflows
 *     are intentionally NOT fired (option b chosen by the user).
 *   - Skip rows without an invoice id, voided/already-paid rows, and rows
 *     whose provider is 'none'.
 *   - Idempotent: re-running only touches rows still flagged 'unpaid'.
 *
 * Usage:
 *   node scripts/backfill-membership-payment-status.mjs                # both tables
 *   node scripts/backfill-membership-payment-status.mjs --table=organisation_membership_history
 *   node scripts/backfill-membership-payment-status.mjs --tenant=<uuid>
 *   node scripts/backfill-membership-payment-status.mjs --limit=100
 *   node scripts/backfill-membership-payment-status.mjs --dry-run
 *
 * Requires env: DEST_SUPABASE_URL, DEST_SUPABASE_KEY (service-role), plus
 * the usual XERO_* / QuickBooks per-tenant credentials in `xero_token` /
 * `quickbooks_token` rows so the provider can reach the API.
 */
import { createClient } from '@supabase/supabase-js';

// The provider helpers (`api/_lib/xero.js`, `api/_lib/quickbooks.js`)
// import `api/_lib/database.js`, which reads `SUPABASE_URL` /
// `SUPABASE_SERVICE_KEY`. In this workspace those env vars may not be
// set — only the `DEST_*` ones are. Mirror them across BEFORE any
// `api/_lib/*` module is imported so the provider's internal Supabase
// client is configured against the same destination DB the script
// itself uses.
if (!process.env.SUPABASE_URL && process.env.DEST_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
}
if (!process.env.SUPABASE_SERVICE_KEY && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const TABLES = args.table
  ? [args.table]
  : ['organisation_membership_history', 'member_membership_history'];
const TENANT_FILTER = args.tenant || null;
const LIMIT = args.limit ? Number(args.limit) : 5000;
const DRY_RUN = !!args['dry-run'];

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Lazy-import provider helpers so the script works from this repo with
// the existing module layout.
const { getAccountingProviderByName, PROVIDER_XERO, PROVIDER_NONE } = await import('../api/_lib/accountingProvider.js');

const totals = { scanned: 0, paid: 0, voided: 0, partial: 0, unchanged: 0, errors: 0, skipped: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRateLimitRetry(fn, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      await sleep(1200); // stay under Xero's 60 req/min tenant limit
      return await fn();
    } catch (err) {
      if (i < attempts - 1 && /429/.test(String(err.message))) {
        console.log(`  [429] rate limited, waiting 30s (attempt ${i + 1}/${attempts})…`);
        await sleep(30_000);
        continue;
      }
      throw err;
    }
  }
}

for (const table of TABLES) {
  console.log(`\n=== Backfilling ${table} ${DRY_RUN ? '(dry-run)' : ''} ===`);
  let query = supabase
    .from(table)
    .select('*')
    // NULL counts as unpaid (Task #3409) — most historic rows never had
    // payment_status set at creation, so an .eq('unpaid') filter misses them.
    .or('payment_status.eq.unpaid,payment_status.is.null')
    .or('accounting_invoice_id.not.is.null,xero_invoice_id.not.is.null')
    .order('created_at', { ascending: true })
    .limit(LIMIT);
  if (TENANT_FILTER) query = query.eq('tenant_id', TENANT_FILTER);

  const { data: rows, error } = await query;
  if (error) {
    console.error(`Failed to load ${table}: ${error.message}`);
    continue;
  }

  console.log(`Loaded ${rows.length} candidate row(s).`);

  for (const row of rows) {
    totals.scanned++;
    const invoiceId = row.accounting_invoice_id || row.xero_invoice_id;
    const providerName = row.accounting_provider || PROVIDER_XERO;
    if (!invoiceId) { totals.skipped++; continue; }
    if (providerName === PROVIDER_NONE) { totals.skipped++; continue; }

    let snapshot;
    try {
      const provider = getAccountingProviderByName(providerName);
      // Throttle + retry: Xero rate-limits at ~60 calls/min per tenant.
      snapshot = await withRateLimitRetry(() => provider.fetchInvoiceStatus(invoiceId, row.tenant_id));
    } catch (err) {
      totals.errors++;
      console.error(`  [error] ${table}#${row.id} provider=${providerName}: ${err.message}`);
      continue;
    }
    if (!snapshot) { totals.skipped++; continue; }

    const newStatus = snapshot.status;
    if (newStatus === 'unpaid') { totals.unchanged++; continue; }

    if (newStatus === 'paid') totals.paid++;
    else if (newStatus === 'voided') totals.voided++;
    else if (newStatus === 'partial') totals.partial++;

    if (DRY_RUN) {
      console.log(`  [dry] ${table}#${row.id} would be set to ${newStatus} (invoice ${invoiceId})`);
      continue;
    }

    const update = { payment_status: newStatus };
    if (newStatus === 'paid' && snapshot.paidAt) update.paid_at = snapshot.paidAt;

    const { error: updateErr } = await supabase
      .from(table)
      .update(update)
      .eq('id', row.id);
    if (updateErr) {
      totals.errors++;
      console.error(`  [error] ${table}#${row.id} update failed: ${updateErr.message}`);
    } else {
      console.log(`  ${table}#${row.id} -> ${newStatus}${update.paid_at ? ` @ ${update.paid_at}` : ''}`);
    }
  }
}

console.log('\n=== Summary ===');
console.log(JSON.stringify(totals, null, 2));
console.log(DRY_RUN ? '\n(no rows were modified — re-run without --dry-run to apply)' : '\nDone.');
