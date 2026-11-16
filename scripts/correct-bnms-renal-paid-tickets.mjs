// One-off approved correction. Reverses/re-records accounting entries only;
// never contacts Stripe, collects money, creates invoices or sends emails.
import assert from 'node:assert/strict';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { correction } from './correct-bnms-renal-unpaid-tickets.mjs';

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const EVENT = '1fb90343-a129-4fcf-affd-07db4d572a51';
const XERO = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const TARGETS = [
  ['7fda3868-abca-4312-a7dd-e1830a2e2d79', '636f6f84-d704-4d22-bc72-fb3481c29b4e', 'INV-9749', '2c477973-c433-4fc3-83f0-4cbd38eaf6db'],
  ['ed2cb134-21db-4fc6-9b5b-9c51ffa936f7', 'f5cee261-ddd9-4f64-a80a-094f38dfd87c', 'INV-9400', 'f6e38936-6964-4dd2-815f-7ce9c24f63bd'],
  ['fef333b0-9dd0-4410-9dac-70fd9a074c13', 'd291f238-413f-4708-9f57-787e63004c31', 'INV-9623', 'c661f47a-6d5e-4d05-9751-7033c2ad2dd5'],
];
const DIR = 'generated-artifacts/bnms-renal-ticket-correction';
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const invariantSql = `md5((to_jsonb(b)-ARRAY['ticket_class_id','ticket_class_name','ticket_price',
  'total_cost','account_amount','xero_invoice_pdf_base64','survey_invitation_revision'])::text)`;

export function paymentDate(value) {
  const match = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  assert.ok(match, 'Unexpected Xero date format');
  return new Date(Number(match[1])).toISOString().slice(0, 10);
}

export function paymentReplacement(payment, invoiceId, paymentId) {
  assert.equal(payment.PaymentID, paymentId);
  assert.equal(payment.Invoice?.InvoiceID, invoiceId);
  assert.equal(payment.Status, 'AUTHORISED');
  assert.equal(payment.PaymentType, 'ACCRECPAYMENT');
  assert.equal(payment.IsReconciled, false);
  assert.ok(!payment.BatchPayment && !payment.BatchPaymentID);
  assert.equal(payment.Amount, 120);
  assert.equal(payment.BankAmount, 120);
  assert.equal(payment.CurrencyRate, 1);
  assert.equal(payment.Account?.CurrencyCode, 'GBP');
  assert.ok(payment.Account?.AccountID);
  return {
    Invoice: { InvoiceID: invoiceId }, Account: { AccountID: payment.Account.AccountID },
    Date: paymentDate(payment.Date), Amount: 120, BankAmount: 120,
    ...(payment.Reference !== undefined ? { Reference: payment.Reference } : {}),
    IsReconciled: false,
  };
}

function checkPaid(invoice, invoiceId, number, paymentId) {
  assert.equal(invoice.InvoiceID, invoiceId);
  assert.equal(invoice.InvoiceNumber, number);
  assert.equal(invoice.Status, 'PAID');
  assert.equal(invoice.Total, 120);
  assert.equal(invoice.AmountPaid, 120);
  assert.equal(invoice.AmountDue, 0);
  assert.equal(invoice.Payments?.length, 1);
  assert.equal(invoice.Payments[0].PaymentID, paymentId);
  // Validate the intended line changes before removing any payment.
  correction({ ...invoice, Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 120, Payments: [] });
}

