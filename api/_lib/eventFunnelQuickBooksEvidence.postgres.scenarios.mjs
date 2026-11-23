import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareAccountingEventSource,assertAccountingEventSource,linkAccountingEventSource} from './accountingEventSource.js';
import {validateAccountingRequestResult} from './accountingRequestProviders.js';
import {processAccountingRequest} from './accountingRequestQueue.js';
export async function exerciseFunnelQuickBooksEvidence({db,sql}) {
  await db.query(await sql('202701230034_event_funnel_quickbooks_evidence.sql'));
  const original=(await db.query(`SELECT * FROM event_funnel_invoice_work WHERE provider='quickbooks' LIMIT 1`)).rows[0];
  assert.ok(original);
  const id=randomUUID(),key=`${original.allocation_key}:evidence`,snapshot=structuredClone(original.snapshot);
  snapshot.linkage.group=key;
  snapshot.invoice.lines=[];snapshot.linkage.lineAllocations=[];
  for(const event of snapshot.linkage.events)for(const bookingId of event.bookingIds){
    const booking=(await db.query(`SELECT * FROM event_funnel_order_booking
      WHERE tenant_id=$1 AND order_id=$2 AND booking_source=$3 AND booking_id=$4`,
      [original.tenant_id,original.order_id,event.bookingSource,bookingId])).rows[0];
    assert.ok(booking);
    for(const [label,amount] of [['Ticket',Number(booking.gross_minor)],['Training fund',-Number(booking.training_fund_minor)],
      ['Voucher',-Number(booking.voucher_minor)]]){
      if(!amount)continue;
      snapshot.linkage.lineAllocations.push({index:snapshot.invoice.lines.length,source:event.bookingSource,bookingId,amountMinor:amount});
      snapshot.invoice.lines.push({Description:`${label}: ${bookingId}`,Quantity:1,UnitAmount:amount/100,
        TaxType:'NONE',TaxAmount:0,_checkoutTaxPercentage:0,_invoiceLineAmountType:'Inclusive'});
    }
  }
  const preparedRow=(await db.query('SELECT * FROM event_funnel_invoice_preparation WHERE tenant_id=$1 AND order_id=$2',
    [original.tenant_id,original.order_id])).rows[0];
  const entry=structuredClone(preparedRow.prepared.find(item=>item.key===original.allocation_key));
  entry.key=key;entry.snapshot=snapshot;entry.status='pending';
  await db.query('UPDATE event_funnel_invoice_preparation SET prepared=prepared||$1::jsonb WHERE tenant_id=$2 AND order_id=$3',
    [JSON.stringify([entry]),original.tenant_id,original.order_id]);
  await db.query(`INSERT INTO event_funnel_invoice_work(id,tenant_id,order_id,allocation_key,provider,status,snapshot)
    VALUES($1,$2,$3,$4,'quickbooks','pending',$5)`,[id,original.tenant_id,original.order_id,key,snapshot]);
  // Move only disposable fixture links to the new prepared invoice, allowing
  // the production ownership guard to remain in force during this scenario.
  for(const event of snapshot.linkage.events)await db.query(`UPDATE event_funnel_invoice_booking SET invoice_work_id=$1
    WHERE tenant_id=$2 AND booking_source=$3 AND booking_id=ANY($4::uuid[])`,
    [id,original.tenant_id,event.bookingSource,event.bookingIds]);
  const token=randomUUID();
  await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='invoices'`,[original.tenant_id,original.order_id,token]);
  const parameters={
    event_funnel_quickbooks_handoff:['p_tenant','p_order','p_token','p_key'],
    event_funnel_quickbooks_guard:['p_id','p_token'],event_funnel_quickbooks_link:['p_id','p_token'],
    accounting_request_claim:['p_request_id'],accounting_request_guard:['p_id','p_lease_token','p_stage'],
    accounting_request_prepare:['p_id','p_lease_token','p_snapshot'],
    accounting_request_checkpoint:['p_id','p_lease_token','p_stage','p_status','p_result'],
    accounting_request_finish:['p_id','p_lease_token','p_state','p_error','p_retry_seconds','p_cooldown_seconds'],
  };
  const adapter={rpc:async(name,args)=>{
    assert.ok(parameters[name]);
    const values=parameters[name].map(k=>args[k]??null);
    try{return {data:(await db.query(`SELECT to_jsonb(${name}(${values.map((_,i)=>`$${i+1}`).join(',')})) result`,values)).rows[0].result};}
    catch(error){return {error};}
  }};
  const transport={fetch:async url=>{
    if(url.includes('/item/'))return Response.json({Item:{Id:'item',Type:'Service'}});
    if(url.includes('/taxcode/'))return Response.json({TaxCode:{Id:'tax',Taxable:false}});
    if(url.includes('/account/'))return Response.json({Account:{Id:'bank',AccountType:'Bank',CurrencyRef:{value:'GBP'}}});
    if(url.includes('/query?'))return Response.json({QueryResponse:{Customer:[{Id:'customer',PrimaryEmailAddr:{Address:'buyer@example.test'}}]}});
    throw new Error('Unexpected provider lookup');
  }};
  await db.query('SET ROLE service_role');
  const handoff=await adapter.rpc('event_funnel_quickbooks_handoff',{
    p_tenant:original.tenant_id,p_order:original.order_id,p_token:token,p_key:key});
  assert.ifError(handoff.error);
  let writes=0;
  const processed=await processAccountingRequest({db:adapter,requestId:handoff.data.requestId,deadlineAt:Date.now()+20000,
    adapters:async(_row,{beforeRequest})=>({
      assertBinding:row=>assertAccountingEventSource({db:adapter,row}),
      prepare:row=>prepareAccountingEventSource({db:adapter,row,transport}),
      createInvoice:async row=>{
        await beforeRequest(row,{kind:'invoice',method:'POST'});writes++;
        const envelope=row.resolved_snapshot.invoice.envelope;
        const record={...envelope.payload,Id:`issued-${id}`,TotalAmt:snapshot.invoice.amount,TxnTaxDetail:{TotalTax:0},
          Line:envelope.payload.Line.map((line,index)=>({...line,Id:String(index+1)}))};
        return validateAccountingRequestResult(row,'invoice',record);
      },
      createPayment:async row=>{await beforeRequest(row,{kind:'payment',method:'POST'});return {id:`payment-${id}`};},
      linkSource:async row=>{
        await beforeRequest(row,{kind:'link',method:'PATCH'});
        const linked=await linkAccountingEventSource({db:adapter,row});
        assert.deepEqual(await linkAccountingEventSource({db:adapter,row}),linked);
        return linked;
      },
    })});
  await db.query('RESET ROLE');
  const work=(await db.query('SELECT * FROM event_funnel_invoice_work WHERE id=$1',[id])).rows[0];
  const diagnostic=(await db.query('SELECT state,last_error FROM accounting_request_queue WHERE id=$1',[handoff.data.requestId])).rows[0];
  assert.equal(writes,1,JSON.stringify({processed,diagnostic}));assert.equal(work.status,'complete',JSON.stringify({processed,diagnostic}));
  assert.equal(work.issued_evidence.CustomerRef.value,'customer');
  assert.equal(work.issued_evidence.taxAllocations[0].taxMinor,0);
  assert.equal(work.issued_evidence.Id,work.invoice_id);
}
