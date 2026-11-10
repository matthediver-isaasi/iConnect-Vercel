// Owner-requested single-record reconstruction; provider financial calls are GET-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
import { classifyAnnualRenewal } from '../api/_lib/annualRenewalPolicy.js';
const mode = process.argv[2];
assert.ok(['dry-run', 'apply', 'verify'].includes(mode));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = '4cc3ae66-281b-4475-a56e-0a6b70d40445';
const historyId = 'c782c575-7b80-5617-ab1d-7da52f12a6a5';
const invoiceId = 'ebd9b71e-9389-47ce-909f-63d411bc92a2';
const configId = '07f35246-907a-411d-be78-2b3a9587ce3a';
const source = 'owner_requested_priftakis_invoice_reconstruction';
const dir = 'generated-artifacts/priftakis-membership-repair';
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { xeroRateLimitedFetch } = await import('../api/_lib/xeroRateLimit.js');
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path) {
  const r = await xeroRateLimitedFetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  assert.equal(r.status, 200, 'Xero evidence unavailable');
  return r.json();
}
const invoices = (await get('Invoices?InvoiceNumbers=300004700')).Invoices;
assert.equal(invoices.length, 1);
const invoice = invoices[0];
assert.equal(invoice.InvoiceID, invoiceId);
assert.equal(invoice.Status, 'PAID');
assert.equal(invoice.CurrencyCode, 'GBP');
assert.equal(invoice.Total, 156);
assert.equal(invoice.AmountPaid, 156);
assert.equal(invoice.AmountCredited, 0);
assert.equal(invoice.TotalTax, 0);
assert.equal(invoice.LineItems.length, 1);
assert.equal(invoice.LineItems[0].Description, 'Full Membership UK');
assert.equal(invoice.Payments.length, 1);
const payment = (await get(`Payments/${invoice.Payments[0].PaymentID}`)).Payments[0];
assert.equal(payment.Invoice.InvoiceID, invoiceId);
assert.equal(payment.Status, 'AUTHORISED');
assert.equal(payment.Amount, 156);
const contact = (await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
assert.equal(contact.Name, 'Dimitrios Priftakis');
const paidAt = new Date(Number(/\/Date\((\d+)/.exec(payment.Date)?.[1])).toISOString();
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const owner = (await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [member, tenant])).rows[0].data;
  assert.equal(owner.first_name, 'Dimitrios'); assert.equal(owner.last_name, 'Priftakis');
  const read = async table => (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE member_id=$1 AND tenant_id=$2 ORDER BY id`, [member, tenant])).rows.map(r => r.data);
  const prefsSql = `SELECT v.id,f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY v.id`;
  const prefs = (await db.query(prefsSql, [member, tenant])).rows;
  assert.equal(prefs.find(p => p.name === 'member_class').value, 'Full with NMC');
  assert.equal(prefs.find(p => p.name === 'ym_date_membership_expires').value, '26/10/2026');
  const archive = await read('historical_member_invoice');
  assert.ok(archive.some(i => i.invoice_number === '300004700' && i.xero_document_id === invoiceId));
  for (const table of ['membership_billing_agreements', 'membership_payment_plans', 'membership_payment_quote', 'membership_successor_election']) assert.deepEqual(await read(table), []);
  const history = await read('member_membership_history');
  assert.equal(history.length, 1);
  const before = history[0]; assert.equal(before.id, historyId);
  const config = (await db.query('SELECT to_jsonb(c) data FROM membership_tier_config c WHERE id=$1 AND tenant_id=$2 FOR SHARE', [configId, tenant])).rows[0].data;
  assert.equal(config.structure_match_value, 'Full with NMC');
  assert.equal(config.is_active, true); assert.equal(config.renewal_grace_days, 90);
  const amounts = { annual_cost: 156, final_cost: 156, vat_amount: 0, total_with_vat: 156, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: '2025-10-27', paymentMethod: 'upfront',
    paymentFrequency: 'upfront', amounts, pricingSnapshot: { tier_label: 'Full with NMC', ...amounts } });
  assert.equal(commitment.term_end_date, '2026-10-26');
  function verify(after) {
    for (const [k,v] of Object.entries({ ...commitment, ...amounts, config_id: configId, accounting_invoice_id: invoiceId,
      accounting_invoice_number: '300004700', status: 'active', payment_status: 'paid' })) assert.deepEqual(after[k], v, k);
    assert.equal(Date.parse(after.paid_at), Date.parse(paidAt));
    const renewal = classifyAnnualRenewal({ previousRecord: after, config, now: new Date('2026-11-10T12:00:00Z') });
    assert.equal(renewal.eligible, true);
    assert.equal(renewal.target.start.toISOString().slice(0,10), '2026-10-27');
    return renewal;
  }
  if (mode === 'verify') {
    assert.equal(JSON.parse(before.notes).source, source);
    console.log(JSON.stringify({ mode, renewal: verify(before), invoice: '300004700', paidAt }));
    await db.query('ROLLBACK');
  } else {
    assert.equal(JSON.parse(before.notes).source, 'bnms_non_dd_current_backfill');
    assert.equal(before.term_start_date, null); assert.equal(before.term_end_date, '2026-10-26');
    assert.equal(before.commitment_snapshot, null); assert.equal(before.accounting_invoice_id, null);
    const patch = { ...commitment, ...amounts, config_id: configId, field_value: 'Full with NMC', tier_label: 'Full with NMC',
      membership_year: commitment.term_key, paid_at: paidAt, accounting_provider: 'xero',
      accounting_invoice_id: invoiceId, accounting_invoice_number: '300004700', xero_invoice_id: invoiceId, xero_invoice_number: '300004700',
      notes: JSON.stringify({ source, version: 1, originalRecord: before,
        termAuthority: 'owner_requested_annual_reconstruction_retaining_imported_expiry',
        structureAuthority: 'current_member_class_schedule_assumption_not_original_purchase_policy',
        paymentAuthority: 'xero_authorised_payment', invoiceId, paymentId: payment.PaymentID,
        futureCollectionConsent: false, providerWrites: 0 }) };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const proposed = { owner, before, config, patch };
    if (mode === 'apply') assert.deepEqual(proposed, JSON.parse(fs.readFileSync(`${dir}/dry-run.json`)));
    fs.writeFileSync(`${dir}/${mode}-${Date.now()}.json`, JSON.stringify({ proposed, invoice, payment }, null, 2), { mode: 0o600, flag: 'wx' });
    const keys = Object.keys(patch);
    const result = await db.query(`UPDATE member_membership_history h SET ${keys.map((k,i) => `${k}=$${i+1}`).join(',')}
      WHERE id=$${keys.length+1} AND tenant_id=$${keys.length+2} AND to_jsonb(h)=$${keys.length+3}::jsonb RETURNING to_jsonb(h) data`,
    [...keys.map(k => patch[k] !== null && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k]), historyId, tenant, JSON.stringify(before)]);
    assert.equal(result.rowCount, 1);
    const renewal = verify(result.rows[0].data);
    assert.deepEqual((await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1', [member])).rows[0].data, owner);
    assert.deepEqual((await db.query(prefsSql, [member, tenant])).rows, prefs);
    assert.deepEqual(await read('historical_member_invoice'), archive);
    if (mode === 'dry-run') fs.writeFileSync(`${dir}/dry-run.json`, JSON.stringify(proposed), { mode: 0o600 });
    await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode, invoice: '300004700', start: commitment.term_start_date, end: commitment.term_end_date, renewal, providerWrites: 0 }));
  }
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
