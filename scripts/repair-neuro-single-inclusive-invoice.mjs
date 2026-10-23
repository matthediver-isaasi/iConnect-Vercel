// Explicitly approved single-booking repair. Defaults to provider read-only preflight.
import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';
import { createClient } from '@supabase/supabase-js';
import { validRecoverySnapshot, recoveryIdentity, processEventInvoiceRecovery } from '../api/_lib/eventInvoiceRecovery.js';
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const approved = {
  sarah: { event: '20bae95f-3b24-45f8-bd6b-b984cdbee3cf', id: '79091598-6d5c-4a1b-ba5c-18a77a6cc859', bookingId: 'e846b4b0-bacf-4c9c-831c-76cb27b4a016', gross: 200, vat: 33.33, card: true },
  imad: { event: '1fb90343-a129-4fcf-affd-07db4d572a51', id: '99e4164a-3a85-407a-ba97-91c114e512b3', bookingId: 'b6625989-fdee-4c07-87c9-f8b603e62676', gross: 168, vat: 28, card: true },
  shady: { event: '1fb90343-a129-4fcf-affd-07db4d572a51', id: 'b3384a8e-0c8b-4aa1-9911-9eb4fc0a4321', bookingId: '6ad7a923-deea-427c-b11b-0b25f42f6500', gross: 120, vat: 20, card: false },
};
const selected = process.argv.find(x => x.startsWith('--case='))?.slice(7) || 'sarah';
assert(approved[selected], 'Unapproved repair scope');
const { event, id, bookingId, gross, vat, card } = approved[selected];
const apply = process.argv.includes('--apply');
assert(process.argv.slice(2).every(x => x === '--apply' || x === `--case=${selected}`));
const sql = await connectDestination();
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { createEventInvoiceRecoveryXero } = await import('../api/_lib/eventInvoiceRecoveryXero.js');
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { getStripeCredentials } = await import('../api/_lib/stripeCredentials.js');
const q = (s, p = []) => sql.query(s, p);
try {
  const row = (await q('select * from event_invoice_recovery where id=$1 and tenant_id=$2', [id, tenant])).rows[0];
  assert(row);
  if (row.status === 'complete') {
    console.log(JSON.stringify({ status: 'already_complete', invoice: row.invoice_number, writes: 0 }));
  } else {
    assert.equal(row.status, 'needs_review'); assert.equal(row.attempts, 0);
    assert.equal(row.reason_code, 'snapshot_unavailable');
    for (const key of ['invoice_id', 'payment_id', 'invoice_write_started_at', 'payment_write_started_at', 'lease_token', 'settlement_payment_intent_id']) assert.equal(row[key], null);
    const b = (await q('select * from booking where id=$1 and tenant_id=$2', [bookingId, tenant])).rows[0];
    assert.equal(b.event_id, event); assert.equal(b.status, 'confirmed');
    assert.equal(b.booking_group_reference, row.booking_group_reference);
    assert.equal(Number(b.total_cost), gross);
    assert.equal(b.xero_invoice_id, null); assert.equal(b.accounting_invoice_id, null);
    let pi = null;
    assert.equal(row.snapshot.paymentMethod, card ? 'stripe' : 'invoice');
    if (card) {
    assert.equal(b.stripe_payment_intent_id, row.snapshot.settlement.paymentIntentId);
    const credentials = await getStripeCredentials(tenant, 'events');
    assert.equal(credentials.mode, 'live');
    const pr = await fetch(`https://api.stripe.com/v1/payment_intents/${b.stripe_payment_intent_id}?expand%5B%5D=latest_charge`,
      { headers: { Authorization: `Bearer ${credentials.secret_key}` }, signal: AbortSignal.timeout(30000) });
    assert(pr.ok, `Stripe HTTP ${pr.status}`);
    pi = await pr.json();
    assert.equal(pi.status, 'succeeded'); assert.equal(pi.livemode, true);
    assert.equal(pi.amount_received, gross * 100); assert.equal(pi.currency, 'gbp');
    assert.equal(pi.metadata.event_id, event);
    assert.equal(pi.latest_charge.id, row.snapshot.settlement.chargeId);
    assert.equal(pi.latest_charge.captured, true); assert.equal(pi.latest_charge.amount_refunded, 0);
    assert.equal(pi.latest_charge.disputed, false);
    } else {
      assert.equal(b.payment_method, 'account');
      assert.equal(row.snapshot.settlement, null);
    }
    const auth = await getValidXeroAccessToken(tenant);
    assert.equal(auth.tenantId, row.snapshot.provider.xeroTenantId);
    const readInvoice = async invoiceId => {
      const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      assert(response.ok, `Xero HTTP ${response.status}`);
      const result = await response.json();
      assert.equal(result.Invoices?.length, 1);
      return result.Invoices[0];
    };
    const reference = await readInvoice('c0a1a67a-1bde-4e43-bbb3-17378063c5c2');
    assert.equal(reference.Total, 200); assert.equal(reference.TotalTax, 33.33);
    assert.equal(reference.LineAmountTypes, 'Inclusive'); assert.equal(reference.Status, 'PAID');
    const snapshot = structuredClone(row.snapshot);
    assert.deepEqual(snapshot.reviewReasons, ['Historical invoice gross total does not match the checkout amount']);
    const invoice = structuredClone(snapshot.originalInvoice);
    assert.equal(invoice.LineItems.length, 1);
    const line = invoice.LineItems[0];
    assert.equal(line.UnitAmount, gross); assert.equal(line.Quantity, 1);
    assert.equal(line.TaxAmount, Math.round(gross * 20) / 100); assert.equal(line.TaxType, reference.LineItems[0].TaxType);
    assert.equal(line.AccountCode, reference.LineItems[0].AccountCode);
    invoice.LineAmountTypes = 'Inclusive'; line.TaxAmount = vat;
    snapshot.invoice = invoice; snapshot.invoiceLineAmountPolicies = ['Inclusive'];
    delete snapshot.originalInvoice; delete snapshot.reviewReasons;
    assert(validRecoverySnapshot(snapshot));
    // Complete date-bounded scan, including invoices created after checkout.
    // The normal adapter intentionally caps legacy discovery at three pages.
    let scanComplete = false;
    for (let page = 1; page <= 30; page++) {
      const params = new URLSearchParams({ where: 'Type=="ACCREC"&&Date>=DateTime(2026,10,14)', page: String(page), pageSize: '100' });
      const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices?${params}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      assert(response.ok, `Invoice scan HTTP ${response.status}`);
      const invoices = (await response.json()).Invoices;
      assert(Array.isArray(invoices));
      if (!invoices.length) { scanComplete = true; break; }
      for (let candidate of invoices) {
        if (!Array.isArray(candidate.LineItems)) candidate = await readInvoice(candidate.InvoiceID);
        const text = JSON.stringify(candidate).toLowerCase();
        assert(!(pi && text.includes(pi.id.toLowerCase()))
          && !text.includes(row.booking_group_reference.toLowerCase())
          && !text.includes(b.attendee_email.toLowerCase())
          && !text.includes(`${b.attendee_first_name} ${b.attendee_last_name}`.toLowerCase()), 'Possible existing invoice requires adoption review');
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    assert(scanComplete, 'Invoice scan incomplete');
    const adapter = await createEventInvoiceRecoveryXero({
      db, row: { ...row, snapshot },
      identity: recoveryIdentity(tenant, row.source, row.booking_group_reference),
      guard: async () => {}, deadlineAt: Date.now() + 60000,
      fetchImpl: (url, init) => { assert.equal(init?.method, 'GET', 'Preflight provider writes forbidden'); return fetch(url, init); },
    });
    assert.equal((await adapter.findInvoices()).length, 0, 'Existing invoice requires adoption review');
    assert.equal((await adapter.findPayments()).length, 0, 'Existing payment requires adoption review');
    console.log(JSON.stringify({ preflight: 'passed', gross, vat, stripeCaptured: card, existingInvoices: 0 }));
    if (apply) {
      await q('begin');
      await q("set local lock_timeout='5s'; set local statement_timeout='30s'");
      const locked = (await q('select * from event_invoice_recovery where id=$1 for update', [id])).rows[0];
      assert.deepEqual(locked, row);
      const fresh = (await q('select * from booking where id=$1 for update', [bookingId])).rows[0];
      assert.deepEqual(fresh, b);
      await q(`insert into event_invoice_tax_correction_audit(operation_id,original_snapshot,corrected_snapshot,authority)
        values($1,$2,$3,$4)`, [id, row.snapshot, snapshot,
        `Owner approved this single booking VAT-inclusive GBP${gross} correction, VAT GBP${vat}; ${card ? 'live Stripe captured/unrefunded/undisputed' : 'on account, retain unpaid status'}; preserve original contact, dates, payment and tax code. Duplicate preflight clear.`]);
      await q(`update event_invoice_recovery set snapshot=$2,status='pending',reason_code=null,next_attempt_at=now(),updated_at=now() where id=$1`, [id, snapshot]);
      if (card) {
      // Exercise the actual guard. A missing settlement identity must fail before any provider write.
      const claimed = (await q('select * from event_invoice_recovery_claim($1,$2,$3,true)', [tenant, 'booking', row.booking_group_reference])).rows[0];
      assert.equal(claimed.id, id);
      assert.equal((await q('select event_invoice_recovery_guard($1,$2) safe', [id, claimed.lease_token])).rows[0].safe, false);
      // Persist the no-provider-attempt outcome, then use the installed audited link-repair exception.
      await q(`update event_invoice_recovery set status='needs_review',reason_code='booking_or_lease_changed',
        lease_token=null,lease_expires_at=null where id=$1`, [id]);
      const before = (await q('select to_jsonb(r) row from event_invoice_recovery r where id=$1', [id])).rows[0].row;
      const after = (await q(`select to_jsonb(x) row from jsonb_populate_record(NULL::event_invoice_recovery,
        $1::jsonb||jsonb_build_object('settlement_payment_intent_id',$2::text,'status','pending','reason_code',null,'next_attempt_at',now(),'updated_at',now())) x`,
      [before, pi.id])).rows[0].row;
      await q(`insert into event_invoice_payment_link_repair_audit(operation_id,original_record,corrected_record,authority) values($1,$2,$3,$4)`,
        [id, before, after, 'Owner approved single-booking invoice recovery: bind verified existing live Stripe receipt; no new charge.']);
      await q(`update event_invoice_recovery set settlement_payment_intent_id=$2,status='pending',reason_code=null,
        next_attempt_at=$3,updated_at=$4 where id=$1`, [id, pi.id, after.next_attempt_at, after.updated_at]);
      // Clear this transaction's released connection lease so the scoped worker can proceed.
      await q(`update event_invoice_recovery_connection set lease_token=null,lease_expires_at=null where connection_id=$1 and lease_token=$2`,
        [row.connection_id, claimed.lease_token]);
      }
      await q('commit');
      const result = await processEventInvoiceRecovery({ db, tenantId: tenant, source: 'booking',
        bookingGroupReference: row.booking_group_reference, deadlineAt: Date.now() + 60000 });
      console.log(JSON.stringify({ worker: result }));
      const final = (await q('select status,reason_code,invoice_id,invoice_number,payment_id from event_invoice_recovery where id=$1', [id])).rows[0];
      console.log(JSON.stringify({ recovery: final }));
      assert.equal(final.status, 'complete', 'Recovery did not complete; inspect before retrying');
      const actual = await readInvoice(final.invoice_id);
      assert.equal(actual.Total, gross); assert.equal(actual.TotalTax, vat);
      assert.equal(actual.AmountPaid, card ? gross : 0); assert.equal(actual.AmountDue, card ? 0 : gross);
      assert.equal(actual.Status, card ? 'PAID' : invoice.Status);
      const mirror = (await q('select xero_invoice_id,xero_invoice_number,invoice_recovery_status from booking where id=$1', [bookingId])).rows[0];
      assert.equal(mirror.xero_invoice_id, actual.InvoiceID);
      assert.equal(mirror.invoice_recovery_status, 'complete');
      console.log(JSON.stringify({ verified: true, number: actual.InvoiceNumber, total: actual.Total, vat: actual.TotalTax, paid: actual.AmountPaid, due: actual.AmountDue, report: mirror }));
    }
  }
} catch (error) {
  await q('rollback').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally { await sql.end(); }
