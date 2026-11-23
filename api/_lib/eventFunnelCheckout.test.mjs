import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunnelCheckoutService } from './eventFunnelCheckout.js';
import { snapshotFunnelTicket } from './eventFunnelCommercial.js';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const owner={tenantId:uuid(1),sessionId:uuid(2),memberId:uuid(3)};
  const purchaser={first_name:'Original',last_name:'Buyer',email:'original@example.test'};
  const price={...snapshotFunnelTicket({id:uuid(4),tenant_id:owner.tenantId,title:'Admission'},
    {id:'A',name:'Admission',price:5,currency:'GBP'},'simple',
    {stripe:{mode:'test',accountFingerprint:'frozen'},accounting:{name:'xero',company:'original-company'},accountingSettings:{}},
    {id:owner.memberId}),purchaser};
  const snapshot={serverNow:'2027-01-23T10:00:00Z',
    session:{id:owner.sessionId,tenant_id:owner.tenantId,member_id:owner.memberId,revision:2,state:'held',
      expires_at:'2027-01-23T10:10:00Z',journey:{version:1,decisions:{},checkoutNow:true}},
    graph:{version:1,tenantId:owner.tenantId,entry:'source',reservationSeconds:600,invoiceMode:'per_event',
      nodes:[{id:'source',type:'source',event:{id:uuid(4),kind:'simple',tenantId:owner.tenantId},ticketIds:['A'],requires:[],accept:'checkout'},
        {id:'checkout',type:'checkout'}]},
    holds:[{node_id:'source',event_id:uuid(4),event_kind:'simple',ticket_id:'A',quantity:1,places:1,price_snapshot:price}],
    drafts:{source:{attendees:[{...purchaser}],third_party_consent:false}}};
  const calls=[];let preparedOrder=null;
  const db={rpc:async(name,args)=>{
    calls.push({name,args});
    if(name==='event_funnel_read_session') return {data:structuredClone(snapshot)};
    if(name==='event_funnel_prepare_order') {
      preparedOrder={id:uuid(5),snapshot:args.p_snapshot};
      return {data:preparedOrder};
    }
    if(name==='event_funnel_session_order')return {data:preparedOrder};
    if(name==='event_funnel_training_ready')return {data:true};
    if(name==='event_funnel_voucher_ready')return {data:true};
    if(name==='event_funnel_training_quote')return {data:{enabled:true,availableMinor:500,organizationId:uuid(8)}};
    throw new Error(name);
  }};
  const dependencies={db,
    resolveSelection:async input=>({lines:input.previousHolds.map(h=>({ticketId:h.ticket_id,priceSnapshot:h.price_snapshot})),
      answers:{...input.answers,attendees:[{...purchaser,job_title:'Verified title'}]}}),
    resolveCustomer:async input=>{
      assert.equal(input.memberId,owner.memberId);assert.deepEqual(input.purchaser,purchaser);
      return {contact:{name:'Invoice recipient',email:'finance@example.test',provenance:{kind:'member',id:owner.memberId}},
        selectedBindings:{xeroId:'contact',xeroCompany:'original-company'}};
    },
    loadChoices:async()=>({choices:[{kind:'member',id:owner.memberId,name:'Buyer',bindings:{xeroId:'private'}}],personalAddress:null}),
  };
  return {owner,snapshot,calls,dependencies,service:createFunnelCheckoutService(dependencies),
    command:{expectedRevision:2,paymentMethod:'card',submissionAccepted:true,customer:{kind:'member',id:owner.memberId}}};
}
test('checkout revalidates attendees, keeps original purchaser/prices and freezes one verified customer',async()=>{
  const f=fixture();
  const order=await f.service.prepare(f.owner,f.command);
  assert.equal(order.snapshot.payableMinor,500);
  assert.equal(order.snapshot.purchaser.email,'original@example.test');
  assert.equal(order.snapshot.invoiceCustomer.email,'finance@example.test');
  assert.equal(order.snapshot.invoiceCustomer.providerCustomerId,'contact');
  assert.equal(order.snapshot.lines[0].registrations[0].row.attendee_job_title,'Verified title');
  assert.equal(f.calls.filter(call=>call.name==='event_funnel_prepare_order').length,1);
  assert.equal(f.snapshot.drafts.source.attendees[0].job_title,undefined);
});
test('summary never exposes provider customer bindings',async()=>{
  const f=fixture();const summary=await f.service.summary(f.owner);
  assert.equal(summary.totalMinor,500);
  assert.equal(JSON.stringify(summary).includes('private'),false);
  assert.equal(summary.customers[0].bindings,undefined);
});
test('quote is read-only and a changed final amount cannot prepare an order',async()=>{
  const f=fixture();
  const quote=await f.service.quote(f.owner,{...f.command,submissionAccepted:false,trainingFundMinor:500});
  assert.equal(quote.payableMinor,0);assert.equal(quote.paymentMethod,'free');
  assert.equal(f.calls.filter(call=>call.name==='event_funnel_prepare_order').length,0);
  assert.ok(!JSON.stringify(quote).includes('original-company'));
  assert.ok(!JSON.stringify(quote).includes('finance@example.test'));
  await assert.rejects(f.service.prepare(f.owner,{...f.command,expectedPayableMinor:499}),{code:'QUOTE_CHANGED'});
  assert.equal(f.calls.filter(call=>call.name==='event_funnel_prepare_order').length,0);
  assert.equal((await f.service.prepare(f.owner,{...f.command,expectedPayableMinor:500})).snapshot.payableMinor,500);
});
test('training funds are server-quoted, bound to their owner and cannot exceed the available balance',async()=>{
  const f=fixture();
  const order=await f.service.prepare(f.owner,{...f.command,trainingFundMinor:500,paymentMethod:'free'});
  assert.equal(order.snapshot.payableMinor,0);
  assert.equal(order.snapshot.trainingFundMinor,500);
  assert.equal(order.snapshot.lines[0].registrations[0].row.organization_id,uuid(8));
  const other=fixture();
  await assert.rejects(other.service.prepare(other.owner,{...other.command,trainingFundMinor:501}),{code:'FUNDING_UNAVAILABLE'});
  assert.equal(other.calls.some(call=>call.name==='event_funnel_prepare_order'),false);
});
test('voucher funding uses server-derived post-training amounts and freezes exact allocations',async()=>{
  const f=fixture();
  const service=createFunnelCheckoutService({...f.dependencies,quoteVouchers:async input=>{
    assert.deepEqual(input.lines,[{nodeId:'source',ticketId:'A',remainingMinor:300}]);
    assert.deepEqual(input.requestedIds,[uuid(9)]);
    return {voucherMinor:300,allocations:[{voucherId:uuid(9),amountMinor:300,lines:input.lines.map(line=>({
      nodeId:line.nodeId,ticketId:line.ticketId,amountMinor:300,
    }))}]};
  }});
  const order=await service.prepare(f.owner,{...f.command,trainingFundMinor:200,voucherIds:[uuid(9)],paymentMethod:'free'});
  assert.equal(order.snapshot.payableMinor,0);
  assert.equal(order.snapshot.voucherMinor,300);
  assert.equal(order.snapshot.lines[0].voucherMinor,300);
  assert.equal(order.snapshot.voucherAllocations[0].voucherId,uuid(9));
});
test('a lost preparation response resumes the original immutable order',async()=>{
  const f=fixture();
  const first=await f.service.prepare(f.owner,f.command);
  f.snapshot.session.state='payable';f.snapshot.session.revision++;
  assert.deepEqual(await f.service.prepare(f.owner,f.command),first);
  await assert.rejects(f.service.prepare(f.owner,{...f.command,paymentMethod:'account'}),{code:'REVISION_CONFLICT'});
  assert.equal(f.calls.filter(call=>call.name==='event_funnel_prepare_order').length,1);
});
test('forged payment authority, unaccepted submission and stale revisions cannot prepare an order',async()=>{
  for(const change of [{amount:1},{purchaser:{email:'forged@example.test'}},{submissionAccepted:false},
    {voucherMinor:1},{expectedRevision:1}]) {
    const f=fixture();
    await assert.rejects(f.service.prepare(f.owner,{...f.command,...change}));
    assert.equal(f.calls.some(call=>call.name==='event_funnel_prepare_order'),false);
  }
});
test('changed eligibility or prices leave the original reservation and payment untouched',async()=>{
  for(const resolver of [
    async()=>{throw new Error('Eligibility unavailable');},
    async input=>({lines:[{ticketId:'A',priceSnapshot:{...input.previousHolds[0].price_snapshot,unitMinor:999}}],answers:input.answers}),
  ]) {
    const f=fixture();
    const service=createFunnelCheckoutService({...f.dependencies,resolveSelection:resolver});
    await assert.rejects(service.prepare(f.owner,f.command));
    assert.equal(f.calls.some(call=>call.name==='event_funnel_prepare_order'),false);
  }
});