async function main() {
  const mode = process.argv[2];
  assert.ok(['--capture', '--apply'].includes(mode));
  const db = await connectDestination();
  await mkdir(DIR, { recursive: true });
  const journal = await open(`${DIR}/paid-${mode.slice(2)}.jsonl`, 'wx', 0o600);
  const record = async entry => { await journal.writeFile(JSON.stringify(entry) + '\n'); await journal.sync(); };
  try {
    const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
    const auth = await getValidXeroAccessToken(TENANT, { requireEnabled: true });
    assert.equal(auth.tenantId, XERO);
    const request = async (resource, method = 'GET', body, key) => {
      // Each writer is pinned by its caller to an approved invoice/payment.
      const response = await fetch(`https://api.xero.com/api.xro/2.0/${resource}`, {
        method, headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': XERO,
          Accept: 'application/json', 'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || result.ErrorNumber || result.HasErrors ||
          [...(result.Payments || []), ...(result.Invoices || [])].some(x => x.HasErrors || x.HasValidationErrors || x.ValidationErrors?.length)) {
        await record({ phase: 'provider_error', resource, status: response.status, result });
        throw new Error('Provider request rejected; inspect journal before any retry');
      }
      return result;
    };
    const getInvoice = async id => {
      const result = await request(`Invoices/${id}`);
      assert.equal(result.Invoices?.length, 1);
      assert.equal(result.Invoices[0].InvoiceID, id);
      return result.Invoices[0];
    };
    const getPayment = async id => {
      const result = await request(`Payments/${id}`);
      assert.equal(result.Payments?.length, 1);
      assert.equal(result.Payments[0].PaymentID, id);
      return result.Payments[0];
    };
    const captured = mode === '--apply'
      ? (await readFile(`${DIR}/paid-capture.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse) : [];
    for (const [bookingId, invoiceId, number, oldPaymentId] of TARGETS) {
      await db.query(mode === '--capture' ? 'BEGIN READ ONLY' : 'BEGIN');
      await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      const rows = (await db.query(`SELECT id,ticket_class_id,ticket_price,total_cost,account_amount,
        xero_invoice_id,status,payment_method, ${invariantSql} AS invariant
        FROM booking b WHERE id=$1 AND tenant_id=$2 AND event_id=$3 ${mode === '--apply' ? 'FOR UPDATE' : ''}`,
      [bookingId, TENANT, EVENT])).rows;
      assert.equal(rows.length, 1);
      const booking = rows[0];
      assert.equal(booking.xero_invoice_id, invoiceId);
      assert.equal(booking.status, 'confirmed');
      assert.equal(booking.payment_method, 'account');
      assert.equal(booking.ticket_class_id, 'ticket-1783521202290-vpmz8');
      for (const key of ['ticket_price', 'total_cost', 'account_amount']) assert.equal(Number(booking[key]), 120);
      assert.equal((await db.query(`SELECT count(*)::int n FROM booking WHERE tenant_id=$1
        AND (xero_invoice_id=$2 OR accounting_invoice_id=$2)`, [TENANT, invoiceId])).rows[0].n, 1);
      const recovery = (await db.query(`SELECT id,status,payment_id FROM event_invoice_recovery
        WHERE tenant_id=$1 AND invoice_id=$2`, [TENANT, invoiceId])).rows;
      assert.equal(recovery.length, 1);
      assert.equal(recovery[0].status, 'complete');
      assert.equal(recovery[0].payment_id, null);
      const before = await getInvoice(invoiceId);
      const payment = await getPayment(oldPaymentId);
      checkPaid(before, invoiceId, number, oldPaymentId);
      const replacement = paymentReplacement(payment, invoiceId, oldPaymentId);
      const state = { bookingId, booking, invoice: before, payment, replacement, recovery };
      await record({ phase: 'capture', ...state });
      if (mode === '--capture') {
        await db.query('ROLLBACK');
        console.log(JSON.stringify({ invoice: number, eligible: true, currentTotal: 120, targetTotal: 168, targetPaid: 120, targetDue: 48 }));
        continue;
      }
      const prior = captured.find(x => x.bookingId === bookingId);
      assert.ok(prior);
      for (const key of ['booking', 'invoice', 'payment', 'replacement', 'recovery']) {
        assert.equal(digest(state[key]), digest(prior[key]), `Changed since capture: ${key}`);
      }
      // Preflight local constraints while no provider changes have been made.
      await db.query(`UPDATE booking SET ticket_class_id='ticket-1791551363156-sde7l',
        ticket_class_name='Non Member Ticket',ticket_price=168,total_cost=168,account_amount=168,
        xero_invoice_pdf_base64=NULL WHERE id=$1 AND tenant_id=$2`, [bookingId, TENANT]);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      assert.equal((await db.query(`SELECT ${invariantSql} AS invariant FROM booking b WHERE id=$1`,
        [bookingId])).rows[0].invariant, booking.invariant);
      assert.equal(digest(await getInvoice(invoiceId)), digest(before));
      assert.equal(digest(await getPayment(oldPaymentId)), digest(payment));
      await record({ phase: 'remove_payment_intent', invoiceId, oldPaymentId });
      await request(`Payments/${oldPaymentId}`, 'POST', { Status: 'DELETED' }, `renal-remove-${oldPaymentId}`);
      assert.equal((await getPayment(oldPaymentId)).Status, 'DELETED');
      const unpaid = await getInvoice(invoiceId);
      const patch = correction(unpaid);
      await record({ phase: 'invoice_update_intent', invoiceId, patch });
      await request(`Invoices/${invoiceId}`, 'POST', { Invoices: [patch] }, `renal-rate-${invoiceId}`);
      const updated = await getInvoice(invoiceId);
      assert.equal(updated.Total, 168);
      assert.equal(updated.AmountPaid, 0);
      assert.equal(updated.AmountDue, 168);
      await record({ phase: 'replacement_payment_intent', invoiceId, replacement });
      const created = await request('Payments', 'PUT', { Payments: [replacement] }, `renal-reapply-${oldPaymentId}`);
      assert.equal(created.Payments?.length, 1);
      const newPaymentId = created.Payments[0].PaymentID;
      assert.ok(newPaymentId && newPaymentId !== oldPaymentId);
      await record({ phase: 'replacement_payment_created', invoiceId, oldPaymentId, newPaymentId });
      const newPayment = await getPayment(newPaymentId);
      assert.deepEqual(paymentReplacement(newPayment, invoiceId, newPaymentId), replacement);
      const after = await getInvoice(invoiceId);
      assert.equal(after.InvoiceNumber, number);
      assert.equal(after.Total, 168);
      assert.equal(after.TotalTax, 28);
      assert.equal(after.AmountPaid, 120);
      assert.equal(after.AmountDue, 48);
      assert.equal(after.Status, 'AUTHORISED');
      assert.equal(after.Payments?.length, 1);
      assert.equal(after.Payments[0].PaymentID, newPaymentId);
      for (const key of ['Contact', 'Reference', 'Date', 'DueDate', 'CurrencyCode', 'CreditNotes']) {
        assert.deepEqual(after[key], before[key], `Unexpected invoice change: ${key}`);
      }
      assert.equal(after.LineItems[0].Description, patch.LineItems[0].Description);
      assert.equal(after.LineItems[0].LineItemID, before.LineItems[0].LineItemID);
      assert.equal(after.LineItems[0].AccountCode, before.LineItems[0].AccountCode);
      assert.deepEqual(after.LineItems[0].Tracking, before.LineItems[0].Tracking);
      await record({ phase: 'verified_provider', invoice: after, payment: newPayment });
      await db.query('COMMIT');
      await record({ phase: 'local_committed', bookingId, invoiceId });
      await request(`Invoices/${invoiceId}/History`, 'PUT', { HistoryRecords: [{
        Details: `Owner-approved non-member early-bird correction from GBP120 to GBP168 inclusive of 20% VAT. Payment ${oldPaymentId} reversed and re-recorded as ${newPaymentId}, preserving GBP120, payment date, account and reference. GBP48 now outstanding. Matching iConnect ticket corrected. No money refunded or collected; no email sent.`,
      }] }, `renal-audit-${invoiceId}`);
      console.log(JSON.stringify({ invoice: number, total: 168, paid: 120, outstanding: 48,
        paymentDetailsPreserved: true, bookingUpdated: true, emailsSent: 0 }));
    }
  } catch (error) {
    await record({ phase: 'stopped', reason: error.message });
    throw error;
  } finally {
    await db.query('ROLLBACK');
    await db.end();
    await journal.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Correction stopped; inspect private journal before any further write.'); process.exitCode = 1; });
}
