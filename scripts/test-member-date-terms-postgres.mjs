import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'member-date-'));
const cluster = join(dir, 'data');
let running = false;
let db;
const tenant = '00000000-0000-4000-8000-000000000001';
const member = '00000000-0000-4000-8000-000000000002';
const field = '00000000-0000-4000-8000-000000000003';
const config = '00000000-0000-4000-8000-000000000004';
const history = '00000000-0000-4000-8000-000000000005';
let checks = 0;
async function rejects(sql, args = []) {
  await assert.rejects(db.query(sql, args));
  checks++;
}
try {
  execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
  execFileSync('pg_ctl', ['-D', cluster, '-l', join(dir, 'pg.log'), '-o', `-k ${dir} -p 55489 -h ''`, '-w', 'start'], { stdio: 'pipe' });
  running = true;
  db = new pg.Client({ host: dir, port: 55489, user: 'runner', database: 'postgres' });
  await db.connect();
  await db.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE member(id uuid primary key, tenant_id uuid,membership_paused boolean);
    CREATE TABLE preference_field(id uuid primary key,tenant_id uuid,entity_scope text,field_type text,is_active boolean,custom_object_id uuid);
    CREATE TABLE member_preference_value(member_id uuid,field_id uuid,value text,unique(member_id,field_id));
    CREATE TABLE membership_tier_config(id uuid primary key,tenant_id uuid,structure_scope_type text,pricing_model text,
      flat_cost numeric,dd_enabled boolean,card_monthly_enabled boolean,prorata_enabled boolean,free_period_amount integer,rollover_enabled boolean,
      name text,currency text,is_active boolean default true,effective_from date,effective_to date,structure_field_id uuid,structure_match_value text,renewal_grace_days integer);
    CREATE TABLE member_membership_history(id uuid primary key default gen_random_uuid(),tenant_id uuid,member_id uuid,config_id uuid,
      annual_cost numeric,final_cost numeric,total_with_vat numeric,vat_amount numeric,billing_agreement_id uuid,term_key text,
      term_start_date date,term_end_date date,membership_renewal_date date,status text,payment_status text,
      membership_year text,tier_label text,currency text,billing_period text,paid_at timestamptz,notes text);
    CREATE TABLE membership_billing_agreements(id uuid primary key,tenant_id uuid,member_id uuid,status text);
    CREATE TABLE form(id uuid primary key,tenant_id uuid,fields jsonb,form_type text,is_anonymous boolean,due_diligence_required boolean);
    CREATE TABLE form_submission(id uuid primary key,tenant_id uuid,form_id uuid,entity_processing_completed_at timestamptz,
      created_member_id uuid,is_anonymous boolean,status text);
  `);
  await db.query(readFileSync('supabase/migrations/202612310090_member_date_terms.sql', 'utf8'));
  await db.query('insert into member(id,tenant_id) values($1,$2)', [member, tenant]);
  await db.query(`insert into preference_field values($1,$2,'member','date',true,null)`, [field, tenant]);
  await db.query(`insert into membership_tier_config(id,tenant_id,structure_scope_type,pricing_model,flat_cost,term_end_mode,term_end_field_id)
    values($1,$2,'member','flat',0,'member_date_field',$3)`, [config, tenant, field]);
  for (const assignment of ["flat_cost=1", "structure_scope_type='organization'", "dd_enabled=true", "term_end_field_id=null", "term_end_mode='wrong'"]) {
    await rejects(`update membership_tier_config set ${assignment} where id=$1`, [config]);
  }
  const snapshot = { version: 1, type: 'member_date_field', tenant_id: tenant, member_id: member, field_id: field, end_date: '2028-06-30', grace_days: 0 };
  const insert = `insert into member_membership_history(id,tenant_id,member_id,config_id,annual_cost,final_cost,total_with_vat,
    term_start_date,term_end_date,membership_renewal_date,status,payment_status,term_source_snapshot)
    values($1,$2,$3,$4,0,0,0,'2026-11-08','2028-06-30','2028-07-01','active','paid',$5)`;
  await db.query(insert, [history, tenant, member, config, snapshot]);
  checks++;
  await rejects(insert, ['00000000-0000-4000-8000-000000000006', tenant, member, config, snapshot]);
  await rejects(`update membership_tier_config set term_end_mode='standard',term_end_field_id=null where id=$1`, [config]);
  await rejects(`update member_membership_history set term_end_date='2029-06-30',membership_renewal_date='2029-07-01' where id=$1`, [history]);
  await rejects(`update member_membership_history set term_source_snapshot=null where id=$1`, [history]);
  const call = 'select extend_member_date_term($1,$2,$3,$4,$5,$6,$7) result';
  const args = [tenant, member, history, '2028-06-30', '2029-06-30', 'admin', 'Course extended'];
  await rejects(call, [...args.slice(0, 6), '']);
  await rejects(call, [tenant, member, history, '2028-06-29', ...args.slice(4)]);
  await rejects(call, ['00000000-0000-4000-8000-000000000099', ...args.slice(1)]);
  await db.query('set role authenticated');
  await rejects(call, args);
  await rejects('select * from member_date_term_extension');
  await db.query('reset role');
  await db.query('set role service_role');
  const result = await db.query(call, args);
  assert.equal(result.rows[0].result.term_end_date, '2029-06-30');
  checks++;
  await db.query('reset role');
  const saved = (await db.query('select term_source_snapshot,term_end_date::text from member_membership_history where id=$1', [history])).rows[0];
  assert.equal(saved.term_end_date, '2029-06-30');
  assert.equal(saved.term_source_snapshot.end_date, '2028-06-30');
  assert.equal((await db.query('select count(*) from member_date_term_extension')).rows[0].count, '1');
  await rejects(call, args);
  checks++;
  await db.query(readFileSync('supabase/migrations/202612310091_form_member_date_terms.sql', 'utf8'));
  const student = '00000000-0000-4000-8000-000000000012';
  const form = '00000000-0000-4000-8000-000000000020';
  const submission = '00000000-0000-4000-8000-000000000021';
  await db.query('insert into member(id,tenant_id) values($1,$2)', [student, tenant]);
  await db.query(`insert into member_preference_value values($1,$2,'2030-06-30')`, [student, field]);
  await db.query(`insert into form(id,tenant_id,fields,due_diligence_required,date_membership_config_id)
    values($1,$2,'[]',true,$3)`, [form, tenant, config]);
  await rejects(`update form set fields='[{"type":"payment"}]' where id=$1`, [form]);
  await db.query(`insert into form_submission values($1,$2,$3,now(),$4,false,'pending')`, [submission, tenant, form, student]);
  assert.equal((await db.query('select count(*) from member_membership_history where member_id=$1', [student])).rows[0].count, '0');
  await db.query(`update form_submission set status='approved' where id=$1`, [submission]);
  const granted = (await db.query('select * from member_membership_history where member_id=$1', [student])).rows;
  assert.equal(granted.length, 1);
  assert.equal(granted[0].term_source_snapshot.submission_id, submission);
  await db.query(`update form_submission set status='approved' where id=$1`, [submission]);
  assert.equal((await db.query('select count(*) from member_membership_history where member_id=$1', [student])).rows[0].count, '1');
  await rejects('update form_submission set created_member_id=$1 where id=$2', [member, submission]);
  checks += 4;
  const oldSubmission = '00000000-0000-4000-8000-000000000022';
  await db.query(`update form set date_membership_config_id=null where id=$1`, [form]);
  await db.query(`insert into form_submission values($1,$2,$3,now(),$4,false,'approved')`, [oldSubmission, tenant, form, student]);
  await db.query('update form set date_membership_config_id=$1 where id=$2', [config, form]);
  await db.query(`update form_submission set status='approved' where id=$1`, [oldSubmission]);
  assert.equal((await db.query('select count(*) from form_date_membership_completion where submission_id=$1', [oldSubmission])).rows[0].count, '0');
  checks++;
  await db.query('grant all on member_membership_history,membership_tier_config,member,preference_field to authenticated');
  await db.query('set role authenticated');
  await rejects(`update membership_tier_config set flat_cost=0 where id=$1`, [config]);
  await rejects(`update member_membership_history set notes='forged' where id=$1`, [history]);
  await db.query('reset role');
  await rejects(`update preference_field set field_type='text' where id=$1`, [field]);
  console.log(`PASS: ${checks} member date-term database protection checks.`);
} finally {
  await db?.end();
  if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
}
