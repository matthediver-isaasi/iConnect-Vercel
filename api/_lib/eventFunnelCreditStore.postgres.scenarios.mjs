import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFunnelCreditStore} from './eventFunnelCreditStore.js';
export async function exerciseFunnelCreditStore({db,sql}) {
  await db.query(await sql('202701230032_event_funnel_credit_journal.sql'));
  const reversal=(await db.query(`SELECT * FROM event_funnel_reversal WHERE cancelled_at IS NOT NULL AND state<>'released' LIMIT 1`)).rows[0];
  assert.ok(reversal);const id=randomUUID(),workId=randomUUID();
  // Journal boundary fixture only: the producer must independently derive
  // these immutable instructions from the original issued-invoice authority.
  await db.query(`INSERT INTO event_funnel_invoice_work(id,tenant_id,order_id,allocation_key,provider,status,snapshot)
    VALUES($1,$2,$3,$4,'xero','complete','{}')`,[workId,reversal.tenant_id,reversal.order_id,`credit-${id}`]);
  await db.query(`INSERT INTO event_funnel_credit_work(id,tenant_id,order_id,reversal_id,invoice_work_id,snapshot)
    VALUES($1,$2,$3,$4,$5,$6)`,[id,reversal.tenant_id,reversal.order_id,reversal.id,workId,
    {invoice_id:'invoice',company_id:`company-${id}`,original_invoice:{CurrencyCode:'GBP'},selected:[{amountMinor:100}]}]);
  const adapter={rpc:async(name,args)=>{
    try{return {data:(await db.query(`SELECT ${name}($1,$2,$3,$4,$5) result`,
      [args.p_tenant,args.p_order,args.p_id,args.p_action,args.p_value])).rows[0].result};}
    catch(error){return {error};}
  }};
  const store=createFunnelCreditStore({db:adapter,tenantId:reversal.tenant_id,orderId:reversal.order_id,jobId:id});
  const plan={version:1,amountMinor:100,taxMinor:0,CurrencyCode:'GBP',LineAmountTypes:'Inclusive',
    LineItems:[{Quantity:1,UnitAmount:1,TaxAmount:0}]};
  await db.query('SET ROLE service_role');
  assert.equal(await store.begin(id),false);
  await assert.rejects(store.prepare(id,{...plan,amountMinor:200}));
  assert.equal(await store.prepare(id,plan),true);
  assert.equal(await store.prepare(id,{...plan,taxMinor:1}),false);
  assert.equal(await store.begin(id),true);assert.equal(await store.begin(id),false);
  assert.equal(await store.beginAllocation(id,200),false);
  assert.equal(await store.beginAllocation(id,100),true);assert.equal(await store.beginAllocation(id,100),false);
  const receipt={provider:'xero',creditNoteId:'credit',invoiceId:'invoice',amountMinor:100,taxMinor:0,
    currency:'GBP',allocated:false,allocationRequired:true};
  assert.equal(await store.complete(id,receipt),true);
  assert.equal(await store.complete(id,{...receipt,allocated:true}),true);
  assert.equal(await store.complete(id,receipt),false);
  await assert.rejects(db.query('SELECT * FROM event_funnel_credit_work'),{code:'42501'});
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
    await db.query(`SET ROLE ${role}`);await assert.rejects(store.begin(id));await db.query('RESET ROLE');
  }
  const other=createFunnelCreditStore({db:adapter,tenantId:randomUUID(),orderId:reversal.order_id,jobId:id});
  assert.equal(await other.begin(id),false);
}
