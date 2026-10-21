// Owner-approved cohort only. Default is read-only preflight.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { session } from './repair-bnms-invoice-8958.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const contact = '75fbe7cb-61de-446a-b74e-afbff0f8283f';
const approved = {
  'INV-9312': ['in_1UP1bP0Ku8P2LW364R6jX4ZM', 508],
  'INV-9313': ['in_1UP3v20Ku8P2LW36npc3NIXc', 508],
  'INV-9327': ['in_1UQofT0Ku8P2LW366VmUEbE7', 508],
  'INV-9328': ['in_1UQqCg0Ku8P2LW36t6SUiXVh', 508],
  'INV-9329': ['in_1UQrOl0Ku8P2LW36BXCdf4PY', 508],
  'INV-9330': ['in_1UQt0Z0Ku8P2LW36tpcuQXiP', 508],
  'INV-9331': ['in_1UQtp90Ku8P2LW36MAuBlPJY', 508],
  'INV-9339': ['in_1UR91l0Ku8P2LW36CjMamUHb', 1066],
  'INV-9341': ['in_1UR9df0Ku8P2LW36wEQTe0yq', 1066],
  'INV-9343': ['in_1URXJ40Ku8P2LW36NjsgghtJ', 1066],
  'INV-9344': ['in_1URcJA0Ku8P2LW36LK4ITNnx', 1066],
  'INV-9345': ['in_1URvIO0Ku8P2LW36i6PijqJ9', 508],
  'INV-9346': ['in_1URypT0Ku8P2LW3633v2OzFY', 508],
  'INV-9347': ['in_1US9Er0Ku8P2LW36uFABfORR', 1066],
  'INV-9349': ['in_1USAYP0Ku8P2LW367GPFvNZg', 1066],
  'INV-9354': ['in_1USCw50Ku8P2LW36rscYzugS', 1066],
};
assert(process.argv.slice(2).every(x => x === '--apply'));
const apply = process.argv.includes('--apply');
const dir = `generated-artifacts/bnms-stripe-test-cleanup/${new Date().toISOString().replaceAll(':', '-')}`;
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const journal = (stage, data) => fs.appendFileSync(`${dir}/journal.jsonl`,
  JSON.stringify({ at: new Date().toISOString(), stage, ...data }) + '\n', { mode: 0o600 });
