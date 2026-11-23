import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFunnelVoucherReversal} from './eventFunnelVoucherReversal.js';
function fixture(){
  const calls=[],operation={id:'op',tenant_id:'tenant',order_id:'order',cancelled_at:'2026-01-01',state:'processing',
    refund_options:{voucherReplacements:[]},allocations:[{voucherMinor:100}],voucher_plan:[{voucherId:'v',allocationId:'a',amountMinor:100}],voucher_receipts:{}};
  const db={rpc:async(name,args)=>{calls.push(['save',args]);return {data:true};}};
  const refund=async(db,args)=>{calls.push(['refund',args]);return {voucherId:'v',cumulativeMinor:100,amountMinor:100};};
  return {operation,db,refund,calls};
}
test('voucher restoration uses original allocation identity and stable recovery key',async()=>{
  const f=fixture();assert.equal((await recoverFunnelVoucherReversal(f)).amountMinor,100);
  assert.equal(f.calls[0][1].refundKey,'event-funnel-reversal:op:a');
  assert.equal(f.calls[1][1].p_order,'order');
});
test('lost receipts replay the same refund authority, not another credit',async()=>{
  const f=fixture();f.db.rpc=async()=>({error:{code:'unavailable'}});
  await assert.rejects(recoverFunnelVoucherReversal(f),/recovery/);
  await assert.rejects(recoverFunnelVoucherReversal(f),/recovery/);
  assert.equal(f.calls[0][1].refundKey,f.calls[1][1].refundKey);
});
test('missing frozen shares and uncancelled registrations never reach credit restoration',async()=>{
  const f=fixture();f.operation.voucher_plan=[];
  await assert.rejects(recoverFunnelVoucherReversal(f),/incomplete/);
  f.operation.cancelled_at=null;await assert.rejects(recoverFunnelVoucherReversal(f),/authority/);
  assert.equal(f.calls.length,0);
});
test('a stored matching receipt avoids repeating accounting inspection',async()=>{
  const f=fixture();f.operation.voucher_receipts.a={voucherId:'v',cumulativeMinor:100};
  await recoverFunnelVoucherReversal(f);assert.equal(f.calls.length,0);
});
test('caller options cannot replace the original approved policy',async()=>{
  const f=fixture();f.operation.refund_options={voucherReplacements:[{voucherId:'v',newExpiryDate:'2027-01-01'}]};
  await recoverFunnelVoucherReversal({...f,reversalOptions:{voucherReplacements:[]}});
  assert.deepEqual(f.calls[0][1].reversalOptions,f.operation.refund_options);
});
test('missing original options require reconciliation before restoring money',async()=>{
  const f=fixture();delete f.operation.refund_options;
  await assert.rejects(recoverFunnelVoucherReversal(f),/approved/);
  assert.equal(f.calls.length,0);
});
