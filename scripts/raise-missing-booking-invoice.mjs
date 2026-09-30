#!/usr/bin/env node
/**
 * One-off remediation: raise a missing Xero invoice for a single booking group
 * (tenant GFI) where the post-booking invoice flow failed silently, leaving
 * the booking with no Xero invoice and no account_charge transaction row.
 * Used for OOE-1770381875481-N766O (6 Feb 2026) and OOE-1770907303824-L30DM
 * (12 Feb 2026).
 *
 * Hard-pinned to tenant GFI and a single booking group per run — this is NOT
 * a general backfill tool.
 *
 * Usage:
 *   node scripts/raise-missing-booking-invoice.mjs --booking=<GROUP_REF>            # dry run (default)
 *   node scripts/raise-missing-booking-invoice.mjs --booking=<GROUP_REF> --apply    # create the invoice
 *
 * Idempotency guards:
 *   - If the bookings already carry a Xero invoice id/number, invoice creation
 *     is skipped but the script continues so the account_charge backfill
 *     still runs (re-running after a partial failure is safe).
 *   - Searches Xero for an existing ACCREC invoice with the PO reference
 *     before creating; if one exists it is adopted (ids written back) instead
 *     of creating a duplicate.
 *   - The account_charge row is only inserted if absent.
 */

// The workspace default SUPABASE_URL points at the stale legacy SOURCE DB.
// Force the DEST (prod) project before importing any api/_lib modules.
if (process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY (or SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const bookingArg = process.argv.find((a) => a.startsWith('--booking='));
const BOOKING_GROUP_REFERENCE = bookingArg ? bookingArg.slice('--booking='.length).trim() : '';
if (!BOOKING_GROUP_REFERENCE) {
  console.error('Missing --booking=<GROUP_REF> argument (e.g. --booking=OOE-1770907303824-L30DM).');
  process.exit(1);
}
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d'; // GFI

const { supabase } = await import('../api/_lib/database.js');
const { getValidXeroAccessToken, findOrCreateXeroContact } = await import('../api/_lib/xero.js');

function fail(msg) {
  console.error(`ABORT: ${msg}`);
  process.exit(1);
}

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to make changes)'}`);
console.log(`Booking group: ${BOOKING_GROUP_REFERENCE}`);

// ---------------------------------------------------------------------------
// 1. Load the booking group and related records
// ---------------------------------------------------------------------------
const { data: bookings, error: bookingsErr } = await supabase
  .from('booking')
  .select('id, booking_group_reference, attendee_email, attendee_first_name, attendee_last_name, member_id, organization_id, total_cost, payment_method, purchase_order_number, po_to_follow, status, xero_invoice_id, xero_invoice_number, ticket_class_id, event_id')
  .eq('booking_group_reference', BOOKING_GROUP_REFERENCE);
if (bookingsErr) fail(`booking lookup failed: ${bookingsErr.message}`);
if (!bookings || bookings.length === 0) fail('no bookings found for group');

console.log(`Found ${bookings.length} booking(s) in group.`);
for (const b of bookings) {
  console.log(`  - ${b.id} ${b.attendee_first_name} ${b.attendee_last_name} <${b.attendee_email}> £${b.total_cost} status=${b.status} xero=${b.xero_invoice_number || 'NONE'}`);
}

const already = bookings.filter((b) => b.xero_invoice_id || b.xero_invoice_number);
const invoiceAlreadyLinked = already.length > 0;
if (invoiceAlreadyLinked) {
  console.log(`Booking(s) already have a Xero invoice: ${already.map((b) => b.xero_invoice_number || b.xero_invoice_id).join(', ')} — skipping invoice creation, will still backfill the account_charge row if missing.`);
}

const first = bookings[0];
if (first.payment_method !== 'account') fail(`unexpected payment_method ${first.payment_method}`);
if (!first.organization_id) fail('booking has no organization_id');

const purchaseOrderNumber = (first.purchase_order_number || '').trim();
if (!purchaseOrderNumber) fail('booking has no purchase order number');

const totalToInvoice = bookings.reduce((sum, b) => sum + (Number(b.total_cost) || 0), 0);
if (!(totalToInvoice > 0)) fail(`total to invoice is £${totalToInvoice}`);

const { data: event, error: eventErr } = await supabase
  .from('event')
  .select('id, title, internal_reference, xero_account_code, pricing_config, tenant_id')
  .eq('id', first.event_id)
  .single();
if (eventErr || !event) fail(`event lookup failed: ${eventErr?.message}`);
if (event.tenant_id !== TENANT_ID) fail(`event tenant ${event.tenant_id} does not match expected ${TENANT_ID}`);

const { data: org, error: orgErr } = await supabase
  .from('organization')
  .select('id, name, invoicing_email')
  .eq('id', first.organization_id)
  .single();
if (orgErr || !org) fail(`organization lookup failed: ${orgErr?.message}`);

const ticketClass = (event.pricing_config?.ticket_classes || []).find((tc) => tc.id === first.ticket_class_id) || null;
const ticketClassName = ticketClass?.name || 'Standard';
const vatRateKey = ticketClass?.vat_rate_key || null;
const ticketUnitPrice = Number(ticketClass?.price) || (totalToInvoice / bookings.length);

// ---------------------------------------------------------------------------
// 2. Tenant settings (same resolution as the booking flow)
// ---------------------------------------------------------------------------
async function getSetting(key) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', key)
    .eq('tenant_id', TENANT_ID)
    .maybeSingle();
  if (error) fail(`system_settings lookup failed for ${key}: ${error.message}`);
  return data?.setting_value ?? null;
}

