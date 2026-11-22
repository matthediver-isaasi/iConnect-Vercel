import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleInvoiceBlocker, loadLifecycleObligations } from './memberLifecycleObligations.js';
const member = { id: 'member', email: 'fixture@example.invalid' }, policy = { timezone: 'UTC' };
const now = new Date('2026-11-22');
const read = values => async (_db, table) => values[table] || [];
test('invoice cancellation and import labels do not prove settlement', () => {
  assert.equal(lifecycleInvoiceBlocker({ payment_status: 'paid' }), null);
  assert.equal(lifecycleInvoiceBlocker({ invoice_status: 'VOIDED' }), null);
  assert.equal(lifecycleInvoiceBlocker({ status: 'Paid' }), 'unresolved_invoice');
  assert.equal(lifecycleInvoiceBlocker({ payment_status: 'cancelled' }), 'unresolved_invoice');
  assert.equal(lifecycleInvoiceBlocker({ payment_status: 'paid', check_error: 'unavailable' }), 'invoice_status_unverified');
});
test('empty complete sources have no financial blockers', async () => {
  const result = await loadLifecycleObligations({}, 'tenant', member, policy, now, read({}));
  assert.equal(result.complete, true);
  assert.deepEqual(result.blockers, []);
});
test('future events, pending invoice work, form debts and unspent credit block disposal', async () => {
  const result = await loadLifecycleObligations({}, 'tenant', member, policy, now, read({
    booking: [{ id: 'booking', status: 'confirmed', event_id: 'event',total_cost:0 }],
    event: [{ id: 'event', start_date: '2027-01-01' }],
    unified_booking_invoice: [{ purchase_key: 'purchase', state: 'needs_review', provision_state: 'completed' }],
    form_submission: [{ id: 's', payment_amount: 20, payment_provider: 'invoice', payment_status: 'unpaid' }],
    voucher: [{ id: 'voucher', value: 5, status: 'active', expires_at: '2027-01-01' }],
  }));
  assert.deepEqual(result.blockers, ['booking_invoice_pending', 'form_payment_or_invoice_unresolved',
    'future_or_current_event_booking', 'unspent_member_credit']);
});
test('source failures are not collapsed to empty obligations', async () => {
  await assert.rejects(loadLifecycleObligations({}, 'tenant', member, policy, now,
    async () => { throw new Error('unavailable'); }), /unavailable/);
});
test('past chargeable bookings require settlement and refund evidence, including legacy accounts',async()=>{
  for(const table of ['booking','complex_event_booking']){
    const eventTable=table==='booking'?'event':'complex_event';
    for(const state of [
      {payment_method:'invoice',payment_status:'unpaid'},
      {payment_status:'paid',refund_status:'pending'},
      {payment_status:'paid',payment_meta:{refund_status:'processing'}},
    ]){
      const result=await loadLifecycleObligations({},'tenant',member,policy,now,read({
        [table]:[{id:'booking',status:'confirmed',event_id:'event',total_cost:50,...state}],
        [eventTable]:[{id:'event',start_date:'2020-01-01'}],
      }));
      assert.ok(result.blockers.some(reason=>['booking_settlement_unverified','booking_refund_unresolved'].includes(reason)));
    }
  }
  const queued=await loadLifecycleObligations({},'tenant',member,policy,now,read({
    unified_booking_invoice:[{purchase_key:'fixture',state:'queued',provision_state:'completed'}],
  }));
  assert.ok(queued.blockers.includes('booking_invoice_settlement_unverified'));
});
