import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('scoped badge replay preserves old event-wide behavior, isolates registrations and denies browser roles',{timeout:90000},async()=>{
  const h=await createLocalPostgresHarness('cpd-followups-');
  const command=(name,args)=>{
    const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r;
  };
  const sql=text=>{
    const result=spawnSync('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:text,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  try{
    command('initdb',['-D',h.data,'-A','trust','-U','postgres','--no-locale']);
    command('pg_ctl',['-D',h.data,'-l',`${h.root}/server.log`,'-o',`-k ${h.socket} -p ${h.port} -h ''`,'-w','start']);
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE event(id uuid,tenant_id uuid); CREATE TABLE complex_event(LIKE event);
      CREATE TABLE booking(id uuid,tenant_id uuid,event_id uuid,status text);
      CREATE TABLE complex_event_booking(LIKE booking);
      CREATE TABLE event_cpd_badge_rule(id uuid,tenant_id uuid,event_id uuid,event_type text,active boolean,
        is_no_award boolean,trigger_type text,created_at timestamptz DEFAULT now());
      CREATE TABLE event_cpd_badge_outbox(tenant_id uuid,idempotency_key text,booking_type text,booking_id uuid,
        trigger_type text,evidence_type text,evidence_id text,evidence_snapshot jsonb,
        UNIQUE(tenant_id,idempotency_key));
      CREATE TABLE attendee_cpd_certificate_delivery(purpose text DEFAULT 'attendee' CHECK(purpose IN ('attendee','test')));
      CREATE FUNCTION claim_attendee_cpd_certificate_delivery(p_tenant_id uuid,p_source text,p_booking uuid,
        p_request uuid,p_fingerprint text,p_actor text,p_recipient text,p_provenance jsonb,
        p_deliberate_resend boolean,p_purpose text) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF p_purpose NOT IN ('attendee','test') THEN RAISE EXCEPTION 'invalid purpose'; END IF;
        IF p_purpose='attendee' AND FOUND AND NOT p_deliberate_resend THEN RETURN '{"blocked":true}'; END IF;
        RETURN jsonb_build_object('purpose',p_purpose);
      END $$;`);
    sql(readFileSync(new URL('./20261014_event_cpd_badge_replay.sql',import.meta.url),'utf8'));
    sql(readFileSync(new URL('./20261125_scoped_cpd_follow_up_actions.sql',import.meta.url),'utf8'));
    sql(readFileSync(new URL('./20261125_scoped_cpd_follow_up_actions.sql',import.meta.url),'utf8'));
    sql(`INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
      INSERT INTO event VALUES('${id(3)}','${id(1)}');
      INSERT INTO complex_event VALUES('${id(4)}','${id(1)}');
      INSERT INTO booking VALUES('${id(5)}','${id(1)}','${id(3)}','confirmed'),('${id(6)}','${id(1)}','${id(3)}','confirmed');
      INSERT INTO complex_event_booking VALUES('${id(7)}','${id(1)}','${id(4)}','confirmed'),('${id(8)}','${id(1)}','${id(4)}','confirmed');
      INSERT INTO event_cpd_badge_rule(id,tenant_id,event_id,event_type,active,is_no_award,trigger_type)
        VALUES('${id(9)}','${id(1)}','${id(3)}','event',true,false,'registration'),
          ('${id(10)}','${id(1)}','${id(4)}','complex_event',true,false,'registration');`);
    const invoke=(type,event,booking,run)=>sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
      SELECT enqueue_event_cpd_badge_registration_replay('${id(1)}','${type}','${id(event)}','${id(run)}','tester','${id(booking)}');`);
    assert.equal(invoke('event',3,5,11),'1');
    assert.equal(invoke('event',3,5,11),'1');
    assert.equal(invoke('complex_event',4,7,12),'1');
    assert.equal(sql('SELECT count(*) FROM event_cpd_badge_outbox'),'2');
    assert.equal(sql(`SELECT count(*) FROM event_cpd_badge_outbox WHERE booking_id IN ('${id(6)}','${id(8)}')`),'0');
    assert.equal(sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
      SELECT enqueue_event_cpd_badge_replay('${id(1)}','event','${id(3)}','${id(13)}','tester');`),'2');
    assert.equal(sql(`SELECT has_function_privilege('anon','public.enqueue_event_cpd_badge_registration_replay(uuid,text,uuid,uuid,text,uuid)','EXECUTE')`),'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','public.enqueue_event_cpd_badge_registration_replay(uuid,text,uuid,uuid,text,uuid)','EXECUTE')`),'f');
    sql(`INSERT INTO attendee_cpd_certificate_delivery VALUES('badge')`);
    assert.equal(sql(`SELECT claim_attendee_cpd_certificate_delivery(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,true,'badge')->>'purpose'`),'badge');
  }finally{spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop'],{encoding:'utf8'});await h.cleanup();}
});
