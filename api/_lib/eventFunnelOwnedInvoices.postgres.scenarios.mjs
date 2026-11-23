import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelOwnedInvoices({db,sql}) {
  await db.query(await sql('202701230019_event_funnel_owned_invoices.sql'));
  const original=(await db.query(`SELECT w.*,o.session_id,o.version_id,o.payment_method,o.currency,o.payable_minor,
    o.snapshot order_snapshot FROM event_funnel_invoice_work w JOIN event_funnel_order o
      ON o.tenant_id=w.tenant_id AND o.id=w.order_id WHERE w.status='complete' LIMIT 1`)).rows[0];
  assert.ok(original);
  const session=randomUUID(),expired=randomUUID(),order=randomUUID(),work=randomUUID(),booking=randomUUID(),hash='a'.repeat(64);
  // Synthetic owned receipt in the disposable fixture only. Real commitment
  // and allocation creation were exercised earlier in this same database.
  for(const [id,isExpired] of [[session,false],[expired,true]]) {
    await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,guest_capability_hash,
      state,created_at,access_expires_at,retain_until) VALUES($1,$2,$3,$4,'confirmed',
      now()-interval '2 days',now()+$5::interval,now()+interval '2 days')`,
    [id,original.tenant_id,original.version_id,hash,isExpired?'-1 day':'1 day']);
  }
  await db.query(`INSERT INTO event_funnel_order(id,tenant_id,session_id,session_revision,version_id,state,
    payment_method,currency,payable_minor,snapshot) VALUES($1,$2,$3,1,$4,'confirmed',$5,$6,$7,$8)`,
  [order,original.tenant_id,session,original.version_id,original.payment_method,original.currency,original.payable_minor,original.order_snapshot]);
  await db.query(`INSERT INTO event_funnel_invoice_work(id,tenant_id,order_id,allocation_key,provider,snapshot,status,
    connection_id,xero_tenant_id,invoice_id,invoice_number,payment_id)
    VALUES($1,$2,$3,$4,$5,$6,'complete',$7,$8,$9,$10,$11)`,
  [work,original.tenant_id,order,`guest-fixture-${order}`,original.provider,original.snapshot,original.connection_id,
    original.xero_tenant_id,original.invoice_id,original.invoice_number,original.payment_id]);
  await db.query(`INSERT INTO event_funnel_order_booking(tenant_id,order_id,booking_id,booking_source,event_id,node_id,
    ticket_id,places,gross_minor,payable_minor) SELECT tenant_id,$1,$2,booking_source,event_id,node_id,ticket_id,places,
    gross_minor,payable_minor FROM event_funnel_order_booking WHERE tenant_id=$3 AND order_id=$4 LIMIT 1`,
  [order,booking,original.tenant_id,original.order_id]);
  await db.query(`INSERT INTO event_funnel_invoice_booking(invoice_work_id,tenant_id,booking_source,booking_id,amount_minor)
    SELECT $1,tenant_id,booking_source,booking_id,payable_minor FROM event_funnel_order_booking WHERE order_id=$2`,
  [work,order]);
  const invoke=async({tenant=original.tenant_id,id=session,member=null,cap=hash,target=order,invoice=null}={})=>
    (await db.query('SELECT event_funnel_owned_invoices($1,$2,$3,$4,$5,$6) r',[tenant,id,member,cap,target,invoice])).rows[0].r;
  await db.query('SET ROLE service_role');
  const list=await invoke();assert.equal(list.invoices.length,1);assert.equal(list.invoices[0].available,true);
  assert.equal(list.invoices[0].id,work);
  assert.doesNotMatch(JSON.stringify(list),/companyId|connectionId|private-provider|capability|snapshot/);
  assert.equal((await invoke({invoice:work})).invoiceId,original.invoice_id);
  for(const invalid of [{cap:null},{cap:'b'.repeat(64)},{member:randomUUID()},{id:expired},
    {target:original.order_id},{invoice:original.id},{tenant:randomUUID()}]) {
    await assert.rejects(invoke(invalid),{code:'PT404'});
  }
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);await assert.rejects(invoke(),{code:'42501'});
  }
  await db.query('RESET ROLE');
}
