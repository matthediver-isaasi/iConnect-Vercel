import assert from 'node:assert/strict';
import {deliverFunnelQuickBooks} from './eventFunnelQuickBooks.js';
import {processAccountingRequest} from './accountingRequestQueue.js';
import {assertAccountingEventSource,linkAccountingEventSource,prepareAccountingEventSource} from './accountingEventSource.js';

export async function exerciseFunnelQuickBooks({db,connect,sql}) {
  // Install the actual shared queue, including its preparation/immutable-stage
  // contracts; never replace it with a mock SQL queue.
  for(const file of ['202612050001_accounting_request_queue.sql','202612050002_accounting_request_gc_preparation.sql',
    '202701230017_event_funnel_quickbooks_delivery.sql']) await db.query(await sql(file));
  const saved=(await db.query('SELECT * FROM event_funnel_invoice_preparation LIMIT 1')).rows[0];
  const prepared=saved.prepared,invoice=prepared.find(item=>item.amountMinor>0);
  assert.ok(invoice);
  // Reset provider fixtures in the disposable database; no production account
  // is changed. The preceding scenarios verify immutable real preparation.
  const amount=invoice.amountMinor/100;
  const snapshot={version:1,preparation:true,bookingContractVersion:2,environment:'production',
    approvalProvider:{connectionId:'fixture-qbo',realmId:'fixture-realm'},
    invoice:{amount,currency:'GBP',paymentMethod:'stripe',date:'2026-11-23',dueDate:'2026-12-23',
      contact:{name:'Buyer',email:'buyer@example.test',provenance:{kind:'member',id:'fixture-member'}},
      settings:{quickbooks_event_item_id:'item',quickbooks_event_tax_code_id:'tax',quickbooks_event_stripe_bank_account_id:'bank'},
      lines:[{Description:'Original event allocation',Quantity:1,UnitAmount:amount,TaxType:'NONE',TaxAmount:0,
        _checkoutTaxPercentage:0,_invoiceLineAmountType:'Inclusive'}]},
    payment:{paymentIntentId:'pi_fixture',status:'succeeded',livemode:true,amount,currency:'GBP',paidAt:'2026-11-23T12:00:00Z'},
    linkage:{source:'event_funnel',group:invoice.key,orderId:saved.order_id,events:invoice.events}};
  invoice.provider='quickbooks';invoice.status='pending';invoice.snapshot=snapshot;
  await db.query('UPDATE event_funnel_invoice_preparation SET prepared=$1 WHERE tenant_id=$2 AND order_id=$3',
    [JSON.stringify(prepared),saved.tenant_id,saved.order_id]);
  await db.query(`UPDATE event_funnel_invoice_work SET provider='quickbooks',snapshot=$1,status='pending',
    invoice_id=NULL,invoice_number=NULL,payment_id=NULL,invoice_write_started_at=NULL,payment_write_started_at=NULL,
    resolved_snapshot=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now()
    WHERE tenant_id=$2 AND allocation_key=$3`,[snapshot,saved.tenant_id,invoice.key]);
  const token=(await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '2 minutes' WHERE tenant_id=$1 AND order_id=$2 AND kind='invoices' RETURNING lease_token`,
  [saved.tenant_id,saved.order_id])).rows[0].lease_token;
  const job={tenant_id:saved.tenant_id,order_id:saved.order_id,lease_token:token};
  const parameters={
    event_funnel_quickbooks_handoff:['p_tenant','p_order','p_token','p_key'],
    event_funnel_quickbooks_guard:['p_id','p_token'],event_funnel_quickbooks_link:['p_id','p_token'],
    accounting_request_claim:['p_request_id'],
    accounting_request_guard:['p_id','p_lease_token','p_stage'],
    accounting_request_prepare:['p_id','p_lease_token','p_snapshot'],
    accounting_request_checkpoint:['p_id','p_lease_token','p_stage','p_status','p_result'],
    accounting_request_finish:['p_id','p_lease_token','p_state','p_error','p_retry_seconds','p_cooldown_seconds'],
  };
  const adapter=client=>({rpc:async(name,args={})=>{
    try {
      assert.ok(parameters[name],`Unexpected RPC ${name}`);
      const values=parameters[name].map(key=>args[key]===undefined?null:
        args[key]&&typeof args[key]==='object'?JSON.stringify(args[key]):args[key]);
      return {data:(await client.query(`SELECT to_jsonb(${name}(${values.map((_,i)=>`$${i+1}`).join(',')})) r`,values)).rows[0].r};
    } catch(error) {return {error};}
  }});
  const client=adapter(db),scope={p_tenant:job.tenant_id,p_order:job.order_id,p_token:token,p_key:invoice.key};
  await db.query('SET ROLE service_role');
  const first=await client.rpc('event_funnel_quickbooks_handoff',scope);
  assert.ifError(first.error);
  assert.equal((await client.rpc('event_funnel_quickbooks_handoff',scope)).data.requestId,first.data.requestId);
  assert.ok((await client.rpc('event_funnel_quickbooks_handoff',{...scope,p_tenant:'00000000-0000-4000-8000-000000000099'})).error);
  const requestId=first.data.requestId;
  const claim=await client.rpc('accounting_request_claim',{p_request_id:requestId});assert.ifError(claim.error);
  const row=claim.data;assert.equal(row.source_type,'event_funnel');assert.equal(row.snapshot.invoice.amount,amount);
  const competitor=await connect();await competitor.query('SET ROLE service_role');
  assert.equal((await adapter(competitor).rpc('accounting_request_claim',{p_request_id:requestId})).data,null);
  assert.equal((await client.rpc('event_funnel_quickbooks_guard',{p_id:requestId,p_token:row.lease_token})).data,true);
  assert.equal((await client.rpc('event_funnel_quickbooks_guard',{p_id:requestId,p_token:token})).data,false);
  assert.ok((await client.rpc('event_funnel_quickbooks_link',{p_id:requestId,p_token:row.lease_token})).error);
  await client.rpc('accounting_request_finish',{p_id:requestId,p_lease_token:row.lease_token,p_state:'retry',p_retry_seconds:1,p_cooldown_seconds:0});
  await db.query('RESET ROLE');
  await db.query('UPDATE accounting_request_queue SET next_attempt_at=now() WHERE id=$1',[requestId]);
  await db.query('SET ROLE service_role');
  let invoiceWrites=0,paymentWrites=0,invoiceResult=null,loseResponse=true;
  const transport={fetch:async(url,init)=>{
    assert.equal(init.method,'GET'); // fixture uses an existing customer
    if(url.includes('/item/')) return Response.json({Item:{Id:'item',Type:'Service'}});
    if(url.includes('/taxcode/')) return Response.json({TaxCode:{Id:'tax',Taxable:false}});
    if(url.includes('/account/')) return Response.json({Account:{Id:'bank',AccountType:'Bank',CurrencyRef:{value:'GBP'}}});
    if(url.includes('/query?')) return Response.json({QueryResponse:{Customer:[{Id:'customer',
      DisplayName:'Buyer',PrimaryEmailAddr:{Address:'buyer@example.test'}}]}});
    throw new Error('Unexpected fixture provider URL');
  }};
  const adapters=async(_row,{beforeRequest})=>({
    assertBinding:candidate=>assertAccountingEventSource({db:client,row:candidate}),
    prepare:candidate=>prepareAccountingEventSource({db:client,row:candidate,transport}),
    createInvoice:async candidate=>{
      await beforeRequest(candidate,{kind:'invoice',method:'POST'});
      invoiceWrites++;invoiceResult={id:'qbo-invoice',invoiceNumber:'QBO-1'};
      if(loseResponse) {loseResponse=false;throw new Error('lost provider response');}return invoiceResult;
    },
    discoverInvoice:async()=>({outcome:'found',result:invoiceResult}),
    createPayment:async candidate=>{
      await beforeRequest(candidate,{kind:'payment',method:'POST'});
      assert.equal(candidate.resolved_snapshot.payment.envelope.payload.TotalAmt,amount);
      paymentWrites++;return {id:'qbo-payment'};
    },
    linkSource:async candidate=>{
      await beforeRequest(candidate,{kind:'link',method:'PATCH'});
      const linked=await linkAccountingEventSource({db:client,row:candidate});
      // Crash/retry after successful link is safe too.
      assert.deepEqual(await linkAccountingEventSource({db:client,row:candidate}),linked);
      return linked;
    },
  });
  const processRequest=input=>processAccountingRequest({...input,adapters});
  const delivery=()=>deliverFunnelQuickBooks({db:client,job,key:invoice.key,deadlineAt:Date.now()+20000,processRequest});
  assert.equal((await delivery()).status,'pending');
  assert.equal(invoiceWrites,1);assert.equal(paymentWrites,0);
  await db.query('RESET ROLE');
  await db.query('UPDATE accounting_request_queue SET next_attempt_at=now() WHERE id=$1',[requestId]);
  await db.query('SET ROLE service_role');
  assert.equal((await delivery()).status,'complete');
  assert.equal((await delivery()).status,'complete');
  assert.equal(invoiceWrites,1);assert.equal(paymentWrites,1);
  await assert.rejects(db.query('SELECT * FROM event_funnel_invoice_booking'),{code:'42501'});
  await db.query('RESET ROLE');
  const work=(await db.query('SELECT * FROM event_funnel_invoice_work WHERE tenant_id=$1 AND allocation_key=$2',
    [job.tenant_id,invoice.key])).rows[0];
  assert.equal(work.invoice_id,'qbo-invoice');assert.equal(work.payment_id,'qbo-payment');
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_invoice_booking WHERE invoice_work_id=$1',[work.id])).rows[0].n,
    invoice.events.flatMap(e=>e.bookingIds).length);
  // The general queue is not authority to borrow another tenant's funnel
  // allocation, even if all original provider/snapshot values are copied.
  await db.query('SET ROLE service_role');
  const foreign=(await db.query(`SELECT to_jsonb(accounting_request_enqueue($1,'quickbooks',
    'fixture-qbo','fixture-realm','event_funnel',$2,'invoice',$3)) r`,
  ['00000000-0000-4000-8000-000000000099',invoice.key,snapshot])).rows[0].r;
  const foreignClaim=await client.rpc('accounting_request_claim',{p_request_id:foreign.id});
  assert.ifError(foreignClaim.error);
  assert.equal((await client.rpc('event_funnel_quickbooks_guard',{
    p_id:foreign.id,p_token:foreignClaim.data.lease_token})).data,false);
  assert.ok((await client.rpc('event_funnel_quickbooks_link',{
    p_id:foreign.id,p_token:foreignClaim.data.lease_token})).error);
  assert.ifError((await client.rpc('accounting_request_finish',{p_id:foreign.id,p_lease_token:foreignClaim.data.lease_token,
    p_state:'review',p_error:'FIXTURE_FOREIGN_SOURCE',p_retry_seconds:60,p_cooldown_seconds:0})).error);
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT event_funnel_quickbooks_guard($1,$2)',[requestId,token]),{code:'42501'});
    await db.query('RESET ROLE');
  }
}