const date = value => value ? Number(String(value).match(/Date\((\d+)/)?.[1] || Date.parse(value)) : 0;
const { db, request } = await session();
try {
  assert((await db.query("select pg_try_advisory_lock(hashtext('bnms-confirmed-stripe-test-cleanup')) locked")).rows[0].locked);
  const { getStripeIntegrationCredentials } = await import('../api/_lib/stripeCredentials.js');
  const creds = await getStripeIntegrationCredentials(tenant);
  assert(creds.test_secret_key?.startsWith('sk_test_'), 'Test key required');
  const stripe = new Stripe(creds.test_secret_key, { maxNetworkRetries: 0 });
  const orgs = (await request('Organisations')).Organisations;
  assert.equal(orgs.length, 1);
  const lockDate = Math.max(date(orgs[0].PeriodLockDate), date(orgs[0].EndOfYearLockDate));
  assert(Number.isFinite(lockDate));
  const cohort = [];
  for (const [number, [externalId, amount]] of Object.entries(approved)) {
    const rows = (await db.query(`select i.*,a.member_id,a.environment,a.provider agreement_provider,
      a.stripe_subscription_id,a.status agreement_status,p.status plan_status,
      p.stripe_subscription_id plan_subscription_id,m.email
      from membership_instalment_invoices i
      join membership_billing_agreements a on a.id=i.billing_agreement_id and a.tenant_id=i.tenant_id
      join membership_payment_plans p on p.id=i.plan_id and p.tenant_id=i.tenant_id and p.billing_agreement_id=a.id
      join member m on m.id=a.member_id and m.tenant_id=i.tenant_id
      where i.tenant_id=$1 and i.external_payment_id=$2 and i.provider='stripe'`, [tenant, externalId])).rows;
    assert.equal(rows.length, 1, `Ledger count ${number}`);
    const row = rows[0];
    assert(row.environment === 'test' && row.agreement_provider === 'stripe'
      && row.email.endsWith('@deleted.local') && row.amount_minor === amount
      && row.accounting_invoice_number === number && row.accounting_provider === 'xero');
    assert(row.stripe_subscription_id && row.plan_subscription_id === row.stripe_subscription_id);
    const si = await stripe.invoices.retrieve(externalId);
    const subscriptionId = si.subscription || si.parent?.subscription_details?.subscription;
    assert(si.livemode === false && si.status === 'paid' && si.amount_paid === amount
      && si.currency === 'gbp' && subscriptionId === row.stripe_subscription_id);
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    assert(sub.livemode === false && ['active', 'canceled'].includes(sub.status));
    const invoice = (await request(`Invoices/${row.accounting_invoice_id}`)).Invoices[0];
    assert(invoice.InvoiceNumber === number && invoice.Contact.ContactID === contact
      && invoice.CurrencyCode === 'GBP' && Math.round(invoice.Total * 100) === amount
      && invoice.Reference.includes(externalId) && ['PAID', 'AUTHORISED', 'VOIDED'].includes(invoice.Status));
    assert(date(invoice.Date) > lockDate, 'Locked invoice');
    assert(!invoice.CreditNotes?.length && !invoice.Prepayments?.length && !invoice.Overpayments?.length);
    const payments = [];
    for (const ref of invoice.Payments || []) {
      const payment = (await request(`Payments/${ref.PaymentID}`)).Payments[0];
      if (payment.Status === 'DELETED') continue;
      assert(payment.Invoice.InvoiceID === invoice.InvoiceID && payment.IsReconciled === false
        && payment.Status === 'AUTHORISED' && Math.round(payment.Amount * 100) === amount
        && date(payment.Date) > lockDate, 'Payment reconciled, locked or changed');
      payments.push(payment);
    }
    assert(payments.length <= 1 && (invoice.Status !== 'PAID' || payments.length === 1));
    const item = { row, invoice, payments, subscriptionId, subscriptionStatus: sub.status };
    journal('preflight', item);
    cohort.push(item);
  }
  assert.equal(new Set(cohort.map(x => x.subscriptionId)).size, 16);
  console.log(JSON.stringify({ preflight: 'passed', count: cohort.length, apply, audit: dir }));
  if (apply) for (const item of cohort) {
    const { row, invoice, subscriptionId } = item;
    journal('begin', { invoice: invoice.InvoiceNumber, subscriptionId });
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    assert.equal(current.livemode, false);
    if (current.status !== 'canceled') {
      assert.equal(current.status, 'active');
      const cancelled = await stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false });
      assert.equal(cancelled.status, 'canceled');
    }
    journal('subscription_cancelled', { subscriptionId });
    await db.query('BEGIN');
    try {
      for (const [table, id] of [['membership_billing_agreements', row.billing_agreement_id], ['membership_payment_plans', row.plan_id]]) {
        const targetStatus = table === 'membership_payment_plans' ? 'payment_plan_cancelled' : 'cancelled';
        const changed = await db.query(`update ${table} set status=$4,updated_at=now()
          where id=$1 and tenant_id=$2 and stripe_subscription_id=$3
            and status in ('active','cancelled','payment_plan_cancelled') returning id`,
        [id, tenant, subscriptionId, targetStatus]);
        assert.equal(changed.rowCount, 1);
      }
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    journal('local_cancelled', { agreementId: row.billing_agreement_id, planId: row.plan_id });
    for (const p of item.payments) {
      const fresh = (await request(`Payments/${p.PaymentID}`)).Payments[0];
      if (fresh.Status === 'DELETED') continue;
      assert(fresh.IsReconciled === false && fresh.Status === 'AUTHORISED'
        && fresh.Invoice.InvoiceID === invoice.InvoiceID && fresh.Amount === p.Amount);
      journal('payment_delete_intent', { paymentId: p.PaymentID });
      await request(`Payments/${p.PaymentID}`, 'POST', { Status: 'DELETED' });
      assert.equal((await request(`Payments/${p.PaymentID}`)).Payments[0].Status, 'DELETED');
      journal('payment_deleted', { paymentId: p.PaymentID });
    }
    const fresh = (await request(`Invoices/${invoice.InvoiceID}`)).Invoices[0];
    if (fresh.Status !== 'VOIDED') {
      assert(fresh.Status === 'AUTHORISED' && fresh.AmountPaid === 0
        && fresh.Total === invoice.Total && fresh.Contact.ContactID === contact && !fresh.CreditNotes?.length);
      journal('invoice_void_intent', { invoiceId: invoice.InvoiceID });
      await request(`Invoices/${invoice.InvoiceID}`, 'POST', { Invoices: [{ InvoiceID: invoice.InvoiceID, Status: 'VOIDED' }] });
    }
    const verified = (await request(`Invoices/${invoice.InvoiceID}`)).Invoices[0];
    assert(verified.Status === 'VOIDED' && verified.AmountPaid === 0);
    const updated = await db.query(`update membership_instalment_invoices
      set accounting_sync_status='skipped',accounting_sync_error=$1,updated_at=now()
      where id=$2 and tenant_id=$3 and accounting_invoice_id=$4 returning id`,
    ['Owner-approved test cleanup: Stripe test subscription cancelled; Xero test payment removed and invoice voided. Do not repost.', row.id, tenant, invoice.InvoiceID]);
    assert.equal(updated.rowCount, 1);
    journal('complete', { invoice: invoice.InvoiceNumber, invoiceId: invoice.InvoiceID, ledgerId: row.id });
    console.log(`Completed ${invoice.InvoiceNumber}`);
  }
} catch (error) {
  journal('stopped', { error: error.message });
  console.error('Cleanup stopped:', error.message);
  process.exitCode = 1;
} finally { await db.end(); }
