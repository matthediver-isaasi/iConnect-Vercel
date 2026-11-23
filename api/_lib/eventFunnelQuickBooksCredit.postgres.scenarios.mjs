import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recoverFunnelInvoiceCredits} from './eventFunnelCreditRecovery.js';
import {executeFunnelQuickBooksCredit} from './eventFunnelQuickBooksCredit.js';
export async function exerciseFunnelQuickBooksCredit({db,sql}) {
  await db.query(await sql('202701230035_event_funnel_quickbooks_credit_authority.sql'));
  const work=(await db.query(`SELECT * FROM event_funnel_invoice_work
    WHERE provider='quickbooks' AND status='complete' AND issued_evidence IS NOT NULL LIMIT 1`)).rows[0];
  assert.ok(work);
  const b=(await db.query(`SELECT b.* FROM event_funnel_order_booking b JOIN event_funnel_invoice_booking i
    ON i.tenant_id=b.tenant_id AND i.booking_source=b.booking_source AND i.booking_id=b.booking_id
    WHERE i.invoice_work_id=$1 AND b.payable_minor>0 LIMIT 1`,[work.id])).rows[0];
  assert.ok(b);const operation=randomUUID();
  // Accepted cancellation fixture; earlier scenarios exercise cancellation
  // and remaining-limit checks independently through their real RPCs.
  await db.query(`INSERT INTO event_funnel_reversal(id,tenant_id,order_id,allocations,cancelled_at)
    VALUES($1,$2,$3,$4,now())`,[operation,b.tenant_id,b.order_id,JSON.stringify([{
      source:b.booking_source,id:b.booking_id,invoiceMinor:1,cardMinor:0,trainingFundMinor:0,voucherMinor:0}])]);
  const adapter={rpc:async(name,args)=>{
    assert.ok(['event_funnel_credit_prepare','event_funnel_credit_operation'].includes(name));
    const values=name==='event_funnel_credit_prepare'?[args.p_tenant,args.p_order,args.p_reversal]:
      [args.p_tenant,args.p_order,args.p_id,args.p_action,args.p_value];
    try{return {data:(await db.query(`SELECT to_jsonb(${name}(${values.map((_,i)=>`$${i+1}`).join(',')})) result`,values)).rows[0].result};}
    catch(error){return {error};}
  }};
  let writes=0,reads=0,note=null;
  const recover=()=>recoverFunnelInvoiceCredits({db:adapter,context:{
    order:{id:b.order_id,tenant_id:b.tenant_id},operation:{id:operation,tenant_id:b.tenant_id,order_id:b.order_id}},
    execute:options=>executeFunnelQuickBooksCredit({...options,
      loadToken:async()=>({accessToken:'fixture',realmId:work.snapshot.approvalProvider.realmId,environment:work.snapshot.environment}),
      fetcher:async(url,options)=>{
        if(options.method==='POST'){
          writes++;const payload=JSON.parse(options.body);
          note={...payload,Id:`credit-${operation}`,TotalAmt:0.01,RemainingCredit:0.01};
          return Response.json({CreditMemo:note});
        }
        reads++;const path=new URL(url).pathname;
        if(path.includes('/invoice/'))return Response.json({Invoice:{...work.issued_evidence,Balance:0}});
        if(path.endsWith('/query'))return Response.json({QueryResponse:{}});
        if(path.includes('/creditmemo/'))return Response.json({CreditMemo:note});
        throw new Error('Unexpected credit fixture request');
      },
    })});
  await db.query('SET ROLE service_role');
  const first=await recover();assert.equal(first.status,'complete',JSON.stringify(first));
  assert.equal(first.outcomes[0].receipt.provider,'quickbooks');assert.equal(writes,1);
  const before=reads;assert.equal((await recover()).status,'complete');assert.equal(writes,1);assert.equal(reads,before);
  await db.query('RESET ROLE');
  const saved=(await db.query('SELECT * FROM event_funnel_credit_work WHERE reversal_id=$1',[operation])).rows[0];
  assert.equal(saved.snapshot.original_invoice.Contact.ContactID,work.issued_evidence.CustomerRef.value);
  assert.equal(saved.snapshot.environment,'production');
  assert.equal(saved.status,'complete');
}
