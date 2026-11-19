import test from 'node:test';
import assert from 'node:assert/strict';
import { addUnifiedBookingReportStatus } from './unifiedBookingReport.js';
const group = () => ({ bookingContractVersion:2, groupRef:'original-group',
  publicInvoicePurchaser:{email:'booker@example.invalid'},groupPayment:{},attendees:[{attendee_email:'attendee@example.invalid'}] });
function fixture(data,error=null){
  const q={select(){return q;},eq(key,value){assert.equal(key,'tenant_id');assert.equal(value,'tenant');return q;},
    in(key,values){assert.equal(key,'purchase_key');assert.ok(values.length<=100);return Promise.resolve({data,error});}};
  return {from(table){assert.equal(table,'unified_booking_invoice');return q;}};
}
test('pre-queue invoice and provisioning failures remain visible without exposing private instructions',async()=>{
  const booking=group();
  await addUnifiedBookingReportStatus(fixture([{purchase_key:'original-group',state:'needs_review',provision_state:'needs_review',
    prepared:{snapshot:{reviewReasons:['Original accounting company was unavailable'],provider:{token:'private-must-not-leak'}}},
    provisioned:[{email:'attendee@example.invalid',memberId:'created-attendee'}],booker_member_id:'explicit-booker'}]),'tenant',[booking]);
  assert.equal(booking.groupPayment.invoiceRecoveryStatus,'needs_review');
  assert.match(booking.invoiceRecoveryReason,/Original accounting company/);
  assert.equal(booking.attendees[0].linked_member_id,'created-attendee');
  assert.equal(booking.bookerCreatedMemberId,'explicit-booker');
  assert.equal(booking.provisionState,'needs_review');
  assert.ok(!JSON.stringify(booking).includes('private-must-not-leak'));
});
test('unavailable or missing durable status is review, not a fabricated success or an absent booking',async()=>{
  for(const db of [fixture(null,{code:'offline'}),fixture([]),{from(){throw new Error('unavailable');}}]){
    const booking=group();
    await addUnifiedBookingReportStatus(db,'tenant',[booking]);
    assert.equal(booking.groupPayment.invoiceRecoveryStatus,'needs_review');
    assert.match(booking.invoiceRecoveryReason,/could not be loaded/);
  }
});
test('free bookings stay outside invoicing and historical groups never read the new outbox',async()=>{
  const booking=group();
  await addUnifiedBookingReportStatus(fixture([{purchase_key:'original-group',state:'not_applicable',provision_state:'completed',provisioned:[]}]),'tenant',[booking]);
  assert.equal(booking.groupPayment.invoiceRecoveryStatus,'not_applicable');
  const legacy={...group(),bookingContractVersion:1};
  await addUnifiedBookingReportStatus({from(){throw new Error('must not query');}},'tenant',[legacy]);
  assert.deepEqual(legacy.groupPayment,{});
});
