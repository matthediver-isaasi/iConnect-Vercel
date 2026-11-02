// Narrow approved repair: activate a verified paid term and link its predecessor invoice.
// No provider writes or email/workflow dispatch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const mode = process.argv[2];
assert.ok(['dry-run', 'apply', 'verify'].includes(mode));
destinationTarget(process.env);
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { runScheduledActivation } = await import('../api/_lib/directDebitOwnerPipeline.js');
const { getStripeCredentials } = await import('../api/_lib/stripeCredentials.js');
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { default: Stripe } = await import('stripe');
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db', member = '53095180-56fe-42cd-a8c0-88f0c773c530';
const oldId = 'd90ba9ef-2e94-5d81-a612-51218b860d9a', currentId = 'f367ee9f-f5e1-4f1f-ad98-57db32191a63';
const oldInvoice = 'ff4cad45-d2cc-4ee8-a622-47a76b53b8da', currentInvoice = 'f283c5b9-4579-4441-96cc-26c92405de2d';
const credentials = await getStripeCredentials(tenant, 'membership');
const stripe = new Stripe(credentials.secret_key);
const intent = await stripe.paymentIntents.retrieve('pi_3UQrJm0UfSpC8b2b1OA6rkj2', { expand: ['latest_charge'] });
assert.equal(intent.livemode, true);
assert.equal(intent.status, 'succeeded');
assert.equal(intent.amount_received, 15600);
assert.equal(intent.currency, 'gbp');
assert.equal(intent.metadata.member_id, member);
assert.equal(intent.metadata.tenant_id, tenant);
assert.equal(intent.latest_charge.amount_refunded, 0);
assert.equal(intent.latest_charge.disputed, false);
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
for (const [id, number, description] of [[oldInvoice, '300004667', 'Full Membership UK'], [currentInvoice, 'INV-9378', 'Full membership.']]) {
  const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${id}`, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(res.status, 200);
  const invoice = (await res.json()).Invoices[0];
  assert.equal(invoice.InvoiceNumber, number);
  assert.equal(invoice.Contact.Name, 'George Yeung');
  assert.equal(invoice.Status, 'PAID');
  assert.equal(invoice.Total, 156);
  assert.equal(invoice.AmountPaid, 156);
  assert.equal(invoice.AmountDue, 0);
  assert.equal(invoice.AmountCredited || 0, 0);
  assert.ok(invoice.LineItems.some(l => l.Description.startsWith(description)));
}
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const history = async () => (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE member_id=$1 AND tenant_id=$2 ORDER BY id FOR UPDATE', [member, tenant])).rows.map(r => r.data);
  const prefSql = `SELECT v.id,f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY v.id`;
  const before = await history(), previous = before.find(r => r.id === oldId), current = before.find(r => r.id === currentId);
  assert.equal(before.length, 2);
  const prefs = (await db.query(prefSql, [member, tenant])).rows;
  const expiry = prefs.filter(r => r.name === 'ym_date_membership_expires');
  assert.equal(expiry.length, 1);
  const archiveSql = 'SELECT to_jsonb(i) data FROM historical_member_invoice i WHERE member_id=$1 AND tenant_id=$2 ORDER BY id';
  const archives = (await db.query(archiveSql, [member, tenant])).rows;
  assert.ok(archives.some(r => r.data.xero_document_id === oldInvoice));
  assert.equal(current.payment_status, 'paid');
  assert.equal(current.stripe_payment_intent_id, intent.id);
  assert.equal(current.term_start_date, '2026-10-17');
  assert.equal(current.term_end_date, '2027-10-16');
  assert.equal(current.total_with_vat, 156);
  assert.equal(current.xero_invoice_id, currentInvoice);
  const replay = current.status === 'active';
  if (mode === 'verify') assert.ok(replay);
  if (!replay) {
    assert.equal(current.status, 'scheduled');
    assert.equal(expiry[0].value, '16/10/2026');
    assert.equal(previous.xero_invoice_id, null);
    assert.equal(previous.accounting_invoice_id, null);
    if (mode === 'apply') {
      fs.mkdirSync('generated-artifacts/verified-scheduled-member', { recursive: true, mode: 0o700 });
      fs.writeFileSync(`generated-artifacts/verified-scheduled-member/before-${Date.now()}.json`, JSON.stringify({ before, prefs, archives }, null, 2), { mode: 0o600, flag: 'wx' });
    }
    const activation = await runScheduledActivation({ row: current, tenantId: tenant, scope: 'member', now: new Date(),
      effects: { async perform(operation) {
        assert.equal(operation.type, 'owner.activate_scheduled');
        const result = await db.query(`UPDATE member_membership_history SET status='active',annual_renewal_state='renewed',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='scheduled' RETURNING id`, [currentId, tenant]);
        return { data: result.rows, error: null };
      } } });
    assert.ok(activation.activated);
    const notes = JSON.parse(previous.notes);
    notes.invoiceAuthority = 'verified_xero_membership_invoice';
    notes.invoiceReviewState = 'verified_matching_membership_invoice';
    notes.invoiceLinkVerification = { number: '300004667', total: 156, amountPaid: 156, checkedAt: new Date().toISOString() };
    await db.query(`UPDATE member_membership_history SET accounting_provider='xero',accounting_invoice_id=$1,xero_invoice_id=$1,accounting_invoice_number='300004667',xero_invoice_number='300004667',notes=$2 WHERE id=$3 AND tenant_id=$4`, [oldInvoice, JSON.stringify(notes), oldId, tenant]);
    await db.query(`UPDATE member_membership_history SET notes=coalesce(notes,'') || $1 WHERE id=$2 AND tenant_id=$3`,
      ['\n[Verified activation repair] Live Stripe payment and paid Xero INV-9378 reverified; overdue scheduled term activated without new collection or invoice. Legacy expiry aligned to 16/10/2027.', currentId, tenant]);
    const changed = await db.query("UPDATE member_preference_value SET value='16/10/2027' WHERE id=$1 AND member_id=$2 AND value='16/10/2026'", [expiry[0].id, member]);
    assert.equal(changed.rowCount, 1);
  }
  const after = await history();
  const nowCurrent = after.find(r => r.id === currentId), nowOld = after.find(r => r.id === oldId);
  assert.equal(nowCurrent.status, 'active');
  assert.equal(nowCurrent.annual_renewal_state, 'renewed');
  assert.equal(nowOld.xero_invoice_id, oldInvoice);
  assert.equal(nowOld.accounting_invoice_number, '300004667');
  for (const old of before) {
    const now = after.find(r => r.id === old.id);
    const allowed = old.id === currentId ? ['status', 'annual_renewal_state', 'updated_at', 'notes']
      : ['accounting_provider', 'accounting_invoice_id', 'xero_invoice_id', 'accounting_invoice_number', 'xero_invoice_number', 'notes', 'updated_at'];
    for (const key of Object.keys(old)) if (!allowed.includes(key)) assert.deepEqual(now[key], old[key], key);
  }
  const afterPrefs = (await db.query(prefSql, [member, tenant])).rows;
  assert.deepEqual(afterPrefs, prefs.map(p => p.id === expiry[0].id ? { ...p, value: '16/10/2027' } : p));
  assert.deepEqual((await db.query(archiveSql, [member, tenant])).rows, archives);
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ mode, replay, status: nowCurrent.status, end: nowCurrent.term_end_date, currentInvoice: nowCurrent.xero_invoice_number, previousInvoice: nowOld.xero_invoice_number, providerWrites: 0 }));
} catch (e) { await db.query('ROLLBACK'); throw e; }
finally { await db.end(); }
