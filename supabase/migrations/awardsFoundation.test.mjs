import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {startAwardsPostgrest} from '../../scripts/test-support/awards-postgrest.mjs';
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const migrations = await Promise.all([
  '202701220001_awards_assessment_foundation.sql',
  '202701220002_awards_configuration_commands.sql',
  '202701220003_awards_decision_evidence.sql',
  '202701220004_assessment_session_commands.sql',
  '202701220005_assessment_revision_commands.sql',
  '202701220006_assessment_round_configuration.sql',
  '202701220007_assessment_allocation.sql',
  '202701220008_awards_intake_capture.sql',
  '202701220009_awards_application_decisions.sql',
  '202701220010_assessment_access_rate_limit.sql',
  '202701220011_assessment_dashboard.sql',
  '202701220012_awards_canonical_ownership.sql',
  '202701220013_assessment_evidence.sql',
  '202701220014_awards_programmes_and_duplication.sql',
  '202701220015_awards_identity_lookup.sql',
  '202701220016_awards_invitation_delivery.sql',
  '202701220017_assessment_shortlisting.sql',
  '202701220018_awards_outcome_commands.sql',
  '202701220019_awards_publication_commands.sql',
  '202701220020_awards_event_integration.sql',
  '202701220021_assessment_round_advancement.sql',
  '202701220022_assessment_session_logout.sql',
  '202701220023_assessment_decision_guards.sql',
  '202701220024_assessment_assignment_controls.sql',
  '202701220025_awards_applicant_status.sql',
  '202701220026_awards_review_attachments.sql',
  '202701220027_assessment_attachment_access.sql',
  '202701220028_assessment_scoring_templates.sql',
  '202701220029_assessment_lifecycle.sql',
  '202701220030_awards_certificates.sql',
  '202701220031_awards_message_configuration.sql',
  '202701220032_awards_certificate_links.sql',
  '202701220033_awards_shortlist_publication.sql',
  '202701220034_awards_shortlist_catalog.sql',
  '202701220035_awards_amendment_evidence.sql',
  '202701220036_awards_amendment_processing_guard.sql',
  '202701220037_awards_amendment_email_guard.sql',
  '202701220038_assessment_snapshot_adoption.sql',
  '202701220039_awards_amendment_intake.sql',
  '202701220040_awards_amendment_editor.sql',
  '202701220041_awards_amendment_trigger_isolation.sql',
  '202701220042_assessment_peer_visibility.sql',
  '202701220043_assessment_panel_authority.sql',
  '202701220044_assessment_panel_workflows.sql',
  '202701220045_assessment_panel_dashboard.sql',
  '202701220046_assessment_panel_policy.sql',
  '202701220047_assessment_criteria_revision.sql',
  '202701220048_assessment_evidence_authority.sql',
  '202701220049_assessment_assignment_decline.sql',
  '202701220050_awards_event_progress.sql',
  '202701220051_awards_certificate_revocation.sql',
  '202701220052_awards_automatic_messages.sql',
  '202701220053_awards_delivery_controls.sql',
  '202701220054_awards_ranking_approval_scope.sql',
  '202701220055_awards_applicant_access.sql',
  '202701220056_awards_external_withdrawal.sql',
  '202701220057_awards_external_amendments.sql',
  '202701220058_awards_applicant_certificates.sql',
  '202701220059_awards_applicant_access_controls.sql',
  '202701220060_awards_publication_event_links.sql',
  '202701220061_awards_review_reopening.sql',
  '202701220062_assessment_submitted_history.sql',
  '202701220063_awards_repeatable_file_evidence.sql',
  '202701220064_awards_attachment_chunks.sql',
  '202701220065_awards_evidence_readers.sql',
  '202701220066_awards_display_evidence.sql',
  '202701220067_awards_amendment_choice_access.sql',
  '202701220068_awards_staff_review_evidence.sql',
  '202701220069_awards_http_conflicts.sql',
  '202701220070_awards_duplicate_flags.sql',
].map(name => readFile(new URL(name, import.meta.url), 'utf8')));
test('isolated awards foundation: tenant ownership, grants, immutability and transactional commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'awards-foundation-'));
  const port = 47000 + Math.floor(Math.random()*10000);
  execFileSync('initdb',['-D',join(root,'data'),'-A','trust','-U','postgres'],{stdio:'ignore'});
  execFileSync('pg_ctl',['-D',join(root,'data'),'-o',`-F -p ${port} -k ${root}`,'-w','start'],{stdio:'ignore'});
  const db = new pg.Client({host:root,port,user:'postgres',database:'postgres'});
  await db.connect();
  t.after(async () => { await db.end(); execFileSync('pg_ctl',['-D',join(root,'data'),'-m','immediate','stop'],{stdio:'ignore'}); await rm(root,{recursive:true,force:true}); });
  await db.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
      'SELECT coalesce(nullif(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''role'',nullif(current_setting(''request.jwt.claim.role'',true),''''))';
    GRANT USAGE ON SCHEMA auth TO service_role;
    CREATE TABLE tenant(id uuid PRIMARY KEY);
    CREATE TABLE tenant_user(id uuid PRIMARY KEY,tenant_id uuid,email text);
    CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenant);
    CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid REFERENCES organization,email text);
    CREATE TABLE organization_contact(id uuid PRIMARY KEY,organization_id uuid REFERENCES organization,email text);
    CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean,name text,fields jsonb DEFAULT '[]',pages jsonb DEFAULT '[]',layout_type text,slug text);
    CREATE TABLE form_submission(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid REFERENCES form,submission_data jsonb DEFAULT '{}',payment_status text);
    CREATE TABLE form_due_diligence_initialization(form_submission_id uuid PRIMARY KEY REFERENCES form_submission);
    CREATE TABLE form_submission_due_diligence(form_submission_id uuid PRIMARY KEY REFERENCES form_submission);
    CREATE TABLE email_template(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean,subject text,body text);
    CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid);
    CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid);
    INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
    INSERT INTO organization VALUES('${id(10)}','${id(1)}'),('${id(11)}','${id(2)}');
    INSERT INTO member VALUES('${id(20)}','${id(1)}',NULL,'member@example.invalid'),('${id(21)}',NULL,'${id(11)}','foreign@example.invalid');
    INSERT INTO organization_contact VALUES('${id(30)}','${id(10)}','one@example.invalid'),('${id(31)}','${id(11)}','two@example.invalid');
    INSERT INTO form(id,tenant_id,is_active) VALUES('${id(40)}','${id(1)}',true),('${id(41)}','${id(2)}',true);
    INSERT INTO form_submission(id,tenant_id,form_id) VALUES('${id(50)}','${id(1)}','${id(40)}'),('${id(51)}','${id(2)}','${id(41)}');
    CREATE TABLE fixture_submission_actions(submission_id uuid, action text);
    CREATE FUNCTION fixture_submission_action() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN INSERT INTO fixture_submission_actions VALUES(NEW.id,TG_NAME); RETURN NEW; END $$;
    CREATE TRIGGER allocate_submission_bundle AFTER INSERT ON form_submission FOR EACH ROW EXECUTE FUNCTION fixture_submission_action();
    CREATE TRIGGER capture_form_submission_alerts AFTER INSERT ON form_submission FOR EACH ROW
      WHEN (NEW.submission_data ? 'document') EXECUTE FUNCTION fixture_submission_action();
    CREATE TRIGGER settle_submission_cart AFTER UPDATE ON form_submission FOR EACH ROW
      WHEN (OLD.payment_status IS DISTINCT FROM NEW.payment_status) EXECUTE FUNCTION fixture_submission_action();
  `);
  await db.query('ALTER TABLE form_submission ADD COLUMN submitted_by_email text');
  for (const sql of migrations) await db.query(sql);
  const changedChoices=async(fields,before,after)=>(await db.query(
    'SELECT public.awards_changed_choice_fields($1,$2,$3) changes',[JSON.stringify(fields),JSON.stringify(before),JSON.stringify(after)])).rows[0].changes;
  const linkedFields=[{id:'org',type:'organisation_dropdown'},{id:'rows',type:'repeatable_rows',children:[
    {id:'record',type:'relationship_dropdown'},{id:'notes',type:'text'}]}];
  const linkedAnswers={org:'original',rows:[{_row_id:'stable',record:'retained',notes:'original'}]};
  assert.deepEqual(await changedChoices(linkedFields,linkedAnswers,{...linkedAnswers,org:'different'}),['org']);
  assert.deepEqual(await changedChoices(linkedFields,linkedAnswers,{...linkedAnswers,rows:[{_row_id:'stable',record:'retained',notes:'edited'}]}),[]);
  assert.deepEqual(await changedChoices(linkedFields,linkedAnswers,{...linkedAnswers,rows:[{_row_id:'replacement',record:'different'}]}),['rows','rows']);
  assert.deepEqual(await changedChoices(linkedFields,linkedAnswers,{...linkedAnswers,rows:[]}),['rows']);
  assert.deepEqual(await changedChoices([{id:'org',name:'organization',type:'organisation_dropdown'}],{organization:'old'},{organization:'new'}),['org']);
  const tables = ['awards_programme','awards_competition','awards_form_binding','assessment_round','assessment_criteria_version',
    'awards_application','awards_application_version','assessment_appointment','assessment_assignment','assessment_revision','awards_audit_event',
    'assessment_invitation','assessment_session','assessment_moderation','assessment_moderation_message',
    'assessment_moderation_revision','assessment_shortlist_decision','awards_outcome_category','awards_outcome_revision',
    'awards_event_link','awards_publication_revision','awards_delivery_release','awards_delivery','awards_certificate_issue'];
  for (const table of tables) {
    const row = (await db.query(`SELECT relrowsecurity,has_table_privilege('anon',oid,'SELECT') AS anon,
      has_table_privilege('authenticated',oid,'INSERT') AS browser,
      has_table_privilege('service_role',oid,'UPDATE') AS direct_write FROM pg_class WHERE relname=$1`,[table])).rows[0];
    assert.deepEqual(row,{relrowsecurity:true,anon:false,browser:false,direct_write:false});
  }
  const command = async (name, award, version, payload, tenant=id(1)) => (await db.query(
    'select awards_configure($1,$2,$3,$4,$5,$6,$7) as result',
    [tenant,'member',id(20),name,award,version,payload])).rows[0].result;
  await assert.rejects(command('create',null,null,{name:'Award'}),/Service authority/);
  await db.query(`SET request.jwt.claims='{"role":"service_role"}'; SET ROLE service_role`);
  let a = await command('create',null,null,{name:'Research'});
  await assert.rejects(db.query('update awards_competition set name=$1 where id=$2',['Bypass',a.id]),/permission denied/);
  await assert.rejects(command('bind_form',a.id,1,{form_id:id(41)}),/another tenant/);
  a = await command('bind_form',a.id,1,{form_id:id(40)});
  await assert.rejects(command('configure',a.id,1,{name:'Stale'}),/reload/);
  await assert.rejects(command('configure',a.id,2,{name:'Wrong tenant'},id(2)),/unavailable/);
  await assert.rejects(command('transition',a.id,2,{state:'open',reason:'Ready'}),/window/);
  a = await command('configure',a.id,2,{opens_at:'2026-01-01T00:00:00Z',closes_at:'2099-01-01T00:00:00Z'});
  await assert.rejects(command('transition',a.id,3,{state:'open',reason:'Ready'}),/retention/);
  a = await command('configure',a.id,3,{retention_policy:{retention_days:365,disposal_authority:'Tenant privacy administrator',legal_hold_policy:'Pause disposal during legal holds'}});
  a = await command('transition',a.id,4,{state:'open',reason:'Approved launch'});
  assert.equal(a.state,'open'); assert.equal(a.version,5);
  await assert.rejects(command('configure',a.id,5,{name:'Change'}),/locked/);
  await assert.rejects(command('transition',a.id,5,{state:'results_approved',reason:'Skip'}),/Unsupported/);
  await db.query('RESET ROLE');
  const binding=(await db.query('select id from awards_form_binding where award_id=$1',[a.id])).rows[0].id;
  await db.query(`INSERT INTO assessment_round(id,tenant_id,award_id,name,position) VALUES($1,$2,$3,'Initial',1)`,[id(60),id(1),a.id]);
  await assert.rejects(db.query(`INSERT INTO assessment_appointment(tenant_id,round_id,contact_id) VALUES($1,$2,$3)`,[id(1),id(60),id(31)]),/another tenant/);
  await assert.rejects(db.query(`INSERT INTO assessment_appointment(tenant_id,round_id,member_id) VALUES($1,$2,$3)`,[id(1),id(60),id(21)]),/another tenant/);
  await assert.rejects(db.query(`INSERT INTO awards_application(tenant_id,award_id,binding_id,submission_id,reference) VALUES($1,$2,$3,$4,'BAD')`,[id(1),a.id,binding,id(51)]),/binding/);
  await db.query(`INSERT INTO awards_application(id,tenant_id,award_id,binding_id,submission_id,reference) VALUES($1,$2,$3,$4,$5,'AY-001')`,[id(70),id(1),a.id,binding,id(50)]);
  await db.query(`INSERT INTO awards_application_version(id,tenant_id,application_id,revision,form_snapshot,answer_snapshot) VALUES($1,$2,$3,1,'{}','{}')`,[id(80),id(1),id(70)]);
  await assert.rejects(db.query(`UPDATE awards_application_version SET answer_snapshot='{"changed":true}'`),/append-only/);
  await assert.rejects(db.query('DELETE FROM awards_audit_event'),/append-only/);
  await assert.rejects(db.query('DELETE FROM form_submission WHERE id=$1',[id(50)]),/foreign key/);
  await db.query(`INSERT INTO assessment_appointment(id,tenant_id,round_id,external_email)
    VALUES($1,$2,$3,'judge@example.invalid')`,[id(90),id(1),id(60)]);
  await db.query('SET ROLE service_role');
  const rotate = async (version, hash, revoke=false) => (await db.query(
    'SELECT assessment_rotate_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [id(1),id(90),version,'member',id(20),hash,revoke,'Test appointment change'])).rows[0].result;
  const redeem = async (hash, sessionHash, tenant=id(1)) => (await db.query(
    'SELECT assessment_redeem_invitation($1,$2,$3,$4,true) AS result',
    [tenant,hash,sessionHash,'c'.repeat(64)])).rows[0].result;
  const authority = hash => db.query('SELECT assessment_session_authority($1,$2) AS result',[id(1),hash]);
  await rotate(1,'a'.repeat(64));
  await assert.rejects(redeem('a'.repeat(64),'b'.repeat(64),id(2)),/unavailable/);
  const accepted=await redeem('a'.repeat(64),'b'.repeat(64));
  assert.equal(accepted.accepted,true);
  await authority('b'.repeat(64));
  await assert.rejects(redeem('a'.repeat(64),'d'.repeat(64)),/unavailable/);
  await rotate(3,'e'.repeat(64));
  await assert.rejects(authority('b'.repeat(64)),/unavailable/);
  await redeem('e'.repeat(64),'f'.repeat(64));
  await rotate(5,null,true);
  await assert.rejects(authority('f'.repeat(64)),/unavailable/);
  await db.query('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM assessment_session')).rows[0].n,2);
  assert.equal((await db.query(`SELECT count(*)::integer AS n FROM awards_audit_event
    WHERE changes::text LIKE '%${'a'.repeat(64)}%' OR changes::text LIKE '%${'b'.repeat(64)}%'`)).rows[0].n,0);
  await db.query(`UPDATE assessment_round SET state='judging',opens_at=now()-interval '1 hour',closes_at=now()+interval '1 day' WHERE id=$1`,[id(60)]);
  await db.query(`UPDATE awards_application SET eligibility='eligible' WHERE id=$1`,[id(70)]);
  await db.query(`INSERT INTO assessment_criteria_version(id,tenant_id,round_id,revision,definition) VALUES($1,$2,$3,1,'{}')`,[id(100),id(1),id(60)]);
  await db.query(`INSERT INTO assessment_appointment(id,tenant_id,round_id,member_id,state) VALUES($1,$2,$3,$4,'accepted')`,[id(101),id(1),id(60),id(20)]);
  await db.query(`INSERT INTO assessment_assignment(id,tenant_id,award_id,round_id,appointment_id,application_id,application_version_id,criteria_version_id,conflict)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'none')`,[id(102),id(1),a.id,id(60),id(101),id(70),id(80),id(100)]);
  await db.query('SET ROLE service_role');
  const save = async (expected, request, submit, member=id(20), answers={a:{value:4}}) => (await db.query(
    'SELECT assessment_record_revision($1,$2,$3,NULL,NULL,$4,$5,$6,$7,$8,$9,$10) AS result',
    [id(1),id(102),member,expected,id(request),submit,answers,{numerator:'80',denominator:'1'},id(100),id(80)])).rows[0].result;
  await assert.rejects(save(0,110,false,id(21)),/unavailable/);
  assert.equal((await save(0,110,false)).revision,1);
  assert.equal((await save(0,110,false)).replayed,true);
  await assert.rejects(save(0,110,false,id(20),{a:{value:3}}),/different/);
  await assert.rejects(save(0,111,true),/changed/);
  assert.equal((await save(1,111,true)).state,'submitted');
  await assert.rejects(save(2,112,false),/locked/);
  const reopened=(await db.query('SELECT assessment_reopen($1,$2,$3,$4,$5,$6) AS result',
    [id(1),id(102),2,'member',id(20),'Correct a transcription error'])).rows[0].result;
  assert.equal(reopened.revision,3);
  assert.equal((await save(3,113,true)).revision,4);
  assert.equal((await db.query(`SELECT count(*)::integer AS n FROM assessment_revision WHERE assignment_id=$1 AND state='submitted'`,[id(102)])).rows[0].n,2);
  const roundCommand = async (command, round, version, payload) => (await db.query(
    'SELECT assessment_configure_round($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [id(1),a.id,round,version,'member',id(20),command,payload])).rows[0].result;
  const nextRound=await roundCommand('create',null,null,{name:'Final panel'});
  assert.equal(nextRound.position,2);
  await assert.rejects(roundCommand('appoint',nextRound.id,1,{external_email:'member@example.invalid'}),/existing member/);
  await assert.rejects(roundCommand('appoint',nextRound.id,1,{external_email:'one@example.invalid'}),/existing organisation contact/);
  const appointed=await roundCommand('appoint',nextRound.id,1,{contact_id:id(30),role:'chair'});
  assert.equal(appointed.version,2);
  await assert.rejects(roundCommand('appoint',nextRound.id,2,{contact_id:id(30),role:'judge'}),/already has/);
  await assert.rejects(roundCommand('criteria',id(60),1,{definition:{optionalPolicy:'incomplete',criteria:[]}}),/locked/);
  const conflict=async(state,version=1)=>db.query(
    'SELECT assessment_declare_conflict($1,$2,$3,NULL,NULL,$4,$5,$6)',
    [id(1),id(102),id(20),version,state,'Discovered a collaboration']);
  await conflict('potential');
  await assert.rejects(conflict('none',2),/Administrator review/);
  await assert.rejects(db.query('SELECT assessment_confirm_allocation($1,$2,$3,$4,$5,$6)',
    [id(1),id(60),1,'member',id(20),JSON.stringify([{applicationId:id(70),appointmentId:id(101),applicationVersionId:id(80),criteriaVersionId:id(100)}])]),/duplicate key/);
  await db.query('RESET ROLE');
  await db.query(`INSERT INTO form_submission(id,tenant_id,form_id,awards_binding_id,awards_applicant_member_id,submission_data)
    VALUES($1,$2,$3,$4,$5,'{"research":"Original"}')`,[id(130),id(1),id(40),binding,id(20)]);
  await db.query(`UPDATE form_submission SET submission_data='{"research":"Later edit"}' WHERE id=$1`,[id(130)]);
  await db.query(`UPDATE awards_competition SET state='closed' WHERE id=$1`,[a.id]);
  await assert.rejects(db.query(`INSERT INTO form_submission(id,tenant_id,form_id,awards_binding_id)
    VALUES($1,$2,$3,$4)`,[id(131),id(1),id(40),binding]),/closed/);
  await db.query('SET ROLE service_role');
  const received=(await db.query('SELECT awards_finalise_intake($1,$2,$3) AS result',[id(1),id(130),binding])).rows[0].result;
  assert.equal(received.status,'received');
  const replay=(await db.query('SELECT awards_finalise_intake($1,$2,$3) AS result',[id(1),id(130),binding])).rows[0].result;
  assert.deepEqual(replay,received);
  const snapshotAnswer=(await db.query('SELECT answer_snapshot FROM awards_application_version WHERE application_id=$1',[received.id])).rows[0].answer_snapshot;
  assert.deepEqual(snapshotAnswer,{research:'Original'});
  await assert.rejects(db.query('SELECT awards_application_decide($1,$2,1,$3,$4,$5,$6,true)',
    [id(1),received.id,'member',id(21),'withdrawn','Applicant withdrawal']),/unavailable/);
  const withdrawal=(await db.query('SELECT awards_application_decide($1,$2,1,$3,$4,$5,$6,true) AS result',
    [id(1),received.id,'member',id(20),'withdrawn','Applicant withdrawal'])).rows[0].result;
  assert.equal(withdrawal.eligibility,'withdrawn');
  const dashboard=(await db.query('SELECT assessment_dashboard($1,$2,NULL,1) AS result',[id(1),id(20)])).rows[0].result;
  assert.equal(dashboard.assignments.length,1);
  assert.equal(dashboard.assignments[0].assessmentState,'submitted');
  const outsider=(await db.query('SELECT assessment_dashboard($1,$2,NULL,1) AS result',[id(1),id(21)])).rows[0].result;
  assert.equal(outsider.assignments.length,0);
  for(let i=0;i<21;i++){
    const allowed=(await db.query('SELECT assessment_consume_access_limit($1,$2) AS allowed',[id(1),'d'.repeat(64)])).rows[0].allowed;
    assert.equal(allowed,i<20);
  }
  await db.query('RESET ROLE');
  await db.query('UPDATE assessment_assignment SET conflict=$1 WHERE id=$2',['none',id(102)]);
  await db.query('UPDATE assessment_round SET required_judges=1 WHERE id=$1',[id(60)]);
  await db.query('SET ROLE service_role');
  const ev=(await db.query('SELECT assessment_evidence($1,$2,$3) AS result',[id(1),id(60),id(70)])).rows[0].result;
  const originalId=ev.assessments[0].revisionId;
  const staffEvidence=(await db.query('SELECT awards_staff_review($1,$2,$3,$4,$5,$6) result',
    [id(1),id(60),id(70),'member',id(22),id(80)])).rows[0].result;
  assert.equal(staffEvidence.id,id(80));
  await assert.rejects(db.query('SELECT awards_staff_review($1,$2,$3,$4,$5,$6)',
    [id(2),id(60),id(70),'member',id(22),id(80)]),/unavailable/);
  await assert.rejects(db.query('SELECT awards_staff_review($1,$2,$3,$4,$5,$6)',
    [id(1),id(60),id(70),'member',id(22),id(81)]),/unavailable/);
  const moderate=async(command,version,actor=id(20))=>(await db.query(
    'SELECT assessment_moderate($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$9,$10,$11) AS result',
    [id(1),id(60),id(70),'member',actor,command,version,'overall',{numerator:'90',denominator:'1'},[originalId],'Evidence-based panel decision']
  )).rows[0].result;
  const proposed=await moderate('propose',0);
  await assert.rejects(moderate('approve',proposed.version),/separate approver/);
  const approved=await moderate('approve',proposed.version,id(22));
  assert.equal(approved.state,'approved');
  const moderationReopened=await moderate('reopen',approved.version,id(22));
  assert.equal(moderationReopened.state,'reopened');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM assessment_moderation_revision WHERE moderation_id=$1',[approved.id])).rows[0].count,3);
  assert.equal((await db.query('SELECT id FROM assessment_revision WHERE assignment_id=$1 ORDER BY revision DESC LIMIT 1',[id(102)])).rows[0].id,originalId);
  await db.query('RESET ROLE');
  await assert.rejects(db.query('UPDATE member SET tenant_id=$1 WHERE id=$2',[id(2),id(20)]),/ownership/);
  await assert.rejects(db.query('UPDATE organization_contact SET organization_id=$1 WHERE id=$2',[id(11),id(30)]),/ownership/);
  await assert.rejects(db.query('UPDATE form SET tenant_id=$1 WHERE id=$2',[id(2),id(40)]),/ownership/);
  await assert.rejects(db.query('UPDATE form_submission SET form_id=$1 WHERE id=$2',[id(41),id(130)]),/ownership/);
  await assert.rejects(db.query('DELETE FROM form_submission WHERE id=$1',[id(130)]),/foreign key/);
  await db.query(`SET request.jwt.claims=''; SET request.jwt.claim.role='service_role'; SET ROLE service_role`);
  const legacy=await command('create',null,null,{name:'Legacy claims'});
  assert.equal(legacy.name,'Legacy claims');
  const programme=(await db.query('SELECT awards_programme_command($1,$2,$3,NULL,NULL,$4) AS result',
    [id(1),'member',id(20),{name:'Research programme',cycle:'2027'}])).rows[0].result;
  assert.equal(programme.name,'Research programme');
  const linked=await command('configure',legacy.id,legacy.version,{programme_id:programme.id});
  assert.equal(linked.programme_id,programme.id);
  const sourceVersion=(await db.query('SELECT version FROM awards_competition WHERE id=$1',[a.id])).rows[0].version;
  const copied=(await db.query('SELECT awards_duplicate($1,$2,$3,$4,$5,$6) AS result',
    [id(1),a.id,sourceVersion,'member',id(20),'New cycle configuration'])).rows[0].result;
  assert.equal(copied.state,'draft');assert.equal(copied.opens_at,null);assert.equal(copied.closes_at,null);
  assert.notEqual(copied.id,a.id);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM awards_application WHERE award_id=$1',[copied.id])).rows[0].count,0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM assessment_round WHERE award_id=$1',[copied.id])).rows[0].count,2);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM assessment_appointment j JOIN assessment_round r ON r.id=j.round_id WHERE r.award_id=$1',[copied.id])).rows[0].count,0);
  const contactVersion=(await db.query('SELECT version FROM assessment_appointment WHERE id=$1',[id(90)])).rows[0].version;
  const queued=(await db.query('SELECT awards_queue_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [id(1),id(90),contactVersion,'member',id(20),'8'.repeat(64),{v:1,ciphertext:'isolated encrypted fixture'},'Resend requested'])).rows[0].result;
  assert.equal(queued.state,'invited');
  const claimed=(await db.query('SELECT * FROM awards_claim_deliveries(5)')).rows[0];
  assert.equal(claimed.id,queued.delivery_id);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM awards_claim_deliveries(5)')).rows[0].count,0);
  await db.query('SELECT assessment_rotate_invitation($1,$2,$3,$4,$5,NULL,true,$6)',
    [id(1),id(90),queued.version,'member',id(20),'Revoke queued invitation']);
  assert.equal((await db.query("SELECT awards_delivery_result($1,$2,$3,'starting',NULL) AS allowed",
    [id(1),claimed.id,claimed.claim_token])).rows[0].allowed,false);
  assert.equal((await db.query("SELECT awards_delivery_result($1,$2,$3,'cancelled',NULL) AS allowed",
    [id(1),claimed.id,claimed.claim_token])).rows[0].allowed,true);
  const panelProposed=await moderate('propose',moderationReopened.version);
  await moderate('approve',panelProposed.version,id(22));
  const rankings=async()=>{
    const result=(await db.query('SELECT assessment_round_evidence($1,$2,1) AS result',[id(1),id(60)])).rows[0].result;
    return Object.fromEntries(result.entries.map(e=>[e.evidence.application.id,e.fingerprint]));
  };
  const shortlist=async(state,fingerprints)=>(await db.query('SELECT assessment_record_shortlist($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [id(1),id(60),'member',id(20),'manual',JSON.stringify([{applicationId:id(70),state,score:{numerator:'90',denominator:'1'},override:true}]),
      fingerprints,'Panel confirmed selection'])).rows[0].result;
  await assert.rejects(shortlist('confirmed',await rankings()),/Recommend before/);
  const shortlistFingerprint=await rankings();
  await shortlist('recommended',shortlistFingerprint);
  await assert.rejects(shortlist('confirmed',shortlistFingerprint),/evidence changed/);
  await shortlist('confirmed',await rankings());
  const shortlistCatalog=(await db.query('SELECT awards_shortlist_catalog($1,$2,1) AS result',[id(1),a.id])).rows[0].result;
  const publicShortlistId=shortlistCatalog.shortlists[0].id;
  await db.query("SELECT awards_publish_shortlist($1,$2,NULL,'public','publish',0,$3,'member',$4,$5)",
    [id(1),publicShortlistId,{title:'Confirmed finalist',recipient:'Approved public name',summary:'Approved shortlist text'},id(22),'Publish confirmed shortlist']);
  assert.equal((await db.query("SELECT awards_public_shortlists($1,$2,'public',NULL) AS result",[id(1),a.id])).rows[0].result.length,1);
  await assert.rejects(shortlist('reopened',await rankings()),/Retract published shortlist/);
  await db.query("SELECT awards_publish_shortlist($1,$2,NULL,'public','retract',1,'{}','member',$3,$4)",
    [id(1),publicShortlistId,id(22),'Correct shortlist publication']);
  assert.deepEqual((await db.query("SELECT awards_public_shortlists($1,$2,'public',NULL) AS result",[id(1),a.id])).rows[0].result,[]);
  const shortlistRelease=(await db.query("SELECT awards_shortlist_release($1,$2,'member',$3,$4) AS result",
    [id(1),publicShortlistId,id(22),'Authorise finalist notification'])).rows[0].result;
  assert.ok(shortlistRelease.release_id);
  const category=(await db.query('SELECT awards_category_command($1,$2,$3,$4,NULL,$5) AS result',
    [id(1),a.id,'member',id(20),{name:'Winner',certificate_enabled:true}])).rows[0].result;
  const decide=async(state,revision,actor=id(20))=>{
    const fingerprints=await rankings();
    return(await db.query('SELECT awards_record_outcome($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS result',
      [id(1),id(60),id(70),category.id,revision,state,'score','Verified ranking recommendation',false,fingerprints[id(70)],
        {numerator:'90',denominator:'1'},'member',actor,fingerprints])).rows[0].result;
  };
  await assert.rejects(decide('approved',0),/Invalid outcome/);
  await decide('provisional',0);
  await decide('recommended',1);
  await assert.rejects(decide('approved',2),/separate outcome approver/);
  const approvedOutcome=await decide('approved',2,id(22));
  assert.ok(approvedOutcome.ranking_sources[id(70)]);
  await db.query('RESET ROLE; BEGIN');
  assert.equal((await db.query('SELECT awards_outcome_is_current($1,$2) AS valid',[id(1),approvedOutcome.id])).rows[0].valid,true);
  // A newly admitted candidate changes score-selection authority, even when
  // the previously selected application's own assessment has not changed.
  await db.query("INSERT INTO form_submission(id,tenant_id,form_id,submission_data) SELECT $1,tenant_id,form_id,'{}' FROM form_submission WHERE id=(SELECT submission_id FROM awards_application WHERE id=$2)",
    [id(191),id(70)]);
  await db.query("INSERT INTO awards_application SELECT (jsonb_populate_record(NULL::awards_application,to_jsonb(original)||$1::jsonb)).* FROM awards_application original WHERE id=$2",
    [JSON.stringify({id:id(190),submission_id:id(191),reference:'AW-RANKING-FIXTURE',eligibility:'pending'}),id(70)]);
  assert.equal((await db.query('SELECT awards_outcome_is_current($1,$2) AS valid',[id(1),approvedOutcome.id])).rows[0].valid,false);
  await db.query('ROLLBACK; SET ROLE service_role');
  const {PDFDocument}=await import('pdf-lib');
  const {renderCpdCertificatePdf}=await import('../../api/_lib/cpdCertificatePdf.js');
  const {createHash:certificateHash}=await import('node:crypto');
  const sourcePdf=await PDFDocument.create();sourcePdf.addPage([600,400]);
  const sourceBytes=Buffer.from(await sourcePdf.save());
  const placeholders=[{placeholder_key:'award.name',page_number:1,x:20,y:20,width:400,height:50,font_size:18,field_type:'text'}];
  const certificateTemplate=(await db.query('SELECT awards_save_certificate_template($1,NULL,0,$2,$3,$4,$5,$6) AS result',
    [id(1),'Award certificate',sourceBytes.toString('hex'),JSON.stringify(placeholders),'member',id(22)])).rows[0].result;
  const issuedBytes=await renderCpdCertificatePdf(sourceBytes,placeholders,{'award.name':'Approved award'});
  const issue=async()=>(await db.query('SELECT awards_issue_certificate($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
    [id(1),approvedOutcome.id,certificateTemplate.id,{name:'Approved recipient'},issuedBytes.toString('hex'),
      certificateHash('sha256').update(issuedBytes).digest('hex'),'member',id(22),'Approved generation'])).rows[0].result;
  const issuedCertificate=await issue();
  assert.equal((await issue()).id,issuedCertificate.id);
  await assert.rejects(db.query('SELECT awards_read_certificate($1,$2,$3,NULL)',[id(1),issuedCertificate.id,id(20)]),/not released/);
  const recipientRelease=(await db.query('SELECT awards_release_outcome($1,$2,$3,$4,$5) AS result',
    [id(1),approvedOutcome.id,'member',id(22),'Authorised recipient release'])).rows[0].result;
  await db.query("SELECT awards_certificate_link($1,$2,$3,now()+interval '7 days','member',$4,false)",
    [id(1),issuedCertificate.id,'fa'.repeat(32),id(22)]);
  const downloadedCertificate=(await db.query('SELECT awards_read_certificate($1,$2,NULL,$3) AS result',
    [id(1),issuedCertificate.id,'fa'.repeat(32)])).rows[0].result;
  assert.equal(downloadedCertificate.hex,issuedBytes.toString('hex'));
  const certificateLinks=(await db.query('SELECT awards_certificate_links($1,$2,1) AS result',[id(1),issuedCertificate.id])).rows[0].result;
  assert.equal(certificateLinks.total,1);
  assert.equal(certificateLinks.links[0].token_hash,undefined);
  await db.query("SELECT awards_certificate_link($1,$2,$3,now()+interval '7 days','member',$4,false)",
    [id(1),issuedCertificate.id,'fb'.repeat(32),id(22)]);
  const revokeLinks=(version)=>db.query('SELECT awards_revoke_certificate_links($1,$2,$3,$4,$5,$6) AS result',
    [id(1),issuedCertificate.id,version,'member',id(22),'Replace compromised external links']);
  await assert.rejects(revokeLinks(certificateLinks.version),/links changed/);
  const currentLinks=(await db.query('SELECT awards_certificate_links($1,$2,1) AS result',[id(1),issuedCertificate.id])).rows[0].result;
  assert.equal((await revokeLinks(currentLinks.version)).rows[0].result.revokedCount,2);
  await assert.rejects(db.query('SELECT awards_certificate_links($1,$2,1)',[id(2),issuedCertificate.id]),/unavailable/);
  assert.equal((await db.query('SELECT count(*)::integer n FROM awards_certificate_issue WHERE id=$1',[issuedCertificate.id])).rows[0].n,1);
  await db.query("SELECT awards_certificate_link($1,$2,NULL,NULL,'member',$3,true)",[id(1),issuedCertificate.id,id(22)]);
  await assert.rejects(db.query('SELECT awards_read_certificate($1,$2,NULL,$3)',[id(1),issuedCertificate.id,'fa'.repeat(32)]),/link unavailable/);
  const messageContext={application_id:id(70),outcome_id:approvedOutcome.id};
  const scheduledMessage=(await db.query("SELECT awards_queue_message($1,$2,'winner',$3,$4,now()-interval '1 second',$5,'member',$6,$7) AS result",
    [id(1),a.id,messageContext,recipientRelease.release_id,id(160),id(22),'Schedule released outcome'])).rows[0].result;
  await db.query("SELECT awards_configure_message($1,$2,'winner',NULL,false,0,'member',$3)",[id(1),a.id,id(22)]);
  const messageClaim=(await db.query('SELECT * FROM awards_claim_messages(5)')).rows.find(row=>row.id===scheduledMessage.id);
  assert.ok(messageClaim);
  assert.equal((await db.query("SELECT awards_delivery_result($1,$2,$3,'starting',NULL) AS result",
    [id(1),messageClaim.id,messageClaim.claim_token])).rows[0].result,false);
  await db.query("SELECT awards_delivery_result($1,$2,$3,'cancelled',NULL)",[id(1),messageClaim.id,messageClaim.claim_token]);
  const publicOutcomes=async()=> (await db.query("SELECT awards_public_outcomes($1,$2,'public',NULL) AS result",[id(1),a.id])).rows[0].result;
  assert.deepEqual(await publicOutcomes(),[]);
  const publish=async(action,version)=>(await db.query('SELECT awards_publish_outcome($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9) AS result',
    [id(1),approvedOutcome.id,'public',action,version,{title:'Approved research award',recipient:'Authorised display name',summary:'Public summary'},
      'Publication approved','member',id(22)])).rows[0].result;
  await publish('publish',0);
  assert.deepEqual(await publicOutcomes(),[{title:'Approved research award',recipient:'Authorised display name',summary:'Public summary',category:'Winner'}]);
  await assert.rejects(decide('reopened',3),/Retract published/);
  await publish('retract',1);
  assert.deepEqual(await publicOutcomes(),[]);
  await decide('reopened',3);
  await db.query('RESET ROLE');
  await db.query('INSERT INTO event(id,tenant_id) VALUES($1,$2)',[id(140),id(1)]);
  await db.query('SET ROLE service_role');
  const eventLink=(await db.query('SELECT awards_event_command($1,$2,$3,NULL,NULL,$4) AS result',
    [id(1),'member',id(20),{award_id:a.id,event_id:id(140),show_information:true,audience:'member'}])).rows[0].result;
  assert.deepEqual((await db.query("SELECT awards_event_projection($1,$2,false,'public') AS result",[id(1),id(140)])).rows[0].result,[]);
  const eventProjection=(await db.query("SELECT awards_event_projection($1,$2,false,'member') AS result",[id(1),id(140)])).rows[0].result;
  assert.equal(eventProjection[0].awardId,a.id);
  assert.deepEqual(eventProjection[0].outcomes,[]);
  await db.query('RESET ROLE');
  await assert.rejects(db.query('UPDATE event SET tenant_id=$1 WHERE id=$2',[id(2),id(140)]),/ownership/);
  await db.query('SET ROLE service_role');
  const laterRound=(await db.query('SELECT id FROM assessment_round WHERE award_id=$1 AND position=2',[a.id])).rows[0].id;
  const confirmedShortlist=(await db.query("SELECT id FROM assessment_shortlist_decision WHERE application_id=$1 AND state='confirmed' ORDER BY revision DESC LIMIT 1",[id(70)])).rows[0].id;
  const selections=JSON.stringify([{applicationId:id(70),shortlistDecisionId:confirmedShortlist}]);
  const advance=async()=>(await db.query('SELECT assessment_advance_round($1,$2,$3,$4,$5,$6,$7) AS result',
    [id(1),id(60),laterRound,selections,'member',id(20),'Advance confirmed shortlist'])).rows[0].result;
  const advanced=await advance();
  assert.deepEqual(await advance(),advanced);
  const laterEvidence=(await db.query('SELECT assessment_round_evidence($1,$2,1) AS result',[id(1),laterRound])).rows[0].result;
  assert.equal(laterEvidence.total,1);
  assert.equal(laterEvidence.entries[0].evidence.application.id,id(70));
  const logoutAppointment=(await db.query('SELECT version FROM assessment_appointment WHERE id=$1',[id(90)])).rows[0];
  await rotate(logoutAppointment.version,'f3'.repeat(32));
  await redeem('f3'.repeat(32),'f1'.repeat(32));
  await assert.rejects(db.query('SELECT assessment_session_logout($1,$2,$3)',[id(2),'f1'.repeat(32),'c'.repeat(64)]),/verification/);
  await db.query('SELECT assessment_session_logout($1,$2,$3)',[id(1),'f1'.repeat(32),'c'.repeat(64)]);
  await assert.rejects(authority('f1'.repeat(32)),/unavailable/);
  const control=async(command,version,actor=id(22))=>(await db.query(
    'SELECT assessment_assignment_command($1,$2,$3,$4,$5,$6,$7) AS result',
    [id(1),id(102),version,command,'member',actor,'Documented assignment review'])).rows[0].result;
  const controlled=(await db.query('SELECT s.version,j.member_id FROM assessment_assignment s JOIN assessment_appointment j ON j.id=s.appointment_id WHERE s.id=$1',[id(102)])).rows[0];
  await assert.rejects(control('exclude',controlled.version),/downstream/);
  await shortlist('reopened',await rankings());
  const moderationVersion=(await db.query('SELECT version FROM assessment_moderation WHERE round_id=$1 AND application_id=$2',[id(60),id(70)])).rows[0].version;
  await moderate('reopen',moderationVersion);
  const revisionCount=(await db.query('SELECT count(*)::int AS n FROM assessment_revision WHERE assignment_id=$1',[id(102)])).rows[0].n;
  const excluded=await control('exclude',controlled.version);
  assert.equal(excluded.included,false);
  await assert.rejects(control('include',controlled.version),/changed/);
  const included=await control('include',excluded.version);
  const conflicted=await control('confirm_conflict',included.version);
  await assert.rejects(control('clear_conflict',conflicted.version,controlled.member_id),/different administrator/);
  const cleared=await control('clear_conflict',conflicted.version);
  assert.equal(cleared.state,'recused');
  const restored=await control('restore',cleared.version);
  assert.equal(restored.included,false);
  await control('include',restored.version);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM assessment_revision WHERE assignment_id=$1',[id(102)])).rows[0].n,revisionCount);
  const applicantStatus=(await db.query('SELECT awards_applicant_status($1,$2,NULL,1) AS result',[id(1),id(20)])).rows[0].result;
  assert.equal(applicantStatus.total,1);
  assert.equal(applicantStatus.applications[0].outcome,null);
  assert.equal(JSON.stringify(applicantStatus).includes('score'),false);
  assert.equal((await db.query('SELECT awards_applicant_status($1,$2,NULL,1) AS result',[id(2),id(20)])).rows[0].result.total,0);
  await db.query('RESET ROLE');
  await db.query("UPDATE awards_competition SET state='open',opens_at=now()-interval '1 day',closes_at=now()+interval '1 day' WHERE id=$1",[a.id]);
  await db.query("INSERT INTO form(id,tenant_id,is_active,fields) VALUES($1,$2,true,$3)",
    [id(151),id(1),JSON.stringify([{id:'document',type:'file',label:'Supporting document'}])]);
  await db.query('UPDATE awards_form_binding SET active=false WHERE award_id=$1',[a.id]);
  await db.query("INSERT INTO awards_form_binding(id,tenant_id,award_id,form_id,review_field_ids) VALUES($1,$2,$3,$4,ARRAY['document'])",
    [id(152),id(1),a.id,id(151)]);
  const sourcePath=`${id(1)}/form-submissions/${id(153)}/original.pdf`;
  await db.query('INSERT INTO form_submission(id,tenant_id,form_id,awards_binding_id,submission_data) VALUES($1,$2,$3,$4,$5)',
    [id(153),id(1),id(151),id(152),{document:{bucket:'private-uploads',path:sourcePath,name:'Original.pdf'}}]);
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT awards_finalise_intake($1,$2,$3)',[id(1),id(153),id(152)]),/attachments have not been retained/);
  const {createHash}=await import('node:crypto');
  const retainedBytes=Buffer.from('%PDF-fixture-retained');
  const file=(await db.query('SELECT awards_capture_attachment($1,$2,$3,$4,$5,$6,$7) AS result',
    [id(1),id(153),'document',sourcePath,'Original.pdf',retainedBytes.toString('hex'),createHash('sha256').update(retainedBytes).digest('hex')])).rows[0].result;
  const fileApplication=(await db.query('SELECT awards_finalise_intake($1,$2,$3) AS result',[id(1),id(153),id(152)])).rows[0].result;
  await db.query('SELECT awards_application_decide($1,$2,1,$3,$4,$5,$6,false)',[id(1),fileApplication.id,'member',id(22),'eligible','File evidence approved']);
  await db.query('RESET ROLE');
  const fileVersion=(await db.query('SELECT id FROM awards_application_version WHERE application_id=$1',[fileApplication.id])).rows[0].id;
  await db.query("INSERT INTO assessment_assignment(id,tenant_id,award_id,round_id,appointment_id,application_id,application_version_id,criteria_version_id,conflict) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'none')",
    [id(154),id(1),a.id,id(60),id(101),fileApplication.id,fileVersion,id(100)]);
  await db.query('SET ROLE service_role');
  const fileRead=(await db.query('SELECT assessment_read_attachment($1,$2,$3,$4,NULL) AS result',[id(1),id(154),file.id,id(20)])).rows[0].result;
  assert.equal(Buffer.from(fileRead.hex,'hex').toString(),retainedBytes.toString());
  await assert.rejects(db.query('SELECT assessment_read_attachment($1,$2,$3,$4,NULL)',[id(1),id(102),file.id,id(20)]),/unavailable/);
  await assert.rejects(db.query('SELECT assessment_read_attachment($1,$2,$3,$4,NULL)',[id(1),id(154),file.id,id(22)]),/unavailable/);
  await assert.rejects(db.query('UPDATE awards_review_attachment SET name=$1 WHERE id=$2',['Changed',file.id]),/permission denied/);
  const templateDefinition=(await db.query('SELECT definition FROM assessment_criteria_version WHERE id=$1',[id(100)])).rows[0].definition;
  const template=(await db.query('SELECT assessment_save_template($1,NULL,0,$2,$3,$4,$5) AS result',
    [id(1),'Reusable panel criteria',templateDefinition,'member',id(22)])).rows[0].result;
  assert.equal((await db.query('SELECT assessment_list_templates($1,1) AS result',[id(1)])).rows[0].result.templates[0].id,template.id);
  assert.equal((await db.query('SELECT assessment_list_templates($1,1) AS result',[id(2)])).rows[0].result.total,0);
  await assert.rejects(db.query('SELECT assessment_save_template($1,$2,0,$3,$4,$5,$6)',
    [id(1),template.series_id,'Stale replacement',templateDefinition,'member',id(22)]),/changed/);
  const roundVersion=(await db.query('SELECT version FROM assessment_round WHERE id=$1',[id(60)])).rows[0].version;
  await assert.rejects(db.query("SELECT assessment_round_transition($1,$2,$3,'closed',NULL,'member',$4,$5)",
    [id(1),id(60),roundVersion,id(22),'Close before evidence complete']),/missing/);
  const extended=(await db.query("SELECT assessment_round_transition($1,$2,$3,'judging',now()+interval '3 days','member',$4,$5) AS result",
    [id(1),id(60),roundVersion,id(22),'Extend judging window'])).rows[0].result;
  assert.equal(extended.version,Number(roundVersion)+1);
  await db.query('RESET ROLE');
  await db.query(`ALTER TABLE form_submission ADD COLUMN survey_version_id uuid;
    CREATE TABLE survey_version(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,fields jsonb,pages jsonb,visibility_rules jsonb,survey_settings jsonb)`);
  await db.query("INSERT INTO survey_version VALUES($1,$2,$3,$4,'[]','[]','{}')",
    [id(155),id(1),id(151),JSON.stringify([{id:'document',type:'text',label:'Original published question'}])]);
  await db.query('INSERT INTO form_submission(id,tenant_id,form_id,awards_binding_id,submission_data,survey_version_id) VALUES($1,$2,$3,$4,$5,$6)',
    [id(156),id(1),id(151),id(152),{document:'Original published answer'},id(155)]);
  await db.query('SET ROLE service_role');
  const surveyCaptured=(await db.query('SELECT form_snapshot FROM awards_intake_capture WHERE submission_id=$1',[id(156)])).rows[0].form_snapshot;
  assert.equal(surveyCaptured.fields[0].label,'Original published question');
  assert.equal(surveyCaptured.survey_version_id,id(155));
  await db.query('RESET ROLE');
  await db.query('UPDATE awards_competition SET amendments_enabled=true WHERE id=$1',[a.id]);
  await db.query('INSERT INTO form_submission(id,tenant_id,form_id,awards_binding_id,awards_applicant_member_id,submission_data,survey_version_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id(160),id(1),id(151),id(152),id(20),{document:'Original'},id(155)]);
  await db.query('SET ROLE service_role');
  const amendmentApplication=(await db.query('SELECT awards_finalise_intake($1,$2,$3) AS result',[id(1),id(160),id(152)])).rows[0].result;
  assert.equal((await db.query('SELECT duplicate_flag FROM awards_application WHERE id=$1',[amendmentApplication.id])).rows[0].duplicate_flag,true);
  assert.equal((await db.query('SELECT duplicate_flag FROM awards_application WHERE id=$1',[received.id])).rows[0].duplicate_flag,true);
  assert.equal((await db.query('SELECT eligibility FROM awards_application WHERE id=$1',[amendmentApplication.id])).rows[0].eligibility,'pending');
  await db.query(`RESET ROLE; BEGIN;
    ALTER TABLE form ADD COLUMN IF NOT EXISTS form_type text;
    ALTER TABLE form ADD COLUMN IF NOT EXISTS survey_settings jsonb;
    ALTER TABLE survey_version ADD COLUMN IF NOT EXISTS version_number integer DEFAULT 1;`);
  await db.query(`UPDATE form SET form_type='survey',survey_settings='{"status":"published","current_version":1}' WHERE id=$1`,[id(151)]);
  await db.query('SET ROLE service_role');
  const surveyEditor=(await db.query('SELECT awards_amendment_editor($1,$2,$3) result',[id(1),id(20),amendmentApplication.id])).rows[0].result;
  assert.equal(surveyEditor.form.fields[0].label,'Original published question','The amendment editor must not expose unpublished draft questions');
  await db.query('ROLLBACK; SET ROLE service_role');
  await db.query('RESET ROLE');
  await db.query('INSERT INTO form_submission(id,tenant_id,form_id,awards_binding_id,awards_applicant_member_id,submission_data,survey_version_id,awards_amendment_application_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id(161),id(1),id(151),id(152),id(20),{document:'Revised'},id(155),amendmentApplication.id]);
  await db.query('SET ROLE service_role');
  const amend=member=>db.query('SELECT awards_record_amendment($1,$2,$3,$4,1,$5) AS result',
    [id(1),member,amendmentApplication.id,id(161),'Correct supporting evidence']);
  await assert.rejects(amend(id(21)),/unavailable/);
  const amended=(await amend(id(20))).rows[0].result;
  assert.equal(amended.replayed,false);
  assert.equal((await amend(id(20))).rows[0].result.replayed,true);
  await assert.rejects(db.query('SELECT awards_finalise_intake($1,$2,$3)',[id(1),id(161),id(152)]),/amendment finalisation/);
  const versions=(await db.query('SELECT answer_snapshot FROM awards_application_version WHERE application_id=$1 ORDER BY revision',[amendmentApplication.id])).rows;
  assert.deepEqual(versions.map(v=>v.answer_snapshot),[{document:'Original'},{document:'Revised'}]);
  assert.equal((await db.query('SELECT submission_id FROM awards_application WHERE id=$1',[amendmentApplication.id])).rows[0].submission_id,id(160));
  await assert.rejects(db.query('INSERT INTO form_due_diligence_initialization VALUES($1)',[id(161)]),/review evidence only/);
  await assert.rejects(db.query('INSERT INTO form_submission_due_diligence VALUES($1)',[id(161)]),/review evidence only/);
  await db.query('INSERT INTO form_due_diligence_initialization VALUES($1)',[id(160)]);
  await db.query('RESET ROLE');
  await db.query('ALTER TABLE form_submission ADD COLUMN submission_email_state jsonb');
  await assert.rejects(db.query("UPDATE form_submission SET submission_email_state='{\"status\":\"processing\"}' WHERE id=$1",[id(161)]),/cannot repeat original/);
  await db.query("UPDATE form_submission SET submission_email_state='{\"status\":\"processing\"}' WHERE id=$1",[id(160)]);
  const oldAssignment=(await db.query('SELECT * FROM assessment_assignment WHERE id=$1',[id(102)])).rows[0];
  const newSnapshot=id(162);
  await db.query("INSERT INTO awards_application_version(id,tenant_id,application_id,revision,form_snapshot,answer_snapshot) VALUES($1,$2,$3,2,'{}','{\"research\":\"Revised evidence\"}')",
    [newSnapshot,id(1),id(70)]);
  const adoptionExpected=(await db.query('SELECT jsonb_object_agg(id::text,version) AS versions FROM assessment_assignment WHERE round_id=$1 AND application_id=$2',[id(60),id(70)])).rows[0].versions;
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query("SELECT assessment_adopt_snapshot($1,$2,$3,$4,'{}','member',$5,$6)",
    [id(1),id(60),id(70),newSnapshot,id(22),'Adopt revised evidence']),/Assignments changed/);
  const adopted=(await db.query("SELECT assessment_adopt_snapshot($1,$2,$3,$4,$5,'member',$6,$7) AS result",
    [id(1),id(60),id(70),newSnapshot,adoptionExpected,id(22),'Adopt revised evidence'])).rows[0].result;
  assert.ok(adopted.changed>0);
  const adoptionHistory=(await db.query('SELECT state,application_version_id FROM assessment_revision WHERE assignment_id=$1 ORDER BY revision',[id(102)])).rows;
  assert.equal(adoptionHistory.at(-1).state,'reopened');
  assert.equal(adoptionHistory.at(-1).application_version_id,newSnapshot);
  assert.ok(adoptionHistory.slice(0,-1).every(row=>row.application_version_id===oldAssignment.application_version_id));
  await db.query('RESET ROLE');
  await db.query("UPDATE form SET fields='[{\"id\":\"document\",\"type\":\"text\"}]' WHERE id=$1",[id(151)]);
  await db.query('SET ROLE service_role');
  const prepare=()=>db.query('SELECT awards_prepare_amendment($1,$2,$3,$4,2,$5) AS result',
    [id(1),id(20),amendmentApplication.id,id(163),{document:'Second revision'}]);
  assert.equal((await prepare()).rows[0].result.replayed,false);
  assert.equal((await prepare()).rows[0].result.replayed,true);
  const staged=(await db.query('SELECT payment_status,submission_email_state FROM form_submission WHERE id=$1',[id(163)])).rows[0];
  assert.equal(staged.payment_status,null);
  assert.equal(staged.submission_email_state.status,'suppressed');
  await assert.rejects(db.query('SELECT awards_prepare_amendment($1,$2,$3,$4,2,$5)',
    [id(1),id(20),amendmentApplication.id,id(163),{document:'Changed retry'}]),/already used/);
  assert.equal((await db.query('SELECT awards_amendment_editor($1,$2,$3) AS result',[id(1),id(20),amendmentApplication.id])).rows[0].result.version,2);
  await assert.rejects(db.query('SELECT awards_amendment_editor($1,$2,$3)',[id(2),id(20),amendmentApplication.id]),/unavailable/);
  await db.query('RESET ROLE');
  await db.query("UPDATE form SET fields='[{\"id\":\"document\",\"type\":\"file\"}]' WHERE id=$1",[id(151)]);
  await db.query('UPDATE awards_application SET member_id=$1 WHERE id=$2',[id(20),fileApplication.id]);
  await db.query('SET ROLE service_role');
  const originalFileAnswers=(await db.query('SELECT answer_snapshot FROM awards_application_version WHERE application_id=$1',[fileApplication.id])).rows[0].answer_snapshot;
  const fileAppVersion=(await db.query('SELECT version FROM awards_application WHERE id=$1',[fileApplication.id])).rows[0].version;
  await db.query('SELECT awards_prepare_amendment($1,$2,$3,$4,$5,$6)',[id(1),id(20),fileApplication.id,id(164),fileAppVersion,originalFileAnswers]);
  assert.equal((await db.query('SELECT awards_copy_amendment_files($1,$2,$3,$4) AS copied',
    [id(1),fileApplication.id,id(164),'document'])).rows[0].copied,true);
  await db.query('SELECT awards_record_amendment($1,$2,$3,$4,$5,$6)',[id(1),id(20),fileApplication.id,id(164),fileAppVersion,'Retain document unchanged']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM awards_review_attachment WHERE submission_id=$1',[id(164)])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM fixture_submission_actions WHERE submission_id=ANY($1::uuid[])',
    [[id(161),id(163),id(164)]])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM fixture_submission_actions WHERE submission_id=$1',[id(160)])).rows[0].n,2);
  await db.query('RESET ROLE');
  await db.query("INSERT INTO assessment_appointment(id,tenant_id,round_id,external_email,state) VALUES($1,$2,$3,'peer@example.invalid','accepted')",[id(165),id(1),id(60)]);
  await db.query("INSERT INTO assessment_assignment(id,tenant_id,award_id,round_id,appointment_id,application_id,application_version_id,criteria_version_id,conflict) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'none')",
    [id(166),id(1),a.id,id(60),id(165),id(70),newSnapshot,oldAssignment.criteria_version_id]);
  await db.query("INSERT INTO assessment_revision(tenant_id,assignment_id,revision,state,answers) VALUES($1,$2,1,'draft',$3)",
    [id(1),id(166),{quality:{value:4,comment:'PRIVATE DRAFT'}}]);
  await db.query("UPDATE assessment_round SET visibility='open',comments_visible=false WHERE id=$1",[id(60)]);
  await db.query('SET ROLE service_role');
  const peerView=()=>db.query('SELECT assessment_peer_view($1,$2,$3,NULL,1) AS result',[id(1),id(102),id(20)]);
  assert.equal((await peerView()).rows[0].result.total,0);
  await db.query('RESET ROLE');
  await db.query("INSERT INTO assessment_revision(tenant_id,assignment_id,revision,state,answers,exact_score,submitted_at) VALUES($1,$2,2,'submitted',$3,$4,now())",
    [id(1),id(166),{quality:{value:4,comment:'WITHHELD COMMENT'}},{numerator:'80',denominator:'1'}]);
  await db.query('SET ROLE service_role');
  const peers=(await peerView()).rows[0].result;
  assert.equal(peers.total,1);
  assert.equal(JSON.stringify(peers).includes('WITHHELD'),false);
  assert.equal(JSON.stringify(peers).includes('peer@example'),false);
  await db.query('RESET ROLE');
  await db.query("UPDATE assessment_round SET visibility='after_submit' WHERE id=$1",[id(60)]);
  await db.query('SET ROLE service_role');
  assert.equal((await peerView()).rows[0].result.available,false);
  await assert.rejects(db.query('SELECT assessment_peer_view($1,$2,$3,NULL,1)',[id(2),id(102),id(20)]),/unavailable/);
  await db.query('RESET ROLE');
  await db.query("INSERT INTO member(id,tenant_id,email) VALUES($1,$3,'chair@example.invalid'),($2,$3,'approver@example.invalid')",[id(167),id(168),id(1)]);
  await db.query("INSERT INTO assessment_appointment(id,tenant_id,round_id,member_id,role,state) VALUES($1,$3,$4,$5,'chair','accepted'),($2,$3,$4,$6,'approver','accepted')",
    [id(169),id(170),id(1),id(60),id(167),id(168)]);
  await db.query("INSERT INTO assessment_revision(tenant_id,assignment_id,revision,state,answers,exact_score,submitted_at) SELECT $1,$2,max(revision)+1,'submitted',$3,$4,now() FROM assessment_revision WHERE assignment_id=$2",
    [id(1),id(102),{quality:{value:4,comment:'Independent completed evidence'}},{numerator:'80',denominator:'1'}]);
  await db.query('SET ROLE service_role');
  const panel=(person)=>db.query('SELECT assessment_panel_evidence($1,$2,$3,$4,NULL,1) AS result',[id(1),id(60),id(70),person]);
  await assert.rejects(panel(id(167)),/Declare or resolve/);
  for(const person of [id(167),id(168)]){
    await db.query("SELECT assessment_panel_conflict_command($1,$2,$3,$4,NULL,NULL,0,'none',$5)",
      [id(1),id(60),id(70),person,'No conflict declared']);
  }
  const chairView=(await panel(id(167))).rows[0].result;
  assert.equal(chairView.capabilities.propose,true);assert.equal(chairView.capabilities.approve,false);
  assert.equal(JSON.stringify(chairView).includes('PRIVATE DRAFT'),false);
  const sources=chairView.evidence.assessments.filter(row=>row.state==='submitted'&&row.included&&!row.recused).map(row=>row.revisionId);
  const proposePanel=(person,command,version)=>db.query('SELECT assessment_panel_moderate($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8,$9,$10,$11,$12) AS result',
    [id(1),id(60),id(70),person,command,version,'overall',{}, {numerator:'82',denominator:'1'}, {numerator:'80',denominator:'1'},sources,'Panel reasoning']);
  const panelProposal=(await proposePanel(id(167),'propose',chairView.evidence.moderation.version)).rows[0].result;
  await assert.rejects(proposePanel(id(167),'approve',panelProposal.version),/not permitted/);
  await assert.rejects(db.query('SELECT assessment_moderate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [id(1),id(60),id(70),'member',id(167),'approve',panelProposal.version,'overall',{},
      {numerator:'82',denominator:'1'},{numerator:'80',denominator:'1'},sources,'Cannot approve through another identity']),/separate approver/);
  assert.equal((await proposePanel(id(168),'approve',panelProposal.version)).rows[0].result.state,'approved');
  await db.query("SELECT assessment_panel_conflict_command($1,$2,$3,$4,NULL,NULL,1,'potential',$5)",
    [id(1),id(60),id(70),id(167),'Potential relationship identified']);
  await assert.rejects(panel(id(167)),/Declare or resolve/);
  await assert.rejects(db.query("SELECT assessment_panel_conflict_command($1,$2,$3,$4,NULL,NULL,2,'none',$5)",
    [id(1),id(60),id(70),id(167),'Attempt self-clear']),/Administrator review/);
  assert.equal((await db.query('SELECT assessment_evidence($1,$2,$3) AS result',[id(1),id(60),id(70)])).rows[0].result.moderation.authorityValid,false);
  await db.query('RESET ROLE');
  await db.query("UPDATE assessment_appointment SET state='revoked' WHERE id=$1",[id(165)]);
  await db.query('SET ROLE service_role');
  const historicalScores=(await db.query('SELECT assessment_evidence($1,$2,$3) AS result',[id(1),id(60),id(70)])).rows[0].result;
  assert.equal(historicalScores.assessments.find(row=>row.assignmentId===id(166)).recused,false);
  const reopenedPanel=(await proposePanel(id(168),'reopen',historicalScores.moderation.version)).rows[0].result;
  assert.equal(reopenedPanel.state,'reopened');
  const roundBefore=(await db.query('SELECT version FROM assessment_round WHERE id=$1',[id(60)])).rows[0];
  const assignmentCount=(await db.query('SELECT count(*)::integer n FROM assessment_assignment WHERE round_id=$1',[id(60)])).rows[0].n;
  const rubric=(await db.query('SELECT definition FROM assessment_criteria_version WHERE id=$1',[id(100)])).rows[0].definition;
  const revisionBefore=(await db.query('SELECT count(*)::integer n FROM assessment_revision WHERE assignment_id=$1',[id(102)])).rows[0].n;
  const reviseCriteria=(version)=>db.query('SELECT assessment_revise_criteria($1,$2,$3,$4,now()+interval \'5 days\',$5,$6,$7) AS result',
    [id(1),id(60),version,rubric,'member',id(22),'Authorised rubric correction']);
  const corrected=(await reviseCriteria(Number(roundBefore.version))).rows[0].result;
  assert.equal(corrected.affectedAssignments,assignmentCount);
  assert.notEqual(corrected.criteriaVersionId,id(100));
  await assert.rejects(reviseCriteria(Number(roundBefore.version)),/Round changed/);
  const retained=(await db.query('SELECT * FROM assessment_revision WHERE assignment_id=$1 ORDER BY revision DESC',[id(102)])).rows;
  assert.equal(retained.length,revisionBefore+1);
  assert.equal(retained[0].state,'reopened');
  assert.equal(retained[0].criteria_version_id,corrected.criteriaVersionId);
  assert.deepEqual(retained[0].answers,{});
  assert.equal(retained[1].state,'submitted');
  const declineVersion=Number((await db.query('SELECT version FROM assessment_assignment WHERE id=$1',[id(102)])).rows[0].version);
  const decline=(member,version)=>db.query('SELECT assessment_decline_assignment($1,$2,$3,NULL,NULL,$4,$5) AS result',
    [id(1),id(102),member,version,'Unable to complete the revised rubric']);
  await assert.rejects(decline(id(168),declineVersion),/Assignment unavailable/);
  assert.equal((await decline(id(20),declineVersion)).rows[0].result.state,'declined');
  await assert.rejects(decline(id(20),declineVersion),/Assignment changed/);
  assert.equal((await db.query('SELECT count(*)::integer n FROM assessment_revision WHERE assignment_id=$1',[id(102)])).rows[0].n,retained.length);
  const progress=(await db.query('SELECT awards_event_progress($1,$2,1) AS result',[id(1),eventLink.id])).rows[0].result;
  assert.equal(progress.total,1);
  assert.equal(progress.awards.length,1);
  assert.equal(typeof progress.awards[0].applications.total,'number');
  assert.equal(typeof progress.awards[0].assessments.scored,'number');
  assert.equal(JSON.stringify(progress).includes('appointmentId'),false);
  await assert.rejects(db.query('SELECT awards_event_progress($1,$2,1)',[id(2),eventLink.id]),/unavailable/);
  const autoConfig=(await db.query("SELECT awards_configure_message($1,$2,'application_confirmation',NULL,true,0,'member',$3) AS result",
    [id(1),a.id,id(22)])).rows[0].result;
  await db.query("SELECT awards_configure_automatic_messages($1,$2,'application_confirmation',$3,true,0,'member',$4,$5)",
    [id(1),a.id,autoConfig.version,id(22),'Enable future application acknowledgements']);
  assert.equal((await db.query('SELECT awards_schedule_automatic_messages(5) AS result')).rows[0].result.queued,0);
  await db.query('RESET ROLE');
  await db.query('UPDATE awards_application SET created_at=clock_timestamp() WHERE id=$1',[id(70)]);
  await db.query('UPDATE awards_message_configuration SET last_scan_at=NULL WHERE id=$1',[autoConfig.id]);
  await db.query('SET ROLE service_role');
  assert.equal((await db.query('SELECT awards_schedule_automatic_messages(5) AS result')).rows[0].result.queued,1);
  const automaticDelivery=(await db.query("SELECT id FROM awards_delivery WHERE tenant_id=$1 AND category='application_confirmation' AND recipient_context->>'application_id'=$2",
    [id(1),id(70)])).rows[0].id;
  const deliveryControl=(command,version=null)=>db.query('SELECT awards_delivery_control($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [id(1),a.id,automaticDelivery,command,version,'member',id(22),'Operator reviewed delivery']);
  const beforeAttention=(await deliveryControl('read')).rows[0].result;
  assert.equal(beforeAttention.canCancel,true);assert.equal(beforeAttention.canRetry,false);
  await db.query('RESET ROLE');
  await db.query("UPDATE awards_delivery SET state='attention',sending_started_at=clock_timestamp() WHERE id=$1",[automaticDelivery]);
  await db.query('SET ROLE service_role');
  const uncertainDelivery=(await deliveryControl('read')).rows[0].result;
  assert.equal(uncertainDelivery.canRetry,false);assert.equal(uncertainDelivery.providerOutcomeUncertain,true);
  await assert.rejects(deliveryControl('retry',uncertainDelivery.version),/definitely unsent/);
  await assert.rejects(deliveryControl('cancel',beforeAttention.version),/Delivery changed/);
  assert.equal((await deliveryControl('cancel',uncertainDelivery.version)).rows[0].result.state,'cancelled');
  assert.equal((await deliveryControl('read')).rows[0].result.providerOutcomeUncertain,true);
  await db.query('RESET ROLE');
  await db.query('UPDATE awards_message_configuration SET last_scan_at=NULL WHERE id=$1',[autoConfig.id]);
  await db.query('SET ROLE service_role');
  assert.equal((await db.query('SELECT awards_schedule_automatic_messages(5) AS result')).rows[0].result.queued,0);
  await db.query('RESET ROLE');
  await db.query("INSERT INTO form_submission(id,tenant_id,form_id,submission_data,awards_binding_id,survey_version_id,submitted_by_email) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [id(192),id(1),id(151),{document:'External original'},id(152),id(155),'external@example.invalid']);
  await db.query('SET ROLE service_role');
  const externalApp=(await db.query('SELECT awards_finalise_intake($1,$2,$3) AS result',[id(1),id(192),id(152)])).rows[0].result;
  const externalAward=(await db.query('SELECT award_id FROM awards_application WHERE id=$1',[externalApp.id])).rows[0].award_id;
  const grantFor=async(request,claim,hash)=>{
    const delivery=(await db.query("SELECT awards_queue_message($1,$2,'application_confirmation',$3,NULL,now(),$4,'member',$5,$6) AS result",
      [id(1),externalAward,{application_id:externalApp.id},request,id(22),'External applicant access fixture'])).rows[0].result;
    await db.query('RESET ROLE');
    await db.query("UPDATE awards_delivery SET state='claimed',claim_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[delivery.id,claim]);
    await db.query('SET ROLE service_role');
    return(await db.query('SELECT awards_issue_applicant_access($1,$2,$3,$4,$5,$6) AS result',
      [id(1),externalApp.id,delivery.id,claim,hash,{v:1,fixture:true}])).rows[0].result;
  };
  const externalHash=createHash('sha256').update('s'.repeat(43)).digest('hex'),externalGrant=await grantFor(id(193),id(194),externalHash);
  const externalStatus=async(tenant=id(1),application=externalApp.id,hash=externalHash)=>(await db.query(
    'SELECT awards_applicant_status($1,NULL,$2,1,$3) AS result',[tenant,application,hash])).rows[0].result;
  assert.equal((await externalStatus()).applications[0].status,'Received');
  assert.equal((await externalStatus(id(2))).total,0);
  assert.equal((await externalStatus(id(1),id(70))).total,0);
  await db.query('RESET ROLE');
  await db.query('UPDATE form SET fields=$1 WHERE id=$2',[JSON.stringify([{id:'document',type:'text',label:'Evidence note'}]),id(151)]);
  await db.query('SET ROLE service_role');
  const externalEditor=(await db.query('SELECT awards_amendment_editor($1,NULL,$2,$3) AS result',[id(1),externalApp.id,externalHash])).rows[0].result;
  assert.equal(externalEditor.form.id,id(151));assert.equal(externalEditor.form.field_mappings,undefined);
  await db.query('SELECT awards_prepare_amendment($1,NULL,$2,$3,1,$4,$5)',
    [id(1),externalApp.id,id(195),{document:'External revision'},externalHash]);
  await db.query('SELECT awards_record_amendment($1,NULL,$2,$3,1,$4,$5)',
    [id(1),externalApp.id,id(195),'Correct external evidence',externalHash]);
  const externalAmendment=(await db.query('SELECT member_id,access_id FROM awards_amendment WHERE submission_id=$1',[id(195)])).rows[0];
  assert.equal(externalAmendment.member_id,null);assert.equal(externalAmendment.access_id,externalGrant.id);
  assert.deepEqual((await db.query('SELECT submission_data FROM form_submission WHERE id=$1',[id(192)])).rows[0].submission_data,{document:'External original'});
  const accessView=(await db.query("SELECT awards_applicant_access_control($1,$2,'read') AS result",[id(1),externalApp.id])).rows[0].result;
  assert.equal(accessView.links[0].token_hash,undefined);
  await db.query("SELECT awards_applicant_access_control($1,$2,'revoke',1,$3,'member',$4,$5)",
    [id(1),externalApp.id,accessView.version,id(22),'Revoke external link']);
  assert.equal((await externalStatus()).total,0);
  await assert.rejects(db.query('SELECT awards_external_withdraw($1,$2,$3,2,$4)',[id(1),externalApp.id,externalHash,'Withdraw']),/expired, revoked/);
  const replacementHash=createHash('sha256').update('t'.repeat(43)).digest('hex');
  await grantFor(id(196),id(197),replacementHash);
  const withdrawnExternal=(await db.query('SELECT awards_external_withdraw($1,$2,$3,2,$4) AS result',
    [id(1),externalApp.id,replacementHash,'Withdraw external application'])).rows[0].result;
  assert.equal(withdrawnExternal.eligibility,'withdrawn');
  assert.equal((await externalStatus(id(1),externalApp.id,replacementHash)).applications[0].status,'Withdrawn');
  const assessmentHistory=(await db.query('SELECT assessment_submitted_history($1,$2,$3,1) AS result',[id(1),id(60),id(70)])).rows[0].result;
  assert.ok(assessmentHistory.total>=3);
  assert.ok(assessmentHistory.assessments.some(row=>row.applicationVersionId===id(80)));
  assert.ok(assessmentHistory.assessments.every(row=>/^Judge [A-F0-9]{8}$/.test(row.judge)));
  assert.equal(JSON.stringify(assessmentHistory).includes('PRIVATE DRAFT'),false);
  await assert.rejects(db.query('SELECT assessment_submitted_history($1,$2,$3,1)',[id(2),id(60),id(70)]),/unavailable/);
  const linkedEvents=(await db.query('SELECT awards_publication_event_links($1,$2,1) AS result',[id(1),a.id])).rows[0].result;
  assert.ok(linkedEvents.links.some(link=>link.id===eventLink.id));
  await db.query('RESET ROLE');
  await db.query("UPDATE awards_competition SET state='completed' WHERE id=$1",[a.id]);
  await db.query('SET ROLE service_role');
  const latestRoundVersion=(await db.query('SELECT version FROM assessment_round WHERE id=$1',[id(60)])).rows[0].version;
  await assert.rejects(db.query("SELECT assessment_round_transition($1,$2,$3,'judging',now()+interval '7 days','member',$4,$5)",
    [id(1),id(60),latestRoundVersion,id(22),'Reopen round']),/Reopen the award/);
  const completedVersion=(await db.query('SELECT version FROM awards_competition WHERE id=$1',[a.id])).rows[0].version;
  await assert.rejects(db.query('SELECT assessment_reopen($1,$2,0,$3,$4,$5)',
    [id(1),id(102),'member',id(22),'No implicit award reopening']),/Reopen the award/);
  const reopenedAward=(await db.query("SELECT awards_reopen_review($1,$2,$3,'member',$4,$5) AS result",
    [id(1),a.id,completedVersion,id(22),'Review a correction'])).rows[0].result;
  assert.equal(reopenedAward.state,'judging');
  const concurrent=new pg.Client({host:root,port,user:'postgres',database:'postgres'});
  await concurrent.connect();
  try{
    await concurrent.query('BEGIN');
    await concurrent.query('SELECT awards_require_active_review($1,$2)',[id(1),a.id]);
    await db.query("RESET ROLE; BEGIN; SET LOCAL lock_timeout='100ms'");
    await assert.rejects(db.query("UPDATE awards_competition SET state='completed' WHERE id=$1",[a.id]),error=>error.code==='55P03');
    await db.query('ROLLBACK; RESET ROLE');
    await concurrent.query('ROLLBACK; BEGIN');
    await concurrent.query("UPDATE awards_competition SET state='completed' WHERE id=$1",[a.id]);
    await assert.rejects(db.query('SELECT awards_require_active_review($1,$2)',[id(1),a.id]),error=>error.code==='PT409');
  }finally{
    await concurrent.query('ROLLBACK');await concurrent.end();
    await db.query('SET ROLE service_role');
  }
  const nestedFields=[{id:'rows',type:'repeatable_rows',repeatable_row:{children:[{id:'note',type:'text'},{id:'paper',type:'file'}]}}];
  const nestedPath=`${id(1)}/form-submissions/${id(201)}/paper.pdf`;
  const nestedAnswers={rows:[{_row_id:'row-one',note:'Original note',paper:{bucket:'private-uploads',path:nestedPath,name:'Paper.pdf'}}]};
  await db.query('RESET ROLE');
  await db.query("UPDATE awards_competition SET state='open',opens_at=now()-interval '1 day',closes_at=now()+interval '7 days',amendments_enabled=true WHERE id=$1",[externalAward]);
  await db.query('INSERT INTO form(id,tenant_id,is_active,name,fields) VALUES($1,$2,true,$3,$4)',[id(199),id(1),'Nested evidence',JSON.stringify(nestedFields)]);
  await db.query('UPDATE awards_form_binding SET active=false WHERE tenant_id=$1 AND award_id=$2',[id(1),externalAward]);
  await db.query('INSERT INTO awards_form_binding(id,tenant_id,award_id,form_id,review_field_ids) VALUES($1,$2,$3,$4,$5)',
    [id(200),id(1),externalAward,id(199),['rows']]);
  await db.query('INSERT INTO form_submission(id,tenant_id,form_id,submission_data,awards_binding_id,awards_applicant_member_id) VALUES($1,$2,$3,$4,$5,$6)',
    [id(201),id(1),id(199),nestedAnswers,id(200),id(20)]);
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT awards_finalise_intake($1,$2,$3)',[id(1),id(201),id(200)]),/Repeatable review attachments/);
  const largeBytes=Buffer.alloc(1048581,0xab),largeDigest=createHash('sha256').update(largeBytes).digest('hex');
  const nestedFile=(await db.query('SELECT awards_capture_attachment($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [id(1),id(201),'rows',nestedPath,'Paper.pdf',largeBytes.toString('hex'),largeDigest,'["row-one","paper"]'])).rows[0].result;
  const nestedApp=(await db.query('SELECT awards_finalise_intake($1,$2,$3) AS result',[id(1),id(201),id(200)])).rows[0].result;
  const nestedReview=(await db.query('SELECT awards_applicant_review($1,$2,$3) AS result',[id(1),id(20),nestedApp.id])).rows[0].result;
  assert.equal(nestedReview.attachment_manifest[0].cell_id,'["row-one", "paper"]');
  await assert.rejects(db.query('SELECT awards_applicant_review($1,$2,$3)',[id(1),id(21),nestedApp.id]),/unavailable/);
  await assert.rejects(db.query('SELECT awards_applicant_review($1,$2,$3)',[id(1),id(20),externalApp.id]),/unavailable/);
  const chunk=async offset=>(await db.query('SELECT awards_applicant_attachment($1,$2,$3,$4,$5) AS result',
    [id(1),id(20),nestedApp.id,nestedFile.id,offset])).rows[0].result;
  const firstChunk=await chunk(0),lastChunk=await chunk(1048576);
  assert.equal(firstChunk.bytes,1048576);assert.equal(lastChunk.bytes,5);
  assert.equal(firstChunk.sha256,largeDigest);
  assert.equal(Buffer.concat([Buffer.from(firstChunk.hex,'hex'),Buffer.from(lastChunk.hex,'hex')]).equals(largeBytes),true);
  await assert.rejects(chunk(largeBytes.length),/Invalid attachment range/);
  const changedNested={rows:[{...nestedAnswers.rows[0],note:'Revised note'}]};
  await db.query('SELECT awards_prepare_amendment($1,$2,$3,$4,1,$5)',[id(1),id(20),nestedApp.id,id(202),changedNested]);
  await assert.rejects(db.query('SELECT awards_record_amendment($1,$2,$3,$4,1,$5)',
    [id(1),id(20),nestedApp.id,id(202),'Revise note']),/Repeatable review attachments/);
  assert.equal((await db.query('SELECT awards_copy_amendment_cell_files($1,$2,$3,$4,$5) AS result',
    [id(1),nestedApp.id,id(202),'rows','["row-one","paper"]'])).rows[0].result,true);
  const nestedAmendment=(await db.query('SELECT awards_record_amendment($1,$2,$3,$4,1,$5) AS result',
    [id(1),id(20),nestedApp.id,id(202),'Revise note'])).rows[0].result;
  assert.ok(nestedAmendment.applicationVersionId);
  if(process.env.TEST_ISOLATION_ALLOW_LOCAL_POSTGREST==='1'){
    const {prepareNativeJourney,runNativeJourney}=await import('./awardsNativeJourney.mjs');
    const journey=await prepareNativeJourney(db,id(1),id(20));
    const gateway=await startAwardsPostgrest(root,port);
    try{
      const {default:externalHandler}=await import('../../api/awards/external-application.js');
      const {default:publicHandler}=await import('../../api/public/awards.js');
      const response=()=>({statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value;},
        status(code){this.statusCode=code;return this;},json(data){this.body=data;return this;}});
      const dependencies={supabase:gateway.client,resolveTenant:async()=>({id:id(1)}),
        getMember:async()=>{throw new Error('External access must not use a member session');}};
      for(const [application,token,expected]of [[externalApp.id,'t'.repeat(43),200],
        [externalApp.id,'s'.repeat(43),403],[id(70),'t'.repeat(43),403]]){
        const res=response();
        await externalHandler({method:'GET',headers:{'x-awards-applicant':token},query:{applicationId:application}},res,dependencies);
        assert.equal(res.statusCode,expected,JSON.stringify(res.body));
        if(expected===200)assert.equal(res.body.applications[0].status,'Withdrawn');
        assert.equal(res.headers['Cache-Control'],'private, no-store');
      }
      const published=response();
      await publicHandler({method:'GET',headers:{},query:{awardId:a.id}},published,dependencies);
      assert.equal(published.statusCode,200,JSON.stringify(published.body));
      assert.equal(published.body.outcomes.length,0,'Retracted outcomes stay absent from real HTTP projections');
      const originalHistory=await gateway.client.rpc('assessment_submitted_history',{
        p_tenant:id(1),p_round:id(60),p_application:id(70),p_page:1});
      assert.equal(originalHistory.error,null,JSON.stringify(originalHistory.error));
      assert.equal(originalHistory.data.total,assessmentHistory.total);
      const bypass=await gateway.client.from('awards_competition').update({name:'Forbidden HTTP bypass'}).eq('id',a.id);
      assert.ok(bypass.error,'Service-role generic HTTP writes cannot bypass domain commands');
      await runNativeJourney({db,client:gateway.client,tenant:id(1),admin:id(20),approver:id(22),formId:id(40),...journey});
    }finally{await gateway.stop();}
  }
  await assert.rejects(db.query("SELECT awards_reopen_review($1,$2,$3,'member',$4,$5)",
    [id(1),a.id,completedVersion,id(22),'Stale retry']),/Award changed/);
  await db.query(`RESET ROLE; SET ROLE anon`);
  await assert.rejects(command('create',null,null,{name:'Forbidden'}),/permission denied/);
});
