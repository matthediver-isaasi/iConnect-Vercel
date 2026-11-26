import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminUnpaidMembershipCancellation, verifyUnpaidInvoice } from './adminUnpaidMembershipCancellation.js';
import { loadJoiningJourney } from './membershipJoiningJourney.js';

const context = { tenantId: 'tenant', memberId: 'member', actorId: 'admin', actorKind: 'admin' };
const purchase = () => ({ id: 'history', tenant_id: 'tenant', member_id: 'member', status: 'pending_payment_setup',
  payment_status: 'unpaid', payment_method: 'invoice', total_with_vat: 128, vat_amount: 0, currency: 'GBP',
  xero_invoice_id: 'invoice', xero_invoice_number: 'INV-9748', commitment_snapshot: { payment_frequency: 'upfront' },
  cancelled_for_switch_at: null });
const document = () => ({ Invoices: [{ InvoiceID: 'invoice', Type: 'ACCREC', Status: 'AUTHORISED',
  Contact: { ContactID: 'payer' }, CurrencyCode: 'GBP', Total: 128, SubTotal: 128, TotalTax: 0,
  AmountPaid: 0, AmountCredited: 0, AmountDue: 128 }] });

function fixture() {
  const history = purchase(), invoice = document();
  let operation, voids = 0, failAfterVoid = false, failFinish = false, failRead = false, beginError = false;
  let books = 'books';
  const tables = { member_membership_history: [history], form_initial_checkout_recovery: [],
    membership_joining_journey: [{ tenant_id: 'tenant', form_id: 'form' }],
    form: [{ id: 'form', tenant_id: 'tenant', slug: 'join', is_active: true, form_type: 'standard' }] };
  const db = {
    from(table) {
      const filters = []; let max = Infinity;
      const q = {
        select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
        is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
        in(k, values) { filters.push(r => values.includes(r[k])); return q; },
        order() { return q; }, limit(n) { max = n; return q; }, range() { return q; },
        async maybeSingle() { return { data: (tables[table] || []).filter(r => filters.every(f => f(r)))[0] || null }; },
        then(resolve) { return Promise.resolve({ data: (tables[table] || []).filter(r => filters.every(f => f(r))).slice(0, max) }).then(resolve); },
      }; return q;
    },
    async rpc(name, args) {
      if (name === 'begin_admin_unpaid_membership_cancellation') {
        if (beginError) return { error: { message: 'blocked' } };
        operation = { id: 'operation', tenant_id: 'tenant', member_id: 'member', state: 'reconciling',
          snapshot: { histories: [structuredClone(args.p_history)], adminUnpaidCancellation: {
            actorId: args.p_actor_id, reason: args.p_reason, invoice: args.p_invoice } } };
        tables.form_initial_checkout_recovery = [operation];
        return { data: operation };
      }
      assert.equal(name, 'finish_admin_unpaid_membership_cancellation');
      if (failFinish) return { error: { message: 'lost DB response' } };
      assert.equal(args.p_receipt.status, 'VOIDED');
      operation.state = 'released';
      history.status = 'expired_checkout'; history.payment_status = 'voided'; history.cancelled_for_switch_at = 'now';
      return { data: true };
    },
  };
  const service = createAdminUnpaidMembershipCancellation({ db, accountingForTenant: async tenant => {
    assert.equal(tenant, 'tenant');
    return { xeroTenantId: books, async request(path, options) {
      assert.equal(path, 'Invoices/invoice');
      if (options) {
        voids++; assert.equal(options.method, 'POST');
        assert.equal(options.key, 'unpaid-membership-operation');
        assert.deepEqual(options.body, { Invoices: [{ InvoiceID: 'invoice', Status: 'VOIDED' }] });
        invoice.Invoices[0].Status = 'VOIDED'; invoice.Invoices[0].AmountDue = 0;
        if (failAfterVoid) throw Error('lost Xero response');
      }
      if (failRead && !options) throw Error('Xero unavailable');
      return structuredClone(invoice);
    } };
  } });
  return { db, service, history, invoice, get voids() { return voids; }, get operation() { return operation; },
    loseVoidResponse() { failAfterVoid = true; }, loseFinish() { failFinish = true; },
    restoreFinish() { failFinish = false; }, failRead() { failRead = true; },
    blockBegin() { beginError = true; }, changeBooks() { books = 'other'; } };
}
async function confirm(f, fingerprint) {
  return f.service.confirm(context, { approve: true, reason: 'Member wants to start again',
    fingerprint: fingerprint || (await f.service.preview(context)).fingerprint });
}
test('cancels the invoice and releases the retained purchase for portal joining', async () => {
  const f = fixture(), owner = { id: 'member', tenant_id: 'tenant' };
  assert.deepEqual(await loadJoiningJourney(f.db, { tenantId: 'tenant', owner }), { eligible: false });
  assert.equal((await f.service.status(context)).eligible, true);
  assert.equal((await confirm(f)).state, 'released');
  assert.equal(f.voids, 1);
  assert.equal(f.history.status, 'expired_checkout');
  assert.deepEqual(await loadJoiningJourney(f.db, { tenantId: 'tenant', owner }), {
    eligible: true, entryHref: '/FormView?slug=join',
  });
  assert.equal((await f.service.status(context)).completed, true);
  await f.service.resume(context, 'operation');
  assert.equal(f.voids, 1);
  // A subsequent pending Direct Debit is not another opportunity to join.
  f.history.cancelled_for_switch_at = null;
  f.history.status = 'pending_payment_setup'; f.history.payment_method = 'direct_debit';
  assert.equal((await f.service.status(context)).completed, false);
});
test('lost Xero response resumes by reading its void, without a duplicate write', async () => {
  const f = fixture(); f.loseVoidResponse();
  await assert.rejects(confirm(f), /lost Xero/);
  assert.equal(f.history.cancelled_for_switch_at, null);
  assert.equal((await f.service.status(context)).pending, true);
  assert.equal((await f.service.resume(context, 'operation')).state, 'released');
  assert.equal(f.voids, 1);
});
test('lost database finalization preserves the hold and safely resumes', async () => {
  const f = fixture(); f.loseFinish();
  await assert.rejects(confirm(f), /Cancellation could not be verified/);
  assert.equal(f.history.cancelled_for_switch_at, null);
  f.restoreFinish();
  await f.service.resume(context, 'operation');
  assert.equal(f.voids, 1);
});
test('preview changes, missing approval, wrong actor and failed reservation never void', async () => {
  const f = fixture(), preview = await f.service.preview(context);
  f.history.total_with_vat = 129;
  await assert.rejects(confirm(f, preview.fingerprint), /invoice must/);
  f.history.total_with_vat = 128;
  f.history.xero_invoice_number = 'changed';
  await assert.rejects(confirm(f, preview.fingerprint), /changed/);
  await assert.rejects(f.service.confirm(context, { approve: false }), /explicitly confirm/);
  await assert.rejects(f.service.preview({ ...context, actorKind: 'member' }), /administrator/);
  f.blockBegin();
  await assert.rejects(confirm(f), /Cancellation could not be verified/);
  assert.equal(f.voids, 0);
});
test('unavailable accounting and changed accounting tenancy cannot release the purchase', async () => {
  const f = fixture(); f.failRead();
  await assert.rejects(confirm(f), /Xero unavailable/);
  assert.equal(f.voids, 0);
  const g = fixture(); g.loseVoidResponse();
  await assert.rejects(confirm(g));
  g.changeBooks();
  await assert.rejects(g.service.resume(context, 'operation'), /organisation changed/);
  assert.equal(g.history.cancelled_for_switch_at, null);
});
test('paid, partial, credited, mismatched and missing provider evidence is rejected', () => {
  for (const patch of [
    { AmountPaid: 1, AmountDue: 127 }, { Status: 'PAID' }, { AmountCredited: 1 },
    { AmountPaid: undefined }, { AmountCredited: undefined }, { Payments: [{ PaymentID: 'paid' }] },
    { CreditNotes: [{ CreditNoteID: 'credit' }] }, { CurrencyCode: 'USD' }, { Total: 129 },
    { Type: 'ACCPAY' }, { InvoiceID: 'another' }, { Contact: {} }, { AmountDue: 127 },
    { Status: 'VOIDED', AmountDue: 0 },
  ]) {
    const response = document(); Object.assign(response.Invoices[0], patch);
    assert.throws(() => verifyUnpaidInvoice(purchase(), response, 'books'));
  }
});
test('recovery detects newly applied cash or changed invoice identity before another write', async () => {
  for (const patch of [{ AmountPaid: 1 }, { Contact: { ContactID: 'other' } }]) {
    const f = fixture(); f.loseFinish(); await assert.rejects(confirm(f));
    Object.assign(f.invoice.Invoices[0], patch);
    await assert.rejects(f.service.resume(context, 'operation'));
    assert.equal(f.voids, 1);
    assert.equal(f.history.cancelled_for_switch_at, null);
  }
});