const xeroInvoiceEnabled = (await getSetting('xero_invoice_enabled')) === 'true';
if (!xeroInvoiceEnabled) fail('xero_invoice_enabled is not true for this tenant');
const systemDefaultAccountCode = (await getSetting('xero_sales_account_code')) || '200';
const eventAccountCode = (event.xero_account_code || '').trim();
const xeroAccountCode = eventAccountCode || systemDefaultAccountCode;
const xeroInvoiceStatus = (await getSetting('xero_invoice_status')) || 'DRAFT';

// ---------------------------------------------------------------------------
// 3. Build the invoice payload (mirrors api/functions/[functionName].js flow)
// ---------------------------------------------------------------------------
const attendeeList = bookings
  .map((b) => `${b.attendee_first_name || ''} ${b.attendee_last_name || ''}`.trim() || b.attendee_email)
  .join('\n');

const ticketsRequired = bookings.length;
const ticketSubtotal = ticketUnitPrice * ticketsRequired;
const financialBreakdown = [
  `${ticketsRequired} x ${ticketClassName} @ £${ticketUnitPrice.toFixed(2)} = £${ticketSubtotal.toFixed(2)}`,
  `Total to invoice: £${totalToInvoice.toFixed(2)}`,
];

const lineDescription = [
  `Event: ${event.title || 'One-off Event'}`,
  `Reference: ${event.internal_reference || 'N/A'}`,
  `Ticket class: ${ticketClassName}`,
  `Attendees: ${ticketsRequired}`,
  attendeeList,
  '',
  '----------',
  'Financial Breakdown:',
  ...financialBreakdown,
].join('\n');

const dueDate = new Date();
dueDate.setDate(dueDate.getDate() + 30);
const dueDateString = dueDate.toISOString().split('T')[0];

const lineItem = {
  Description: lineDescription,
  Quantity: 1,
  UnitAmount: totalToInvoice,
  AccountCode: xeroAccountCode,
};
if (vatRateKey) lineItem.TaxType = vatRateKey;
if (event.internal_reference) {
  lineItem.Tracking = [{ Name: 'Projects', Option: event.internal_reference }];
}

console.log('\n--- Planned invoice ---');
console.log(`Contact: ${org.name}${org.invoicing_email ? ` <${org.invoicing_email}>` : ''}`);
console.log(`Reference: ${purchaseOrderNumber}`);
console.log(`Status: ${xeroInvoiceStatus}, DueDate: ${dueDateString}`);
console.log(`AccountCode: ${xeroAccountCode} (${eventAccountCode ? 'event' : 'tenant default'}), TaxType: ${vatRateKey || '(none)'}`);
console.log(`Tracking: ${event.internal_reference ? `Projects / ${event.internal_reference}` : '(none)'}`);
console.log(`Amount: £${totalToInvoice.toFixed(2)}`);
console.log('Line description:\n' + lineDescription.split('\n').map((l) => '  | ' + l).join('\n'));

// ---------------------------------------------------------------------------
// 4. Xero: check for an existing invoice with this reference first
// ---------------------------------------------------------------------------
const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(TENANT_ID);
if (!accessToken || !xeroTenantId) fail('could not obtain Xero access token');
console.log('\nXero access token OK.');

