import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
import { assessPostGraceRenewal } from '../api/_lib/postGraceRenewal.js';
const apply = process.argv.includes('--apply');
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = '6b75ccfb-5ec7-4162-812a-587911453dec';
const historyId = 'ac0a2dce-b277-548c-ab8f-0f51969422e5';
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
  assert.equal(r.status, 200);
  return r.json();
}
const invoice = (await get('Invoices/7d656fd6-c50d-42ec-acbd-9026c0b38fa9')).Invoices[0];
assert.equal(invoice.InvoiceNumber, '300004413');
assert.equal(invoice.Status, 'PAID');
assert.equal(invoice.Total, 128);
assert.equal(invoice.AmountPaid, 128);
assert.equal(invoice.AmountDue, 0);
assert.equal(invoice.AmountCredited || 0, 0);
assert.equal(invoice.TotalTax, 0);
assert.equal(invoice.CurrencyCode, 'GBP');
assert.equal(invoice.LineItems.length, 1);
assert.equal(invoice.LineItems[0].Description, 'Junior Membership DD');
assert.equal(invoice.Payments.length, 1);
const payment = (await get(`Payments/${invoice.Payments[0].PaymentID}`)).Payments[0];
assert.equal(payment.Invoice.InvoiceID, invoice.InvoiceID);
assert.equal(payment.Status, 'AUTHORISED');
assert.equal(payment.Amount, 128);
assert.equal(payment.IsReconciled, true);
const contact = (await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
const paidAt = new Date(Number(/\/Date\((\d+)/.exec(payment.Date)[1])).toISOString();
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const owner = (await db.query('select * from member where id=$1 and tenant_id=$2 for update', [member, tenant])).rows[0];
  assert.equal(contact.EmailAddress.toLowerCase(), owner.email.toLowerCase());
  assert.equal(owner.login_enabled, true);
  assert.equal(owner.membership_paused, false);
  assert.equal(owner.membership_cancelled, false);
  const histories = (await db.query('select to_jsonb(h) data from member_membership_history h where member_id=$1 and tenant_id=$2 for update', [member, tenant])).rows.map(r => r.data);
  assert.equal(histories.length, 1);
  const old = histories[0];
  assert.equal(old.id, historyId);
  assert.equal(old.status, 'expired');
  const replay = old.term_start_date === '2025-06-13';
  if (!replay) {
    assert.equal(old.term_start_date, null);
    assert.equal(old.term_end_date, '2026-08-01');
    assert.equal(old.term_key, null);
  }
  for (const table of ['membership_billing_agreements', 'membership_payment_plans', 'membership_successor_election', 'membership_expiry_policy_assignment']) {
    assert.equal((await db.query(`select id from ${table} where tenant_id=$1 and member_id=$2`, [tenant, member])).rowCount, 0, table);
  }
  const prefs = (await db.query(`select v.*,f.name from member_preference_value v join preference_field f on f.id=v.field_id
    where v.member_id=$1 and f.tenant_id=$2 order by v.id`, [member, tenant])).rows;
  assert.equal(prefs.find(p => p.name === 'member_class').value, 'Full junior');
  const expiry = prefs.find(p => p.name === 'ym_date_membership_expires');
  assert.equal(expiry.value, replay ? '12/06/2026' : '01/08/2026');
  const configs = (await db.query('select to_jsonb(c) data from membership_tier_config c where tenant_id=$1', [tenant])).rows.map(r => r.data);
  const config = configs.find(c => c.id === '0c68ef89-8543-4dc8-a759-20ab9b2598f5');
  assert.equal(config.structure_match_value, 'Full junior');
  assert.equal(config.renewal_grace_days, 90);
  const amounts = { annual_cost: 128, final_cost: 128, vat_amount: 0, total_with_vat: 128, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: '2025-06-13', paymentMethod: 'upfront', paymentFrequency: 'upfront', amounts });
  assert.equal(commitment.term_end_date, '2026-06-12');
  const patch = {
    ...commitment, ...amounts, config_id: config.id,
    membership_year: commitment.term_key, field_value: 'Full junior', tier_label: 'Junior Membership UK',
    payment_method: 'upfront', payment_status: 'paid', paid_at: paidAt,
    accounting_provider: 'xero', accounting_invoice_id: invoice.InvoiceID, accounting_invoice_number: invoice.InvoiceNumber,
    xero_invoice_id: invoice.InvoiceID, xero_invoice_number: invoice.InvoiceNumber,
    notes: replay ? old.notes : JSON.stringify({
      source: 'owner_approved_jed_term_reconstruction', version: 1, originalEvidence: JSON.parse(old.notes),
      termAuthority: 'owner_explicit_13_June_2025_to_12_June_2026',
      invoiceIssueDate: invoice.DateString, invoiceDueDate: invoice.DueDateString,
      paymentAuthority: 'live_Xero_authorised_reconciled_payment', paymentId: payment.PaymentID,
      renewalPolicyAuthority: 'current_exact_member_class_schedule_for_owner_requested_post_grace_renewal',
      historicalScheduleCaveat: 'Current schedule supplies renewal policy, not original purchase configuration or price.',
      paymentMethodMeaning: 'settled_annual_term_no_continuing_DD_authority', futureCollectionConsent: false, providerWrites: 0,
    }),
  };
  const eligibility = assessPostGraceRenewal({ tenantId: tenant, member: owner,
    histories: [{ ...old, ...patch }], agreements: [], configs, enabled: true });
  assert.equal(eligibility.eligible, true, JSON.stringify(eligibility));
  if (!replay) {
    if (apply) {
      fs.mkdirSync('generated-artifacts/jed-reconstruction', { recursive: true, mode: 0o700 });
      fs.writeFileSync(`generated-artifacts/jed-reconstruction/before-${Date.now()}.json`,
        JSON.stringify({ owner, old, prefs, invoice, payment, patch }, null, 2), { mode: 0o600, flag: 'wx' });
    }
    const keys = Object.keys(patch);
    const result = await db.query(`update member_membership_history set ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')}
      where id=$${keys.length + 1} and tenant_id=$${keys.length + 2}`,
    [...keys.map(k => typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]), historyId, tenant]);
    assert.equal(result.rowCount, 1);
    assert.equal((await db.query('update member_preference_value set value=$1 where id=$2 and value=$3',
      ['12/06/2026', expiry.id, expiry.value])).rowCount, 1);
  }
  const after = (await db.query('select to_jsonb(h) data from member_membership_history h where id=$1', [historyId])).rows[0].data;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'paid_at') assert.equal(Date.parse(after[k]), Date.parse(v));
    else assert.deepEqual(after[k], v, k);
  }
  const ownerAfter = (await db.query('select * from member where id=$1', [member])).rows[0];
  // Preference changes may invalidate eligibility caches; retain that security trigger.
  for (const k of Object.keys(owner)) if (!['updated_at', 'survey_invitation_revision'].includes(k)) assert.deepEqual(ownerAfter[k], owner[k], k);
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ apply, replay, invoice: invoice.InvoiceNumber, start: after.term_start_date,
    end: after.term_end_date, status: after.status, postGraceEligible: eligibility.eligible, providerWrites: 0 }));
} catch (e) { await db.query('ROLLBACK'); throw e; } finally { await db.end(); }
