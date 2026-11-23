import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateEventFunnelVouchers,funnelVoucherLineKey,validateFunnelVoucherAllocations } from './eventFunnelVoucherAllocation.js';
function fixture() {
  const lines=[{nodeId:'source',ticketId:'entry',remainingMinor:500},{nodeId:'later',ticketId:'lunch',remainingMinor:800}];
  return {lines,vouchers:[{id:'early',availableMinor:900,expires_at:'2027-01-01',issued_at:'2026-01-01'},
    {id:'late',availableMinor:700,expires_at:'2027-12-01',issued_at:'2026-01-01'}],
    requestedIds:['late','early'],eligibleLines:new Map([
      ['early',new Set([funnelVoucherLineKey(lines[0])])],
      ['late',new Set(lines.map(funnelVoucherLineKey))],
    ])};
}
test('earliest-expiring credit is used first but cannot fund an ineligible later event',()=>{
  const input=fixture(),before=structuredClone(input);
  const result=allocateEventFunnelVouchers(input);
  assert.deepEqual(input,before);
  assert.equal(result.voucherMinor,1200);
  assert.equal(result.payableMinor,100);
  assert.deepEqual(result.lineAmounts,[500,700]);
  assert.deepEqual(result.allocations.map(row=>[row.voucherId,row.amountMinor]),[['early',500],['late',700]]);
  assert.deepEqual(result.allocations[0].lines,[{nodeId:'source',ticketId:'entry',amountMinor:500}]);
});
test('one voucher is allocated only once across repeated and same-event offer lines',()=>{
  const input=fixture();
  input.requestedIds=['late'];
  input.lines.push({nodeId:'addon',ticketId:'parking',remainingMinor:200});
  input.eligibleLines.set('late',new Set(input.lines.map(funnelVoucherLineKey)));
  const result=allocateEventFunnelVouchers(input);
  assert.equal(result.voucherMinor,700);
  assert.deepEqual(result.lineAmounts,[500,200,0]);
});
test('credit exceeding the basket never creates negative balances or repeated deductions',()=>{
  const input=fixture();
  input.vouchers.forEach(voucher=>{voucher.availableMinor=10000;});
  const result=allocateEventFunnelVouchers(input);
  assert.equal(result.payableMinor,0);
  assert.equal(result.voucherMinor,1300);
  assert.equal(result.allocations.reduce((sum,row)=>sum+row.amountMinor,0),1300);
});
test('registration allocations preserve exact totals and reject invalid destinations',()=>{
  const input=fixture(),result=allocateEventFunnelVouchers(input);
  assert.deepEqual(validateFunnelVoucherAllocations(input.lines,result.allocations,result.voucherMinor),[500,700]);
  for(const mutate of [
    allocations=>allocations.push(structuredClone(allocations[0])),
    allocations=>{allocations[0].amountMinor++;},
    allocations=>{allocations[0].lines[0].nodeId='forged';},
    allocations=>{allocations[1].lines[0].amountMinor=900;allocations[1].amountMinor=900;},
  ]) {
    const allocations=structuredClone(result.allocations);mutate(allocations);
    assert.throws(()=>validateFunnelVoucherAllocations(input.lines,allocations,result.voucherMinor),{code:'INVALID_VOUCHER_ALLOCATION'});
  }
});
test('duplicate selection, unknown eligibility and malformed penny amounts fail closed',()=>{
  for(const change of [
    input=>input.requestedIds.push('early'),
    input=>input.eligibleLines.delete('early'),
    input=>input.eligibleLines.get('early').add('forged'),
    input=>{input.lines[0].remainingMinor=-1;},
    input=>{input.vouchers[0].availableMinor=0.5;},
    input=>input.lines.push({...input.lines[0]}),
  ]) {const input=fixture();change(input);assert.throws(()=>allocateEventFunnelVouchers(input),{code:'INVALID_VOUCHER_ALLOCATION'});}
});
