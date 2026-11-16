// Exact owner-authorised correction of two UNPAID invoices. Never handles paid invoices.
import assert from 'node:assert/strict';
import { mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const EVENT = '1fb90343-a129-4fcf-affd-07db4d572a51';
const XERO = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const TARGETS = [
  ['029b8b96-c905-4b08-a2d2-e8794db2eb60', '39854bf1-066c-4d98-879c-89a6c531e1aa', 'INV-9742'],
  ['a1e51a0f-6665-43ee-93d1-6363b0301ec1', '31d84cf3-959e-49c4-8a88-db4afa915905', 'INV-9359'],
];
const NEW_TICKET = 'ticket-1791551363156-sde7l';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function correction(invoice) {
  assert.equal(invoice.Status, 'AUTHORISED');
  assert.equal(invoice.Type, 'ACCREC');
  assert.equal(invoice.CurrencyCode, 'GBP');
  assert.equal(invoice.LineAmountTypes, 'Inclusive');
  assert.equal(invoice.Total, 120);
  assert.equal(invoice.AmountDue, 120);
  assert.equal(invoice.AmountPaid, 0);
  assert.equal(invoice.AmountCredited || 0, 0);
  assert.equal(invoice.Payments?.length || 0, 0);
  assert.equal(invoice.CreditNotes?.length || 0, 0);
  assert.equal(invoice.LineItems.length, 1);
  const line = invoice.LineItems[0];
  assert.ok(line.LineItemID);
  assert.equal(line.Quantity, 1);
  assert.equal(line.UnitAmount, 120);
  assert.equal(line.LineAmount, 120);
  assert.equal(line.TaxType, 'OUTPUT2');
  assert.equal(line.TaxAmount, 20);
  assert.equal(line.DiscountRate || 0, 0);
  assert.equal(line.DiscountAmount || 0, 0);
  assert.ok(line.Description.includes('Event: Renal sestamibi SPECT/CT study day'));
  assert.ok(line.Description.includes('Ticket class: Member Ticket'));
  assert.ok(line.Description.includes('1 x Member Ticket @ £120.00 = £120.00'));
  assert.ok(line.Description.includes('Total to invoice: £120.00'));
  const updated = Object.fromEntries(['LineItemID', 'Description', 'Quantity', 'UnitAmount',
    'ItemCode', 'AccountCode', 'TaxType', 'TaxAmount', 'LineAmount', 'Tracking']
    .filter(k => Object.hasOwn(line, k)).map(k => [k, line[k]]));
  updated.Description = line.Description
    .replace('Ticket class: Member Ticket', 'Ticket class: Non Member Ticket')
    .replace('1 x Member Ticket @ £120.00 = £120.00', '1 x Non Member Ticket @ £168.00 = £168.00')
    .replace('Total to invoice: £120.00', 'Total to invoice: £168.00');
  updated.UnitAmount = 168;
  updated.LineAmount = 168;
  updated.TaxAmount = 28;
  return { InvoiceID: invoice.InvoiceID, LineAmountTypes: 'Inclusive', LineItems: [updated] };
}

async function main() {
  assert.equal(process.argv[2], '--apply');
  const db = await connectDestination();
  const dir = 'generated-artifacts/bnms-renal-ticket-correction';
  await mkdir(dir, { recursive: true });
  // Exclusive journal: an interrupted provider request must be reviewed, never blindly replayed.
  const journal = await open(`${dir}/unpaid-invoices.jsonl`, 'wx', 0o600);
  const record = async data => { await journal.writeFile(JSON.stringify(data) + '\n'); await journal.sync(); };
  try {
    const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
    const auth = await getValidXeroAccessToken(TENANT, { requireEnabled: true });
    assert.equal(auth.tenantId, XERO);
    for (const [bookingId, invoiceId, number] of TARGETS) {
      const request = async (method = 'GET', body, suffix = '') => {
        const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}${suffix}`, {
          method, headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': XERO,
            Accept: 'application/json', 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
        });
        assert.equal(response.status, 200, 'Provider request failed; inspect journal before retry');
        const result = await response.json();
        assert.ok(!result.ErrorNumber && !result.HasErrors);
        for (const i of result.Invoices || []) assert.ok(!i.HasErrors && !i.ValidationErrors?.length);
        return result;
      };
      const invoice = async () => {
        const result = await request();
        assert.equal(result.Invoices.length, 1);
        assert.equal(result.Invoices[0].InvoiceID, invoiceId);
        assert.equal(result.Invoices[0].InvoiceNumber, number);
        return result.Invoices[0];
      };
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      const rows = (await db.query(`SELECT id,ticket_class_id,ticket_class_name,ticket_price,total_cost,
        account_amount,xero_invoice_id,status,payment_method,
        md5((to_jsonb(b)-ARRAY['ticket_class_id','ticket_class_name','ticket_price','total_cost',
          'account_amount','xero_invoice_pdf_base64','survey_invitation_revision'])::text) AS invariant
        FROM booking b WHERE id=$1 AND tenant_id=$2 AND event_id=$3 FOR UPDATE`,
      [bookingId, TENANT, EVENT])).rows;
      assert.equal(rows.length, 1);
      const before = rows[0];
      assert.equal(before.xero_invoice_id, invoiceId);
      assert.equal(before.status, 'confirmed');
      assert.equal(before.payment_method, 'account');
      assert.equal(before.ticket_class_id, 'ticket-1783521202290-vpmz8');
      for (const key of ['ticket_price', 'total_cost', 'account_amount']) assert.equal(Number(before[key]), 120);
      assert.equal((await db.query(`SELECT count(*)::int n FROM booking
        WHERE tenant_id=$1 AND (xero_invoice_id=$2 OR accounting_invoice_id=$2)`, [TENANT, invoiceId])).rows[0].n, 1);
      const config = (await db.query('SELECT pricing_config FROM event WHERE id=$1 AND tenant_id=$2',
        [EVENT, TENANT])).rows[0].pricing_config.ticket_classes.find(t => t.id === NEW_TICKET);
      assert.equal(config.early_bird_price, 168);
      assert.equal(config.vat_rate_percentage, 20);
      const remoteBefore = await invoice();
      const patch = correction(remoteBefore);
      await record({ phase: 'before', booking: before, invoice: remoteBefore, patch });
      await db.query(`UPDATE booking SET ticket_class_id=$1,ticket_class_name='Non Member Ticket',
        ticket_price=168,total_cost=168,account_amount=168,xero_invoice_pdf_base64=NULL
        WHERE id=$2 AND tenant_id=$3`, [NEW_TICKET, bookingId, TENANT]);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      assert.equal(hash(await invoice()), hash(remoteBefore), 'Invoice changed since review');
      await record({ phase: 'provider_write_intent', invoiceId });
      await request('POST', { Invoices: [patch] });
      const after = await invoice();
      await record({ phase: 'provider_readback', invoice: after });
      assert.equal(after.Total, 168);
      assert.equal(after.TotalTax, 28);
      assert.equal(after.AmountDue, 168);
      assert.equal(after.AmountPaid, 0);
      assert.equal(after.Status, 'AUTHORISED');
      for (const key of ['Contact', 'Reference', 'Date', 'DueDate', 'CurrencyCode', 'Payments', 'CreditNotes']) {
        assert.deepEqual(after[key], remoteBefore[key], `Unexpected change: ${key}`);
      }
      assert.equal(after.LineItems[0].Description, patch.LineItems[0].Description);
      assert.deepEqual(after.LineItems[0].Tracking, remoteBefore.LineItems[0].Tracking);
      assert.equal(after.LineItems[0].AccountCode, remoteBefore.LineItems[0].AccountCode);
      const localAfter = (await db.query(`SELECT ticket_class_name,ticket_price,total_cost,account_amount,
        md5((to_jsonb(b)-ARRAY['ticket_class_id','ticket_class_name','ticket_price','total_cost',
          'account_amount','xero_invoice_pdf_base64','survey_invitation_revision'])::text) AS invariant
        FROM booking b WHERE id=$1`, [bookingId])).rows[0];
      assert.equal(localAfter.invariant, before.invariant);
      await db.query('COMMIT');
      await record({ phase: 'local_committed', bookingId, localAfter });
      await request('PUT', { HistoryRecords: [{
        Details: 'Owner-authorised correction to non-member early-bird ticket rate: GBP120 to GBP168 inclusive of 20% VAT. Matching iConnect booking corrected. No payment or customer changes; no email sent.',
      }] }, '/History');
      console.log(JSON.stringify({ invoice: number, total: after.Total, tax: after.TotalTax,
        amountDue: after.AmountDue, bookingUpdated: true, emailsSent: 0 }));
    }
  } finally {
    await db.query('ROLLBACK');
    await db.end();
    await journal.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Correction stopped; review private journal before retry.'); process.exitCode = 1; });
}
