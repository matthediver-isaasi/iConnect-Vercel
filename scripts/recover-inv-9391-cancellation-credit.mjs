// Owner-approved, pinned cancellation-credit recovery. No email or cash refund.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
const apply = process.argv.includes('--apply');
assert.ok(process.argv.slice(2).every(arg => arg === '--apply'));
assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname, 'lvmzliemqnieeoruhkik.supabase.co');
// Process-local destination binding; never change workspace/deployment settings.
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const bookingId = '591492cb-2409-4625-8d7a-e753af3d4d5c';
const requestId = '2fd96adb-ff1c-4533-ab7a-b0e91f1a6893';
const invoiceId = 'e75e8771-c6a0-4317-89b4-20532fea09f4';
const operationKey = `cancel:${requestId}:${bookingId}`;
const checked = r => { if (r.error) throw new Error(r.error.message); return r.data; };
const booking = checked(await db.from('booking').select('*').eq('tenant_id', tenantId).eq('id', bookingId).single());
assert.equal(booking.member_id, '9e26f58a-e094-4165-895c-9474435d66c1');
assert.equal(booking.status, 'cancelled');
assert.equal(booking.accounting_invoice_id || booking.xero_invoice_id, invoiceId);
assert.equal(Number(booking.ticket_price), 200);
const cancellation = checked(await db.from('booking_cancellation_request').select('status,booking_id').eq('tenant_id', tenantId).eq('id', requestId).single());
assert.equal(cancellation.status, 'approved'); assert.equal(cancellation.booking_id, bookingId);
const invoiceBookings = checked(await db.from('booking').select('id').eq('tenant_id', tenantId).eq('xero_invoice_id', invoiceId));
assert.deepEqual(invoiceBookings.map(b => b.id), [bookingId]);
const { getXeroInvoice, getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { xeroRateLimitedFetch } = await import('../api/_lib/xeroRateLimit.js');
const invoice = await getXeroInvoice(invoiceId, tenantId);
assert.equal(invoice.InvoiceNumber, 'INV-9391');
assert.equal(Number(invoice.Total), 200);
assert.equal(invoice.CurrencyCode, 'GBP');
assert.ok(['AUTHORISED', 'PAID'].includes(invoice.Status));
const binding = await getValidXeroAccessToken(tenantId);
const reference = `Cancel: ${booking.booking_reference || booking.id}`;
// Also inspect all contact credits, not only our recovery reference: a manual
// unallocated credit can otherwise be missed by invoice/reference discovery.
const notes = [];
let exhausted = false;
for (let page = 1; page <= 20; page++) {
  const where = `Contact.ContactID==Guid("${invoice.Contact.ContactID}")`;
  const response = await xeroRateLimitedFetch(`https://api.xero.com/api.xro/2.0/CreditNotes?where=${encodeURIComponent(where)}&page=${page}`, {
    headers: { Authorization: `Bearer ${binding.accessToken}`, 'xero-tenant-id': binding.tenantId, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Credit discovery failed: HTTP ${response.status}`);
  const data = await response.json();
  assert.ok(Array.isArray(data.CreditNotes), 'Incomplete credit discovery');
  notes.push(...data.CreditNotes);
  if (data.CreditNotes.length < 100) { exhausted = true; break; }
}
assert.ok(exhausted, 'Credit discovery page limit reached');
const activeNotes = notes.filter(n => !['VOIDED', 'DELETED'].includes(n.Status));
const candidates = activeNotes.filter(n => n.Reference === reference
  || n.Allocations?.some(a => a.Invoice?.InvoiceID === invoiceId)
  || (Number(n.RemainingCredit) > 0 && Number(n.Total) === 200));
console.log(JSON.stringify({
  invoice: invoice.InvoiceNumber, total: invoice.Total, due: invoice.AmountDue,
  paid: invoice.AmountPaid, credited: invoice.AmountCredited,
  contactCreditCount: activeNotes.length,
  candidates: candidates.map(n => ({ number: n.CreditNoteNumber, id: n.CreditNoteID, total: n.Total, status: n.Status, expectedReference: n.Reference === reference })),
  localCreditLinked: !!booking.xero_credit_note_id, apply,
}));
assert.ok(candidates.length <= 1, 'Multiple potential credits require review');
assert.ok(candidates.every(n => n.Reference === reference), 'Existing manual credit requires explicit matching; no new credit created');
if (!candidates.length) {
  assert.equal(Number(invoice.AmountCredited ?? 0), 0);
  assert.equal(Number(invoice.AmountPaid), 0, 'Paid invoice requires separate allocation review');
  assert.equal(Number(invoice.AmountDue), 200);
}
if (apply) {
  const { enqueueCancellationCredit, processCancellationCredit } = await import('../api/_lib/cancellationCreditRecovery.js');
  const { executeCancellationCredit } = await import('../api/_lib/xeroCancellationRecovery.js');
  const row = await enqueueCancellationCredit({
    db, tenantId, source: 'booking', bookings: [booking], operationKey, email: null,
    args: { invoiceId, creditAmount: 200, reference,
      description: `Cancellation of booking ${booking.booking_reference || booking.id}` },
  });
  const result = await processCancellationCredit({ db, row, execute: r => executeCancellationCredit(db, r) });
  console.log(JSON.stringify({ recoveryState: result.state, result: result.result, error: result.last_error }));
  assert.equal(result.state, 'complete', 'Credit is recorded for recovery/review; do not blindly replay');
  const verified = await getXeroInvoice(invoiceId, tenantId);
  const local = checked(await db.from('booking').select('status,xero_credit_note_id,xero_credit_note_number').eq('tenant_id', tenantId).eq('id', bookingId).single());
  const evidence = checked(await db.from('booking_reversal_evidence').select('status,provider_id,amount_minor,currency')
    .eq('tenant_id', tenantId).eq('operation_key', operationKey).eq('leg', 'credit_note').single());
  assert.equal(local.status, 'cancelled');
  assert.equal(local.xero_credit_note_id, result.result.creditNoteId);
  assert.equal(evidence.status, 'confirmed'); assert.equal(evidence.amount_minor, 20000);
  assert.equal(evidence.provider_id, result.result.creditNoteId);
  assert.equal(Number(verified.AmountDue), 0);
  assert.equal(Number(verified.AmountPaid), 0);
  assert.ok(verified.CreditNotes?.some(note => note.CreditNoteID === result.result.creditNoteId
    && Number(note.AppliedAmount) === 200), 'Invoice must show the exact applied credit note');
  console.log(JSON.stringify({ verified: true, invoice: verified.InvoiceNumber, creditNote: local.xero_credit_note_number,
    credited: 200, due: verified.AmountDue, emailSent: false, cashRefunded: false }));
}
