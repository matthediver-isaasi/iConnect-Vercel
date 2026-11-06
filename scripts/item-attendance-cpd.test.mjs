import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('item attendance awards are scoped, additive, immutable snapshots and replay-safe',async()=>{
 const h=await createLocalPostgresHarness('item-cpd-'); let started=false;
 const run=(cmd,args,input)=>{const r=spawnSync(cmd,args,{input,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();};
 const args=['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'];
 const sql=s=>run('psql',args,s);
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const query=s=>sql(`SET request.jwt.claim.role='service_role'; ${s}`).split('\n').at(-1);
 try{
  run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'pg.log'),'-o',`-k ${h.socket} -p ${h.port} -h ''`,'-w','start']);started=true;
  sql(`CREATE ROLE service_role;CREATE ROLE anon;CREATE ROLE authenticated;
    CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
    CREATE TABLE event(id uuid,tenant_id uuid,is_training boolean,timezone text);
    CREATE TABLE complex_event(id uuid,tenant_id uuid,timezone text);
    CREATE TABLE event_agenda_item(id uuid,tenant_id uuid,event_id uuid,start_date date,end_date date,start_time time,end_time time,description text);
    CREATE TABLE complex_event_session(id uuid,tenant_id uuid,complex_event_id uuid,start_time timestamptz,end_time timestamptz,title text);
    CREATE TABLE booking(id uuid,tenant_id uuid,event_id uuid,member_id uuid,attendee_email text,status text);
    CREATE TABLE complex_event_booking(LIKE booking);
    CREATE TABLE member(id uuid,tenant_id uuid,email text);
    CREATE TABLE attendance_target(id uuid,tenant_id uuid,provider text,event_id uuid,target_type text,target_id uuid,tracking_enabled boolean);
    CREATE TABLE attendance_current_outcome(tenant_id uuid,booking_type text,booking_id uuid,attendance_target_id uuid,provider text,status text,outcome_revision_id uuid);
    CREATE TABLE complex_event_session_checkin(id uuid,tenant_id uuid,complex_event_id uuid,booking_id uuid,session_id uuid,checked_in_at timestamptz,check_in_reversed_at timestamptz);
    CREATE TABLE member_cpd_points_ledger(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,entry_kind text,points_value numeric,event_type text,event_id uuid,booking_type text,booking_id uuid,
      ticket_id text,ticket_name_snapshot text,award_trigger text,evidence_type text,evidence_id text,evidence_snapshot jsonb,rule_snapshot jsonb,occurrence_key text,activity_date date,activity_title text,
      UNIQUE(tenant_id,occurrence_key),CHECK(activity_date IS NULL AND activity_title IS NULL));
    CREATE TABLE event_cpd_points_award_attempt(tenant_id uuid,idempotency_key text,event_type text,event_id uuid,booking_type text,booking_id uuid,member_id uuid,
      trigger_type text,points_value numeric,ledger_entry_id uuid,status text,detail text,delivery_attempt integer);
    CREATE TABLE event_cpd_points_reprocessing_item(tenant_id uuid,idempotency_key text,approved jsonb);
    CREATE FUNCTION outstanding_registration_is_held_for(uuid,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"outcome":"legacy"}'::jsonb$$;
    CREATE FUNCTION record_event_cpd_points_award(jsonb) RETURNS event_cpd_points_award_attempt LANGUAGE plpgsql AS $$DECLARE r event_cpd_points_award_attempt;BEGIN r.status:='legacy';RETURN r;END$$;`);
  sql(readFileSync('supabase/migrations/202701190001_item_attendance_cpd.sql','utf8'));
  sql(`INSERT INTO event VALUES('${id(1)}','${id(2)}',true,'Europe/London');
    INSERT INTO member VALUES('${id(3)}','${id(2)}','attendee@example.test');
    INSERT INTO booking VALUES('${id(4)}','${id(2)}','${id(1)}','${id(3)}','attendee@example.test','confirmed');
    INSERT INTO event_agenda_item(id,tenant_id,event_id,start_date,description,cpd_points)
      VALUES('${id(5)}','${id(2)}','${id(1)}','2026-01-05','Monday',2),('${id(6)}','${id(2)}','${id(1)}','2026-01-06','Tuesday',1);
    INSERT INTO attendance_target VALUES('${id(7)}','${id(2)}','zoom','${id(1)}','agenda_item','${id(5)}',true),
      ('${id(8)}','${id(2)}','zoom','${id(1)}','agenda_item','${id(6)}',true);
    INSERT INTO attendance_current_outcome VALUES('${id(2)}','booking','${id(4)}','${id(7)}','zoom','attended','${id(9)}'),
      ('${id(2)}','booking','${id(4)}','${id(8)}','zoom','pending','${id(10)}');`);
  const attempt={tenant_id:id(2),booking_id:id(4),booking_type:'booking',trigger_type:'attendance',idempotency_key:'test-one'};
  const record=()=>query(`SELECT status FROM record_event_cpd_points_award('${JSON.stringify(attempt)}');`);
  assert.equal(query(`SELECT item_cpd_certificate_state('${id(2)}','booking','${id(4)}','${id(1)}')->>'ready';`),'false');
  assert.equal(record(),'awarded');
  assert.equal(record(),'already_awarded');
  assert.equal(query('SELECT sum(points_value) FROM member_cpd_points_ledger;'),'2');
  sql(`UPDATE attendance_current_outcome SET status='attended' WHERE attendance_target_id='${id(8)}';`);
  assert.equal(record(),'awarded'); // new day, same booking: no duplicate day-one award
  assert.equal(query('SELECT sum(points_value) FROM member_cpd_points_ledger;'),'3');
  assert.equal(query(`SELECT item_cpd_certificate_state('${id(2)}','booking','${id(4)}','${id(1)}')->>'ready';`),'true');
  sql(`UPDATE event_agenda_item SET cpd_points=9 WHERE id='${id(5)}';`);
  assert.equal(record(),'already_awarded');
  assert.equal(query('SELECT sum(points_value) FROM member_cpd_points_ledger;'),'3');
  assert.equal(query(`SELECT item_cpd_mode('${id(99)}','event','${id(1)}');`),'f');
  sql(`UPDATE event SET is_training=false;`);
  assert.equal(record(),'legacy');
  assert.equal(query(`SELECT has_function_privilege('authenticated','record_event_cpd_points_award(jsonb)','execute');`),'f');
  assert.equal(query(`SELECT has_function_privilege('service_role','record_event_cpd_points_award_before_items(jsonb)','execute');`),'f');
  // A complex session is grouped by the event's local date and requires its own check-in.
  sql(`INSERT INTO complex_event VALUES('${id(20)}','${id(2)}','Europe/London');
    INSERT INTO complex_event_session VALUES('${id(21)}','${id(2)}','${id(20)}','2026-07-05 23:30Z','2026-07-06 00:30Z','Session',1.5);
    INSERT INTO complex_event_booking VALUES('${id(22)}','${id(2)}','${id(20)}','${id(3)}','attendee@example.test','confirmed');
    INSERT INTO complex_event_session_checkin VALUES('${id(23)}','${id(2)}','${id(20)}','${id(22)}','${id(21)}','2026-07-05 23:31Z',NULL);`);
  const c=JSON.parse(query(`SELECT item_cpd_candidates('${id(2)}','complex_event_booking','${id(22)}','${id(20)}');`));
  assert.equal(c.length,1);assert.equal(c[0].day,'2026-07-06');assert.equal(c[0].points,1.5);
  sql(`UPDATE complex_event_session_checkin SET check_in_reversed_at='2026-07-06 01:00Z';`);
  assert.equal(query(`SELECT jsonb_array_length(item_cpd_candidates('${id(2)}','complex_event_booking','${id(22)}','${id(20)}'));`),'0');
 }finally{if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);await h.cleanup();}
});
