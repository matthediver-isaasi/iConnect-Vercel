// Exact owner-approved reconstruction. No accounting/payment/email writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';

const mode = process.argv[2];
assert.ok(['dry-run', 'apply', 'verify'].includes(mode));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = '18200101-8739-41fc-83a8-37df91a612f7';
const id = '6fb4b9c8-3f44-467c-951a-fda1759bcb10';
destinationTarget(process.env);
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { shapePersistedCommitment } = await import('../api/membership/member-membership.js');
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
const response = await fetch('https://api.xero.com/api.xro/2.0/Invoices/021c634f-42d0-4d7c-959b-1a18678b04b8', {
  headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
  signal: AbortSignal.timeout(30000),
});
assert.equal(response.status, 200);
const invoice = (await response.json()).Invoices[0];
assert.equal(invoice.InvoiceNumber, '200008338');
assert.equal(invoice.Contact.ContactID, 'a95569ef-12e1-4e0b-b628-d0ecc58519f3');
assert.equal(invoice.Total, 420);
assert.equal(invoice.AmountPaid, 0);
assert.equal(invoice.AmountCredited, 420);
assert.equal(invoice.AmountDue, 0);
const line = invoice.LineItems.find(l => l.LineItemID === '4d2ecda3-bc68-49dd-a782-a253435ab0f8');
assert.equal(line.Description, "1 year's junior membership");
assert.equal(line.LineAmount, 128);
assert.equal(line.TaxAmount, 0);
assert.ok(invoice.CreditNotes.some(c => c.CreditNoteNumber === 'CN-9361' && c.AppliedAmount === 420));

const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const read = async (table) => (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE member_id=$1 AND tenant_id=$2 ORDER BY id`, [member, tenant])).rows.map(r => r.data);
  const m = (await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [member, tenant])).rows[0].data;
  const prefSql = `SELECT v.id,f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY v.id`;
  const prefs = (await db.query(prefSql, [member, tenant])).rows;
  assert.equal(prefs.find(p => p.name === 'member_class')?.value, 'Full junior');
  assert.equal(prefs.find(p => p.name === 'ym_date_membership_expires')?.value, '22/10/2027');
  const archived = await read('historical_member_invoice');
  assert.ok(archived.some(i => i.invoice_number === invoice.InvoiceNumber && i.xero_document_id === invoice.InvoiceID));
  for (const table of ['membership_billing_agreements', 'membership_payment_plans']) assert.deepEqual(await read(table), []);
  const existing = await read('member_membership_history');
  assert.ok(!existing.length || (existing.length === 1 && existing[0].id === id), 'Unexpected membership history');
  const config = (await db.query(`SELECT to_jsonb(c) data FROM membership_tier_config c
    WHERE id='0c68ef89-8543-4dc8-a759-20ab9b2598f5' AND tenant_id=$1
    AND is_active AND structure_match_value='Full junior'
    AND effective_from<='2026-10-23' AND (effective_to IS NULL OR effective_to>='2026-10-23')`, [tenant])).rows[0]?.data;
  assert.ok(config);
  const amounts = { annual_cost: 128, final_cost: 128, vat_amount: 0, total_with_vat: 128, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: '2026-10-23',
    paymentMethod: 'upfront', paymentFrequency: 'upfront', amounts,
    pricingSnapshot: { tier_label: 'Full junior', ...amounts } });
  assert.equal(commitment.term_end_date, '2027-10-22');
  const notes = {
    source: 'owner_confirmed_junior_membership_reconstruction', version: 1,
    paymentAuthority: 'owner_explicitly_confirmed_payment_received_despite_fully_credited_xero_invoice',
    termAuthority: 'owner_approved_current_annual_term_from_retained_expiry',
    invoiceNumber: invoice.InvoiceNumber, invoiceId: invoice.InvoiceID,
    membershipLineAmount: 128, excludedEventLineAmount: 292,
    xeroAmountPaid: 0, xeroAmountCredited: 420, xeroCreditNote: 'CN-9361',
    paymentDate: 'not_verified', futureCollectionConsent: false,
    explanation: 'Owner instructed that invoice 200008338 be accepted as payment evidence for this current membership. Xero cleared the invoice by credit, not a cash payment. No provider settlement is fabricated.',
  };
  const record = { id, tenant_id: tenant, member_id: member, config_id: config.id,
    tier_label: 'Full junior', field_value: 'Full junior', membership_year: commitment.term_key,
    ...commitment, ...amounts, billing_period: 'annual', status: 'active',
    payment_status: 'paid', payment_method: 'upfront', paid_at: null,
    accounting_provider: 'xero', accounting_invoice_id: invoice.InvoiceID,
    accounting_invoice_number: invoice.InvoiceNumber, xero_invoice_id: invoice.InvoiceID,
    xero_invoice_number: invoice.InvoiceNumber, accounting_sync_status: null,
    notes: JSON.stringify(notes) };
  if (mode === 'verify') assert.equal(existing.length, 1);
  if (!existing.length) {
    if (mode === 'apply') {
      fs.mkdirSync('generated-artifacts/junior-owner-confirmed-reconstruction', { recursive: true, mode: 0o700 });
      fs.writeFileSync(`generated-artifacts/junior-owner-confirmed-reconstruction/before-${Date.now()}.json`,
        JSON.stringify({ m, prefs, existing, archived, record, invoice }, null, 2), { flag: 'wx', mode: 0o600 });
    }
    const keys = Object.keys(record);
    await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      keys.map(k => record[k] && typeof record[k] === 'object' ? JSON.stringify(record[k]) : record[k]));
  }
  const after = (await read('member_membership_history'))[0];
  for (const [key, value] of Object.entries(record)) assert.deepEqual(after[key], value, key);
  assert.ok(shapePersistedCommitment(after), 'Member payment-details projection must recognise the commitment');
  assert.deepEqual((await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2', [member, tenant])).rows[0].data, m);
  assert.deepEqual((await db.query(prefSql, [member, tenant])).rows, prefs);
  assert.deepEqual(await read('historical_member_invoice'), archived);
  for (const table of ['membership_billing_agreements', 'membership_payment_plans']) assert.deepEqual(await read(table), []);
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ mode, replay: !!existing.length, start: after.term_start_date,
    end: after.term_end_date, amount: after.total_with_vat, invoice: invoice.InvoiceNumber,
    status: after.status, paymentAuthority: notes.paymentAuthority, providerWrites: 0 }));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
