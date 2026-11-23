import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recoverFunnelInvoiceCredits} from './eventFunnelCreditRecovery.js';
import {executeFunnelXeroCredit} from './eventFunnelXeroCredit.js';
export async function exerciseFunnelCreditProducer({db,sql,connect}) {
  await db.query(await sql('202701230033_event_funnel_credit_producer.sql'));
  const b=(await db.query('SELECT * FROM event_funnel_order_booking WHERE payable_minor>1 LIMIT 1')).rows[0];
  assert.ok(b);const work=randomUUID(),r1=randomUUID(),r2=randomUUID();
  const line={LineItemID:'line',Description:'Original booking',Quantity:1,UnitAmount:Number(b.payable_minor)/100,
    LineAmount:Number(b.payable_minor)/100,TaxAmount:0,TaxType:'NONE',AccountCode:'200'};
  const issued={InvoiceID:`invoice-${work}`,Contact:{ContactID:'original-customer'},CurrencyCode:'GBP',
    LineAmountTypes:'Inclusive',Total:line.LineAmount,TotalTax:0,LineItems:[line]};
  await db.query(`INSERT INTO event_funnel_invoice_work(id,tenant_id,order_id,allocation_key,provider,status,snapshot,
    invoice_id,xero_tenant_id,issued_evidence) VALUES($1,$2,$3,$4,'xero','complete',$5,$6,'original-company',$7)`,
    [work,b.tenant_id,b.order_id,`producer-${work}`,{eventFunnel:{lineAllocations:[{
      index:0,source:b.booking_source,bookingId:b.booking_id,amountMinor:Number(b.payable_minor)}]}},issued.InvoiceID,issued]);
  await db.query(`INSERT INTO event_funnel_invoice_booking(invoice_work_id,tenant_id,booking_source,booking_id,amount_minor)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,booking_source,booking_id) DO UPDATE SET invoice_work_id=excluded.invoice_work_id`,
    [work,b.tenant_id,b.booking_source,b.booking_id,b.payable_minor]);
  // Accepted cancellation fixtures. Actual cancellation and monetary caps are
  // exercised separately through their production RPCs in earlier scenarios.
  for(const id of [r1,r2])await db.query(`INSERT INTO event_funnel_reversal(id,tenant_id,order_id,allocations,cancelled_at)
    VALUES($1,$2,$3,$4,now())`,[id,b.tenant_id,b.order_id,JSON.stringify([{source:b.booking_source,id:b.booking_id,
      invoiceMinor:1,cardMinor:0,trainingFundMinor:0,voucherMinor:0}])]);
  const prepare=(client,id=r1,tenant=b.tenant_id)=>client.query('SELECT event_funnel_credit_prepare($1,$2,$3) result',[tenant,b.order_id,id]);
  await db.query('SET ROLE service_role');
  await assert.rejects(prepare(db,r1,randomUUID()),{code:'PT409'});
  const peer=await connect();
  try{
    await peer.query('SET ROLE service_role');
    const results=await Promise.all([prepare(db),prepare(peer)]);
    assert.deepEqual(results[0].rows,results[1].rows);
    const job=results[0].rows[0].result[0];
    assert.equal(job.original_invoice.Contact.ContactID,'original-customer');
    assert.deepEqual(job.prior_amounts,{});
    await assert.rejects(prepare(db,r2),{code:'PT409'});
    const adapter={rpc:async(name,args)=>{
      assert.ok(['event_funnel_credit_prepare','event_funnel_credit_operation'].includes(name));
      const values=name==='event_funnel_credit_prepare'?[args.p_tenant,args.p_order,args.p_reversal]:
        [args.p_tenant,args.p_order,args.p_id,args.p_action,args.p_value];
      try{return {data:(await db.query(`SELECT ${name}(${values.map((_,index)=>`$${index+1}`).join(',')}) result`,values)).rows[0].result};}
      catch(error){return {error};}
    }};
    let writes=0,reads=0;
    const recover=()=>recoverFunnelInvoiceCredits({db:adapter,context:{
      order:{id:b.order_id,tenant_id:b.tenant_id},operation:{id:r1,order_id:b.order_id,tenant_id:b.tenant_id}},
      execute:options=>executeFunnelXeroCredit({...options,
        loadToken:async()=>({tenantId:'original-company',accessToken:'fixture-only'}),
        fetcher:async(url,options)=>{
          if(options.method==='GET'){reads++;return Response.json(url.includes('/Invoices/')?
            {Invoices:[{...issued,Status:'PAID',AmountDue:0,AmountCredited:0}]}:{CreditNotes:[]});}
          assert.equal(options.method,'POST');writes++;
          const note=JSON.parse(options.body).CreditNotes[0];
          return Response.json({CreditNotes:[{...note,CreditNoteID:`credit-${work}`,Total:0.01,TotalTax:0,RemainingCredit:0.01}]});
        },
      })});
    const first=await recover();assert.equal(first.status,'complete');assert.equal(writes,1);
    const originalReads=reads;
    assert.equal((await recover()).status,'complete');assert.equal(writes,1);assert.equal(reads,originalReads);
    const receipt=first.outcomes[0].receipt;
    const next=(await prepare(db,r2)).rows[0].result[0];
    assert.deepEqual(next.prior_amounts,{[`${b.booking_source}:${b.booking_id}`]:1});
    assert.deepEqual(next.known_credit_ids,[receipt.creditNoteId]);
  } finally{await peer.end();await db.query('RESET ROLE');}
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(prepare(db),{code:'42501'});await db.query('RESET ROLE');
  }
}
