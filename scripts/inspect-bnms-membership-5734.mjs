// Read-only membership/provider evidence. No repair authority is implied.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = '23b0f721-27ff-4840-93f8-20379e90e901';
const contactId = 'b4a06c94-80d4-4745-807d-642656f268f5';
assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname, `${PROJECT}.supabase.co`);
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { xeroRateLimitedFetch } = await import('../api/_lib/xeroRateLimit.js');
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path, accept = 'application/json') {
  const response = await xeroRateLimitedFetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: accept },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `Evidence unavailable: ${path}`);
  return accept === 'application/pdf' ? Buffer.from(await response.arrayBuffer()) : response.json();
}
const db = await connectDestination();
const evidence = { capturedAt: new Date().toISOString(), project: PROJECT, tenant, member };
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='30s'");
  const owner = await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2', [member, tenant]);
  assert.equal(owner.rowCount, 1);
  evidence.owner = owner.rows[0].data;
  evidence.preferences = (await db.query(`SELECT v.id,f.name,v.value FROM member_preference_value v
    JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY v.id`, [member, tenant])).rows;
  for (const table of ['member_membership_history', 'historical_member_invoice',
    'membership_billing_agreements', 'membership_payment_plans', 'membership_payment_quote', 'membership_successor_election']) {
    evidence[table] = (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE member_id=$1 AND tenant_id=$2 ORDER BY id`, [member, tenant])).rows.map(r => r.data);
  }
  evidence.configs = (await db.query(`SELECT to_jsonb(c) data FROM membership_tier_config c
    JOIN preference_field f ON f.id=c.structure_field_id WHERE c.tenant_id=$1 AND f.tenant_id=$1
    AND f.name='member_class' AND c.structure_match_value=$2 ORDER BY c.id`,
  [tenant, evidence.preferences.find(p => p.name === 'member_class')?.value])).rows.map(r => r.data);
  await db.query('ROLLBACK');
} finally { await db.end(); }
evidence.contact = (await get(`Contacts/${contactId}`)).Contacts[0];
evidence.invoices = [];
for (let page = 1; ; page++) {
  assert.ok(page <= 20, 'Provider invoice pagination exceeded safety bound');
  const rows = (await get(`Invoices?ContactIDs=${contactId}&page=${page}`)).Invoices;
  assert.ok(Array.isArray(rows));
  evidence.invoices.push(...rows);
  if (!rows.length) break;
}
const invoice = evidence.invoices.find(i => i.InvoiceNumber === '300005516');
assert.equal(invoice?.InvoiceID, 'be86600a-f39b-4a82-b659-5e5d536d8a4b');
assert.equal(invoice.Contact.ContactID, contactId);
evidence.payments = [];
for (const payment of invoice.Payments || []) {
  evidence.payments.push(...(await get(`Payments/${payment.PaymentID}`)).Payments);
}
const pdf = await get(`Invoices/${invoice.InvoiceID}`, 'application/pdf');
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
const dir = 'generated-artifacts/bnms-membership-5734';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(`${dir}/evidence-${Date.now()}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
const pref = name => evidence.preferences.find(p => p.name === name)?.value;
console.log(JSON.stringify({
  capturedAt: evidence.capturedAt, project: PROJECT,
  identity: {
    emailMatches: evidence.owner.email?.toLowerCase() === evidence.contact.EmailAddress?.toLowerCase(),
    accountMatches: pref('ym_web_site_member_id') === evidence.contact.AccountNumber,
    nameMatches: `${evidence.owner.first_name} ${evidence.owner.last_name}`.toLowerCase() === evidence.contact.Name?.toLowerCase(),
  },
  history: evidence.member_membership_history.map(h => ({ id: h.id, start: h.term_start_date, end: h.term_end_date, config: h.config_id })),
  configs: evidence.configs.map(c => ({ id: c.id, name: c.name, match: c.structure_match_value, effectiveFrom: c.effective_from, active: c.is_active })),
  invoices: evidence.invoices.map(i => ({ id: i.InvoiceID, number: i.InvoiceNumber, date: i.DateString,
    status: i.Status, total: i.Total, paid: i.AmountPaid, credited: i.AmountCredited, currency: i.CurrencyCode,
    lines: i.LineItems.map(l => ({ description: l.Description, amount: l.LineAmount })) })),
  payments: evidence.payments.map(p => ({ id: p.PaymentID, invoiceId: p.Invoice?.InvoiceID, status: p.Status, amount: p.Amount, date: p.Date })),
  pdfVerified: true,
  relatedCounts: Object.fromEntries(['membership_billing_agreements', 'membership_payment_plans', 'membership_payment_quote', 'membership_successor_election'].map(k => [k, evidence[k].length])),
  membershipWrites: 0, providerFinancialWrites: 0,
}, null, 2));
export { evidence };
