import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('manual CPD migration preserves old constraints, scopes writes and deduplicates awards', {timeout:30000},async()=>{
 const run=(bin,args,input)=>{const r=spawnSync(bin,args,{input,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
 const root=await mkdtemp(path.join(tmpdir(),'manual-cpd-pg-'));await mkdir(path.join(root,'socket'));let started=false;
 try{
 run('initdb',['-D',path.join(root,'data'),'-U','postgres','-A','trust','--no-locale']);
 run('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'log'),'-o',`-k ${root}/socket -h ''`,'-w','start']);started=true;
 const sql=s=>run('psql',['-h',path.join(root,'socket'),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],s);
 sql(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
 CREATE TABLE tenant(id uuid PRIMARY KEY);CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
 CREATE TABLE member_cpd_points_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,
 entry_kind text,points_value numeric(20,6),activity_date date,activity_title text,created_by text,
 event_id uuid,event_type text,booking_id uuid,booking_type text,award_trigger text,occurrence_key text,
 rule_id uuid,rule_snapshot jsonb,import_batch_id uuid,source_system text,source_entry_id text,source_metadata jsonb,
 row_hash text,reversal_of uuid,correction_of uuid,evidence_type text,
 CONSTRAINT cpd_entry_kind CHECK(entry_kind='event_award'),
 CONSTRAINT cpd_entry_sign CHECK(points_value>=0),
 CONSTRAINT cpd_entry_context CHECK(event_id IS NOT NULL));
 INSERT INTO tenant VALUES('10000000-0000-4000-8000-000000000001');
 INSERT INTO member VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');`);
 sql(await readFile('supabase/migrations/20261208_manual_cpd_awards.sql','utf8'));
 sql(`DO $test$
 DECLARE t uuid:='10000000-0000-4000-8000-000000000001';m uuid:='20000000-0000-4000-8000-000000000001';
 k uuid:=gen_random_uuid();a uuid;b uuid;c jsonb;
 BEGIN
 c:=jsonb_build_object('path',t||'/manual-cpd/'||m||'/a.pdf','sha256',repeat('a',64));
 SELECT id INTO a FROM record_manual_cpd_award(t,m,k,2.5,'Training','2026-10-25','admin',c);
 SELECT id INTO b FROM record_manual_cpd_award(t,m,k,2.5,'Training','2026-10-25','admin',c);
 IF a<>b OR (SELECT count(*) FROM member_cpd_points_ledger)<>1 THEN RAISE EXCEPTION 'duplicate award';END IF;
 BEGIN PERFORM record_manual_cpd_award(t,m,k,3,'Training','2026-10-25','admin',c);
 RAISE EXCEPTION 'accepted conflict';EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN PERFORM record_manual_cpd_award(gen_random_uuid(),m,gen_random_uuid(),2,'Training','2026-10-25','admin',c);
 RAISE EXCEPTION 'accepted cross tenant';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN INSERT INTO member_cpd_points_ledger(entry_kind,points_value) VALUES('event_award',2);
 RAISE EXCEPTION 'weakened old constraint';EXCEPTION WHEN check_violation THEN NULL;END;
 IF has_function_privilege('anon','record_manual_cpd_award(uuid,uuid,uuid,numeric,text,date,text,jsonb)','execute')
 OR has_function_privilege('authenticated','record_manual_cpd_award(uuid,uuid,uuid,numeric,text,date,text,jsonb)','execute')
 OR has_table_privilege('authenticated','manual_cpd_email_delivery','SELECT')
 OR has_table_privilege('service_role','manual_cpd_email_delivery','DELETE') THEN RAISE EXCEPTION 'unsafe grants';END IF;
 END $test$;`);
 }finally{if(started)run('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);await rm(root,{recursive:true,force:true});}
});
