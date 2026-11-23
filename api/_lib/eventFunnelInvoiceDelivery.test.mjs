import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverFunnelInvoices,funnelInvoiceRecoveryDatabase} from './eventFunnelInvoiceDelivery.js';

const job={tenant_id:'tenant',order_id:'order',lease_token:'outer-token'};
function fixture(rows) {
  const calls=[];
  const db={rpc(name,args) {
    calls.push([name,args]);
    if(name==='event_funnel_invoice_input') return Promise.resolve({data:{order:{},allocations:[],prepared:[{key:'saved'}]}});
    if(name==='event_funnel_invoice_enqueue') return Promise.resolve({data:rows});
    throw new Error(name);
  }};
  return {db,calls};
}
test('only exact frozen invoice scope is passed to the existing provider recovery algorithm',async()=>{
  const f=fixture([{key:'original',provider:'xero',status:'pending'}]);
  const result=await deliverFunnelInvoices({db:f.db,job,deadlineAt:5000,now:()=>0,processInvoice:async options=>{
    assert.equal(options.source,'event_funnel');assert.equal(options.tenantId,'tenant');
    assert.equal(options.bookingGroupReference,'original');assert.equal(options.deadlineAt,5000);
    return {status:'complete'};
  }});
  assert.deepEqual(result,{status:'delivered'});
  assert.equal(f.calls.length,2);
});
test('mixed invoices continue despite individual review; pending providers are not marked delivered',async()=>{
  const f=fixture([{key:'review',provider:'xero',status:'needs_review'},
    {key:'next',provider:'xero',status:'pending'},{key:'qbo',provider:'quickbooks',status:'pending'}]);
  let count=0;
  const result=await deliverFunnelInvoices({db:f.db,job,processInvoice:async()=>{count++;return {status:'complete'};},
    processQuickBooks:async()=>({status:'pending'})});
  assert.equal(count,1);assert.equal(result.status,'retry');
});
test('already delivered and zero-balance invoices do not call the provider again',async()=>{
  const f=fixture([{status:'complete'},{status:'not_applicable'}]);
  assert.deepEqual(await deliverFunnelInvoices({db:f.db,job,processInvoice:()=>assert.fail('No provider call')}),{status:'delivered'});
});
test('time budget exhaustion retains invoice work for retry',async()=>{
  const f=fixture([{key:'original',provider:'xero',status:'pending'}]);
  const result=await deliverFunnelInvoices({db:f.db,job,deadlineAt:1000,now:()=>1000,processInvoice:()=>assert.fail('budget')});
  assert.equal(result.status,'retry');
});
test('database adapter routes only invoice recovery operations and preserves abort-capable builders',()=>{
  const calls=[],builder={abortSignal(){return this;}};
  const db={rpc:(...args)=>{calls.push(args);return builder;},from:name=>name};
  const wrapped=funnelInvoiceRecoveryDatabase(db);
  assert.equal(wrapped.rpc('event_invoice_recovery_guard',{p_id:'id'}),builder);
  assert.deepEqual(calls[0],['event_funnel_invoice_operation',{p_action:'guard',p_args:{p_id:'id'}}]);
  wrapped.rpc('unrelated',{});
  assert.deepEqual(calls[1],['unrelated',{}]);assert.equal(wrapped.from('xero_token'),'xero_token');
});
test('QuickBooks invoices use only their own provider and durable completion result',async()=>{
  const f=fixture([{key:'original-qbo',provider:'quickbooks',status:'pending'}]);
  const result=await deliverFunnelInvoices({db:f.db,job,processInvoice:()=>assert.fail('must not call Xero'),
    processQuickBooks:async input=>{
      assert.equal(input.key,'original-qbo');assert.equal(input.job,job);assert.equal(input.db,f.db);
      return {status:'complete'};
    }});
  assert.equal(result.status,'delivered');
});
