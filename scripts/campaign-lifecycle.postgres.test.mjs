import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('campaign lifecycle: isolation, preservation, work fencing, atomic cascades and summary', async () => {
  const h = await createLocalPostgresHarness('campaign-lifecycle-');
  const run = (cmd,args,input) => {
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); return r.stdout.trim();
  };
  const sql = text => run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-At'],text);
  const tenant='11111111-1111-4111-8111-111111111111';
  const other='22222222-2222-4222-8222-222222222222';
  const c='33333333-3333-4333-8333-333333333333';
  const r='44444444-4444-4444-8444-444444444444';
  const clients=[];
  let started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,first_name text,last_name text,
        communications_opted_out_all boolean,login_enabled boolean,organization_id uuid);
      CREATE TABLE email_template(id uuid PRIMARY KEY);
      CREATE TABLE communication_category(id uuid PRIMARY KEY);
      CREATE TABLE complex_event_session_checkin(tenant_id uuid,booking_id uuid,checked_in_at timestamptz);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,status text,attendee_email text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE member_inbox_message_state(tenant_id uuid,recipient_id uuid);
      CREATE TABLE member_transactional_message(id uuid PRIMARY KEY);
      CREATE TABLE member_inbox_folder(id uuid PRIMARY KEY);`);
    sql(readFileSync('supabase/migrations/20260131_create_email_campaigns.sql','utf8'));
    sql(`ALTER TABLE email_campaign ADD COLUMN category_review_required boolean DEFAULT false;
      ALTER TABLE email_campaign ADD COLUMN communication_category_id uuid REFERENCES communication_category;
      ALTER TABLE email_campaign ADD COLUMN category_review_reason jsonb;
      ALTER TABLE email_campaign ADD COLUMN category_review_marked_at timestamptz;
      ALTER TABLE email_campaign ADD COLUMN deleted_category_id uuid;
      ALTER TABLE email_campaign ADD COLUMN deleted_category_name text;
      ALTER TABLE email_campaign ADD COLUMN future_content_field text;
      ALTER TABLE email_campaign ALTER COLUMN name SET DEFAULT 'Disposable fixture';
      ALTER TABLE email_campaign ALTER COLUMN subject SET DEFAULT 'Disposable fixture';
      ALTER TABLE email_campaign_recipient ALTER COLUMN email SET DEFAULT 'fixture@example.invalid';
      ALTER TABLE email_event ALTER COLUMN email SET DEFAULT 'fixture@example.invalid';
      ALTER TABLE email_event ALTER COLUMN event_type SET DEFAULT 'accepted';
      ALTER TABLE email_link_click ALTER COLUMN original_url SET DEFAULT 'https://example.invalid';
      INSERT INTO tenant VALUES('${tenant}'),('${other}');`);
    // Apply the actual preparation tables, RPCs and guard, not approximations.
    sql(readFileSync('migrations/20261001_campaign_preparation.sql','utf8'));
    // Apply actual survey delivery DDL and provenance guard. Later migration
    // sections adapt the separate certificate-submission engine, outside scope.
    const survey=readFileSync('supabase/migrations/20261122_campaign_survey_delivery.sql','utf8');
    sql(survey.slice(0,survey.indexOf('ALTER TABLE public.certificate_survey_credential'))+'\nCOMMIT;');
    // Realistic protected invitation/credential/response FK graph.
    sql(`CREATE TABLE form_submission(id uuid PRIMARY KEY,payload jsonb NOT NULL);
      CREATE TABLE event_survey_assignment(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenant);
      CREATE TABLE certificate_survey_entitlement(id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant,assignment_id uuid NOT NULL REFERENCES event_survey_assignment,
        response_id uuid UNIQUE REFERENCES form_submission,recipient_email text NOT NULL);
      CREATE TABLE certificate_survey_credential(id uuid PRIMARY KEY,
        entitlement_id uuid NOT NULL REFERENCES certificate_survey_entitlement,
        campaign_delivery_id uuid REFERENCES campaign_survey_delivery,token_hash text NOT NULL);
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      -- Model legacy Supabase table defaults, including permissive base RLS.
      GRANT SELECT,DELETE ON email_campaign,email_campaign_recipient TO PUBLIC,anon,authenticated;`);
    const migration=readFileSync('supabase/migrations/202612310006_campaign_lifecycle.sql','utf8');
    sql(migration); sql(migration);
    const indexMigration=readFileSync('supabase/migrations/202612310007_campaign_delete_fk_indexes.sql','utf8');
    sql(indexMigration); sql(indexMigration);
    for(let i=0;i<2;i++) {
      const db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
      await db.connect(); clients.push(db);
    }
    const [db,worker]=clients;
    const dbPid=(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const workerPid=(await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const waitForLock=async(observer,pid)=>{
      for(let i=0;i<100;i++) {
        const state=(await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
        if(state?.wait_event_type==='Lock') return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail('Expected the concurrent operation to wait on a database lock');
    };
    const lifecycle=(action,t=tenant)=>db.query('SELECT campaign_lifecycle($1,$2,$3) result',[c,t,action]);
    await db.query(`INSERT INTO email_campaign(id,tenant_id,status) VALUES($1,$2,'sent')`,[c,tenant]);
    await assert.rejects(lifecycle('archive',other),/Campaign not found/);
    await assert.rejects(lifecycle('invalid'),/Invalid/);
    await db.query('SET ROLE service_role');
    await assert.rejects(db.query('UPDATE email_campaign SET archived_at=now() WHERE id=$1',[c]),/Use campaign lifecycle/);
    await assert.rejects(db.query('INSERT INTO campaign_lifecycle_permit VALUES(txid_current(),$1)',[c]),/permission denied/);
    await db.query('RESET ROLE');
    await db.query(`INSERT INTO email_campaign_recipient(id,campaign_id,status,open_count,click_count) VALUES($1,$2,'sent',1,1)`,[r,c]);
    await db.query(`INSERT INTO email_campaign_recipient(id,campaign_id,status,open_count,click_count) VALUES($1,$2,'bounced',1,0)`,[other,c]);
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query('DELETE FROM email_campaign WHERE id=$1',[c]),/permission denied/);
    await assert.rejects(db.query('DELETE FROM email_campaign_recipient WHERE id=$1',[r]),/permission denied/);
    await db.query('RESET ROLE');
    for(const role of ['anon','authenticated']) {
      for(const table of ['email_campaign','email_campaign_recipient']) {
        assert.equal(sql(`SELECT has_table_privilege('${role}','${table}','DELETE')`),'f');
      }
    }
    let summary=(await db.query('SELECT campaign_summary($1) result',[tenant])).rows[0].result;
    assert.deepEqual(summary,{totalCampaigns:1,sentCampaigns:1,draftCount:0,scheduledCount:0,totalSent:1,totalOpened:2,totalClicked:1,avgOpenRate:200,avgClickRate:100});
    const archived=(await lifecycle('archive')).rows[0].result;
    assert.ok(archived.archived_at); assert.equal(archived.status,'sent');
    await assert.rejects(db.query('SELECT campaign_test_send_begin($1,$2)',[c,tenant]),/Archived/);
    assert.equal(sql(`SELECT campaign_preparation_identity('{"status":"paused"}') = campaign_preparation_identity('{"status":"paused","archived_at":null}')`),'t');
    assert.deepEqual((await db.query('SELECT campaign_summary($1) result',[tenant])).rows[0].result,summary);
    await assert.rejects(db.query("UPDATE email_campaign SET status='sending' WHERE id=$1",[c]),/Archived/);
    await assert.rejects(db.query("UPDATE email_campaign_recipient SET status='processing' WHERE id=$1",[r]),/Archived/);
    await db.query('SET ROLE service_role');
    for(const field of ['name','subject','html_content','from_email','future_content_field']) {
      await assert.rejects(db.query(`UPDATE email_campaign SET ${field}='changed' WHERE id=$1`,[c]),/content is read-only/);
    }
    await db.query(`UPDATE email_campaign SET sent_count=7,delivered_count=6,opened_count=5,clicked_count=4,
      bounced_count=3,unsubscribed_count=2,complained_count=1,updated_at=now() WHERE id=$1`,[c]);
    await db.query("UPDATE email_campaign_recipient SET status='opened',open_count=2 WHERE id=$1",[r]);
    await db.query("UPDATE email_campaign_recipient SET status='sent',open_count=1 WHERE id=$1",[r]);
    await db.query('RESET ROLE');
    await lifecycle('restore');
    // Archived content editing is fenced on the same parent lock as archive.
    await db.query('BEGIN');
    await lifecycle('archive');
    const lateEdit=assert.rejects(worker.query("UPDATE email_campaign SET subject='racing edit' WHERE id=$1",[c]),/content is read-only/);
    await waitForLock(db,workerPid);
    await db.query('COMMIT');
    await lateEdit;
    await lifecycle('restore');
    await worker.query('BEGIN');
    await worker.query("UPDATE email_campaign SET subject='edit committed first' WHERE id=$1",[c]);
    const archiveAfterEdit=lifecycle('archive');
    await waitForLock(worker,dbPid);
    await worker.query('COMMIT');
    assert.equal((await archiveAfterEdit).rows[0].result.subject,'edit committed first');
    await lifecycle('restore');
    // Safety marking/clearing a deleted category is metadata maintenance, not
    // content editing; arbitrary category reassignment remains forbidden.
    await db.query('INSERT INTO communication_category VALUES($1)',[r]);
    await db.query('UPDATE email_campaign SET communication_category_id=$1 WHERE id=$2',[r,c]);
    await lifecycle('archive');
    await db.query(`UPDATE email_campaign SET communication_category_id=NULL,category_review_required=true,
      deleted_category_id=$1,deleted_category_name='Removed',category_review_marked_at=now(),
      category_review_reason='{"code":"deleted_communication_category"}' WHERE id=$2`,[r,c]);
    await assert.rejects(db.query('UPDATE email_campaign SET communication_category_id=$1 WHERE id=$2',[r,c]),/content is read-only/);
    await db.query('UPDATE email_campaign SET category_review_required=false,category_review_reason=NULL WHERE id=$1',[c]);
    await lifecycle('restore');
    const token=(await db.query('SELECT campaign_test_send_begin($1,$2) token',[c,tenant])).rows[0].token;
    await assert.rejects(lifecycle('archive'),/operator must reconcile provider delivery and release the test-send lease/);
    await assert.rejects(lifecycle('delete'),/unresolved/);
    await assert.rejects(db.query('SELECT campaign_test_send_end($1,$2,$3)',[c,other,token]),/not found/);
    assert.equal((await db.query('SELECT campaign_test_send_end($1,$2,$3) ended',[c,tenant,r])).rows[0].ended,false);
    assert.equal((await db.query('SELECT campaign_test_send_end($1,$2,$3) ended',[c,tenant,token])).rows[0].ended,true);
    for(const status of ['scheduled','preparing','sending','paused']) {
      await db.query('UPDATE email_campaign SET status=$1 WHERE id=$2',[status,c]);
      for(const action of ['archive','delete','restore']) await assert.rejects(lifecycle(action),/unresolved/);
    }
    await db.query("UPDATE email_campaign SET status='failed' WHERE id=$1",[c]);
    await db.query("UPDATE email_campaign_recipient SET status='pending' WHERE id=$1",[r]);
    await assert.rejects(lifecycle('archive'),/unresolved/);
    await assert.rejects(lifecycle('delete'),/unresolved/);
    await db.query("UPDATE email_campaign_recipient SET status='sent' WHERE id=$1",[r]);
    await db.query("INSERT INTO campaign_preparation(id,campaign_id,tenant_id,snapshot,phase) VALUES($1,$2,$3,'{}','resolve')",[r,c,tenant]);
    await assert.rejects(lifecycle('delete'),/unresolved/);
    await db.query("UPDATE campaign_preparation SET phase='complete'");
    await db.query("INSERT INTO campaign_preparation_fact(generation,segment,bucket,key) VALUES($1,0,'fixture','fixture')",[r]);
    await db.query("UPDATE email_campaign SET status='sending' WHERE id=$1",[c]);
    await db.query("UPDATE email_campaign_recipient SET status='processing' WHERE id=$1",[r]);
    await db.query("INSERT INTO booking VALUES($1,$2,$1,'confirmed','fixture@example.invalid')",[r,tenant]);
    await db.query(`INSERT INTO campaign_survey_delivery(id,tenant_id,campaign_id,campaign_recipient_id,purpose,
      booking_source,booking_id,event_type,event_id,source_email,destination_email)
      VALUES($1,$2,$3,$1,'live','standard',$1,'event',$1,'fixture@example.invalid','fixture@example.invalid')`,[r,tenant,c]);
    await db.query("UPDATE campaign_survey_delivery SET status='accepted',resolved_at=now()");
    await db.query("UPDATE email_campaign_recipient SET status='sent' WHERE id=$1",[r]);
    await db.query("UPDATE email_campaign SET status='sent' WHERE id=$1",[c]);
    await db.query("INSERT INTO form_submission VALUES($1,'{\"answer\":\"retained\"}')",[r]);
    await db.query("INSERT INTO event_survey_assignment VALUES($1,$2)",[r,tenant]);
    await db.query("INSERT INTO certificate_survey_entitlement VALUES($1,$2,$1,$1,'fixture@example.invalid')",[r,tenant]);
    await db.query("INSERT INTO certificate_survey_credential VALUES($1,$1,$1,'disposable-token-hash')",[r]);
    await db.query('INSERT INTO member_inbox_message_state VALUES($1,$2)',[tenant,r]);
    const surveyTables=['campaign_survey_delivery','certificate_survey_entitlement','certificate_survey_credential','form_submission',
      'email_campaign_recipient','member_inbox_message_state'];
    const snapshot=async()=>Promise.all(surveyTables.map(async table=>(await db.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
    const beforeSurvey=await snapshot();
    await assert.rejects(lifecycle('delete'),/Archive instead/);
    assert.deepEqual(await snapshot(),beforeSurvey,'protected delete has no partial cleanup');
    const beforeArchiveSummary=(await db.query('SELECT campaign_summary($1) result',[tenant])).rows[0].result;
    await lifecycle('archive');
    assert.deepEqual(await snapshot(),beforeSurvey,'archive preserves invitations, credentials and responses');
    assert.deepEqual((await db.query('SELECT campaign_summary($1) result',[tenant])).rows[0].result,beforeArchiveSummary);
    await lifecycle('restore');
    await db.query('DELETE FROM certificate_survey_credential');
    await db.query('DELETE FROM campaign_survey_delivery');
    await db.query('DELETE FROM member_inbox_message_state');

    // Real preparation resume accepts a pre-migration snapshot without
    // archived_at. Parent lifecycle guard and existing preparation guard coexist.
    await db.query("UPDATE email_campaign SET status='paused',preparation_generation=$1 WHERE id=$2",[r,c]);
    await db.query(`UPDATE campaign_preparation SET phase='resolve',
      snapshot=(SELECT to_jsonb(ec)-'archived_at' FROM email_campaign ec WHERE id=$1)
      WHERE id=$2`,[c,r]);
    await worker.query('BEGIN');
    await worker.query("SELECT campaign_preparation_step($1,$2,'resume')",[r,tenant]);
    const resumeBlocksArchive=assert.rejects(lifecycle('archive'),/stop scheduling\/sending and reconcile/);
    await waitForLock(worker,dbPid);
    await worker.query('COMMIT');
    await resumeBlocksArchive;
    assert.equal((await db.query('SELECT status FROM email_campaign WHERE id=$1',[c])).rows[0].status,'preparing');
    await db.query("UPDATE campaign_preparation SET phase='complete'");
    await db.query("UPDATE email_campaign SET status='sent',preparation_generation=NULL WHERE id=$1",[c]);

    // Archive wins against schedule and delivery-resume transitions. They
    // cannot revive an archived row even when they started before its commit.
    for(const status of ['scheduled','preparing','sending']) {
      await db.query('BEGIN');
      await lifecycle('archive');
      const rejected=assert.rejects(worker.query('UPDATE email_campaign SET status=$1 WHERE id=$2',[status,c]),/Archived/);
      await waitForLock(db,workerPid);
      await db.query('COMMIT');
      await rejected;
      await lifecycle('restore');
    }
    // Schedule wins first: lifecycle must observe it after waiting, not act
    // on the old sent status.
    await worker.query('BEGIN');
    await worker.query("UPDATE email_campaign SET status='scheduled' WHERE id=$1",[c]);
    const scheduleBlocksArchive=assert.rejects(lifecycle('archive'),/unresolved/);
    await waitForLock(worker,dbPid);
    await worker.query('COMMIT');
    await scheduleBlocksArchive;
    await db.query("UPDATE email_campaign SET status='sent' WHERE id=$1",[c]);

    // A parent lock held by archive forces a late child claim to see archive.
    await db.query('BEGIN');
    await lifecycle('archive');
    const lateClaim=worker.query("UPDATE email_campaign_recipient SET status='processing' WHERE id=$1",[r]);
    const lateRejected=assert.rejects(lateClaim,/Archived/);
    await waitForLock(db,workerPid);
    await db.query('COMMIT');
    await lateRejected;
    await lifecycle('restore');
    // Work committed first makes lifecycle refuse, rather than deleting claims.
    await worker.query('BEGIN');
    await worker.query("UPDATE email_campaign SET status='sending' WHERE id=$1",[c]);
    await worker.query("UPDATE email_campaign_recipient SET status='processing' WHERE id=$1",[r]);
    const blockedLifecycle=assert.rejects(lifecycle('delete'),/unresolved/);
    await waitForLock(worker,dbPid);
    await worker.query('COMMIT');
    await blockedLifecycle;
    await db.query("UPDATE email_campaign_recipient SET status='sent' WHERE id=$1",[r]);
    await db.query("UPDATE email_campaign SET status='sent' WHERE id=$1",[c]);

    await db.query('INSERT INTO email_unsubscribe(id,campaign_id,email) VALUES($1,$2,$3)',[r,c,'unsubscribe@example.invalid']);
    await db.query('INSERT INTO email_event(id,campaign_id,recipient_id) VALUES($1,$2,$1)',[r,c]);
    await db.query('INSERT INTO email_link_click(id,campaign_id,recipient_id) VALUES($1,$2,$1)',[r,c]);
    await db.query('INSERT INTO member_inbox_message_state VALUES($1,$2),($1,$3)',[tenant,r,tenant]);
    await db.query('INSERT INTO member_transactional_message VALUES($1)',[r]);
    await db.query('INSERT INTO member_inbox_folder VALUES($1)',[r]);
    await assert.rejects(db.query('DELETE FROM email_campaign WHERE id=$1',[c]),/Use campaign lifecycle/);
    // A previously unknown restrictive FK fails after BEFORE DELETE has cleaned
    // inbox state. The entire statement must restore that cleanup, audit links,
    // consent, child cascades and its private capability.
    await db.query('CREATE TABLE unexpected_campaign_reference(campaign_id uuid REFERENCES email_campaign)');
    await db.query('INSERT INTO unexpected_campaign_reference VALUES($1)',[c]);
    const protectedTables=['email_campaign','email_campaign_recipient','email_unsubscribe','email_event',
      'email_link_click','member_inbox_message_state','campaign_preparation','campaign_preparation_fact','campaign_lifecycle_permit'];
    const protectedSnapshot=async()=>Promise.all(protectedTables.map(async table=>(await db.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
    const beforeUnexpected=await protectedSnapshot();
    await assert.rejects(lifecycle('delete'),/unexpected_campaign_reference/);
    assert.deepEqual(await protectedSnapshot(),beforeUnexpected,'unexpected FK rolls back every side effect');
    await db.query('DROP TABLE unexpected_campaign_reference');
    const beforeDelete=(await db.query('SELECT campaign_summary($1) result',[tenant])).rows[0].result;
    assert.equal(beforeDelete.sentCampaigns,1); assert.equal(beforeDelete.totalSent,1);
    await db.query('BEGIN');
    await lifecycle('delete');
    assert.deepEqual((await db.query('SELECT campaign_summary($1) result',[tenant])).rows[0].result,
      {totalCampaigns:0,sentCampaigns:0,draftCount:0,scheduledCount:0,totalSent:0,totalOpened:0,totalClicked:0,avgOpenRate:0,avgClickRate:0});
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT * FROM email_campaign')).rowCount,1);
    assert.equal((await db.query('SELECT * FROM member_inbox_message_state')).rowCount,2);
    await lifecycle('delete');
    for(const table of ['email_campaign','email_campaign_recipient','email_link_click','campaign_preparation','campaign_preparation_fact','campaign_lifecycle_permit']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).rowCount,0,table);
    }
    assert.equal((await db.query('SELECT campaign_id FROM email_unsubscribe')).rows[0].campaign_id,null);
    assert.deepEqual((await db.query('SELECT campaign_id,recipient_id FROM email_event')).rows[0],{campaign_id:null,recipient_id:null});
    for(const table of ['member_transactional_message','member_inbox_folder','member_inbox_message_state']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).rowCount,1,table);
    }
    // Existing direct draft deletion still works, but pending drafts do not.
    await db.query("INSERT INTO email_campaign(id,tenant_id,status) VALUES($1,$2,'draft')",[c,tenant]);
    await db.query("INSERT INTO email_campaign_recipient(id,campaign_id,status) VALUES($1,$2,'pending')",[r,c]);
    await assert.rejects(db.query('DELETE FROM email_campaign WHERE id=$1',[c]),/unresolved/);
    await db.query('DELETE FROM email_campaign_recipient WHERE id=$1',[r]);
    await db.query('SET ROLE service_role');
    await db.query('DELETE FROM email_campaign WHERE id=$1',[c]);
    await db.query('RESET ROLE');
    // Archived drafts require the tenant-scoped lifecycle capability, even for
    // service-role callers of the legacy direct group-delete path.
    await db.query("INSERT INTO email_campaign(id,tenant_id,status) VALUES($1,$2,'draft')",[c,tenant]);
    await lifecycle('archive');
    await db.query('SET ROLE service_role');
    await assert.rejects(db.query('DELETE FROM email_campaign WHERE id=$1',[c]),/Use campaign lifecycle Delete/);
    await assert.rejects(lifecycle('delete',other),/Campaign not found/);
    assert.equal((await db.query('SELECT status,archived_at FROM email_campaign WHERE id=$1',[c])).rows[0].status,'draft');
    assert.ok((await db.query('SELECT archived_at FROM email_campaign WHERE id=$1',[c])).rows[0].archived_at);
    await lifecycle('delete');
    await db.query('RESET ROLE');
    assert.equal((await db.query('SELECT id FROM email_campaign WHERE id=$1',[c])).rowCount,0);
    // SQL summary has no REST row limit and remains tenant scoped.
    await db.query(`INSERT INTO email_campaign(id,tenant_id,status)
      SELECT gen_random_uuid(),$1,'draft' FROM generate_series(1,1100)`,[tenant]);
    await db.query("INSERT INTO email_campaign(id,tenant_id,status) VALUES($1,$2,'scheduled')",[c,other]);
    summary=(await db.query('SELECT campaign_summary($1) result',[tenant])).rows[0].result;
    assert.equal(summary.totalCampaigns,1100); assert.equal(summary.draftCount,1100);
    assert.equal(summary.scheduledCount,0); assert.equal(summary.avgOpenRate,0);
    for(const signature of ['campaign_lifecycle(uuid,uuid,text)','campaign_summary(uuid)','campaign_lifecycle_ready()',
      'campaign_test_send_begin(uuid,uuid)','campaign_test_send_end(uuid,uuid,uuid)']) {
      assert.equal(sql(`SELECT has_function_privilege('anon','${signature}','EXECUTE') OR has_function_privilege('authenticated','${signature}','EXECUTE')`),'f');
      assert.equal(sql(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')`),'t');
    }
    // Reproduce the deployed missing-index graph, isolated from all live data.
    // Global history matters even when the deleted campaign has few recipients.
    await db.query(`INSERT INTO email_campaign(id,tenant_id,status) VALUES($1,$2,'sent')`,[r,tenant]);
    await db.query(`INSERT INTO email_campaign_recipient(campaign_id,status)
      SELECT $1,'delivered' FROM generate_series(1,400)`,[r]);
    await db.query(`INSERT INTO email_event(campaign_id,raw_event)
      SELECT $1,jsonb_build_object('padding',repeat('x',800)) FROM generate_series(1,550000)`,[c]);
    await db.query(`INSERT INTO email_link_click(campaign_id)
      SELECT $1 FROM generate_series(1,265000)`,[c]);
    await db.query(`INSERT INTO email_event(campaign_id,recipient_id)
      SELECT campaign_id,id FROM email_campaign_recipient WHERE campaign_id=$1`,[r]);
    await db.query(`INSERT INTO email_link_click(campaign_id,recipient_id)
      SELECT campaign_id,id FROM email_campaign_recipient WHERE campaign_id=$1`,[r]);
    await db.query(`INSERT INTO member_inbox_message_state
      SELECT $2,id FROM email_campaign_recipient WHERE campaign_id=$1`,[r,tenant]);
    await db.query(`INSERT INTO email_unsubscribe(tenant_id,email,campaign_id) VALUES($1,'retained@example.invalid',$2)`,[tenant,r]);
    await db.query('DROP INDEX idx_email_event_recipient; DROP INDEX idx_email_link_click_recipient; ANALYZE');
    await db.query("SET statement_timeout='8s'");
    const before=performance.now();
    await assert.rejects(db.query("SELECT campaign_lifecycle($1,$2,'delete')",[r,tenant]),e=>e.code==='57014');
    console.log(`unindexed delete timed out after ${Math.round(performance.now()-before)}ms`);
    assert.equal((await db.query('SELECT count(*)::int n FROM email_campaign_recipient WHERE campaign_id=$1',[r])).rows[0].n,400);
    assert.equal((await db.query('SELECT count(*)::int n FROM member_inbox_message_state WHERE tenant_id=$1',[tenant])).rows[0].n,401);
    assert.equal((await db.query('SELECT count(*)::int n FROM email_event WHERE campaign_id=$1',[r])).rows[0].n,400);
    assert.equal((await db.query('SELECT count(*)::int n FROM email_link_click WHERE campaign_id=$1',[r])).rows[0].n,400);
    await db.query('RESET statement_timeout');
    sql(indexMigration);
    await db.query("SET statement_timeout='8s'; SET ROLE service_role");
    const after=performance.now();
    await db.query("SELECT campaign_lifecycle($1,$2,'delete')",[r,tenant]);
    console.log(`indexed delete completed after ${Math.round(performance.now()-after)}ms`);
    await db.query('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int n FROM email_campaign WHERE id=$1',[r])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM email_campaign_recipient WHERE campaign_id=$1',[r])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM member_inbox_message_state WHERE tenant_id=$1',[tenant])).rows[0].n,1);
    assert.equal((await db.query('SELECT campaign_id FROM email_unsubscribe WHERE email=$1',['retained@example.invalid'])).rows[0].campaign_id,null);
    assert.equal((await db.query('SELECT count(*)::int n FROM email_event WHERE campaign_id=$1',[c])).rows[0].n,550000);
    assert.equal((await db.query('SELECT count(*)::int n FROM email_link_click WHERE campaign_id=$1',[c])).rows[0].n,265000);
  } finally {
    await Promise.all(clients.map(db=>db.end()));
    if(started) spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop'],{encoding:'utf8'});
    await h.cleanup();
  }
});
