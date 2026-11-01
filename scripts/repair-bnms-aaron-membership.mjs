// Owner-authorised, single-member reconstruction. No financial provider writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './annual-meeting-destination.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode = process.argv[2];
assert.ok(['dry-run', 'apply'].includes(mode));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = 'f12896a6-dcd4-47a9-9894-94ee190f7876';
const history = 'ae426958-da54-5834-ae10-63265fcbf6e8';
const invoiceId = '8040ea49-ffe6-44c4-859b-0a2f3782a7d8';
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { selectCanvasCommitment, buildCanvasSummary } = await import('../api/membership/canvas-summary.js');
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path) {
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, 'Provider evidence unavailable');
  return response.json();
}
const invoice = (await get(`Invoices/${invoiceId}`)).Invoices[0];
assert.equal(invoice.InvoiceID, invoiceId);
assert.equal(invoice.InvoiceNumber, '200008165');
assert.equal(invoice.Status, 'PAID');
assert.equal(invoice.Type, 'ACCREC');
assert.equal(invoice.CurrencyCode, 'GBP');
assert.equal(invoice.Total, 261);
assert.equal(invoice.AmountPaid, 261);
assert.equal(invoice.AmountDue, 0);
assert.equal(invoice.AmountCredited || 0, 0);
for (const key of ['CreditNotes', 'Prepayments', 'Overpayments']) assert.equal((invoice[key] || []).length, 0);
assert.equal(invoice.LineItems.length, 2);
const line = invoice.LineItems.find(l => l.LineItemID === 'fa31d996-0b7e-400e-9681-0c0a0dd259c5');
assert.equal(line.Description, "1 year's trainee membership)");
assert.equal(line.LineAmount, 61);
assert.equal(line.TaxAmount, 0);
assert.equal(line.TaxType, 'ZERORATEDOUTPUT');
assert.equal(invoice.Payments.length, 1);
const payment = (await get(`Payments/${invoice.Payments[0].PaymentID}`)).Payments[0];
assert.equal(payment.Invoice.InvoiceID, invoiceId);
assert.equal(payment.Status, 'AUTHORISED');
assert.equal(payment.Amount, 261);
assert.equal(payment.IsReconciled, true);
const paidAt = new Date(Number(/\/Date\((\d+)/.exec(payment.Date)?.[1])).toISOString();
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='8s'");
  await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const read = async (table) => (await db.query(`select to_jsonb(t) data from ${table} t where tenant_id=$1 and member_id=$2 order by id`, [tenant, member])).rows.map(r => r.data);
  const m = (await db.query('select to_jsonb(m) data from member m where tenant_id=$1 and id=$2 for update', [tenant, member])).rows[0].data;
  assert.equal(m.email.toLowerCase(), invoice.Contact.EmailAddress.toLowerCase(), 'Provider identity mismatch');
  const histories = await read('member_membership_history');
  assert.equal(histories.length, 1);
  const before = histories[0];
  assert.equal(before.id, history);
  assert.equal(before.term_end_date, '2027-04-04');
  assert.equal(before.payment_status, 'paid');
  assert.equal(before.payment_method, 'upfront');
  const previousNotes = JSON.parse(before.notes);
  const replay = previousNotes.source === 'bnms_verified_annual_invoice_reconstruction';
  assert.ok(replay || previousNotes.source === 'bnms_corrected_expiry_operator_attestation');
  const unchanged = {};
  for (const table of ['historical_member_invoice', 'membership_billing_agreements', 'membership_payment_plans', 'membership_expiry_policy_assignment']) unchanged[table] = await read(table);
  assert.equal(unchanged.membership_billing_agreements.length, 0);
  assert.equal(unchanged.membership_payment_plans.length, 0);
  assert.ok(unchanged.historical_member_invoice.some(i => i.xero_document_id === invoiceId));
  const prefs = (await db.query(`select f.name,v.value from member_preference_value v join preference_field f on f.id=v.field_id
    where f.tenant_id=$1 and v.member_id=$2 order by v.id`, [tenant, member])).rows;
  assert.equal(prefs.find(p => p.name === 'member_class').value, 'Trainee');
  const configs = (await db.query(`select to_jsonb(c) data from membership_tier_config c where tenant_id=$1
    and structure_scope_type='member' and structure_match_value='Trainee' and is_active
    and effective_from<='2026-04-05' and (effective_to is null or effective_to>='2026-04-05')`, [tenant])).rows;
  assert.equal(configs.length, 1);
  const config = configs[0].data;
  assert.equal(config.billing_period, 'annual');
  const amounts = { annual_cost: 61, final_cost: 61, vat_amount: 0, total_with_vat: 61, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: '2026-04-05', paymentMethod: 'upfront',
    paymentFrequency: 'upfront', amounts, pricingSnapshot: { tier_label: 'Trainee', ...amounts } });
  assert.equal(commitment.term_end_date, before.term_end_date);
  const patch = { ...commitment, ...amounts, config_id: config.id, tier_label: 'Trainee', field_value: 'Trainee',
    membership_year: commitment.term_key, paid_at: paidAt, accounting_provider: 'xero',
    accounting_invoice_id: invoiceId, accounting_invoice_number: invoice.InvoiceNumber,
    xero_invoice_id: invoiceId, xero_invoice_number: invoice.InvoiceNumber,
    notes: replay ? before.notes : JSON.stringify({
      source: 'bnms_verified_annual_invoice_reconstruction', version: 1, previousEvidence: previousNotes,
      termAuthority: 'owner_authorised_one_year_reconstruction_preserving_recorded_expiry',
      paymentAuthority: 'xero_authorised_reconciled_payment', paymentId: payment.PaymentID,
      invoiceId, membershipLineId: line.LineItemID, membershipAmount: 61, wholeInvoiceAmount: 261,
      structureAuthority: 'member_class_date_applicable_schedule', futureCollectionConsent: false,
      paymentMethodMeaning: 'fully_settled_annual_term_not_card_or_mandate_authority',
    }) };
  const dir = 'generated-artifacts/bnms-aaron-reconstruction';
  if (mode === 'apply' && !replay) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${dir}/before-${Date.now()}.json`, JSON.stringify({ before, patch, invoice, payment }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (!replay) {
    const keys = Object.keys(patch);
    const result = await db.query(`update member_membership_history set ${keys.map((k,i) => `${k}=$${i+1}`).join(',')}
      where id=$${keys.length+1} and tenant_id=$${keys.length+2}`, [...keys.map(k => typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]), history, tenant]);
    assert.equal(result.rowCount, 1);
  }
  const after = (await read('member_membership_history'))[0];
  for (const [key,value] of Object.entries(patch)) {
    if (key === 'paid_at') assert.equal(Date.parse(after[key]), Date.parse(value));
    else assert.deepEqual(after[key], value, key);
  }
  for (const [table,rows] of Object.entries(unchanged)) assert.deepEqual(await read(table), rows);
  assert.deepEqual((await db.query('select to_jsonb(m) data from member m where tenant_id=$1 and id=$2', [tenant,member])).rows[0].data, m);
  const today = new Date().toISOString().slice(0,10);
  const summary = buildCanvasSummary({ selected: selectCanvasCommitment([{ ...after, membership_source: 'personal' }], [], today), today });
  assert.equal(summary.membership.state, 'active');
  assert.equal(summary.payment.state, 'paid');
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ mode, replay, invoice: invoice.InvoiceNumber, membershipAmount:61, start:after.term_start_date,
    end:after.term_end_date, paidAt, summary, providerFinancialWrites:0 }));
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
