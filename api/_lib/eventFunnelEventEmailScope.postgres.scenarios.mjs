import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {exerciseFunnelInventoryEvidence} from './eventFunnelInventoryEvidence.postgres.scenarios.mjs';

// Production event_email has no tenant_id column. Remove the fixture-only
// column, then run reminder planning, confirmation planning and cancellation
// suppression for a fresh confirmed order: none may reference it.
export async function exerciseFunnelEventEmailScope({db,sql,tenant,member}) {
  await db.query(await sql('202711280001_event_funnel_event_email_scope.sql'));
  await db.query('ALTER TABLE event_email DROP COLUMN tenant_id');
  await db.query('ALTER TABLE event_email ADD COLUMN IF NOT EXISTS is_complex_event boolean');
  const [order]=await exerciseFunnelInventoryEvidence({db,sql,tenant,member,install:false,
    variants:['total'],bookingCount:2,email:'scope@example.test'});
  const lease=async kind=>{
    const token=randomUUID();
    await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
      WHERE tenant_id=$1 AND order_id=$2 AND kind=$4`,[tenant,order.order,token,kind]);
    return token;
  };
  const reminder=randomUUID(),confirmation=randomUUID();
  await db.query(`INSERT INTO event_email(id,event_id,email_type,is_enabled,subject,body) VALUES
    ($1,$3,'reminder',true,'Reminder','Reminder'),($2,$3,'confirmation',true,'Booked','Booked')`,
    [reminder,confirmation,order.event]);

  const integrationToken=await lease('integrations');
  const integration=async(action='read',id=null,rows=null)=>(await db.query(
    'SELECT event_funnel_integration_operation($1,$2,$3,$4,$5,$6) r',
    [tenant,order.order,integrationToken,action,id,rows===null?null:JSON.stringify(rows)])).rows[0].r;
  const steps=(await integration()).jobs;
  for(const step of steps.filter(s=>s.step!=='notifications')) {
    if(step.step==='providers')await db.query('SELECT event_funnel_zoom_operation($1,$2,$3,$4,$5,$6,$7)',
      [tenant,order.order,integrationToken,step.id,'plan',null,'[]']);
    await integration('finish',step.id);
  }
  for(const step of steps.filter(s=>s.step==='notifications')) {
    await integration('finish',step.id,[{event_email_id:reminder,booking_id:step.booking_id,
      attendee_email:'scope@example.test',scheduled_send_time:new Date(Date.now()+86400000).toISOString(),status:'pending'}]);
  }
  assert.equal((await integration()).status,'delivered');
  await db.query(`SELECT event_funnel_delivery_finish($1,$2,'integrations',$3,'delivered')`,[tenant,order.order,integrationToken]);
  assert.equal(Number((await db.query(`SELECT count(*) FROM scheduled_email WHERE event_email_id=$1`,[reminder])).rows[0].count),2);

  const mailToken=await lease('confirmations');
  const jobs=(await db.query('SELECT event_funnel_confirmation_operation($1,$2,$3,$4,$5,$6) r',
    [tenant,order.order,mailToken,'read',null,null])).rows[0].r.jobs;
  assert.equal(jobs.length,2,'One confirmation per registration from the event template');
  assert.ok(jobs.every(job=>job.template_id===confirmation));

  await db.query("SET session_replication_role='replica'");
  await db.query(`UPDATE booking SET status='cancelled' WHERE id=$1`,[order.bookingIds[0]]);
  await db.query("SET session_replication_role='origin'");
  await db.query('SELECT event_funnel_suppress_cancelled_delivery($1,$2)',[tenant,order.order]);
  const scheduled=(await db.query(`SELECT booking_id,status FROM scheduled_email WHERE event_email_id=$1`,[reminder])).rows;
  assert.equal(scheduled.find(row=>row.booking_id===order.bookingIds[0]).status,'cancelled');
  assert.equal(scheduled.find(row=>row.booking_id===order.bookingIds[1]).status,'pending');
}
