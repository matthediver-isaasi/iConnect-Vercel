import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function exerciseFunnelZoomRecovery({db,sql,connect}) {
  await db.query(`CREATE TABLE IF NOT EXISTS zoom_meeting(id uuid PRIMARY KEY,tenant_id uuid,zoom_meeting_id text);
    CREATE TABLE IF NOT EXISTS zoom_webinar(id uuid PRIMARY KEY,tenant_id uuid,zoom_webinar_id text);
    ALTER TABLE event ADD COLUMN IF NOT EXISTS zoom_meeting_id uuid;`);
  await db.query(await sql('202701230023_event_funnel_zoom_recovery.sql'));
  const step=(await db.query(`SELECT s.*,b.event_id FROM event_funnel_integration_step s JOIN booking b ON b.id=s.booking_id
    AND b.tenant_id=s.tenant_id WHERE s.step='providers' AND s.booking_source='booking' AND b.attendee_email IS NOT NULL LIMIT 1`)).rows[0];
  assert.ok(step);const lease=randomUUID(),local=randomUUID();
  await db.query(`UPDATE event_funnel_integration_step SET state='pending',completed_at=NULL WHERE id=$1`,[step.id]);
  await db.query(`UPDATE event_funnel_delivery SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=$1 AND order_id=$2 AND kind='integrations'`,[step.tenant_id,step.order_id,lease]);
  await db.query(`INSERT INTO zoom_meeting VALUES($1,$2,'123456789')`,[local,step.tenant_id]);
  await db.query(`UPDATE event SET zoom_meeting_id=$1 WHERE id=$2 AND tenant_id=$3`,[local,step.event_id,step.tenant_id]);
  const target={kind:'meetings',numericId:'123456789',localId:local,authorityHash:'a'.repeat(64)};
  const call=async(action,id=null,payload=null,token=lease,client=db)=>(await client.query(
    'SELECT event_funnel_zoom_operation($1,$2,$3,$4,$5,$6,$7) r',
    [step.tenant_id,step.order_id,token,step.id,action,id,payload===null?null:JSON.stringify(payload)])).rows[0].r;
  const finish=()=>db.query(`SELECT event_funnel_integration_operation($1,$2,$3,'finish',$4,NULL)`,
    [step.tenant_id,step.order_id,lease,step.id]);
  await db.query('SET ROLE service_role');
  await assert.rejects(finish(),{code:'PT409'});
  await assert.rejects(call('read',null,null,randomUUID()),{code:'PT409'});
  await call('plan',null,[target]);
  const work=(await call('read')).jobs[0];assert.ok(work);
  await assert.rejects(call('plan',null,[{...target,authorityHash:'b'.repeat(64)}]),{code:'PT409'});
  const other=await connect();await other.query('SET ROLE service_role');
  const claims=await Promise.all([call('begin',work.id),call('begin',work.id,null,lease,other)]);
  await other.end();assert.deepEqual(claims.map(c=>c.write).sort(),[false,true]);
  assert.equal((await call('begin',work.id)).write,false);
  assert.equal((await call('read')).ready,false);
  await assert.rejects(finish(),{code:'PT409'});
  // Reclaimed parent lease cannot reset an uncertain earlier provider write.
  await db.query('RESET ROLE');const replacement=randomUUID();
  await db.query(`UPDATE event_funnel_delivery SET lease_token=$3 WHERE tenant_id=$1 AND order_id=$2 AND kind='integrations'`,
    [step.tenant_id,step.order_id,replacement]);
  await db.query('SET ROLE service_role');
  await call('not_submitted',work.id,null,replacement);
  assert.equal((await call('begin',work.id,null,replacement)).write,false);
  await call('observed',work.id,{outcome:'approved',registrantId:'fixture-registrant'},replacement);
  assert.equal((await call('read',null,null,replacement)).ready,true);
  // Another plan cannot treat a historical approval as current verification.
  await db.query('RESET ROLE');
  await db.query('UPDATE event_funnel_zoom_link SET verified_at=NULL WHERE step_id=$1',[step.id]);
  await db.query('SET ROLE service_role');
  assert.equal((await call('read',null,null,replacement)).ready,false);
  assert.equal((await call('begin',work.id,null,replacement)).write,false);
  await call('observed',work.id,{outcome:'approved',registrantId:'fixture-registrant'},replacement);
  await db.query(`SELECT event_funnel_integration_operation($1,$2,$3,'finish',$4,NULL)`,
    [step.tenant_id,step.order_id,replacement,step.id]);
  await assert.rejects(db.query('SELECT * FROM event_funnel_zoom_registration'),{code:'42501'});
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);await assert.rejects(call('read'),{code:'42501'});
  }
  await db.query('RESET ROLE');
}
