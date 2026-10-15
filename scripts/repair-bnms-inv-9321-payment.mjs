// Explicitly approved, single-invoice settlement repair. Default is read-only.
// Retains the original ambiguous-write marker and reuses the original idempotency key.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
import Stripe from 'stripe';

const apply = process.argv.includes('--apply');
assert(process.argv.slice(2).every(arg => arg === '--apply'));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const operation = '2ec84ab5-ab48-43d5-971b-73d7efd83853';
const booking = 'da8ff9c2-9937-4575-b5e6-10b2bd009bdb';
assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname, 'lvmzliemqnieeoruhkik.supabase.co');
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { supabase: db } = await import('../api/_lib/database.js');
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { getStripeCredentials } = await import('../api/_lib/stripeCredentials.js');
const { recoveryIdentity } = await import('../api/_lib/eventInvoiceRecovery.js');
const { createEventInvoiceRecoveryXero } = await import('../api/_lib/eventInvoiceRecoveryXero.js');
const c = await connectDestination();
let claimed = null;
let committed = false;
const dir = 'generated-artifacts/bnms-inv-9321-repair';
const evidence = { authority: 'User approved verifying the existing £200 Stripe payment, recording it against INV-9321 and repairing the booking.', apply, at: new Date().toISOString() };
await mkdir(dir, { recursive: true, mode: 0o700 });
const save = () => writeFile(`${dir}/${apply ? 'apply' : 'check'}-${evidence.at.replaceAll(':','-')}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
try {
  const before = (await c.query('select to_jsonb(r) row from event_invoice_recovery r where id=$1 and tenant_id=$2', [operation, tenant])).rows[0]?.row;
  assert(before);
  assert.equal(before.invoice_number, 'INV-9321');
  assert.equal(before.source, 'booking');
  evidence.before = before;
  if (before.status !== 'complete') {
    assert.equal(before.status, 'needs_review');
    assert.equal(before.reason_code, 'payment_creation_ambiguous');
    assert(before.payment_write_started_at);
    assert.equal(before.payment_id, null);
  }
  const s = before.snapshot;
  assert.equal(s.amount, 200);
  assert.equal(s.currency, 'GBP');
  const credentials = await getStripeCredentials(tenant, 'events');
  assert(credentials?.is_enabled && credentials.mode === 'live' && credentials.secret_key);
  const stripe = new Stripe(credentials.secret_key);
  const pi = await stripe.paymentIntents.retrieve(s.settlement.paymentIntentId, { expand: ['latest_charge'] });
  assert.equal(pi.status, 'succeeded');
  assert.equal(pi.livemode, true);
  assert.equal(pi.amount_received, 20000);
  assert.equal(pi.currency, 'gbp');
  const charge = pi.latest_charge;
  assert.equal(charge.id, s.settlement.chargeId);
  assert(charge.paid && charge.captured && !charge.refunded && !charge.disputed);
  assert.equal(charge.amount_refunded, 0);
  evidence.stripe = { intent: pi.id, charge: charge.id, status: pi.status, received: pi.amount_received, refunded: charge.amount_refunded };
  const auth = await getValidXeroAccessToken(tenant);
  assert.equal(auth.tenantId, s.provider.xeroTenantId);
  const identity = recoveryIdentity(tenant, before.source, before.booking_group_reference);
  const reference = `${identity}:${pi.id}`;
  const guard = async () => {
    if (!claimed) return;
    assert.equal((await c.query('select event_invoice_recovery_guard($1,$2) ok', [operation, claimed.lease_token])).rows[0].ok, true, 'Recovery lease/booking changed');
  };
  const api = async (path, method = 'GET', body) => {
    assert(method === 'GET' || (apply && claimed && method === 'PUT' && path === 'Payments'));
    await guard();
    const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      method, headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId,
        Accept: 'application/json', 'Content-Type': 'application/json',
        ...(method === 'PUT' ? { 'Idempotency-Key': `${identity}-payment` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) {
      evidence.providerError = { status: response.status, type: result.Type, message: result.Message };
      await save();
      throw new Error(`Xero HTTP ${response.status}`);
    }
    return result;
  };
  const provider = await createEventInvoiceRecoveryXero({ db, row: before, identity, guard,
    deadlineAt: Date.now() + 120000, fetchImpl: () => { throw new Error('Validation must not invoke a provider write'); } });
  const reconcile = async () => {
    const invoices = (await api(`Invoices/${encodeURIComponent(before.invoice_id)}`)).Invoices;
    assert.equal(invoices?.length, 1);
    const invoice = invoices[0];
    assert.equal(invoice.InvoiceNumber, 'INV-9321');
    provider.validateInvoice(invoice);
    const where = `Reference==${JSON.stringify(reference)}||Reference==${JSON.stringify(`Stripe: ${pi.id}`)}`;
    const payments = (await api(`Payments?${new URLSearchParams({ where })}`)).Payments;
    assert(Array.isArray(payments) && payments.length <= 1);
    const payment = payments[0];
    if (payment) provider.validatePayment(payment, invoice);
    else {
      assert.equal(invoice.Status, 'AUTHORISED');
      assert.equal(invoice.AmountPaid, 0);
      assert.equal(invoice.AmountDue, 200);
      assert.equal((invoice.Payments || []).length, 0);
    }
    return { invoice, payment };
  };
  let { invoice, payment } = await reconcile();
  evidence.invoiceBefore = { id: invoice.InvoiceID, number: invoice.InvoiceNumber, status: invoice.Status, due: invoice.AmountDue };
  const accounts = (await api(`Accounts?${new URLSearchParams({ where: `Code==${JSON.stringify(s.settlement.accountCode)}` })}`)).Accounts;
  assert.equal(accounts?.length, 1);
  const account = accounts[0];
  assert(account.Status === 'ACTIVE' && (account.Type === 'BANK' || account.EnablePaymentsToAccount === true));
  assert.equal(account.CurrencyCode, 'GBP');
  if (!apply || before.status === 'complete') {
    if (before.status === 'complete') assert.equal(payment?.PaymentID, before.payment_id);
    await save();
    console.log(JSON.stringify({ readOnly: true, status: before.status, invoice: invoice.InvoiceNumber, paid: invoice.AmountPaid, due: invoice.AmountDue, stripeVerified: true, paymentExists: !!payment }));
  } else {
    await save();
    await c.query('begin');
    await c.query("set local lock_timeout='5s'");
    await c.query('select 1 from event_invoice_recovery_connection where connection_id=$1 for update', [before.connection_id]);
    await c.query('select id from event_invoice_recovery where id=$1 for update', [operation]);
    // Compare JSON through PostgreSQL to avoid timestamp representation differences.
    assert.equal((await c.query('select to_jsonb(r)=$2::jsonb same from event_invoice_recovery r where id=$1', [operation, JSON.stringify(before)])).rows[0].same, true);
    await c.query("update event_invoice_recovery set status='pending',reason_code=null,next_attempt_at=now() where id=$1", [operation]);
    claimed = (await c.query('select * from event_invoice_recovery_claim($1,$2,$3,true)', [tenant, before.source, before.booking_group_reference])).rows[0];
    assert.equal(claimed?.id, operation, 'Worker connection busy; no repair committed');
    assert.equal((await c.query('select event_invoice_recovery_guard($1,$2) ok', [operation, claimed.lease_token])).rows[0].ok, true);
    await c.query('commit');
    committed = true;
    ({ invoice, payment } = await reconcile());
    if (!payment) {
      evidence.paymentRequestStartedAt = new Date().toISOString();
      await save();
      const result = await api('Payments', 'PUT', { Payments: [{
        Invoice: { InvoiceID: invoice.InvoiceID }, Account: { Code: s.settlement.accountCode },
        Date: s.settlement.paidAt.slice(0, 10), Amount: s.settlement.amount, Reference: reference,
      }] });
      assert.equal(result.Payments?.length, 1);
      payment = result.Payments[0];
      provider.validatePayment(payment, invoice);
    }
    evidence.paymentId = payment.PaymentID;
    await save();
    // Independent provider read before publishing the booking link.
    ({ invoice, payment } = await reconcile());
    assert(payment);
    assert.equal(invoice.Status, 'PAID');
    assert.equal(invoice.AmountPaid, 200);
    assert.equal(invoice.AmountDue, 0);
    const { data: finished, error } = await db.rpc('event_invoice_recovery_finish', {
      p_id: operation, p_token: claimed.lease_token, p_status: 'complete', p_reason: null,
      p_invoice_id: invoice.InvoiceID, p_invoice_number: invoice.InvoiceNumber, p_payment_id: payment.PaymentID,
    });
    assert.ifError(error);
    assert.equal(finished, true);
    const verified = (await c.query(`select b.xero_invoice_number,b.xero_invoice_id,r.status,r.reason_code,r.payment_id
      from booking b join event_invoice_recovery r on r.id=$3 and r.tenant_id=b.tenant_id
      where b.id=$1 and b.tenant_id=$2`, [booking, tenant, operation])).rows[0];
    assert.equal(verified.status, 'complete');
    assert.equal(verified.xero_invoice_id, invoice.InvoiceID);
    assert.equal(verified.payment_id, payment.PaymentID);
    evidence.verified = verified;
    evidence.completedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ repaired: true, invoice: invoice.InvoiceNumber, invoiceStatus: invoice.Status, paid: invoice.AmountPaid, due: invoice.AmountDue, bookingLinked: true, recovery: verified.status, newStripeCharges: 0 }));
  }
} catch (error) {
  if (!committed) await c.query('rollback').catch(() => {});
  if (committed && claimed) {
    const result = await db.rpc('event_invoice_recovery_finish', {
      p_id: operation, p_token: claimed.lease_token, p_status: 'needs_review', p_reason: 'payment_creation_ambiguous',
    }).catch(() => null);
    evidence.reviewRestored = result?.data === true;
  }
  evidence.error = error.message;
  await save();
  // Leave any committed write marker intact. A failed repair is never auto-replayed.
  throw error;
} finally { await c.end(); }
