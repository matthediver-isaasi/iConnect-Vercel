// Accounting GETs only. OAuth renewal may persist rotated credentials.
import fs from 'node:fs/promises';
import { compareMembership } from './lib/gfi-membership-comparison.mjs';
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { supabase: db } = await import('../api/_lib/database.js');
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const companyId = '608971fe-5a0d-4031-80bb-3d9d438e90fb';
const out = 'generated-artifacts/gfi-membership-xero-comparison';
await fs.mkdir(out, { recursive: true });
const check = result => { if (result.error) throw new Error(result.error.message); return result.data; };
const histories = check(await db.from('organisation_membership_history').select(
  'id,organization_id,membership_year,currency,final_cost,vat_amount,total_with_vat,payment_status,accounting_invoice_id,xero_invoice_id')
  .eq('tenant_id', tenantId).order('id').limit(1000));
if (histories.length === 1000) throw new Error('History pagination required');
const orgs = check(await db.from('organization').select('id,name').eq('tenant_id', tenantId).order('id').limit(1000));
if (orgs.length === 1000) throw new Error('Organisation pagination required');
const names = new Map(orgs.map(o => [o.id, o.name]));
const targets = histories.filter(h => h.membership_year === '2025/2026' && Number(h.final_cost) > 0
  && !h.accounting_invoice_id && !h.xero_invoice_id && names.has(h.organization_id))
  .map(h => ({ ...h, organization: names.get(h.organization_id) }));
const linkedIds = new Set(histories.flatMap(h => [h.accounting_invoice_id, h.xero_invoice_id]).filter(Boolean));
const memberLinks = check(await db.from('member_membership_history').select('accounting_invoice_id,xero_invoice_id')
  .eq('tenant_id', tenantId).order('id').limit(1000));
if (memberLinks.length === 1000) throw new Error('Member link pagination required');
for (const row of memberLinks) for (const id of [row.accounting_invoice_id, row.xero_invoice_id]) if (id) linkedIds.add(id);
const token = await getValidXeroAccessToken(tenantId);
if (token.tenantId !== companyId) throw new Error('Provider company mismatch');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function read(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(1200);
    const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token.accessToken}`, 'xero-tenant-id': companyId,
        Accept: 'application/json' }, signal: AbortSignal.timeout(30000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      const delay = Number(response.headers.get('retry-after') || 10 * (attempt + 1));
      if (!Number.isFinite(delay) || delay > 120) throw new Error('Provider cooldown exceeds audit budget');
      console.log(`Provider cooldown: ${delay}s`);
      await sleep(delay * 1000); continue;
    }
    if (!response.ok) throw new Error(`Xero GET ${path.split('?')[0]} HTTP ${response.status}`);
    return response.json();
  }
}
async function all(kind) {
  const items = [], seen = new Set();
  for (let page = 1; page <= 200; page++) {
    const payload = await read(`${kind}?page=${page}&pageSize=100${kind === 'Contacts' ? '&includeArchived=true' : ''}`);
    const rows = payload[kind];
    if (!Array.isArray(rows)) throw new Error(`Incomplete ${kind} response`);
    for (const row of rows) {
      const id = row[kind === 'Contacts' ? 'ContactID' : 'InvoiceID'];
      if (!id || seen.has(id)) throw new Error(`Unstable ${kind} pagination`);
      seen.add(id); items.push(row);
    }
    console.log(`${kind}: page ${page}, ${items.length} records`);
    if (rows.length < 100) return items;
  }
  throw new Error(`Incomplete ${kind} scan: pagination cap reached`);
}
console.log(`Historical targets: ${targets.length}`);
const contacts = await all('Contacts');
const invoices = await all('Invoices');
const slimInvoice = i => ({ id: i.InvoiceID, number: i.InvoiceNumber, contactId: i.Contact?.ContactID,
  status: i.Status, reference: i.Reference, currency: i.CurrencyCode, net: i.SubTotal, tax: i.TotalTax,
  total: i.Total, due: i.AmountDue, date: i.DateString || i.Date,
  lines: i.LineItems?.map(l => ({ description: l.Description, net: l.LineAmount, tax: l.TaxAmount })) });
const results = targets.map(row => {
  const compared = compareMembership(row, contacts, invoices, linkedIds);
  return { ...row, finding: compared.finding, matchedInvoices: compared.matches.map(slimInvoice),
    periodCandidates: compared.candidates.map(slimInvoice), otherContactSameAmounts: compared.otherContactSameAmounts,
    contactInvoiceCount: compared.contactInvoices.length,
    contactInvoices: compared.contactInvoices.map(slimInvoice) };
});
const summary = { checkedAt: new Date().toISOString(), companyId, targets: targets.length,
  scannedContacts: contacts.length, scannedInvoices: invoices.length, accountingWrites: 0,
  counts: Object.fromEntries([...new Set(results.map(r => r.finding))].map(f => [f, results.filter(r => r.finding === f).length])) };
await fs.writeFile(`${out}/evidence.json`, JSON.stringify({ summary, results }, null, 2));
const columns = ['organization','membership_year','currency','final_cost','vat_amount','total_with_vat','payment_status',
  'finding','invoice_numbers','xero_statuses','xero_balances','contactInvoiceCount','otherContactSameAmounts','organization_id','id'];
const cell = value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
await fs.writeFile(`${out}/comparison.csv`, [columns, ...results.map(r => columns.map(k =>
  k === 'invoice_numbers' ? r.matchedInvoices.map(i => i.number).join('; ')
    : k === 'xero_statuses' ? r.matchedInvoices.map(i => i.status).join('; ')
      : k === 'xero_balances' ? r.matchedInvoices.map(i => i.due).join('; ') : r[k]))].map(row => row.map(cell).join(',')).join('\r\n'));
console.log(JSON.stringify(summary, null, 2));
