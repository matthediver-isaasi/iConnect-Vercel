// Single-member owner-approved reconstruction. Xero financial requests are GET only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './annual-meeting-destination.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode = process.argv[2];
assert.ok(['dry-run', 'apply'].includes(mode));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = 'de5730b6-ff54-489b-aeb3-9b4c4595e8aa';
const recordId = '67fb7c06-9775-4ed4-a1a9-99e7f02789fe';
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path) {
  const r = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200, 'Xero evidence unavailable');
  return r.json();
}
const invoices = (await get('Invoices?InvoiceNumbers=300004905')).Invoices;
assert.equal(invoices.length, 1);
const invoice = invoices[0];
assert.equal(invoice.InvoiceID, '95e0cd5b-a8e5-45be-9252-27477b360860');
assert.equal(invoice.Status, 'PAID');
assert.equal(invoice.Type, 'ACCREC');
assert.equal(invoice.CurrencyCode, 'GBP');
assert.equal(invoice.Total, 61);
assert.equal(invoice.AmountPaid, 61);
assert.equal(invoice.AmountDue, 0);
assert.equal(invoice.AmountCredited, 0);
assert.equal(invoice.TotalTax, 0);
assert.equal(invoice.LineItems.length, 1);
assert.equal(invoice.LineItems[0].Description, 'Trainee Membership DD');
for (const key of ['CreditNotes', 'Prepayments', 'Overpayments']) assert.equal(invoice[key].length, 0);
assert.equal(invoice.Payments.length, 1);
const payment = (await get(`Payments/${invoice.Payments[0].PaymentID}`)).Payments[0];
assert.equal(payment.Invoice.InvoiceID, invoice.InvoiceID);
assert.equal(payment.Status, 'AUTHORISED');
assert.equal(payment.Amount, 61);
assert.equal(payment.IsReconciled, true);
const contact = (await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
// Owner explicitly confirmed this alternate Xero contact despite the email mismatch.
assert.equal(contact.ContactID, '14be1809-86b9-44b7-9010-5c92bae5e2e3');
assert.equal(contact.Name, 'Lavinia Gabara');
const paidAt = new Date(Number(/\/Date\((\d+)/.exec(payment.Date)?.[1])).toISOString();
assert.equal(paidAt, '2026-01-31T00:00:00.000Z');
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const m = (await db.query('SELECT * FROM member WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [member, tenant])).rows[0];
  assert.equal(m.first_name, 'Lavinia');
  assert.equal(m.last_name, 'Gabara');
  const prefsQuery = `SELECT f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
    WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY f.name,v.id`;
  const prefs = (await db.query(prefsQuery, [member, tenant])).rows;
  assert.equal(prefs.find(p => p.name === 'ym_web_site_member_id').value, '81829040');
  assert.equal(prefs.find(p => p.name === 'member_class').value, 'Trainee');
  assert.equal(prefs.find(p => p.name === 'ym_date_membership_expires').value, '31/01/2027');
  const readBilling = async table => (await db.query(`SELECT id FROM ${table} WHERE member_id=$1 AND tenant_id=$2`, [member, tenant])).rows;
  for (const table of ['membership_billing_agreements', 'membership_payment_plans']) assert.deepEqual(await readBilling(table), []);
  const existing = (await db.query('SELECT id FROM member_membership_history WHERE member_id=$1 AND tenant_id=$2', [member, tenant])).rows;
  assert.ok(existing.length === 0 || (existing.length === 1 && existing[0].id === recordId), 'Unexpected membership history');
  const archived = (await db.query('SELECT to_jsonb(i) data FROM historical_member_invoice i WHERE member_id=$1 AND tenant_id=$2 ORDER BY id', [member, tenant])).rows;
  assert.ok(archived.some(r => r.data.invoice_number === invoice.InvoiceNumber && r.data.xero_document_id === invoice.InvoiceID));
  const configs = (await db.query(`SELECT c.* FROM membership_tier_config c JOIN preference_field f ON f.id=c.structure_field_id
    WHERE c.tenant_id=$1 AND f.name='member_class' AND c.structure_match_value='Trainee' AND c.is_active
    AND c.structure_scope_type='member' AND c.effective_from<=$2 AND (c.effective_to IS NULL OR c.effective_to>=$2)`,
  [tenant, '2026-02-01'])).rows;
  assert.equal(configs.length, 1);
  const config = JSON.parse(JSON.stringify(configs[0]));
  const amounts = { annual_cost: 61, final_cost: 61, vat_amount: 0, total_with_vat: 61, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: '2026-02-01', paymentMethod: 'upfront',
    paymentFrequency: 'upfront', amounts, pricingSnapshot: { tier_label: 'Trainee', ...amounts } });
  assert.equal(commitment.term_end_date, '2027-01-31');
  const record = { id: recordId, tenant_id: tenant, member_id: member, config_id: config.id, tier_label: 'Trainee',
    field_value: 'Trainee', membership_year: commitment.term_key, ...commitment, ...amounts,
    billing_period: 'annual', status: 'active', payment_status: 'paid', payment_method: 'upfront', paid_at: paidAt,
    accounting_provider: 'xero', accounting_invoice_id: invoice.InvoiceID, accounting_invoice_number: invoice.InvoiceNumber,
    xero_invoice_id: invoice.InvoiceID, xero_invoice_number: invoice.InvoiceNumber, accounting_sync_status: null,
    notes: JSON.stringify({ source: 'bnms_owner_approved_lavinia_annual_reconstruction', version: 1,
      identityAuthority: 'owner_explicitly_confirmed_alternate_xero_contact_despite_email_mismatch',
      xeroContactId: contact.ContactID, termAuthority: 'owner_approved_annual_term_from_retained_imported_expiry',
      structureAuthority: 'member_class_Trainee_date_applicable_schedule',
      paymentAuthority: 'xero_authorised_reconciled_payment', paymentId: payment.PaymentID, invoiceId: invoice.InvoiceID,
      paymentMethodMeaning: 'fully_settled_annual_term_not_card_or_mandate_authority',
      futureCollectionConsent: false, providerWrites: 0 }) };
  const dir = 'generated-artifacts/bnms-lavinia-reconstruction';
  if (mode === 'apply') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${dir}/before-${Date.now()}.json`, JSON.stringify({ m, prefs, existing, archived, record, invoice, payment, contact }, null, 2), { flag: 'wx', mode: 0o600 });
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
  assert.deepEqual((await db.query(prefsQuery, [member, tenant])).rows, prefs);
  assert.deepEqual((await db.query('SELECT to_jsonb(i) data FROM historical_member_invoice i WHERE member_id=$1 AND tenant_id=$2 ORDER BY id', [member, tenant])).rows, archived);
  for (const table of ['membership_billing_agreements', 'membership_payment_plans']) assert.deepEqual(await readBilling(table), []);
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
