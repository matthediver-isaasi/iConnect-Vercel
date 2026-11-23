import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelConfirmations({db,sql}) {
  // Add the real presentation columns omitted by the capacity-only fixture.
  for(const table of ['booking','complex_event_booking']) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS attendee_email text`);
    await db.query(`UPDATE ${table} SET attendee_email='recipient@example.test'`);
  }
  await db.query(`CREATE TABLE event_email(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,email_type text,
    is_enabled boolean,subject text,body text,cc text)`);
  await db.query(await sql('202701230020_event_funnel_confirmations.sql'));
  const row=(await db.query(`SELECT d.*,b.event_id FROM event_funnel_delivery d
    JOIN event_funnel_order_booking b ON b.tenant_id=d.tenant_id AND b.order_id=d.order_id
    WHERE d.kind='confirmations' LIMIT 1`)).rows[0];
  assert.ok(row);
  const token=randomUUID(),template=randomUUID();
  await db.query(`INSERT INTO event_email VALUES($1,$2,$3,'confirmation',true,'Original subject','Original body',NULL)`,
    [template,row.tenant_id,row.event_id]);
  await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='confirmations'`,[row.tenant_id,row.order_id,token]);
  const invoke=async(action='read',item=null,payload=null,lease=token,tenant=row.tenant_id)=>
    (await db.query('SELECT event_funnel_confirmation_operation($1,$2,$3,$4,$5,$6) r',
      [tenant,row.order_id,lease,action,item,payload])).rows[0].r;
  await db.query('SET ROLE service_role');
  assert.deepEqual(await invoke(),{status:'retry',jobs:[]});
  await db.query('RESET ROLE');
  await db.query(`UPDATE event_funnel_delivery SET state='delivered' WHERE tenant_id=$1 AND order_id=$2 AND kind='integrations'`,
    [row.tenant_id,row.order_id]);
  await db.query('SET ROLE service_role');
  const plan=await invoke();assert.ok(plan.jobs.length);
  const first=plan.jobs[0],payload={tenantId:row.tenant_id,to:'recipient@example.test',html:'original'};
  await assert.rejects(invoke('begin',first.id,{...payload,to:'other@example.test'}));
  await assert.rejects(invoke('read',null,null,randomUUID()),{code:'PT409'});
  await assert.rejects(invoke('read',null,null,token,randomUUID()),{code:'PT409'});
  assert.equal((await invoke('begin',first.id,payload)).status,'send');
  assert.equal((await invoke('begin',first.id,payload)).status,'needs_review');
  await invoke('finish',first.id,{outcome:'not_submitted'});
  const retried=await invoke('begin',first.id,{...payload,html:'changed'});
  assert.equal(retried.payload.html,'original');
  await invoke('finish',first.id,{outcome:'delivered',messageId:'provider-message'});
  assert.equal((await invoke('begin',first.id,payload)).status,'delivered');
  await db.query('RESET ROLE');
  // Editing the template cannot add recipients or remove pending deliveries
  // from the already captured plan.
  await db.query('DELETE FROM event_email WHERE id=$1',[template]);
  await db.query(`INSERT INTO event_email VALUES($1,$2,$3,'confirmation',true,'New','New',NULL)`,
    [randomUUID(),row.tenant_id,row.event_id]);
  await db.query('SET ROLE service_role');
  const remaining=await invoke();
  assert.ok(remaining.jobs.every(item=>item.template_id===template));
  for(const item of remaining.jobs) {
    await invoke('begin',item.id,payload);
    await invoke('finish',item.id,{outcome:'unknown'});
  }
  assert.ok(['delivered','needs_review'].includes((await invoke()).status));
  await assert.rejects(db.query('SELECT * FROM event_funnel_confirmation'),{code:'42501'});
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);await assert.rejects(invoke(),{code:'42501'});
  }
  await db.query('RESET ROLE');
}
