/**
 * One-off correction for the GFI 2025/2026 organisation membership history
 * row that was recorded without an accounting invoice and left unpaid.
 *
 * Usage:
 *   node scripts/fix-gfi-2025-membership-payment-status.mjs          # dry-run
 *   node scripts/fix-gfi-2025-membership-payment-status.mjs --apply  # apply
 *
 * Uses the destination Supabase only. It refuses ambiguous matches and
 * conditionally repeats every safety predicate on update.
 */
import { createClient } from '@supabase/supabase-js';

const TENANT_SLUG = 'gfi';
const ORGANIZATION_ID = '55a86410-7f60-4451-a45c-5760d93ccf1a';
const ORGANIZATION_NAME = 'Abertay University';
const HISTORY_ID = 'a06c952f-e718-49a3-b763-c4ce988578a4';
const MEMBERSHIP_YEAR = '2025/2026';
const apply = process.argv.includes('--apply');

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const columns = [
  'id',
  'tenant_id',
  'organization_id',
  'membership_year',
  'status',
  'payment_status',
  'paid_at',
  'accounting_invoice_id',
  'accounting_invoice_number',
  'xero_invoice_id',
  'xero_invoice_number',
].join(', ');

function hasNoProviderInvoice(row) {
  return !row.accounting_invoice_id
    && !row.accounting_invoice_number
    && !row.xero_invoice_id
    && !row.xero_invoice_number;
}

async function readYearRows(tenantId) {
  const { data, error } = await supabase
    .from('organisation_membership_history')
    .select(columns)
    .eq('id', HISTORY_ID)
    .eq('tenant_id', tenantId)
    .eq('organization_id', ORGANIZATION_ID)
    .eq('membership_year', MEMBERSHIP_YEAR);
  if (error) throw new Error(`Could not read membership history: ${error.message}`);
  return data || [];
}

async function main() {
  const { data: tenants, error: tenantError } = await supabase
    .from('tenant')
    .select('id, name, slug')
    .eq('slug', TENANT_SLUG);
  if (tenantError) throw new Error(`Could not resolve GFI tenant: ${tenantError.message}`);
  if (tenants?.length !== 1) {
    throw new Error(`Refusing to proceed: expected exactly one tenant slug=${TENANT_SLUG}, found ${tenants?.length || 0}.`);
  }

  const tenant = tenants[0];
  if (!/graduate futures institute/i.test(tenant.name || '')) {
    throw new Error(`Refusing to proceed: tenant slug=${TENANT_SLUG} has unexpected name "${tenant.name}".`);
  }
  console.log('TENANT:', JSON.stringify(tenant));

  const { data: organizations, error: organizationError } = await supabase
    .from('organization')
    .select('id, tenant_id, name')
    .eq('id', ORGANIZATION_ID)
    .eq('tenant_id', tenant.id);
  if (organizationError) throw new Error(`Could not resolve target organisation: ${organizationError.message}`);
  if (organizations?.length !== 1 || organizations[0].name !== ORGANIZATION_NAME) {
    throw new Error(`Refusing to proceed: expected ${ORGANIZATION_NAME} (${ORGANIZATION_ID}) in GFI.`);
  }
  console.log('ORGANISATION:', JSON.stringify(organizations[0]));

  const beforeRows = await readYearRows(tenant.id);
  // Legacy NULL is rendered and treated as Unpaid throughout membership history.
  const eligible = beforeRows.filter((row) => (row.payment_status === null || row.payment_status === 'unpaid') && hasNoProviderInvoice(row));
  const alreadyCorrected = beforeRows.filter((row) => row.payment_status === 'paid' && hasNoProviderInvoice(row));

  if (eligible.length === 0 && alreadyCorrected.length === 1) {
    console.log('BEFORE:', JSON.stringify(alreadyCorrected[0]));
    console.log('No change needed — the single no-invoice 2025/2026 row is already Paid.');
    return;
  }
  if (eligible.length !== 1) {
    throw new Error(`Refusing to proceed: expected the one pinned unpaid, no-invoice ${MEMBERSHIP_YEAR} row; found ${eligible.length}.`);
  }

  const target = eligible[0];
  console.log('BEFORE:', JSON.stringify(target));
  if (!apply) {
    console.log('DRY-RUN: would set payment_status=paid. Re-run with --apply to commit.');
    return;
  }

  const { data: updated, error: updateError } = await supabase
    .from('organisation_membership_history')
    .update({ payment_status: 'paid' })
    .eq('id', target.id)
    .eq('tenant_id', tenant.id)
    .eq('organization_id', ORGANIZATION_ID)
    .eq('membership_year', MEMBERSHIP_YEAR)
    .or('payment_status.eq.unpaid,payment_status.is.null')
    .is('accounting_invoice_id', null)
    .is('accounting_invoice_number', null)
    .is('xero_invoice_id', null)
    .is('xero_invoice_number', null)
    .select(columns);
  if (updateError) throw new Error(`Update failed: ${updateError.message}`);
  if (updated?.length !== 1) {
    throw new Error(`Verification failed: guarded update changed ${updated?.length || 0} rows instead of 1.`);
  }

  const afterRows = await readYearRows(tenant.id);
  const after = afterRows.find((row) => row.id === target.id);
  if (!after || after.payment_status !== 'paid' || !hasNoProviderInvoice(after)) {
    throw new Error('Verification failed: target row did not re-read as Paid with no provider invoice.');
  }
  console.log('AFTER:', JSON.stringify(after));
  console.log('Done — corrected exactly one GFI organisation membership history row.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});