// Owner-requested, single-member reconstruction. No invoice/payment creation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './annual-meeting-destination.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode = process.argv[2];
assert.ok(['dry-run', 'apply'].includes(mode));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = '0f2535cf-25ea-4da8-9e9b-214b379d9883';
const recordId = '6cc14e12-1b43-46dc-bf28-0f1d39b74041';
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path) {
  const res = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(res.status, 200, 'Xero evidence unavailable');
  return res.json();
}
const invoices = (await get('Invoices?InvoiceNumbers=300005495')).Invoices;
assert.equal(invoices.length, 1);
const invoice = invoices[0];
assert.equal(invoice.InvoiceID, '190e5482-543b-4f06-98e4-061fa2cc0083');
assert.equal(invoice.Status, 'PAID');
assert.equal(invoice.Type, 'ACCREC');
assert.equal(invoice.CurrencyCode, 'GBP');
assert.equal(invoice.Total, 156);
assert.equal(invoice.AmountPaid, 156);
assert.equal(invoice.AmountDue, 0);
assert.equal(invoice.AmountCredited, 0);
assert.equal(invoice.TotalTax, 0);
assert.equal(invoice.LineItems.length, 1);
assert.equal(invoice.LineItems[0].Description, 'Full Membership UK');
assert.equal(invoice.Payments.length, 1);
assert.equal(invoice.CreditNotes.length, 0);
const payment = (await get(`Payments/${invoice.Payments[0].PaymentID}`)).Payments[0];
assert.equal(payment.Invoice.InvoiceID, invoice.InvoiceID);
assert.equal(payment.Status, 'AUTHORISED');
assert.equal(payment.Amount, 156);
const contact = (await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
const paidAt = new Date(Number(/\/Date\((\d+)/.exec(payment.Date)?.[1])).toISOString();
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const m = (await db.query('SELECT * FROM member WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [member, tenant])).rows[0];
  assert.equal(m.email.toLowerCase(), contact.EmailAddress.toLowerCase());
  const prefs = (await db.query(`SELECT f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
    WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY f.name`, [member, tenant])).rows;
  assert.equal(prefs.find(p => p.name === 'ym_web_site_member_id').value, contact.AccountNumber);
  assert.equal(prefs.find(p => p.name === 'member_class').value, 'Full');
  assert.equal(prefs.find(p => p.name === 'ym_date_membership_expires').value, '30/07/2027');
  for (const table of ['membership_billing_agreements', 'membership_payment_plans']) {
    assert.equal((await db.query(`SELECT id FROM ${table} WHERE member_id=$1 AND tenant_id=$2`, [member, tenant])).rowCount, 0);
  }
  const existing = (await db.query('SELECT * FROM member_membership_history WHERE member_id=$1 AND tenant_id=$2', [member, tenant])).rows;
  assert.ok(existing.length === 0 || (existing.length === 1 && existing[0].id === recordId), 'Unexpected membership history');
  const configs = (await db.query(`SELECT c.* FROM membership_tier_config c JOIN preference_field f ON f.id=c.structure_field_id
    WHERE c.tenant_id=$1 AND f.name='member_class' AND c.structure_match_value='Full' AND c.is_active
    AND c.structure_scope_type='member' AND c.effective_from<=$2 AND (c.effective_to IS NULL OR c.effective_to>=$2)`,
  [tenant, '2026-07-31'])).rows;
  assert.equal(configs.length, 1, 'Expected one applicable Full schedule');
  const config = JSON.parse(JSON.stringify(configs[0]));
  const amounts = { annual_cost: 156, final_cost: 156, vat_amount: 0, total_with_vat: 156, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: '2026-07-31', paymentMethod: 'upfront',
    paymentFrequency: 'upfront', amounts, pricingSnapshot: { tier_label: 'Full', ...amounts } });
  assert.equal(commitment.term_end_date, '2027-07-30');
  const record = { id: recordId, tenant_id: tenant, member_id: member, config_id: config.id, tier_label: 'Full',
    field_value: 'Full', membership_year: commitment.term_key, ...commitment, ...amounts,
    billing_period: 'annual', status: 'active', payment_status: 'paid', payment_method: 'upfront', paid_at: paidAt,
    accounting_provider: 'xero', accounting_invoice_id: invoice.InvoiceID, accounting_invoice_number: invoice.InvoiceNumber,
    xero_invoice_id: invoice.InvoiceID, xero_invoice_number: invoice.InvoiceNumber, accounting_sync_status: null,
    notes: JSON.stringify({ source: 'bnms_owner_requested_paid_membership_reconstruction', version: 1,
      termAuthority: 'annual_term_reconstructed_from_retained_imported_expiry',
      structureAuthority: 'member_class_Full_with_date_applicable_schedule',
      paymentAuthority: 'xero_authorised_payment', paymentId: payment.PaymentID, invoiceId: invoice.InvoiceID,
      futureCollectionConsent: false, providerWrites: 0 }) };
  const dir = 'generated-artifacts/bnms-anver-reconstruction';
  if (mode === 'apply') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${dir}/before-${Date.now()}.json`, JSON.stringify({ m, prefs, existing, record, invoice, payment, contact }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (!existing.length) {
    const keys = Object.keys(record);
    await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      keys.map(k => record[k] && typeof record[k] === 'object' ? JSON.stringify(record[k]) : record[k]));
  }
  const after = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1 AND tenant_id=$2', [recordId, tenant])).rows[0].data;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'paid_at') assert.equal(Date.parse(after[key]), Date.parse(value));
    else assert.deepEqual(after[key], value, key);
  }
  assert.deepEqual((await db.query('SELECT * FROM member WHERE id=$1 AND tenant_id=$2', [member, tenant])).rows[0], m);
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  if (mode === 'apply') {
    const committed = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1', [recordId])).rows[0].data;
    assert.deepEqual(committed, after);
    fs.writeFileSync(`${dir}/receipt-${Date.now()}.json`, JSON.stringify({ committed, invoice, payment }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ mode, replay: !!existing.length, structure: config.name, start: after.term_start_date,
    end: after.term_end_date, amount: after.total_with_vat, paidAt, invoice: invoice.InvoiceNumber, providerWrites: 0 }));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
