import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('job alerts migration: publication, consent, isolation, leases, protected category and atomic inbox', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'job-alerts-pg-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket'); mkdirSync(socket);
  function run(cmd, args, input, allowed = true) {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (allowed) assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0, 'Expected denial');
    return result.stdout.trim();
  }
  const args = ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  const sql = (query, allowed = true) => run('psql', args, query, allowed);
  const tenant = '10000000-0000-4000-8000-000000000001', other = '10000000-0000-4000-8000-000000000002';
  const member = '20000000-0000-4000-8000-000000000001', role = '30000000-0000-4000-8000-000000000001';
  const job = '40000000-0000-4000-8000-000000000001', adzuna = '40000000-0000-4000-8000-000000000002';
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'log'), '-o', `-F -k ${socket} -c listen_addresses=`, '-w', 'start']); started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features jsonb DEFAULT '[]');
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,role_id uuid,communications_opted_out_all boolean DEFAULT false,login_enabled boolean DEFAULT true);
      CREATE TABLE job_posting(id uuid PRIMARY KEY,tenant_id uuid,status text,external_source text,title text);
      CREATE TABLE communication_category(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,description text,is_active boolean,is_public boolean,member_enabled boolean,display_order integer);
      CREATE TABLE communication_category_role(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),category_id uuid,role_id uuid);
      CREATE TABLE member_communication_preference(member_id uuid,tenant_id uuid,category_id uuid,is_subscribed boolean,PRIMARY KEY(member_id,category_id));
      CREATE TABLE member_transactional_message(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,recipient_email text,subject text,body_html text,communication_category_id uuid,label_key text,sent_at timestamptz);
      INSERT INTO tenant VALUES('${tenant}'),('${other}');
      INSERT INTO role(id,tenant_id) VALUES('${role}','${tenant}');
      INSERT INTO member(id,tenant_id,role_id) VALUES('${member}','${tenant}','${role}');
      INSERT INTO job_posting VALUES('${job}','${tenant}','active',null,'Existing');
    `);
    sql(readFileSync(new URL('../../supabase/migrations/20261204_job_posting_alerts.sql', import.meta.url), 'utf8'));
    const cat = sql(`SELECT configure_job_alerts('${tenant}',true);`);
    assert.equal(sql(`SELECT configure_job_alerts('${tenant}',true);`), cat, 'single protected category');
    sql(`DELETE FROM communication_category WHERE id='${cat}';`, false);
    sql(`UPDATE communication_category SET name='Changed' WHERE id='${cat}';`, false);
    sql(`INSERT INTO communication_category_role(category_id,role_id) VALUES('${cat}','${role}');`, false);
    sql(`SET ROLE authenticated; SELECT * FROM job_alert_settings;`, false);
    sql(`SET ROLE authenticated; SELECT configure_job_alerts('${tenant}',false);`, false);
    sql(`INSERT INTO member_communication_preference VALUES('${member}','${other}','${cat}',true);`, false);
    sql(`UPDATE role SET excluded_features='["jobs"]'; INSERT INTO member_communication_preference VALUES('${member}','${tenant}','${cat}',true);`, false);
    sql(`UPDATE role SET excluded_features='[]'; INSERT INTO member_communication_preference VALUES('${member}','${tenant}','${cat}',true);`);
    sql(`UPDATE job_posting SET status='draft' WHERE id='${job}'; UPDATE job_posting SET status='active' WHERE id='${job}';`);
    assert.equal(sql('SELECT count(*) FROM job_alert_delivery;'), '0', 'no retroactive alerts');
    sql(`INSERT INTO job_posting VALUES('${adzuna}','${tenant}','draft','adzuna','Imported job');`);
    assert.equal(sql('SELECT count(*) FROM job_alert_delivery;'), '0');
    sql(`UPDATE job_posting SET status='active' WHERE id='${adzuna}'; UPDATE job_posting SET title='Edit' WHERE id='${adzuna}';`);
    assert.equal(sql('SELECT count(*) FROM job_alert_delivery;'), '1', 'one initial publication only');
    const [id, lease] = sql('SELECT id,lease_id FROM claim_job_alert_delivery();').split('|');
    assert.equal(sql('SELECT count(*) FROM claim_job_alert_delivery();'), '0', 'lease excludes another worker');
    sql(`UPDATE job_alert_delivery SET status='sending',lease_until=now()-interval '1 second'; SELECT count(*) FROM claim_job_alert_delivery();`);
    assert.equal(sql('SELECT status FROM job_alert_delivery;'), 'uncertain');
    const finish = `SELECT finish_job_alert_delivery('${id}','${lease}','message','test@example.invalid','New job','<p>job</p>');`;
    sql(finish); sql(finish);
    assert.equal(sql('SELECT count(*) FROM member_transactional_message;'), '1');
    assert.equal(sql('SELECT status FROM job_alert_delivery;'), 'sent');
    sql(`INSERT INTO job_posting VALUES('40000000-0000-4000-8000-000000000003','${tenant}','active',null,'Direct job');`);
    assert.equal(sql("SELECT count(*) FROM job_alert_delivery WHERE status='pending';"), '1', 'direct posts also enqueue');
    sql(`SELECT configure_job_alerts('${tenant}',false);`);
    assert.equal(sql("SELECT count(*) FROM job_alert_delivery WHERE status='pending';"), '0', 'disablement cancels pending alerts');
    assert.equal(sql(`SELECT is_active FROM communication_category WHERE id='${cat}';`), 'f');
    sql(`UPDATE member_communication_preference SET is_subscribed=true;`, false);
    sql(`UPDATE member_communication_preference SET is_subscribed=false;`);
    assert.equal(sql(`SELECT count(*) FROM communication_category WHERE system_key='job_postings';`), '1');
    sql(`SET ROLE service_role; SELECT * FROM job_alert_settings;`);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
