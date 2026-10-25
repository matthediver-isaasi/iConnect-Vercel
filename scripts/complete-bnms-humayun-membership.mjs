// Individually approved annual reconstruction; preserve original evidence in audit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './annual-meeting-destination.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode = process.argv[2];
assert.ok(['dry-run', 'apply'].includes(mode));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = '1ab1438d-ddee-49b3-a8fe-b51722c2dbbe';
const id = '14a9f3af-a307-5dbf-a092-f8a9faaef045';
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
  assert.equal(r.status, 200, 'Xero verification failed');
  return r.json();
}
const invoices = (await get('Invoices?InvoiceNumbers=300005416')).Invoices;
assert.equal(invoices.length, 1);
const invoice = invoices[0];
assert.equal(invoice.InvoiceID, '552222ac-f33b-4ecd-8c76-f1ab07e41e5c');
assert.equal(invoice.Status, 'PAID');
assert.equal(invoice.Type, 'ACCREC');
assert.equal(invoice.CurrencyCode, 'GBP');
assert.equal(invoice.Total, 156);
assert.equal(invoice.AmountPaid, 156);
assert.equal(invoice.AmountDue, 0);
assert.equal(invoice.AmountCredited, 0);
assert.equal(invoice.CreditNotes.length, 0);
assert.equal(invoice.TotalTax, 0);
assert.equal(invoice.LineItems.length, 1);
assert.equal(invoice.LineItems[0].Description, 'Full Membership DD');
assert.equal(invoice.Payments.length, 1);
const payment = (await get(`Payments/${invoice.Payments[0].PaymentID}`)).Payments[0];
assert.equal(payment.Invoice.InvoiceID, invoice.InvoiceID);
assert.equal(payment.Status, 'AUTHORISED');
assert.equal(payment.Amount, 156);
assert.equal(payment.IsReconciled, true);
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
  // This Xero contact has no legacy account number; the email match above is
  // the independently verified identity. If an account number is supplied it
  // must also agree, rather than silently ignoring conflicting evidence.
  if (contact.AccountNumber) assert.equal(prefs.find(p => p.name === 'ym_web_site_member_id').value, contact.AccountNumber);
  assert.equal(prefs.find(p => p.name === 'member_class').value, 'Full with NMC');
  for (const table of ['membership_billing_agreements', 'membership_payment_plans']) {
    assert.equal((await db.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND member_id=$2`, [tenant, member])).rowCount, 0);
  }
  const rows = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE tenant_id=$1 AND member_id=$2', [tenant, member])).rows;
  assert.equal(rows.length, 1);
  const before = rows[0].data;
  assert.equal(before.id, id);
  assert.equal(before.xero_invoice_id, invoice.InvoiceID);
  assert.equal(before.accounting_invoice_id, invoice.InvoiceID);
  assert.equal(before.payment_status, 'paid');
  assert.equal(Date.parse(before.paid_at), Date.parse(paidAt));
  assert.equal(before.total_with_vat, 156);
  const priorNotes = JSON.parse(before.notes);
  const replay = priorNotes.source === 'bnms_approved_humayun_annual_completion';
  if (!replay) {
    assert.equal(priorNotes.source, 'bnms_five_member_reconstruction_v1');
    assert.equal(before.term_end_date, null);
    assert.equal(before.config_id, null);
    assert.equal(before.term_key, null);
    assert.equal(before.term_start_date.slice(0, 10), '2026-07-30');
  }
  const configs = (await db.query(`SELECT c.* FROM membership_tier_config c JOIN preference_field f ON f.id=c.structure_field_id
    WHERE c.tenant_id=$1 AND f.name='member_class' AND c.structure_match_value='Full with NMC'
    AND c.is_active AND c.structure_scope_type='member' AND c.effective_from<=$2
    AND (c.effective_to IS NULL OR c.effective_to>=$2)`, [tenant, '2026-07-30'])).rows;
  assert.equal(configs.length, 1);
  const config = JSON.parse(JSON.stringify(configs[0]));
  const amounts = { annual_cost: 156, final_cost: 156, vat_amount: 0, total_with_vat: 156, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: '2026-07-30', paymentMethod: 'upfront',
    paymentFrequency: 'upfront', amounts, pricingSnapshot: { tier_label: 'Full with NMC', ...amounts } });
  assert.equal(commitment.term_end_date, '2027-07-29');
  const patch = { ...commitment, ...amounts, config_id: config.id, field_value: 'Full with NMC',
    tier_label: 'Full with NMC', membership_year: commitment.term_key, billing_period: 'annual',
    payment_method: 'upfront',
    notes: replay ? before.notes : JSON.stringify({ source: 'bnms_approved_humayun_annual_completion', version: 1,
      previousEvidence: priorNotes, termAuthority: 'owner_explicitly_approved_2026-07-30_through_2027-07-29',
      structureAuthority: 'owner_approved_current_member_class_Full_with_NMC',
      paymentAuthority: 'xero_authorised_reconciled_full_payment', paymentId: payment.PaymentID,
      invoiceId: invoice.InvoiceID, paymentMethodMeaning: 'fully_settled_annual_term_not_card_or_mandate_authority',
      futureCollectionConsent: false, providerWrites: 0 }) };
  const dir = 'generated-artifacts/bnms-humayun-annual-completion';
  if (mode === 'apply') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${dir}/before-${Date.now()}.json`, JSON.stringify({ before, patch, m, prefs, invoice, payment }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (!replay) {
    const keys = Object.keys(patch);
    const result = await db.query(`UPDATE member_membership_history SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')}
      WHERE id=$${keys.length + 1} AND tenant_id=$${keys.length + 2}`,
    [...keys.map(k => patch[k] && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k]), id, tenant]);
    assert.equal(result.rowCount, 1);
  }
  const after = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1', [id])).rows[0].data;
  for (const [key, value] of Object.entries(patch)) assert.deepEqual(after[key], value, key);
  for (const key of Object.keys(before)) {
    if (!(key in patch) && key !== 'updated_at') assert.deepEqual(after[key], before[key], `Unexpected change to ${key}`);
  }
  assert.deepEqual((await db.query('SELECT * FROM member WHERE id=$1', [member])).rows[0], m);
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  if (mode === 'apply') {
    const persisted = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1', [id])).rows[0].data;
    assert.deepEqual(persisted, after);
    fs.writeFileSync(`${dir}/receipt-${Date.now()}.json`, JSON.stringify({ persisted, invoice, payment }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ mode, replay, structure: config.name, start: after.term_start_date,
    end: after.term_end_date, amount: after.total_with_vat, invoice: after.xero_invoice_number, paidAt, providerWrites: 0 }));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
