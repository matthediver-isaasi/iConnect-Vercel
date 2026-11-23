// GET-only provider evidence; the inherited inspection also verifies the current term.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evidence } from './inspect-bnms-membership-5734.mjs';
import { connectDestination } from './lib/member-index-destination.mjs';
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { xeroRateLimitedFetch } = await import('../api/_lib/xeroRateLimit.js');
const auth = await getValidXeroAccessToken(evidence.tenant);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path, pdf = false) {
  const r = await xeroRateLimitedFetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    method: 'GET', headers: { Authorization: `Bearer ${auth.accessToken}`,
      'xero-tenant-id': auth.tenantId, Accept: pdf ? 'application/pdf' : 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200, `Evidence unavailable: ${path}`);
  return pdf ? Buffer.from(await r.arrayBuffer()) : r.json();
}
const candidates = evidence.invoices.filter(i => i.InvoiceNumber === '300004583');
assert.equal(candidates.length, 1);
evidence.olderInvoice = candidates[0];
evidence.olderDetail = (await get(`Invoices/${candidates[0].InvoiceID}`)).Invoices[0];
evidence.olderPayments = [];
for (const p of candidates[0].Payments) {
  evidence.olderPayments.push(...(await get(`Payments/${p.PaymentID}`)).Payments);
}
const pdf = await get(`Invoices/${candidates[0].InvoiceID}`, true);
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
evidence.olderPdfBytes = pdf.length;
const db = await connectDestination();
try {
  await db.query('BEGIN READ ONLY');
  evidence.historyTriggers = (await db.query(`SELECT t.tgname, pg_get_functiondef(t.tgfoid) definition
    FROM pg_trigger t WHERE t.tgrelid='member_membership_history'::regclass AND NOT t.tgisinternal`)).rows;
  evidence.allocations = (await db.query(`SELECT to_jsonb(h) data FROM member_membership_history h
    WHERE accounting_invoice_id=$1 OR xero_invoice_id=$1`, [candidates[0].InvoiceID])).rows.map(r => r.data);
  await db.query('ROLLBACK');
} finally { await db.end(); }
const dir = 'generated-artifacts/bnms-membership-5737';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(`${dir}/evidence-${Date.now()}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ olderInvoice: candidates[0].InvoiceID,
  payments: evidence.olderPayments.map(p => ({ id: p.PaymentID, date: p.Date, amount: p.Amount })),
  pdfBytes: pdf.length, allocations: evidence.allocations.length }));
export { evidence };
