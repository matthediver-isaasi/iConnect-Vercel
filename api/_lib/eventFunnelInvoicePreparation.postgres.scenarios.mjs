import assert from 'node:assert/strict';
import {prepareFunnelInvoices,prepareFunnelInvoiceDelivery} from './eventFunnelInvoicePreparation.js';

export async function exerciseFunnelInvoicePreparation({db,sql}) {
  await db.query(await sql('202701230015_event_funnel_invoice_preparation.sql'));
  const row=(await db.query(`SELECT o.id,o.tenant_id FROM event_funnel_order o
    WHERE o.state='confirmed' AND o.snapshot ? 'invoiceCustomer' AND EXISTS(SELECT 1 FROM event_funnel_order_booking a WHERE a.order_id=o.id)
    ORDER BY o.created_at LIMIT 1`)).rows[0];
  assert.ok(row);
  // Reset only an isolated fixture delivery so it can be claimed.
  await db.query(`UPDATE event_funnel_delivery SET state='pending',lease_until=NULL,next_attempt_at=now()
    WHERE tenant_id=$1 AND order_id=$2 AND kind='invoices'`,[row.tenant_id,row.id]);
  const token=(await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '1 minute' WHERE tenant_id=$1 AND order_id=$2 AND kind='invoices' RETURNING lease_token`,
  [row.tenant_id,row.id])).rows[0].lease_token;
  const job={tenant_id:row.tenant_id,order_id:row.id,lease_token:token};
  const adapter={rpc:async(name,args)=>{
    try {
      const values=[args.p_tenant,args.p_order,args.p_token];
      if(name==='event_funnel_invoice_capture') values.push(JSON.stringify(args.p_prepared));
      else assert.equal(name,'event_funnel_invoice_input');
      const data=(await db.query(`SELECT ${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) result`,values)).rows[0].result;
      return {data};
    } catch(error) {return {error};}
  }};
  await db.query('SET ROLE service_role');
  const prepared=await prepareFunnelInvoices({db:adapter,job});
  assert.ok(prepared.length);
  assert.deepEqual(await prepareFunnelInvoices({db:adapter,job}),prepared);
  const outcome=await prepareFunnelInvoiceDelivery({db:adapter,job});
  assert.equal(outcome.status,prepared.every(item=>item.status==='not_applicable')?'delivered':
    prepared.some(item=>item.status==='needs_review')?'needs_review':'retry');
  await assert.rejects(db.query('SELECT * FROM event_funnel_invoice_preparation'),{code:'42501'});
  await assert.rejects(db.query('SELECT event_funnel_invoice_capture($1,$2,$3,$4)',
    [row.tenant_id,row.id,token,JSON.stringify([...prepared,prepared[0]])]),{code:'PT409'});
  await db.query('RESET ROLE');
  await db.query(`UPDATE event_funnel_delivery SET lease_until=now()-interval '1 second'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='invoices'`,[row.tenant_id,row.id]);
  await assert.rejects(prepareFunnelInvoices({db:adapter,job}),/unavailable/);
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT event_funnel_invoice_input($1,$2,$3)',[row.tenant_id,row.id,token]),{code:'42501'});
    await db.query('RESET ROLE');
  }
}
