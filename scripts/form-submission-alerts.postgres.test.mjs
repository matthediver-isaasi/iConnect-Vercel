import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('private alert schema: settings isolation, transactional scheduling, claims and revocation',async()=>{
  const h=await createLocalPostgresHarness('form-alerts-');
  const run=(cmd,args,input)=>{
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr||r.stdout); return r.stdout.trim();
  };
  const sql=text=>run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-At'],text);
  let started=false;
  const tenant='11111111-1111-4111-8111-111111111111';
  const form='22222222-2222-4222-8222-222222222222';
  const sub='33333333-3333-4333-8333-333333333333';
  try{
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']); started=true;
    sql(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,name text,fields jsonb,pages jsonb);
      CREATE TABLE form_submission(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,form_id uuid,
        created_date timestamptz DEFAULT now(),source text,submission_email_state jsonb,payment_status text,payment_meta jsonb);
      CREATE TABLE form_due_diligence_one_off_ready(form_submission_id uuid PRIMARY KEY,tenant_id uuid);`);
    const migration=readFileSync('supabase/migrations/20261210_form_submission_alerts.sql','utf8');
    sql(migration);sql(migration);
    assert.equal(sql(`SELECT has_table_privilege('anon','form_alert_delivery','SELECT') OR
      has_table_privilege('authenticated','form_alert_settings','SELECT') OR
      has_function_privilege('authenticated','claim_form_submission_alert(uuid,uuid,text)','EXECUTE')`),'f');
    sql(`INSERT INTO form VALUES('${form}','${tenant}','Example','[]','[]');
      INSERT INTO form_submission(tenant_id,form_id) VALUES('${tenant}','${form}');`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'0');
    sql(`INSERT INTO form_alert_settings VALUES('${tenant}','${form}',true,ARRAY['a@example.test','b@example.test']);
      INSERT INTO form_submission(id,tenant_id,form_id,submission_email_state)
      VALUES('${sub}','${tenant}','${form}','{"status":"pending"}');`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'0');
    sql(`BEGIN;UPDATE form_submission SET submission_email_state='{"status":"ready"}' WHERE id='${sub}';ROLLBACK;`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'0');
    sql(`UPDATE form_submission SET submission_email_state='{"status":"ready"}' WHERE id='${sub}';
      UPDATE form_submission SET submission_email_state='{"status":"ready"}' WHERE id='${sub}';`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'2');
    sql(`INSERT INTO form_submission(tenant_id,form_id,source) VALUES('${tenant}','${form}','synthetic_dd_swap');
      INSERT INTO form_submission(tenant_id,form_id,payment_status) VALUES('${tenant}','${form}','pending');`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'2');
    sql(`UPDATE form_submission SET payment_status='paid',payment_meta='{"completion":{"status":"processing"}}' WHERE payment_status='pending';`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'2');
    sql(`UPDATE form_submission SET payment_meta='{"completion":{"status":"done"}}' WHERE payment_status='paid';`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'4');
    sql(`INSERT INTO form_submission(tenant_id,form_id,payment_status,payment_meta)
      VALUES('${tenant}','${form}','paid','{"finalized":true}');
      INSERT INTO form_due_diligence_one_off_ready SELECT id,tenant_id FROM form_submission WHERE payment_meta='{"finalized":true}';`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'6');
    sql(`INSERT INTO form_submission(tenant_id,form_id,payment_status)
      VALUES('${tenant}','${form}','setup_complete');
      UPDATE form_submission SET payment_meta='{"monthly_dd_state":{"status":"done"}}'
      WHERE payment_status='setup_complete';`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'8');
    sql(`UPDATE form_submission SET payment_meta='{"monthly_dd_state":{"status":"done"}}'
      WHERE payment_status='setup_complete';`);
    assert.equal(sql('SELECT count(*) FROM form_alert_delivery'),'8');
    const delivery=sql(`SELECT id FROM form_alert_delivery WHERE submission_id='${sub}' ORDER BY id LIMIT 1`);
    const claim="44444444-4444-4444-8444-444444444444";
    assert.equal(sql(`SET ROLE service_role;SELECT count(*) FROM claim_form_submission_alert('${delivery}','${claim}','${'a'.repeat(64)}')`),'1');
    assert.equal(sql(`SELECT count(*) FROM claim_form_submission_alert('${delivery}','${claim}','${'b'.repeat(64)}')`),'0');
    sql(`SET ROLE service_role;SELECT revoke_form_submission_alerts('${tenant}','${form}','${sub}')`);
    assert.equal(sql(`SELECT count(*) FROM form_alert_delivery WHERE submission_id='${sub}' AND status='revoked' AND token_hash IS NULL`),'2');
    assert.equal(sql(`SELECT bool_and(limit_form_alert_reads('${'c'.repeat(64)}')) FROM generate_series(1,60)`),'t');
    assert.equal(sql(`SELECT limit_form_alert_reads('${'c'.repeat(64)}')`),'f');
    sql(`DELETE FROM form_submission WHERE id='${sub}'`);
    assert.equal(sql(`SELECT count(*) FROM form_alert_delivery WHERE submission_id='${sub}'`),'0');
  }finally{
    if(started) spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop'],{encoding:'utf8'});
    await h.cleanup();
  }
});