const where = encodeURIComponent(`Reference=="${purchaseOrderNumber}" AND Type=="ACCREC"`);
const searchRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices?where=${where}`, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'xero-tenant-id': xeroTenantId,
    Accept: 'application/json',
  },
});
if (!searchRes.ok) fail(`Xero invoice search failed: ${searchRes.status} ${(await searchRes.text()).slice(0, 300)}`);
const searchData = await searchRes.json();
const existing = (searchData?.Invoices || []).filter((i) => i.Status !== 'DELETED' && i.Status !== 'VOIDED');

let invoice = null;
if (existing.length > 0) {
  invoice = existing[0];
  console.log(`Existing Xero invoice found with reference ${purchaseOrderNumber}: ${invoice.InvoiceNumber} (${invoice.Status}, total ${invoice.Total}) — will ADOPT it, not create a new one.`);
} else {
  console.log(`No existing Xero invoice with reference ${purchaseOrderNumber}.`);
}

if (!APPLY) {
  console.log('\nDRY RUN complete — no changes made. Re-run with --apply to execute.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 5. APPLY: create the invoice (if needed)
// ---------------------------------------------------------------------------
if (!invoice) {
  const contactId = await findOrCreateXeroContact(accessToken, xeroTenantId, {
    name: org.name,
    email: org.invoicing_email || null,
    isOrganization: true,
  });
  if (!contactId) fail('could not resolve Xero contact');
  console.log(`Xero contact ID: ${contactId}`);

  const invoicePayload = {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    DueDate: dueDateString,
    LineItems: [lineItem],
    Reference: purchaseOrderNumber,
    Status: xeroInvoiceStatus,
  };

  const createRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ Invoices: [invoicePayload] }),
  });
  const createText = await createRes.text();
  let createData = null;
  try { createData = JSON.parse(createText); } catch { /* noop */ }
  if (!createRes.ok || !createData?.Invoices?.length) {
    fail(`Xero invoice creation failed: ${createRes.status} ${createText.slice(0, 500)}`);
  }
  invoice = createData.Invoices[0];
  console.log(`Invoice CREATED: ${invoice.InvoiceNumber} (${invoice.InvoiceID}) status=${invoice.Status} total=${invoice.Total}`);
}

// ---------------------------------------------------------------------------
// 6. APPLY: write invoice ids back to the booking group
// ---------------------------------------------------------------------------
const { error: updateErr } = await supabase
  .from('booking')
  .update({ xero_invoice_id: invoice.InvoiceID, xero_invoice_number: invoice.InvoiceNumber })
  .eq('booking_group_reference', BOOKING_GROUP_REFERENCE);
if (updateErr) fail(`failed to update bookings with invoice ids: ${updateErr.message}`);
console.log(`Bookings updated with invoice ${invoice.InvoiceNumber}.`);

// ---------------------------------------------------------------------------
// 7. APPLY: backfill the missing account_charge transaction row (if absent)
// ---------------------------------------------------------------------------
const { data: existingTx, error: txLookupErr } = await supabase
  .from('program_ticket_transaction')
  .select('id')
  .eq('transaction_type', 'account_charge')
  .eq('booking_reference', BOOKING_GROUP_REFERENCE);
if (txLookupErr) fail(`account_charge lookup failed: ${txLookupErr.message}`);

if (existingTx && existingTx.length > 0) {
  console.log(`account_charge row already exists (${existingTx[0].id}) — skipping insert.`);
} else {
  const { error: txInsertErr } = await supabase
    .from('program_ticket_transaction')
    .insert({
      organization_id: org.id,
      tenant_id: TENANT_ID,
      transaction_type: 'account_charge',
      program_name: event.title || 'One-off Event',
      quantity: bookings.length,
      total_cost_before_discount: totalToInvoice,
      booking_reference: BOOKING_GROUP_REFERENCE,
      event_name: event.title || 'One-off Event',
      member_email: first.attendee_email,
      purchase_order_number: purchaseOrderNumber,
      po_to_follow: false,
      notes: `Account charge: £${totalToInvoice.toFixed(2)} for ${event.title || 'event'} (PO: ${purchaseOrderNumber}) [backfilled ${new Date().toISOString().split('T')[0]} — original invoice attempt failed silently]`,
    });
  if (txInsertErr) fail(`account_charge insert failed: ${txInsertErr.message}`);
  console.log('account_charge transaction row inserted.');
}

console.log('\nDone.');
