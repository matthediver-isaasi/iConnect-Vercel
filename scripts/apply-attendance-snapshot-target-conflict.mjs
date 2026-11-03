// Default: execute the repair and real RPC regression inside a rolled-back
// transaction. --apply commits DDL only, then repeats the rollback-only tests.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
const sql=fs.readFileSync('supabase/migrations/202612110001_attendance_snapshot_target_conflict.sql','utf8');
const claimsSql=fs.readFileSync('supabase/migrations/202612110002_attendance_snapshot_service_claims.sql','utf8');
const db=await connectDestination();
const apply=process.argv.includes('--apply');
try{
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='8s'");
  await db.query(sql);
  await db.query(sql); // migration replay must be safe
  await db.query(claimsSql);
  await db.query(claimsSql);
  if(apply){await db.query('COMMIT');await db.query('BEGIN');}
  const booking=(await db.query(`SELECT id,tenant_id,event_id FROM booking
    WHERE event_id='4a21aa95-0c72-4317-a8eb-638ec73c96b0' AND status='confirmed' ORDER BY id LIMIT 1`)).rows[0];
  assert.ok(booking);
  const target=randomUUID(),key=randomUUID();
  const payload={target:{type:'event',id:target,eventId:booking.event_id,
    providerTargetId:'diagnostic-rollback-only',providerTargetType:'meeting',thresholdMinutes:20},
    intervals:[],matches:[],outcomes:[{bookingType:'booking',bookingId:booking.id,status:'attended',durationSeconds:1800,thresholdMinutes:20,resultFingerprint:'rollback-only-outcome-fingerprint'}],
    metadata:{source:'rollback_only_execution_test'}};
  for(const role of ['anon','authenticated']){
    const grant=(await db.query("SELECT has_function_privilege($1,'public.replace_attendance_report_snapshot(uuid,text,text,jsonb)','EXECUTE') allowed",[role])).rows[0];
    assert.equal(grant.allowed,false);
  }
  assert.equal((await db.query("SELECT has_function_privilege('service_role','public.replace_attendance_report_snapshot(uuid,text,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,true);
  await db.query("SELECT set_config('request.jwt.claim.role','',true)");
  await db.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
  await db.query('SET LOCAL ROLE service_role');
  const invoke=async(k)=> (await db.query('SELECT * FROM public.replace_attendance_report_snapshot($1,$2,$3,$4::jsonb)',[booking.tenant_id,'zoom',k,JSON.stringify(payload)])).rows[0];
  const first=await invoke(key);assert.ok(first.target_id);assert.ok(first.sync_run_id);
  assert.deepEqual(await invoke(key),first);
  await db.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
  await db.query("SELECT set_config('request.jwt.claims','{}',true)");
  assert.deepEqual(await invoke(key),first);
  await invoke(`${key}-new-report`);
  await db.query('SAVEPOINT rejected_role');
  await db.query("SELECT set_config('request.jwt.claim.role','',true)");
  await db.query("SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\"}',true)");
  await assert.rejects(()=>invoke(`${key}-forbidden`),e=>e.code==='P0001'&&/service_role is required/.test(e.message));
  await db.query('ROLLBACK TO SAVEPOINT rejected_role');
  assert.equal(Number((await db.query('SELECT count(*) n FROM attendance_current_outcome WHERE attendance_target_id=$1',[first.target_id])).rows[0].n),1);
  assert.equal(Number((await db.query('SELECT count(*) n FROM attendance_outcome_revision WHERE attendance_target_id=$1',[first.target_id])).rows[0].n),1);
  assert.equal(Number((await db.query('SELECT count(*) n FROM attendance_outcome_transition WHERE attendance_target_id=$1',[first.target_id])).rows[0].n),1);
  await db.query('ROLLBACK');
  console.log(JSON.stringify({migration:apply?'applied':'tested and rolled back',execution:true,sameReportReplay:true,unchangedOutcomeNoDuplicateRevision:true,serviceOnly:true,testDataRolledBack:true}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
