import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelIntegrations({db,sql,connect}) {
  await db.query(`CREATE TABLE IF NOT EXISTS event_agenda_item(id uuid PRIMARY KEY,event_id uuid);
    CREATE TABLE IF NOT EXISTS complex_event_session(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid);
    CREATE TABLE scheduled_email(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_email_id uuid,booking_id uuid,
      attendee_email text,scheduled_send_time timestamptz,status text,session_id uuid,training_target_snapshot text,
      follow_up_target_key text,follow_up_target_snapshot text,follow_up_booking_table text);`);
  const baseline=await sql('202612310060_event_email_follow_ups.sql');
  const start=baseline.indexOf('CREATE UNIQUE INDEX idx_scheduled_email_unique');
  await db.query(baseline.slice(start,baseline.indexOf('COMMIT;',start)));
  await db.query(await sql('202701230022_event_funnel_integration_steps.sql'));
  const original=(await db.query(`SELECT d.* FROM event_funnel_delivery d WHERE d.kind='integrations'
    AND EXISTS(SELECT 1 FROM event_funnel_order_booking b WHERE b.tenant_id=d.tenant_id AND b.order_id=d.order_id) LIMIT 1`)).rows[0];
  const token=randomUUID();
  await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='integrations'`,[original.tenant_id,original.order_id,token]);
  const call=async(action='read',step=null,rows=null,lease=token)=>(await db.query(
    'SELECT event_funnel_integration_operation($1,$2,$3,$4,$5,$6) r',
    [original.tenant_id,original.order_id,lease,action,step,rows===null?null:JSON.stringify(rows)])).rows[0].r;
  await db.query('SET ROLE service_role');
  const plan=await call();assert.ok(plan.jobs.length);
  const notification=plan.jobs.find(j=>j.step==='notifications');assert.ok(notification);
  await assert.rejects(call('read',null,null,randomUUID()),{code:'PT409'});
  await assert.rejects(call('finish',notification.id,[]),{code:'PT409'});
  const provider=plan.jobs.find(j=>j.step==='providers'&&j.booking_id===notification.booking_id);
  await call('finish',provider.id);
  await db.query('RESET ROLE');
  const template=randomUUID();
  await db.query(`INSERT INTO event_email VALUES($1,$2,$3,'reminder',true,'Reminder','Reminder',NULL)`,
    [template,original.tenant_id,notification.booking.event_id]);
  const row={event_email_id:template,booking_id:notification.booking_id,attendee_email:notification.booking.attendee_email,
    scheduled_send_time:'2027-01-01T12:00:00Z',status:'pending',session_id:null};
  assert.ok(row.attendee_email);
  await db.query('SET ROLE service_role');
  await assert.rejects(call('finish',notification.id,[row,{...row,booking_id:randomUUID()}]));
  await db.query('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int n FROM scheduled_email')).rows[0].n,0);
  const concurrent=await connect();
  await concurrent.query('BEGIN');
  await concurrent.query(`INSERT INTO scheduled_email(event_email_id,booking_id,attendee_email,scheduled_send_time,status)
    VALUES($1,$2,$3,$4,'pending')`,[template,notification.booking_id,row.attendee_email,row.scheduled_send_time]);
  await db.query('SET ROLE service_role');
  // The ordinary scheduler wins the existing unique key. The integration
  // transaction must wait, then preserve it rather than create a second email.
  const finishing=call('finish',notification.id,[row,row]);
  await concurrent.query('COMMIT');await concurrent.end();
  await finishing;await call('finish',notification.id,[row]);
  await db.query('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int n FROM scheduled_email')).rows[0].n,1);
  assert.equal((await db.query('SELECT status FROM scheduled_email')).rows[0].status,'pending');
  await db.query('SET ROLE service_role');
  for(const item of (await call()).jobs)await call('finish',item.id,item.step==='notifications'?[]:null);
  assert.equal((await call()).status,'delivered');
  await assert.rejects(db.query('SELECT * FROM event_funnel_integration_step'),{code:'42501'});
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);await assert.rejects(call(),{code:'42501'});
  }
  await db.query('RESET ROLE');
}
