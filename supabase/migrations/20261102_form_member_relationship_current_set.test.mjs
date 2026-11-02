import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const migration = await readFile(new URL('./20261102_form_member_relationship_current_set.sql', import.meta.url), 'utf8');
const snapshots = await readFile(new URL('./20261102_form_member_affiliation_snapshots.sql', import.meta.url), 'utf8');
const reviews = await readFile(new URL('./20261102_form_member_affiliation_reviews.sql', import.meta.url), 'utf8');
test('real PostgreSQL: atomic membership links, rollback, stale fencing, replay and permissions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'form-affiliation-pg-'));
  const port = String(24000 + process.pid % 12000);
  const data = path.join(root, 'db');
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 3e6 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  let running = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'log'), '-o', `-k ${root} -p ${port} -h ''`, '-w', 'start']);
    running = true;
    const sql = text => run('psql', ['-h', root, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], text);
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE organization_group(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid);
      CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,require_authentication boolean,mutation_access_policy jsonb);
      CREATE TABLE form_submission(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,created_member_id uuid);
      CREATE TABLE custom_object_record(id uuid PRIMARY KEY,tenant_id uuid,custom_object_id uuid,archived_at timestamptz);
      CREATE TABLE custom_object_relationship_definition(id uuid PRIMARY KEY,tenant_id uuid,source_kind text,target_kind text,
        source_custom_object_id uuid,target_custom_object_id uuid,status text);
      CREATE TABLE custom_object_relationship(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,relationship_definition_id uuid,
        source_record_id uuid,target_record_id uuid,created_by text,archived_by text,archived_at timestamptz,metadata jsonb);
      CREATE UNIQUE INDEX edges ON custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id) WHERE archived_at IS NULL;
    `);
    sql(migration);
    sql(snapshots);
    sql(reviews);
    sql(`
      DO $test$
      DECLARE
        t uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); s uuid:=gen_random_uuid();
        org1 uuid:=gen_random_uuid(); org2 uuid:=gen_random_uuid(); obj uuid:=gen_random_uuid();
        def uuid:=gen_random_uuid(); d1 uuid:=gen_random_uuid(); d2 uuid:=gen_random_uuid(); oldedge uuid:=gen_random_uuid();
        snap jsonb; sets jsonb; result jsonb;
      BEGIN
        INSERT INTO tenant VALUES(t);
        INSERT INTO organization VALUES(org1,t),(org2,t);
        INSERT INTO member VALUES(m,t,org1);
        INSERT INTO form VALUES(f,t,true,'{"version":1,"mode":"authenticated_owner"}');
        INSERT INTO form_submission VALUES(s,t,f,m);
        INSERT INTO custom_object_record VALUES(d1,t,obj,null),(d2,t,obj,null);
        INSERT INTO custom_object_relationship_definition VALUES(def,t,'custom_object','member',obj,null,'active');
        INSERT INTO custom_object_relationship(id,tenant_id,relationship_definition_id,source_record_id,target_record_id,metadata)
          VALUES(oldedge,t,def,d1,m,'{"role":"preserve"}');
        snap:=form_member_relationship_snapshot(t,m,ARRAY[def]);
        sets:=jsonb_build_array(jsonb_build_object('definition_id',def,'related_ids',jsonb_build_array(d1,d2)));
        -- No browser role can reach the write function or operation records.
        IF has_function_privilege('anon','form_member_relationship_apply(uuid,uuid,uuid,jsonb,uuid,jsonb)','EXECUTE')
          OR has_function_privilege('authenticated','form_member_relationship_apply(uuid,uuid,uuid,jsonb,uuid,jsonb)','EXECUTE')
          OR has_table_privilege('authenticated','form_member_relationship_operation','SELECT')
          OR has_table_privilege('service_role','form_member_relationship_operation','INSERT') THEN
          RAISE EXCEPTION 'Unsafe grants';
        END IF;
        BEGIN
          PERFORM form_member_relationship_apply(t,s,m,'{}',org2,sets);
          RAISE EXCEPTION 'Stale snapshot accepted';
        EXCEPTION WHEN serialization_failure THEN NULL; END;
        BEGIN
          PERFORM form_member_relationship_apply(t,s,m,snap,org2,
            jsonb_build_array(jsonb_build_object('definition_id',def,'related_ids',jsonb_build_array(gen_random_uuid()))));
          RAISE EXCEPTION 'Missing target accepted';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        IF (SELECT organization_id FROM member WHERE id=m)<>org1 THEN RAISE EXCEPTION 'Failed request changed organisation'; END IF;
        result:=form_member_relationship_apply(t,s,m,snap,org2,sets);
        IF (result->>'added')::integer<>1 OR (result->>'archived')::integer<>0 THEN RAISE EXCEPTION 'Wrong diff'; END IF;
        IF (SELECT metadata FROM custom_object_relationship WHERE id=oldedge)<>'{"role":"preserve"}'::jsonb THEN RAISE EXCEPTION 'Metadata changed'; END IF;
        IF (SELECT organization_id FROM member WHERE id=m)<>org2 THEN RAISE EXCEPTION 'Organisation not applied'; END IF;
        result:=form_member_relationship_apply(t,s,m,snap,org2,sets);
        IF result->>'replayed'<>'true' OR (SELECT count(*) FROM custom_object_relationship WHERE archived_at IS NULL)<>2 THEN RAISE EXCEPTION 'Replay duplicated links'; END IF;
        BEGIN
          PERFORM form_member_relationship_apply(t,s,m,snap,org1,sets);
          RAISE EXCEPTION 'Conflicting replay accepted';
        EXCEPTION WHEN unique_violation THEN NULL; END;
        s:=gen_random_uuid();
        INSERT INTO form_submission VALUES(s,t,f,m);
        snap:=form_member_relationship_snapshot(t,m,ARRAY[def]);
        result:=form_member_relationship_apply(t,s,m,snap,org2,
          jsonb_build_array(jsonb_build_object('definition_id',def,'related_ids','[]'::jsonb)));
        IF (result->>'archived')::integer<>2 OR EXISTS(SELECT 1 FROM custom_object_relationship WHERE archived_at IS NULL) THEN
          RAISE EXCEPTION 'Explicit clear failed';
        END IF;
        IF (SELECT count(*) FROM custom_object_relationship)<>2 THEN RAISE EXCEPTION 'History deleted'; END IF;
      END $test$;
    `);
    sql(`
      ALTER TABLE organization ADD COLUMN name text DEFAULT 'Example organisation';
      ALTER TABLE custom_object_record ADD COLUMN data jsonb DEFAULT '{}';
      ALTER TABLE custom_object_record ADD COLUMN created_by text;
      ALTER TABLE custom_object_record ADD COLUMN archived_by text;
      ALTER TABLE custom_object_record ADD COLUMN archive_reason text;
      ALTER TABLE custom_object_record ADD COLUMN updated_at timestamptz DEFAULT now();
      DO $test$
      DECLARE
        t uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); s uuid:=gen_random_uuid();
        org1 uuid:=gen_random_uuid(); org2 uuid:=gen_random_uuid(); obj uuid:=gen_random_uuid();
        deptobj uuid:=gen_random_uuid(); dd uuid:=gen_random_uuid(); dept uuid:=gen_random_uuid();
        md uuid:=gen_random_uuid(); od uuid:=gen_random_uuid(); token uuid; cfg jsonb; r jsonb;
      BEGIN
        INSERT INTO tenant VALUES(t);
        INSERT INTO organization(id,tenant_id) VALUES(org1,t),(org2,t);
        INSERT INTO member VALUES(m,t,org1);
        INSERT INTO form VALUES(f,t,true,'{"version":1,"mode":"authenticated_owner"}');
        INSERT INTO form_submission VALUES(s,t,f,m);
        INSERT INTO custom_object_record(id,tenant_id,custom_object_id) VALUES(dept,t,deptobj);
        INSERT INTO custom_object_relationship_definition VALUES
          (dd,t,'custom_object','member',deptobj,null,'active'),
          (md,t,'custom_object','member',obj,null,'active'),
          (od,t,'custom_object','organization',obj,null,'active');
        cfg:=jsonb_build_object('version',1,'enabled',true,'memberDepartmentDefinitionId',dd,
          'secondaryObjectId',obj,'secondaryMemberDefinitionId',md,'secondaryOrganizationDefinitionId',od);
        INSERT INTO form_member_affiliation_config VALUES(t,f,cfg,now());
        token:=(form_member_affiliation_capture(t,f,m)->>'token')::uuid;
        BEGIN
          PERFORM form_member_affiliation_apply(token,s,org1,ARRAY[dept],ARRAY[org2]);
          RAISE EXCEPTION 'Unbound submission accepted';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        BEGIN
          PERFORM form_member_affiliation_bind(token,s,gen_random_uuid());
          RAISE EXCEPTION 'Wrong actor accepted';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        PERFORM form_member_affiliation_bind(token,s,m);
        -- An error after secondary creation must roll the WHOLE transaction back.
        BEGIN
          PERFORM form_member_affiliation_apply(token,s,org1,ARRAY[gen_random_uuid()],ARRAY[org2]);
          RAISE EXCEPTION 'Invalid department accepted';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        IF EXISTS(SELECT 1 FROM custom_object_record WHERE tenant_id=t AND custom_object_id=obj) THEN
          RAISE EXCEPTION 'Secondary record survived failed department write';
        END IF;
        IF (SELECT result FROM form_member_affiliation_snapshot WHERE id=token) IS NOT NULL THEN
          RAISE EXCEPTION 'Failed write recorded success';
        END IF;
        r:=form_member_affiliation_apply(token,s,org1,ARRAY[dept],ARRAY[org2]);
        IF r->>'committed'<>'true' THEN RAISE EXCEPTION 'Not committed'; END IF;
        IF (SELECT count(*) FROM custom_object_record WHERE tenant_id=t AND custom_object_id=obj AND archived_at IS NULL)<>1 THEN
          RAISE EXCEPTION 'Secondary record not created';
        END IF;
        r:=form_member_affiliation_apply(token,s,org1,ARRAY[dept],ARRAY[org2]);
        IF r->>'replayed'<>'true' THEN RAISE EXCEPTION 'Not replayed'; END IF;
        token:=(form_member_affiliation_capture(t,f,m)->>'token')::uuid;
        s:=gen_random_uuid(); INSERT INTO form_submission VALUES(s,t,f,m);
        PERFORM form_member_affiliation_bind(token,s,m);
        r:=form_member_affiliation_apply(token,s,org2,'{}','{}');
        IF EXISTS(SELECT 1 FROM custom_object_record WHERE tenant_id=t AND custom_object_id=obj AND archived_at IS NULL) THEN
          RAISE EXCEPTION 'Secondary record not archived';
        END IF;
        IF (SELECT count(*) FROM custom_object_record WHERE tenant_id=t AND custom_object_id=obj)<>1 THEN
          RAISE EXCEPTION 'Secondary history lost';
        END IF;
        IF has_function_privilege('authenticated','form_member_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[])','EXECUTE')
          OR has_function_privilege('anon','form_member_affiliation_capture(uuid,uuid,uuid)','EXECUTE')
          OR has_table_privilege('service_role','form_member_affiliation_snapshot','UPDATE') THEN
          RAISE EXCEPTION 'Unsafe snapshot privileges';
        END IF;
        token:=(form_member_affiliation_capture(t,f,m)->>'token')::uuid;
        s:=gen_random_uuid(); INSERT INTO form_submission VALUES(s,t,f,m);
        PERFORM form_member_affiliation_bind(token,s,m);
        r:=form_member_affiliation_defer(token,s,'[{"kind":"organization","fieldId":"hospital","requestedName":"New hospital"}]');
        IF r->>'status'<>'awaiting_review' OR r->>'blocks_renewal'<>'false'
          OR (SELECT organization_id FROM member WHERE id=m)<>org2 THEN
          RAISE EXCEPTION 'Review unexpectedly changed affiliations or blocked renewal';
        END IF;
        r:=form_member_affiliation_defer(token,s,'[{"kind":"organization","fieldId":"hospital","requestedName":"New hospital"}]');
        IF r->>'replayed'<>'true' OR (SELECT count(*) FROM form_member_affiliation_review WHERE tenant_id=t)<>1 THEN
          RAISE EXCEPTION 'Duplicate review';
        END IF;
        BEGIN
          PERFORM form_member_affiliation_apply(token,s,org1,'{}','{}');
          RAISE EXCEPTION 'Review was silently converted to an affiliation change';
        EXCEPTION WHEN unique_violation THEN NULL; END;
        IF has_function_privilege('authenticated','form_member_affiliation_defer(uuid,uuid,jsonb)','EXECUTE')
          OR has_table_privilege('authenticated','form_member_affiliation_review','SELECT')
          OR has_table_privilege('service_role','form_member_affiliation_review','UPDATE') THEN
          RAISE EXCEPTION 'Unsafe review grants';
        END IF;
      END $test$;
    `);
    sql(`
      ALTER TABLE form_submission ADD COLUMN submission_data jsonb;
      ALTER TABLE form ADD COLUMN name text, ADD COLUMN slug text, ADD COLUMN fields jsonb, ADD COLUMN pages jsonb,
        ADD COLUMN is_active boolean, ADD COLUMN due_diligence_required boolean;
      CREATE TABLE form_due_diligence_config(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,form_id uuid,
        workflow_stages jsonb,status_change_webhooks jsonb DEFAULT '[]',on_first_edit_stage text,
        applicant_name_field text,applicant_email_field text);
      CREATE TABLE form_submission_due_diligence(id uuid PRIMARY KEY,tenant_id uuid,form_submission_id uuid,
        application_uid text,original_form_values jsonb,reviewed_form_values jsonb,field_review_status jsonb,
        workflow_status text,history_log jsonb,stage_action_occurrence_id uuid);
    `);
    sql(await readFile(new URL('./20261102_form_member_affiliation_due_diligence.sql', import.meta.url), 'utf8'));
    sql(`
      DO $test$
      DECLARE
        t uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); rf uuid:=gen_random_uuid();
        sub uuid:=gen_random_uuid(); token uuid; review_id uuid; dd uuid; o1 uuid:=gen_random_uuid(); o2 uuid:=gen_random_uuid();
        config_id uuid:=gen_random_uuid(); occurrence uuid:=gen_random_uuid(); result jsonb;
      BEGIN
        INSERT INTO tenant VALUES(t);
        INSERT INTO organization(id,tenant_id) VALUES(o1,t),(o2,t);
        INSERT INTO member VALUES(m,t,o1);
        INSERT INTO form(id,tenant_id,require_authentication,mutation_access_policy) VALUES(f,t,true,'{"version":1,"mode":"authenticated_owner"}'),
          (rf,t,true,'{"version":1,"mode":"authenticated_owner"}');
        INSERT INTO form_due_diligence_config(id,tenant_id,form_id,workflow_stages,affiliation_review)
          VALUES(config_id,t,rf,'[{"id":"review","is_initial":true},{"id":"yes"},{"id":"no"}]',
            '{"enabled":true,"version":1,"approved_stage_id":"yes","rejected_stage_id":"no"}');
        INSERT INTO form_member_affiliation_config(tenant_id,form_id,config)
          VALUES(t,f,jsonb_build_object('enabled',true,'dueDiligenceReviewFormId',rf));
        INSERT INTO form_submission(id,tenant_id,form_id,created_member_id) VALUES(sub,t,f,m);
        token:=(form_member_affiliation_capture(t,f,m)->>'token')::uuid;
        PERFORM form_member_affiliation_bind(token,sub,m);
        result:=form_member_affiliation_defer(token,sub,'[{"kind":"organization","fieldId":"org","requestedName":"New name"}]');
        review_id:=(result->>'review_id')::uuid;
        SELECT due_diligence_submission_id INTO dd FROM form_member_affiliation_review WHERE id=review_id;
        IF dd IS NULL THEN RAISE EXCEPTION 'DD case not created atomically'; END IF;
        PERFORM form_member_affiliation_defer(token,sub,'[{"kind":"organization","fieldId":"org","requestedName":"New name"}]');
        IF (SELECT count(*) FROM form_submission_due_diligence WHERE tenant_id=t)<>1 THEN
          RAISE EXCEPTION 'Retry duplicated DD case'; END IF;
        IF (SELECT organization_id FROM member WHERE id=m)<>o1 THEN RAISE EXCEPTION 'Deferral changed affiliations'; END IF;
        BEGIN
          UPDATE form_due_diligence_config SET affiliation_review=NULL WHERE id=config_id;
          RAISE EXCEPTION 'Removed dedicated workflow guard';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        PERFORM save_form_member_affiliation_resolution(t,review_id,'admin',
          jsonb_build_object('primary',o2,'departments','[]'::jsonb,'secondary','[]'::jsonb),0);
        BEGIN
          PERFORM save_form_member_affiliation_resolution(t,review_id,'admin',
            jsonb_build_object('primary',o1,'departments','[]'::jsonb,'secondary','[]'::jsonb),0);
          RAISE EXCEPTION 'Stale reviewer overwrote resolution';
        EXCEPTION WHEN serialization_failure THEN NULL; END;
        UPDATE form_submission_due_diligence SET workflow_status='yes',stage_action_occurrence_id=occurrence WHERE id=dd;
        BEGIN
          PERFORM decide_form_member_affiliation_review(t,review_id,dd,'yes',gen_random_uuid()::text,'admin','approve');
          RAISE EXCEPTION 'Stale occurrence accepted';
        EXCEPTION WHEN serialization_failure THEN NULL; END;
        UPDATE member SET organization_id=o2 WHERE id=m;
        BEGIN
          PERFORM decide_form_member_affiliation_review(t,review_id,dd,'yes',occurrence::text,'admin','approve');
          RAISE EXCEPTION 'Stale graph accepted';
        EXCEPTION WHEN serialization_failure THEN NULL; END;
        IF (SELECT snap.result->>'status' FROM form_member_affiliation_snapshot snap WHERE id=token)<>'awaiting_review' THEN
          RAISE EXCEPTION 'Failed approval lost pending state'; END IF;
        UPDATE member SET organization_id=o1 WHERE id=m;
        UPDATE form_member_affiliation_snapshot SET expires_at=now()-interval '3 days' WHERE id=token;
        result:=decide_form_member_affiliation_review(t,review_id,dd,'yes',occurrence::text,'admin','approve');
        IF result->>'status'<>'applied' OR (SELECT organization_id FROM member WHERE id=m)<>o2 THEN
          RAISE EXCEPTION 'Approval did not apply affiliations'; END IF;
        result:=decide_form_member_affiliation_review(t,review_id,dd,'yes',occurrence::text,'admin','approve');
        IF result->>'status'<>'already_applied' THEN RAISE EXCEPTION 'Approval not idempotent'; END IF;
        IF has_function_privilege('authenticated','decide_form_member_affiliation_review(uuid,uuid,uuid,text,text,text,text)','EXECUTE')
          OR has_function_privilege('service_role','form_member_affiliation_defer_internal(uuid,uuid,jsonb)','EXECUTE') THEN
          RAISE EXCEPTION 'Review authority exposed'; END IF;
        f:=gen_random_uuid();
        INSERT INTO form(id,tenant_id,require_authentication,mutation_access_policy,name)
          VALUES(f,t,true,'{"version":1,"mode":"authenticated_owner"}','Renewal');
        result:=configure_form_member_affiliations(t,f,'{"version":1,"enabled":true}');
        IF result->>'dueDiligenceReviewFormId' IS NULL
          OR (SELECT count(*) FROM form_due_diligence_config WHERE tenant_id=t)<>2 THEN
          RAISE EXCEPTION 'Dedicated workflow not provisioned'; END IF;
        result:=configure_form_member_affiliations(t,f,'{"version":1,"enabled":true}');
        IF (SELECT count(*) FROM form_due_diligence_config WHERE tenant_id=t)<>2 THEN
          RAISE EXCEPTION 'Configuration retry created a duplicate workflow'; END IF;
      END $test$;
    `);
  } finally {
    if (running) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
