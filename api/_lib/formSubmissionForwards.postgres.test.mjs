import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('forwarding migration scopes recipient/submission, deduplicates and protects private rows', {timeout:30000},async()=>{
  const run=(bin,args,input)=>{const r=spawnSync(bin,args,{input,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const root=await mkdtemp(path.join(tmpdir(),'submission-forward-pg-'));await mkdir(path.join(root,'socket'));let started=false;
  try {
    run('initdb',['-D',path.join(root,'data'),'-U','postgres','-A','trust','--no-locale']);
    run('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'log'),'-o',`-k ${root}/socket -h ''`,'-w','start']);started=true;
    const sql=s=>run('psql',['-h',path.join(root,'socket'),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],s);
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,status text,email text);
      CREATE TABLE form_submission(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,UNIQUE(tenant_id,form_id,id));
      INSERT INTO member VALUES ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','active','example@example.test');
      INSERT INTO form_submission VALUES ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004');`);
    sql(await readFile('supabase/migrations/20261216_form_submission_forwarding.sql','utf8'));
    sql(`SET ROLE service_role;
      INSERT INTO form_submission_forward(tenant_id,form_id,submission_id,member_id,recipient_name,recipient_email,actor,idempotency_key,form_snapshot)
      VALUES('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003','Example','example@example.test','test', '10000000-0000-4000-8000-000000000005','{}');
      UPDATE form_submission_forward SET status='sent',sent_at=now();
      RESET ROLE;
      DO $test$
      BEGIN
        IF has_table_privilege('anon','form_submission_forward','SELECT')
          OR has_table_privilege('authenticated','form_submission_forward','INSERT')
          OR has_column_privilege('service_role','form_submission_forward','message_html','UPDATE')
          OR has_table_privilege('service_role','form_submission_forward','DELETE')
          OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='form_submission_forward'::regclass)
        THEN RAISE EXCEPTION 'unsafe grants'; END IF;
        BEGIN
          INSERT INTO form_submission_forward SELECT * FROM form_submission_forward;
          RAISE EXCEPTION 'duplicate accepted';
        EXCEPTION WHEN unique_violation THEN NULL; END;
        BEGIN
          INSERT INTO form_submission_forward(tenant_id,form_id,submission_id,member_id,recipient_name,recipient_email,actor,idempotency_key,form_snapshot)
          VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000003','Example','example@example.test','test',gen_random_uuid(),'{}');
          RAISE EXCEPTION 'cross tenant accepted';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO form_submission_forward(tenant_id,form_id,submission_id,member_id,recipient_name,recipient_email,actor,idempotency_key,form_snapshot)
          VALUES('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000003','Example','example@example.test','test',gen_random_uuid(),'{}');
          RAISE EXCEPTION 'wrong form accepted';
        EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      END $test$;
      DELETE FROM form_submission;
      DO $$ BEGIN IF EXISTS(SELECT FROM form_submission_forward) THEN RAISE EXCEPTION 'orphan capability'; END IF; END $$;`);
  } finally {
    if(started)run('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});
