#!/usr/bin/env node
// Disposable local PostgreSQL only; never SOURCE or DEST.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const url = process.env.ANONYMOUS_SURVEY_TEST_DATABASE_URL;
if (!url) throw new Error('ANONYMOUS_SURVEY_TEST_DATABASE_URL required');
const target = new URL(url);
if (!['127.0.0.1','localhost'].includes(target.hostname) || !target.port
  || target.pathname !== '/anonymous_survey_test') throw new Error('Disposable local database only');
const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  // Share the existing invitation test's schema scaffold and production nested
  // RPCs, then add the real member/version columns needed by the new contract.
  const source = await readFile(new URL('./test-certificate-survey-grants-sql.mjs', import.meta.url), 'utf8');
  const bootstrap = source.match(/await client.query\(`(DO \$roles\$[\s\S]*?)`\);/)[1];
  await db.query(bootstrap);
  await db.query(`CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
    CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,organization_id uuid);
    ALTER TABLE survey_version ADD COLUMN survey_settings jsonb;
    ALTER TABLE form_submission ADD COLUMN submitted_by_name text, ADD COLUMN member_id uuid,
      ADD COLUMN idempotency_key text, ADD COLUMN ip_address text, ADD COLUMN user_agent text;`);
  const assignmentSql = await readFile(new URL('../supabase/migrations/20260804_event_survey_assignment.sql',import.meta.url),'utf8');
  const scoreSql = await readFile(new URL('../supabase/migrations/20260804_survey_form_type_score.sql',import.meta.url),'utf8');
  await db.query(scoreSql.match(/CREATE TABLE IF NOT EXISTS survey_answer \([\s\S]*?\n\);/)[0]);
  await db.query(assignmentSql.match(/CREATE OR REPLACE FUNCTION public\.create_survey_submission\([\s\S]*?\n\$fn\$;/)[0]);
  for (const file of ['20261121_certificate_survey_grants.sql','20261122_campaign_survey_delivery.sql','20261127_anonymous_survey_completion.sql']) {
    await db.query(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  }
  const tenant=randomUUID(), form=randomUUID(), version=randomUUID(), member=randomUUID();
  const settings={ status:'published', current_version:1, response_identity:'anonymous_dedupe', anonymous_completion_version:1 };
  await db.query('INSERT INTO tenant VALUES($1)',[tenant]);
  await db.query("INSERT INTO form(id,tenant_id,form_type,is_active,survey_settings) VALUES($1,$2,'survey',true,$3)",[form,tenant,settings]);
  await db.query('INSERT INTO survey_version VALUES($1,$2,$3,1,$4)',[version,tenant,form,settings]);
  await db.query("INSERT INTO member(id,tenant_id,email) VALUES($1,$2,'member@example.org')",[member,tenant]);
  const payload={ tenant_id:tenant,form_id:form,survey_version_id:version,submission_data:{rating:5} };
  const answer={ tenant_id:tenant,form_id:form,survey_version_id:version,field_id:'rating',raw_score:5 };
  const accept=(p=payload,m=member,key='a',answers=[answer],token=null,client=db)=>client.query(
    'SELECT accept_anonymous_survey_completion($1,$2,$3,$4,$5) result',[p,JSON.stringify(answers),m,token,key.repeat(64)]);
  const count=async table=>(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
  await assert.rejects(accept({...payload,tenant_id:randomUUID()}),/unavailable/);
  await assert.rejects(accept(payload,randomUUID()),/member unavailable/);
  await assert.rejects(accept({...payload,member_id:member}),/Unexpected anonymous/);
  await assert.rejects(accept(payload,member,'a',[{...answer,form_id:randomUUID()}]),/linkage mismatch/);
  assert.equal(await count('form_submission'),0);
  assert.equal(await count('survey_completion'),0);
  assert.equal(await count('survey_completion_retry'),0);
  await assert.rejects(accept(payload,null),/Sign in or use/);
  await db.query("UPDATE form SET form_type='standard'");
  await assert.rejects(accept(),/publication unavailable/);
  await db.query("UPDATE form SET form_type='survey'");
  await db.query("UPDATE survey_version SET survey_settings=survey_settings-'anonymous_completion_version'");
  await assert.rejects(accept(),/publication unavailable/);
  await db.query('UPDATE survey_version SET survey_settings=$1',[settings]);
  const peer=new pg.Client({connectionString:url}); await peer.connect();
  try {
    const race=await Promise.all([accept(),accept(payload,member,'a',[answer],null,peer)]);
    assert.deepEqual(race.map(r=>r.rows[0].result.replayed).sort(),[false,true]);
  } finally { await peer.end(); }
  assert.equal(await count('form_submission'),1); assert.equal(await count('survey_answer'),1);
  await assert.rejects(accept(payload,member,'b'),/already completed/);
  const row=(await db.query('SELECT * FROM form_submission')).rows[0];
  for(const k of ['member_id','submitted_by_name','submitted_by_email','ip_address','user_agent','idempotency_key','survey_respondent_key']) assert.equal(row[k],null);
  assert.equal(row.is_anonymous,true);
  const completion=(await db.query('SELECT * FROM survey_completion')).rows[0];
  assert.deepEqual(Object.keys(completion).sort(),['id','tenant_id','form_id','assignment_id','member_id','recipient_email','completed_day'].sort());
  await db.query("UPDATE survey_version SET survey_settings=survey_settings||'{\"response_identity\":\"anonymous\"}'");
  await accept(payload,member,'b'); // repeat allowed, one completion
  await accept(payload,null,'c'); // unverified public has no named completion
  await accept(payload,null,'c'); // same public retry does not add answer
  assert.equal(await count('form_submission'),3); assert.equal(await count('survey_completion'),1);
  const event=randomUUID(), assignment=randomUUID(), booking=randomUUID(), delivery=randomUUID();
  await db.query('INSERT INTO event VALUES($1)',[event]);
  await db.query("INSERT INTO event_survey_assignment(id,tenant_id,form_id,event_type,event_id,status) VALUES($1,$2,$3,'event',$4,'active')",[assignment,tenant,form,event]);
  await db.query("INSERT INTO booking VALUES($1,$2,$3,'confirmed','guest@example.org')",[booking,tenant,event]);
  await db.query("INSERT INTO attendee_cpd_certificate_delivery VALUES($1,$2,'standard',$3,'pending')",[delivery,tenant,booking]);
  const grant=(await db.query("INSERT INTO certificate_survey_entitlement(tenant_id,booking_source,booking_id,assignment_id,recipient_email,expires_at) VALUES($1,'standard',$2,$3,'guest@example.org',now()+interval '1 day') RETURNING id",[tenant,booking,assignment])).rows[0].id;
  await db.query("INSERT INTO certificate_survey_credential(entitlement_id,delivery_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[grant,delivery,'f'.repeat(64)]);
  await db.query("UPDATE attendee_cpd_certificate_delivery SET status='accepted' WHERE id=$1",[delivery]);
  const invited={...payload,survey_assignment_id:assignment,event_id:event};
  await assert.rejects(accept(invited,null,'d',[{...answer,field_id:null}],'f'.repeat(64)));
  assert.equal((await db.query('SELECT completed_at FROM certificate_survey_entitlement')).rows[0].completed_at,null);
  await accept(invited,null,'d',[answer],'f'.repeat(64));
  assert.equal((await accept(invited,null,'d',[answer],'f'.repeat(64))).rows[0].result.replayed,true);
  const entitlement=(await db.query('SELECT response_id,completed_at FROM certificate_survey_entitlement')).rows[0];
  assert.equal(entitlement.response_id,null); assert.ok(entitlement.completed_at);
  await assert.rejects(accept(invited,null,'e',[answer],'f'.repeat(64)),/already completed/);
  await db.query("UPDATE certificate_survey_credential SET revoked_at=now()");
  await assert.rejects(accept(invited,null,'d',[answer],'f'.repeat(64)),/invitation unavailable/);
  assert.equal(await count('survey_completion'),2);
  assert.equal(await count('form_submission'),4);
  await db.query('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT * FROM survey_completion'),/permission denied/);
  await assert.rejects(accept(),/permission denied/);
  await db.query('RESET ROLE; SET ROLE service_role');
  await assert.rejects(db.query('SELECT * FROM survey_completion_retry'),/permission denied/);
  await db.query('RESET ROLE');
  await db.query(await readFile(new URL('../supabase/migrations/20261128_survey_response_policy_lock.sql',import.meta.url),'utf8'));
  const fixture=async()=>{
    const f=randomUUID(),v=randomUUID();
    const policy={status:'published',current_version:1,response_identity:'anonymous',anonymous_completion_version:1};
    await db.query("INSERT INTO form(id,tenant_id,form_type,is_active,survey_settings) VALUES($1,$2,'survey',true,$3)",[f,tenant,policy]);
    await db.query('INSERT INTO survey_version VALUES($1,$2,$3,1,$4)',[v,tenant,f,policy]);
    return {f,v,policy,p:{tenant_id:tenant,form_id:f,survey_version_id:v,submission_data:{rating:4}}};
  };
  const rival=new pg.Client({connectionString:url}); await rival.connect();
  const rivalPid=(await rival.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const waitBlocked=async()=>{
    for(let i=0;i<100;i++){
      if((await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[rivalPid])).rows[0]?.wait_event_type==='Lock')return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('Expected concurrent policy operation to wait for acceptance row lock');
  };
  try {
    // Response wins: UPDATE must see the committed first response after waiting.
    const a=await fixture();
    await db.query('BEGIN'); await accept(a.p,null,'a',[]);
    const edit=rival.query("UPDATE form SET survey_settings=survey_settings||'{\"response_identity\":\"identified\"}' WHERE id=$1",[a.f])
      .then(()=>({ok:true}),error=>({error}));
    await waitBlocked(); await db.query('COMMIT');
    assert.match((await edit).error.message,/immutable after responses/);
    await assert.rejects(db.query("UPDATE form SET form_type='standard' WHERE id=$1",[a.f]),/immutable/);
    await assert.rejects(db.query("UPDATE form SET survey_settings=survey_settings||'{\"one_submission_per_respondent\":true}' WHERE id=$1",[a.f]),/immutable/);
    await assert.rejects(db.query("UPDATE form SET survey_settings=survey_settings-'anonymous_completion_version' WHERE id=$1",[a.f]),/immutable/);
    await assert.rejects(db.query('UPDATE survey_version SET survey_settings=$1 WHERE id=$2',[a.policy,a.v]),/snapshots are immutable/);
    await assert.rejects(db.query('DELETE FROM survey_version WHERE id=$1',[a.v]),/snapshots are immutable/);
    // Publication wins: stale snapshot cannot be accepted after commit.
    const b=await fixture();
    await db.query('BEGIN');
    await db.query("UPDATE form SET survey_settings=survey_settings||'{\"response_identity\":\"identified\"}' WHERE id=$1",[b.f]);
    const stale=accept(b.p,null,'a',[],null,rival).then(()=>({ok:true}),error=>({error}));
    await waitBlocked(); await db.query('COMMIT');
    assert.match((await stale).error.message,/policy changed/);
    assert.equal((await db.query('SELECT count(*)::int n FROM form_submission WHERE form_id=$1',[b.f])).rows[0].n,0);
    // Snapshot allocation/publication races use the same form tuple boundary.
    const c=await fixture();
    await db.query('BEGIN'); await accept(c.p,null,'a',[]);
    const publish=rival.query('INSERT INTO survey_version VALUES($1,$2,$3,2,$4)',
      [randomUUID(),tenant,c.f,{...c.policy,response_identity:'identified'}]).then(()=>({ok:true}),error=>({error}));
    await waitBlocked(); await db.query('COMMIT');
    assert.match((await publish).error.message,/immutable after responses/);
    // Unchanged policy remains publishable, and ordinary Standard rows work.
    await db.query('INSERT INTO survey_version VALUES($1,$2,$3,2,$4)',[randomUUID(),tenant,c.f,c.policy]);
    const d=await fixture();
    await db.query('INSERT INTO survey_version VALUES($1,$2,$3,2,$4)',
      [randomUUID(),tenant,d.f,{...d.policy,response_identity:'identified'}]);
    await accept(d.p,null,'a',[]);
    await assert.rejects(db.query("UPDATE form SET survey_settings=survey_settings||'{\"current_version\":2}' WHERE id=$1",[d.f]),/immutable after responses/);
    // Identified/legacy anonymous RPCs still write when their policies agree.
    for(const mode of ['identified','anonymous']){
      const f=randomUUID(),v=randomUUID(),s={status:'published',current_version:1,response_identity:mode};
      await db.query("INSERT INTO form(id,tenant_id,form_type,is_active,survey_settings) VALUES($1,$2,'survey',true,$3)",[f,tenant,s]);
      await db.query('INSERT INTO survey_version VALUES($1,$2,$3,1,$4)',[v,tenant,f,s]);
      await db.query("SELECT * FROM create_survey_submission($1,'[]')",
        [{tenant_id:tenant,form_id:f,survey_version_id:v,submission_data:{rating:4},is_anonymous:mode==='anonymous'}]);
    }
    const standard=randomUUID();
    await db.query("INSERT INTO form(id,tenant_id,form_type,is_active,survey_settings) VALUES($1,$2,'standard',true,'{}')",[standard,tenant]);
    await db.query("INSERT INTO form_submission(tenant_id,form_id,submission_data) VALUES($1,$2,'{}')",[tenant,standard]);
    await db.query("UPDATE form SET survey_settings='{}' WHERE id=$1",[standard]);
  } finally { await rival.end(); }
  await db.query(await readFile(new URL('../supabase/migrations/20261129_survey_completion_member_tenancy.sql',import.meta.url),'utf8'));
  const inherited=await fixture(),org=randomUUID(),orgMember=randomUUID(),otherTenant=randomUUID();
  await db.query('INSERT INTO organization VALUES($1,$2)',[org,tenant]);
  await db.query("INSERT INTO member VALUES($1,NULL,'inherited@example.org',$2)",[orgMember,org]);
  await accept(inherited.p,orgMember,'a',[]);
  const evidence=(await db.query('SELECT * FROM survey_completion WHERE member_id=$1',[orgMember])).rows[0];
  assert.equal(evidence.tenant_id,tenant);
  assert.equal(evidence.recipient_email,'inherited@example.org');
  await db.query('UPDATE member SET tenant_id=$1 WHERE id=$2',[otherTenant,orgMember]);
  await assert.rejects(accept(inherited.p,orgMember,'b',[]),/member unavailable/);
  await db.query('UPDATE member SET tenant_id=NULL WHERE id=$1',[orgMember]);
  await db.query('UPDATE organization SET tenant_id=$1 WHERE id=$2',[otherTenant,org]);
  await assert.rejects(accept(inherited.p,orgMember,'b',[]),/member unavailable/);
  console.log('PASS: real nested SQL rollback, forged scope/identity, concurrency, retries, repeat policy, public, invitation separation and privileges');
  console.log('PASS: acceptance vs PATCH/publication race locks, immutable policy/snapshots, unchanged publication and Standard writes');
  console.log('PASS: inherited organisation tenancy, conflicting direct tenant and cross-tenant organisation denial');
} finally { await db.end(); }