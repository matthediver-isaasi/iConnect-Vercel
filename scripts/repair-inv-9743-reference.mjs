// Owner-authorised reference-only repair. No invoice creation, payment or email.
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const invoiceId = 'c9d661f0-4f78-4068-80e2-72ca169d530e';
const sql = await connectDestination();
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { xeroRateLimitedFetch } = await import('../api/_lib/xeroRateLimit.js');
try {
  const { rows } = await sql.query(`select state,invoice_status,invoice_result,company_id,source_id
    from accounting_request_queue where tenant_id=$1 and invoice_result->>'id'=$2`, [tenantId, invoiceId]);
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'complete'); assert.equal(rows[0].invoice_status, 'done');
  const history = await sql.query(`select id from member_membership_history
    where tenant_id=$1 and id=$2 and accounting_invoice_id=$3`, [tenantId, rows[0].source_id, invoiceId]);
  assert.equal(history.rowCount, 1);
  const auth = await getValidXeroAccessToken(tenantId);
  assert.equal(auth.tenantId, rows[0].company_id);
  async function request(method, body) {
    const response = await xeroRateLimitedFetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      method, headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId,
        Accept: 'application/json', 'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Idempotency-Key': 'inv-9743-reference-only-repair' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000),
    });
    assert.equal(response.status, 200, `Xero returned ${response.status}`);
    const result = await response.json();
    assert.equal(result.Invoices?.length, 1);
    assert.ok(!result.Invoices[0].HasErrors);
    return result.Invoices[0];
  }
  const before = await request('GET');
  assert.equal(before.InvoiceNumber, 'INV-9743');
  assert.equal(before.Contact.ContactID, '234faa51-72dc-422a-ae7d-870558120e7d');
  assert.equal(before.Total, 156);
  assert.ok(['AUTHORISED', 'PAID'].includes(before.Status));
  assert.ok(['TBC', 'TBC\n[aq:inv-bXU2TMJkCw2fW1TgdlwPPYu8MwbCIB0VRusWFQvRuj8]'].includes(before.Reference));
  const financial = invoice => Object.fromEntries(['InvoiceID', 'InvoiceNumber', 'Status', 'Total', 'SubTotal',
    'TotalTax', 'AmountPaid', 'AmountDue', 'AmountCredited', 'CurrencyCode', 'Date', 'DueDate', 'LineItems', 'Payments',
    'CreditNotes', 'Contact', 'SentToContact'].map(key => [key, invoice[key]]));
  if (process.argv.includes('--apply') && before.Reference !== 'TBC') {
    await request('POST', { Invoices: [{ InvoiceID: invoiceId, Reference: 'TBC' }] });
  }
  const after = await request('GET');
  assert.deepEqual(financial(after), financial(before));
  if (process.argv.includes('--apply')) assert.equal(after.Reference, 'TBC');
  console.log(JSON.stringify({ invoice: 'INV-9743', reference: after.Reference,
    applied: process.argv.includes('--apply'), unchangedFinancialsAndContact: true, emailsSent: 0, paymentsCreated: 0 }));
} finally { await sql.end(); }
