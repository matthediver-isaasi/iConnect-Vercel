// Narrow operator recovery. Dry-run by default; --apply authorizes only the
// pinned paid history row. No membership workflows, emails, or Stripe writes.
import { connectDestination } from './annual-meeting-destination.mjs';

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const MEMBER = '53095180-56fe-42cd-a8c0-88f0c773c530';
const HISTORY = 'f367ee9f-f5e1-4f1f-ad98-57db32191a63';
const PI = 'pi_3UQrJm0UfSpC8b2b1OA6rkj2';
const QUOTE = '7416ed82-a818-4427-bb9c-e5471b6c8cc1';
const COMPANY = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const CONTACT = '8b1b0f8f-8644-4888-97d4-fe26d1c4f9fb';
const assert = (ok, message) => { if (!ok) throw Error(message); };
const apply = process.argv.includes('--apply');
const db = await connectDestination();
try {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  const xero = await import('../api/_lib/xero.js');
  const { retrieveTenantPaymentIntent } = await import('../api/_lib/stripeCredentials.js');
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout = '5s'");
  const { rows: [row] } = await db.query(
    'SELECT * FROM member_membership_history WHERE id=$1 AND tenant_id=$2 AND member_id=$3 FOR UPDATE',
    [HISTORY, TENANT, MEMBER]);
  assert(row && row.stripe_payment_intent_id === PI && row.payment_status === 'paid'
    && Number(row.final_cost) === 156 && Number(row.total_with_vat) === 156
    && Number(row.vat_amount) === 0 && row.currency === 'GBP'
    && row.membership_payment_quote_id === QUOTE && !row.billing_agreement_id,
  'History authority changed; stop');
  const { rows: owners } = await db.query(
    'SELECT id FROM accounting_request_queue WHERE tenant_id=$1 AND source_id=$2',
    [TENANT, HISTORY]);
  const { rows: submissions } = await db.query(
    'SELECT id FROM form_submission WHERE tenant_id=$1 AND payment_reference=$2',
    [TENANT, PI]);
  assert(!owners.length && !submissions.length, 'Another recovery owner exists');
  const { rows: [quote] } = await db.query(
    'SELECT * FROM membership_payment_quote WHERE id=$1 AND tenant_id=$2 AND member_id=$3',
    [QUOTE, TENANT, MEMBER]);
  const sim = quote?.quote?.simResult;
  assert(quote?.stripe_payment_intent_id === PI && !quote.organization_id
    && !quote.cancelled_for_switch_at && sim?.finalCost === 156
    && sim.totalWithVat === 156 && sim.vatAmount === 0 && sim.currency === 'GBP'
    && sim.membershipYear.label === row.membership_year
    && sim.config?.nominal_code === '200' && !quote.quote.addonLines?.length,
  'Original quote no longer matches');
  const { rows: [member] } = await db.query(
    'SELECT first_name,last_name,email FROM member WHERE id=$1 AND tenant_id=$2', [MEMBER, TENANT]);
  const { rows: [provider] } = await db.query(
    'SELECT active_provider FROM tenant_accounting_settings WHERE tenant_id=$1', [TENANT]);
  assert(provider?.active_provider === 'xero', 'Accounting provider changed');
  const { paymentIntent: pi } = await retrieveTenantPaymentIntent(TENANT, 'membership', PI);
  assert(pi.id === PI && pi.status === 'succeeded' && pi.amount_received === 15600
    && pi.amount === 15600 && pi.currency === 'gbp' && pi.metadata.member_id === MEMBER
    && pi.metadata.tenant_id === TENANT && pi.metadata.membership_quote_id === QUOTE,
  'Stripe evidence does not match');
  const auth = await xero.getValidXeroAccessToken(TENANT);
  assert(auth.tenantId === COMPANY, 'Xero company changed');
  const get = async path => {
    const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': COMPANY,
        Accept: 'application/json' }, signal: AbortSignal.timeout(20000),
    });
    assert(response.ok, `Xero read failed: ${response.status}`);
    return response.json();
  };
  const contact = (await get(`Contacts/${CONTACT}`)).Contacts?.[0];
  assert(contact?.EmailAddress?.toLowerCase() === member.email.toLowerCase(), 'Contact ownership changed');
  const accounts = (await get('Accounts')).Accounts || [];
  assert(accounts.some(a => a.Code === '200' && a.TaxType === 'ZERORATEDOUTPUT'
    && a.Status === 'ACTIVE'), 'Revenue/tax terms changed');
  assert(accounts.some(a => a.Code === '600' && a.Type === 'BANK'
    && a.Status === 'ACTIVE'), 'Stripe clearing account unavailable');
  const { rows: [bank] } = await db.query(
    "SELECT setting_value FROM system_settings WHERE tenant_id=$1 AND setting_key='xero_stripe_bank_account_code'",
    [TENANT]);
  assert(bank?.setting_value === '600', 'Clearing account changed');

  let invoiceId = row.accounting_invoice_id || row.xero_invoice_id;
  const discovered = await xero.findFormStripeXeroInvoice({ appTenantId: TENANT,
    stripePaymentIntentId: PI, createdAfter: '2026-10-15', expectedProviderContext: COMPANY });
  assert(!invoiceId || !discovered || discovered.invoice_id === invoiceId, 'Conflicting invoice evidence');
  invoiceId ||= discovered?.invoice_id;
  const contactInvoices = (await get(`Invoices?ContactIDs=${CONTACT}`)).Invoices || [];
  assert(!contactInvoices.some(i => i.InvoiceID !== invoiceId
    && String(i.DateString || '').slice(0, 10) >= '2026-10-15'
    && !['VOIDED', 'DELETED'].includes(i.Status)), 'Recent invoice requires manual review');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', historyId: HISTORY,
    amount: 156, currency: 'GBP', stripeStatus: pi.status, existingInvoice: invoiceId || null }));
  if (!apply) {
    await db.query('ROLLBACK');
  } else {
    if (!invoiceId) {
      // Existing provider helper, frozen quote, explicit zero tax, fixed verified
      // contact (no contact writes), and a durable exact-PI discovery marker.
      const created = await xero.createXeroMembershipInvoice({
        appTenantId: TENANT, organizationName: [member.first_name, member.last_name].filter(Boolean).join(' '),
        invoicingEmail: member.email, membershipYear: row.membership_year,
        tierLabel: sim.tierLabel, finalCost: 156, currency: 'GBP',
        reference: `Membership ${row.membership_year}`, nominalCode: '200',
        vatRate: { taxType: 'ZERORATEDOUTPUT' }, markAsPaid: false,
        deferStripeSettlement: true, stripePaymentIntentId: PI,
        invoiceDescription: sim.config.invoice_description,
        idempotencyKey: `membership-upfront-invoice:${TENANT}:${PI}`,
        expectedProviderContext: COMPANY,
      }, { findOrCreateXeroContact: async () => CONTACT });
      invoiceId = created.invoice_id;
      console.log(JSON.stringify({ createdInvoiceId: invoiceId, number: created.invoice_number }));
    }
    let invoice = (await get(`Invoices/${invoiceId}`)).Invoices?.[0];
    assert(invoice?.Contact?.ContactID === CONTACT && invoice.Total === 156
      && invoice.TotalTax === 0 && invoice.CurrencyCode === 'GBP', 'Invoice economics mismatch');
    const settlement = await xero.settleFormStripeXeroInvoice({
      appTenantId: TENANT, invoiceId, stripePaymentIntentId: PI, amount: 156, currency: 'GBP',
      paidAt: new Date(pi.created * 1000).toISOString(), expectedAccount: '600',
      expectedProviderContext: COMPANY, operationKey: `membership-upfront-settlement:${TENANT}:${PI}`,
    });
    assert(settlement.payment_recorded && settlement.annotation_recorded,
      `Invoice ${invoiceId} retained; settlement requires review: ${settlement.error}`);
    invoice = (await get(`Invoices/${invoiceId}`)).Invoices?.[0];
    assert(invoice?.Status === 'PAID' && invoice.AmountDue === 0 && invoice.AmountPaid === 156,
      'Provider has not confirmed full settlement');
    const result = await db.query(`UPDATE member_membership_history
      SET accounting_provider='xero', accounting_invoice_id=$1, xero_invoice_id=$1,
        accounting_invoice_number=$2, xero_invoice_number=$2,
        accounting_sync_status=NULL, accounting_sync_error=NULL
      WHERE id=$3 AND tenant_id=$4 AND member_id=$5 AND payment_status='paid'
      RETURNING id,payment_status,accounting_invoice_id,accounting_invoice_number,accounting_sync_status`,
    [invoiceId, invoice.InvoiceNumber, HISTORY, TENANT, MEMBER]);
    assert(result.rowCount === 1, 'History linkage failed');
    await db.query('COMMIT');
    console.log(JSON.stringify({ recovered: result.rows[0], providerStatus: invoice.Status,
      total: invoice.Total, amountPaid: invoice.AmountPaid, amountDue: invoice.AmountDue }));
  }
} catch (error) {
  await db.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
