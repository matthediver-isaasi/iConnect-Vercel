import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('lifecycle confirmations preserve history, tenant boundaries, and live publication', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('survey-lifecycle-');
  const run = (name,args) => { const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr); };
  let db, started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,form_type text,name text,is_active boolean,archived_at timestamptz,survey_settings jsonb);
      CREATE TABLE event_survey_assignment(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,event_title text,status text,opens_at timestamptz,closes_at timestamptz,access_mode text,archived_at timestamptz,archived_by text,updated_at timestamptz);
      CREATE TABLE form_submission(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,form_id uuid,survey_assignment_id uuid);
      CREATE TABLE survey_version(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,form_id uuid,version_number integer,
        fields jsonb,pages jsonb,visibility_rules jsonb,survey_settings jsonb,published_by text);
      CREATE TABLE certificate_survey_entitlement(id uuid DEFAULT gen_random_uuid(),assignment_id uuid);
      CREATE TABLE survey_completion(form_id uuid,tenant_id uuid);
      ALTER TABLE form ADD COLUMN survey_audit_log jsonb;
      ALTER TABLE form ADD COLUMN require_authentication boolean;
    `);
    const prior=readFileSync('supabase/migrations/20260804_survey_form_type_score.sql','utf8');
    const legacyPublisher=[...prior.matchAll(/CREATE OR REPLACE FUNCTION public.publish_survey\([\s\S]*?\$fn\$;/g)].at(-1)?.[0];
    assert.ok(legacyPublisher);
    await db.query(legacyPublisher);
    const migration=readFileSync('supabase/migrations/202612310040_survey_lifecycle.sql','utf8');
    await db.query(migration);await db.query(migration);
    const t='11111111-1111-4111-8111-111111111111',f='22222222-2222-4222-8222-222222222222',a='33333333-3333-4333-8333-333333333333';
    await db.query(`insert into form values($1,$2,'survey','Feedback',true,null,'{"status":"published","current_version":1}');
    `,[f,t]);
    await db.query(`insert into survey_version(tenant_id,form_id,version_number) values($1,$2,1)`,[t,f]);
    await db.query(`insert into event_survey_assignment(id,tenant_id,form_id,event_title,status) values($1,$2,$3,'Event','active')`,[a,t,f]);
    const call=async(op,action,token=null,assignment=null,tenant=t,actor='admin')=>
      (await db.query(`select manage_survey_lifecycle($1,$2,$3,$4,$5,$6,$7,true,null) result`,[tenant,actor,f,op,action,assignment,token])).rows[0].result;
    await assert.rejects(call('preview','pause',null,null,a));
    const first=await call('preview','pause');
    await db.query(`insert into form_submission(tenant_id,form_id,survey_assignment_id) values($1,$2,$3)`,[t,f,a]);
    await assert.rejects(call('execute','pause',first.confirmation_token));
    const next=await call('preview','pause');
    await assert.rejects(call('execute','pause',next.confirmation_token,null,t,'other-admin'));
    await call('execute','pause',next.confirmation_token);
    await db.query('update form set require_authentication=true where id=$1',[f]);
    await assert.rejects(db.query(`insert into form_submission(tenant_id,form_id) values($1,$2)`,[t,f]));
    await assert.rejects(call('execute','pause',next.confirmation_token));
    const activate=await call('preview','activate');await call('execute','activate',activate.confirmation_token);
    await assert.rejects(db.query('update form set require_authentication=false where id=$1',[f]));
    // A legacy edit requesting draft cannot withdraw the active published version.
    await db.query(`update form set survey_settings=jsonb_set(survey_settings,'{status}','"draft"') where id=$1`,[f]);
    assert.equal((await db.query(`select survey_settings->>'status' status from form where id=$1`,[f])).rows[0].status,'published');
    await assert.rejects(db.query(`update form set is_active=false where id=$1`,[f]));
    const remove=await call('preview','remove_assignment',null,a);
    await call('execute','remove_assignment',remove.confirmation_token,a);
    assert.equal((await db.query('select count(*)::int n from form_submission')).rows[0].n,1);
    await assert.rejects(db.query('delete from event_survey_assignment where id=$1',[a]));
    const restore=await call('preview','reattach_assignment',null,a);
    await call('execute','reattach_assignment',restore.confirmation_token,a);
    assert.equal((await call('preview','delete')).impact.deletion_allowed,false);
    const history=await call('history',null);
    assert.equal(history.history.length,5);
    assert.equal((await db.query(`select has_table_privilege('service_role','survey_lifecycle_audit','UPDATE') allowed`)).rows[0].allowed,false);
    const pause=await call('preview','pause');
    await db.query('BEGIN');
    await call('execute','pause',pause.confirmation_token);
    const concurrent=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
    await concurrent.connect();
    try {
      const rejected=assert.rejects(concurrent.query(`insert into form_submission(tenant_id,form_id) values($1,$2)`,[t,f]));
      await db.query('COMMIT');
      await rejected;
    } finally {await concurrent.end();}
    // Publishing while paused must not reopen access, including unchanged versions.
    await db.query(`select publish_survey($1,$2,'[]','[]','[]',(select survey_settings from form where id=$2),'admin')`,[t,f]);
    assert.equal((await call('history',null)).state,'paused');
    const draft='44444444-4444-4444-8444-444444444444';
    await db.query(`insert into form values($1,$2,'survey','Draft',true,null,'{"status":"draft","current_version":1}')`,[draft,t]);
    await db.query(`insert into survey_version(tenant_id,form_id,version_number) values($1,$2,1)`,[t,draft]);
    await db.query(`select publish_survey($1,$2,'[]','[]','[]','{"status":"draft","current_version":1}','admin')`,[t,draft]);
    assert.equal((await db.query('select survey_effective_lifecycle(f) state from form f where id=$1',[draft])).rows[0].state,'active');
    const unused='55555555-5555-4555-8555-555555555555';
    await db.query(`insert into form values($1,$2,'survey','Unused',true,null,'{"status":"draft"}')`,[unused,t]);
    await db.query('create table dependency_test(form_id uuid references form(id) on delete cascade)');
    await db.query('insert into dependency_test values($1)',[unused]);
    const unusedPreview=async()=>(await db.query(`select manage_survey_lifecycle($1,'admin',$2,'preview','delete') result`,[t,unused])).rows[0].result;
    assert.equal((await unusedPreview()).impact.deletion_allowed,false);
    await db.query('delete from dependency_test');
    const approved=await unusedPreview();
    assert.equal(approved.impact.deletion_allowed,true);
    await db.query(`select manage_survey_lifecycle($1,'admin',$2,'execute','delete',null,$3,true,'DELETE')`,[t,unused,approved.confirmation_token]);
    assert.equal((await db.query('select count(*)::int n from form where id=$1',[unused])).rows[0].n,0);
  } finally {
    if(db)await db.end();
    if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
