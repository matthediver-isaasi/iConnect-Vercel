import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFunnelReversal} from './eventFunnelReversalRecovery.js';
function fixture(){
  const calls=[],operation={id:'op',tenant_id:'tenant',order_id:'order',state:'reserved',cancelled_at:null,card_state:'reserved',
    allocations:[{cardMinor:0,invoiceMinor:100,trainingFundMinor:50,voucherMinor:0}]};
  const order={id:'order',tenant_id:'tenant',snapshot:{}};
  const db={rpc:async(name,args)=>{
    calls.push(name);
    if(name==='event_funnel_reversal_context')return {data:{order,history:[operation]}};
    if(name==='event_funnel_reversal_cancel'){operation.cancelled_at='accepted';return {data:[]};}
    if(name==='event_funnel_reversal_training')return {data:{amountMinor:50}};
    throw new Error('Unexpected operation');
  }};
  return {db,tenantId:'tenant',orderId:'order',operationId:'op',operation,order,calls,
    recoverVoucher:async()=>({status:'complete'})};
}
test('missing accounting support fails before any cancellation or refund',async()=>{
  const f=fixture();f.recoverCredit=null;await assert.rejects(recoverFunnelReversal(f),/accounting credit/);
  assert.deepEqual(f.calls,['event_funnel_reversal_context']);
});
test('missing original voucher policy blocks cancellation before any side effects',async()=>{
  const f=fixture();f.operation.allocations[0].voucherMinor=100;
  await assert.rejects(recoverFunnelReversal(f),/approved voucher/);
  assert.deepEqual(f.calls,['event_funnel_reversal_context']);
});
test('an accounting outage does not undo cancellation or block original funding restoration',async()=>{
  const f=fixture();f.recoverCredit=async()=>{throw new Error('Provider offline');};
  const result=await recoverFunnelReversal(f);
  assert.equal(result.status,'retry');assert.equal(result.outcomes.training.status,'complete');
  assert.equal(f.operation.cancelled_at,'accepted');
  assert.equal(f.calls.filter(n=>n==='event_funnel_reversal_cancel').length,1);
  await recoverFunnelReversal(f);
  assert.equal(f.calls.filter(n=>n==='event_funnel_reversal_cancel').length,1);
});
test('a foreign operation cannot cause cancellation side effects',async()=>{
  const f=fixture();f.operation.tenant_id='other';
  await assert.rejects(recoverFunnelReversal(f),/scope/);
  assert.deepEqual(f.calls,['event_funnel_reversal_context']);
});
test('completed refunds remain complete after provider settings change',async()=>{
  const f=fixture();f.operation.cancelled_at='accepted';f.operation.card_state='complete';
  f.operation.allocations[0].cardMinor=100;f.order.currency='GBP';
  f.operation.card_receipt={id:'re',amountMinor:100,currency:'gbp'};
  f.providerFor=async()=>{throw new Error('Must not reload completed provider authority');};
  f.recoverCredit=async()=>({status:'complete'});
  const result=await recoverFunnelReversal(f);assert.equal(result.outcomes.card.status,'complete');
});
test('financial completion cannot hide missing booking cleanup',async()=>{
  const f=fixture();f.operation.requires_cleanup=true;f.recoverCredit=async()=>({status:'complete'});
  const result=await recoverFunnelReversal(f);
  assert.equal(result.outcomes.training.status,'complete');
  assert.equal(result.outcomes.cleanup.status,'needs_review');
  assert.equal(result.status,'needs_review');
});
