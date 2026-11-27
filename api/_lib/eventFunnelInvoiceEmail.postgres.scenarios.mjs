import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliverFunnelInvoiceEmail} from './eventFunnelInvoiceEmail.js';
// Combined invoice email journal against the real funnel schema. Every case
// runs in a rolled-back transaction on an order issued earlier in this database.
export async function exerciseFunnelInvoiceEmail({db,sql}) {
  await db.query(await sql('202711270004_event_funnel_invoice_email.sql'));
  const original=(await db.query(`SELECT w.tenant_id,w.order_id FROM event_funnel_invoice_work w
    JOIN event_funnel_order o ON o.tenant_id=w.tenant_id AND o.id=w.order_id
    WHERE w.status='complete' AND w.invoice_id IS NOT NULL AND o.state='confirmed' AND o.payable_minor>0 LIMIT 1`)).rows[0];
  assert.ok(original,'An issued, confirmed funnel invoice fixture is required');
  const {tenant_id:tenant,order_id:order}=original;
  const lease=randomUUID();
  const setup=async(email={invoiceCustomer:'Finance@Example.test',purchaser:'booker@example.test'})=>{
    await db.query('BEGIN');
    // Fixture-only: vary the frozen addresses inside this rolled-back transaction.
    await db.query("SET LOCAL session_replication_role='replica'");
    await db.query(`UPDATE event_funnel_order SET snapshot=jsonb_set(jsonb_set(snapshot,'{invoiceCustomer,email}',to_jsonb($3::text)),
      '{purchaser}',coalesce(snapshot->'purchaser','{}'::jsonb)||jsonb_build_object('email',$4::text)) WHERE tenant_id=$1 AND id=$2`,
    [tenant,order,email.invoiceCustomer,email.purchaser]);
    // Only the issued invoices matter here; anything else is out of scope.
    await db.query(`UPDATE event_funnel_invoice_work SET status='not_applicable' WHERE tenant_id=$1 AND order_id=$2
      AND NOT (status='complete' AND invoice_id IS NOT NULL)`,[tenant,order]);
    await db.query("SET LOCAL session_replication_role='origin'");
    await db.query(`INSERT INTO event_funnel_delivery(tenant_id,order_id,kind,evidence,state) VALUES($1,$2,'invoices','{}','running')
      ON CONFLICT(tenant_id,order_id,kind) DO NOTHING`,[tenant,order]);
    await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
      WHERE tenant_id=$1 AND order_id=$2 AND kind='invoices'`,[tenant,order,lease]);
    await db.query('SET LOCAL ROLE service_role');
  };
  const call=async(action,payload=null,token=lease)=>(await db.query(
    'SELECT event_funnel_invoice_email_operation($1,$2,$3,$4,$5) r',[tenant,order,token,action,payload])).rows[0].r;
  const issued=Number((await db.query(`SELECT count(*) FROM event_funnel_invoice_work WHERE tenant_id=$1 AND order_id=$2
    AND status='complete' AND invoice_id IS NOT NULL`,[tenant,order])).rows[0].count);

  await setup();
  try {
    await db.query('SAVEPOINT bad_lease');
    await assert.rejects(call('read',null,randomUUID()),{code:'PT409'});
    await db.query('ROLLBACK TO SAVEPOINT bad_lease');
    const plan=await call('read');
    assert.equal(plan.status,'pending');assert.equal(plan.recipient,'finance@example.test');
    assert.equal(plan.invoices.length,issued);assert.ok(plan.invoices.every(i=>i.invoiceId&&i.provider));
    await db.query('SAVEPOINT bad_envelope');
    await assert.rejects(call('begin',{to:'other@example.test',subject:'S',html:'H'}));
    await db.query('ROLLBACK TO SAVEPOINT bad_envelope');
    const envelope={to:'finance@example.test',subject:'Your invoices',html:'<p>Attached</p>'};
    assert.equal((await call('begin',envelope)).status,'send');
    assert.equal((await call('begin',envelope)).status,'needs_review','a claimed send is never claimed twice');
    assert.equal((await call('finish',{outcome:'not_submitted'})).status,'pending');
    // The retry resends the original envelope unchanged.
    assert.deepEqual((await call('begin',{...envelope,subject:'Changed'})).payload,envelope);
    assert.equal((await call('finish',{outcome:'unknown'})).status,'needs_review');
    assert.equal((await call('read')).status,'needs_review');
  } finally {await db.query('ROLLBACK');}

  // Real sender against the journal; the owner view then reports it as sent.
  await setup({invoiceCustomer:'',purchaser:'booker@example.test'});
  try {
    const adapter={rpc:async(name,args)=>({data:(await db.query(`SELECT ${name}($1,$2,$3,$4,$5) r`,
      [args.p_tenant,args.p_order,args.p_token,args.p_action,args.p_payload])).rows[0].r})};
    const sent=[];
    const result=await deliverFunnelInvoiceEmail({db:adapter,job:{tenant_id:tenant,order_id:order,lease_token:lease},
      deadlineAt:Date.now()+60000,loadPdf:async()=>Buffer.from('%PDF-1.4 fixture'),
      send:async message=>{sent.push(message);return {success:true,messageId:'fixture'};}});
    assert.deepEqual(result,{status:'complete'});
    assert.equal(sent.length,1);assert.equal(sent[0].to,'booker@example.test','falls back to the booker');
    assert.equal(sent[0].attachments.length,issued);
    assert.equal((await call('read')).status,'complete');
    await db.query('RESET ROLE');
    const stored=(await db.query('SELECT state,message_id FROM event_funnel_invoice_email WHERE order_id=$1',[order])).rows[0];
    assert.deepEqual(stored,{state:'delivered',message_id:'fixture'});
  } finally {await db.query('ROLLBACK');}

  // No usable address: nothing is journalled and delivery is not held up.
  await setup({invoiceCustomer:'not-an-email',purchaser:''});
  try {assert.equal((await call('read')).status,'complete');}
  finally {await db.query('ROLLBACK');}
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(call('read'),{code:'42501'});
    await db.query('RESET ROLE');
  }
}
