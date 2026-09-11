import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationUrl = new URL('./20261018_form_due_diligence_initialization.sql', import.meta.url);
const migrationPath = fileURLToPath(migrationUrl);
const attentionMigrationUrl = new URL('./20261019_form_due_diligence_expired_processing_attention.sql', import.meta.url);
const attentionMigrationPath = fileURLToPath(attentionMigrationUrl);
const workflowOutboxMigrationUrl = new URL('./20261020_form_due_diligence_field_mapping_workflow_outbox.sql', import.meta.url);
const workflowOutboxMigrationPath = fileURLToPath(workflowOutboxMigrationUrl);
const oneOffReadyMigrationPath = fileURLToPath(new URL('./20261021_form_due_diligence_one_off_ready.sql', import.meta.url));
const oneOffRecoveryMigrationPath = fileURLToPath(new URL('./20261022_form_due_diligence_one_off_ready_recovery.sql', import.meta.url));
const oneOffRecoverySafetyMigrationPath = fileURLToPath(new URL('./20261023_form_due_diligence_one_off_ready_recovery_safety.sql', import.meta.url));
const sql = await readFile(migrationUrl, 'utf8');
const attentionSql = await readFile(attentionMigrationUrl, 'utf8');
const workflowOutboxSql = await readFile(workflowOutboxMigrationUrl, 'utf8');

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('paid DD eligibility is INSERT-only and anonymous-safe', () => {
  assert.match(sql, /AFTER INSERT ON public\.form_submission/i);
  assert.match(sql, /NEW\.payment_status IS DISTINCT FROM 'pending'/);
  assert.match(sql, /NEW\.is_anonymous/);
  assert.match(sql, /survey_settings->>'response_identity'/);
  assert.doesNotMatch(sql, /^\s*UPDATE public\.form_submission/im);
});

test('DD lifecycle has a tenant-bound claim, retry state and durable action checkpoints', () => {
  assert.match(sql, /form_due_diligence_action_checkpoint/);
  assert.match(sql, /PRIMARY KEY \(form_submission_due_diligence_id, action_key\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /requires_attention/);
  assert.match(sql, /IF p_paid_only THEN[\s\S]*?v_lifecycle\.paid_eligible IS NOT TRUE/);
  assert.match(sql, /list_form_due_diligence_paid_initialization_work/);
  assert.match(sql, /PAYMENT_NOT_SUCCESSFUL/);
  assert.match(sql, /submission\.payment_status = 'paid'/);
  assert.match(sql, /record_form_due_diligence_claim_failure/);
  assert.match(sql, /JOIN public\.form form_row/);
  assert.match(sql, /NOT COALESCE\(submission\.is_anonymous, FALSE\)/);
});

test('expired paid processing leases are bounded into manual attention, never replayed', () => {
  assert.match(attentionSql, /state = 'requires_attention'/);
  assert.match(attentionSql, /FOR UPDATE SKIP LOCKED/);
  assert.match(attentionSql, /LIMIT LEAST\(GREATEST\(p_limit, 1\), 100\)/);
  assert.match(attentionSql, /external action completion is ambiguous/i);
});

test('field-mapping workflow outbox is tenant-private and deduplicated per DD event', () => {
  assert.match(workflowOutboxSql, /UNIQUE \(form_submission_due_diligence_id, event_key\)/);
  assert.match(workflowOutboxSql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(workflowOutboxSql, /REVOKE ALL ON TABLE[\s\S]*?anon, authenticated/);
  assert.match(workflowOutboxSql, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*?TO service_role/);
});

test('isolated SQL fixture marks only new eligible pending rows and excludes completed work', { timeout: 45_000 }, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) return t.skip('PostgreSQL command-line tools are unavailable');
  const root = await mkdtemp(path.join(tmpdir(), 'dd-init-rpc-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  const port = String(25000 + (process.pid % 10000));
  run('mkdir', ['-p', socket]);
  const conn = ['-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'];
  let started = false;
  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    run(psql, conn, { input: `
      CREATE EXTENSION pgcrypto; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, due_diligence_required boolean, form_type text, survey_settings jsonb);
      CREATE TABLE form_submission (
        id uuid PRIMARY KEY, form_id uuid NOT NULL, tenant_id uuid NOT NULL, submission_data jsonb,
        payment_status text, payment_provider text, payment_meta jsonb DEFAULT '{}', is_anonymous boolean DEFAULT false
      );
      CREATE TABLE form_submission_due_diligence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), form_submission_id uuid UNIQUE NOT NULL,
        tenant_id uuid NOT NULL, application_uid text, original_form_values jsonb, reviewed_form_values jsonb,
        field_review_status jsonb, workflow_status text, history_log jsonb
      );
       CREATE TABLE organization (id uuid PRIMARY KEY);
      CREATE TABLE form_due_diligence_config (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), form_id uuid NOT NULL,
        tenant_id uuid NOT NULL, workflow_stages jsonb
      );
      INSERT INTO form VALUES ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true,'standard','{}');
      -- A qualifying historical row exists before the migration, and must not be marked.
      INSERT INTO form_submission VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','{}','pending','stripe','{}',false);
    ` });
    run(psql, [...conn, '-f', migrationPath]);
    run(psql, [...conn, '-f', attentionMigrationPath]);
    run(psql, [...conn, '-f', workflowOutboxMigrationPath]);
    run(psql, [...conn, '-f', oneOffReadyMigrationPath]);
    run(psql, [...conn, '-f', oneOffRecoveryMigrationPath]);
    run(psql, [...conn, '-f', oneOffRecoverySafetyMigrationPath]);
    const scalar = input => run(psql, [...conn, '-t', '-A'], { input });
    assert.equal(scalar('SELECT count(*) FROM form_due_diligence_field_mapping_workflow_outbox'), '0');
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class
      WHERE oid='form_due_diligence_field_mapping_workflow_outbox'::regclass`), 't');
    assert.equal(scalar(`SELECT has_table_privilege(
      'service_role', 'form_due_diligence_field_mapping_workflow_outbox', 'SELECT')`), 't');
    assert.equal(scalar(`SELECT has_table_privilege(
      'anon', 'form_due_diligence_field_mapping_workflow_outbox', 'SELECT')`), 'f');
    run(psql, conn, { input: `
      INSERT INTO organization VALUES ('50000000-0000-4000-8000-000000000001');
      INSERT INTO form_submission_due_diligence (id,form_submission_id,tenant_id) VALUES
        ('40000000-0000-4000-8000-000000000001',
         '20000000-0000-4000-8000-000000000099',
         '00000000-0000-4000-8000-000000000001');
      INSERT INTO form_due_diligence_field_mapping_workflow_outbox
        (form_submission_due_diligence_id,tenant_id,event_key,event_type,organization_id,payload)
      VALUES ('40000000-0000-4000-8000-000000000001',
              '00000000-0000-4000-8000-000000000001','core:organization','core',
              '50000000-0000-4000-8000-000000000001','{}');
    ` });
    const duplicate = spawnSync(psql, conn, {
      input: `INSERT INTO form_due_diligence_field_mapping_workflow_outbox
        (form_submission_due_diligence_id,tenant_id,event_key,event_type,organization_id,payload)
      VALUES ('40000000-0000-4000-8000-000000000001',
              '00000000-0000-4000-8000-000000000001','core:organization','core',
              '50000000-0000-4000-8000-000000000001','{}');`,
      encoding: 'utf8',
    });
    assert.notEqual(duplicate.status, 0, 'duplicate outbox event key must be rejected');
    assert.equal(scalar('SELECT count(*) FROM form_due_diligence_initialization'), '0');
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization(
      '00000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000009',false)`), /PAYMENT_LIFECYCLE_REQUIRES_MARKER/);
    assert.equal(scalar('SELECT count(*) FROM form_due_diligence_initialization'), '0');
    run(psql, conn, { input: `
      INSERT INTO form_submission VALUES ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','{"answer":"yes"}','pending','stripe','{}',false);
      INSERT INTO form_submission VALUES ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','{}','pending','stripe','{}',true);
      INSERT INTO form_submission VALUES ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','{}','failed','stripe','{}',false);
    ` });
    assert.equal(scalar('SELECT count(*) FROM form_due_diligence_initialization WHERE paid_eligible'), '1');
    assert.equal(scalar('SELECT count(*) FROM list_form_due_diligence_paid_initialization_work(20)'), '0');
    const tenant = '00000000-0000-4000-8000-000000000001';
    const otherTenant = '00000000-0000-4000-8000-000000000099';
    const sub = '20000000-0000-4000-8000-000000000002';
    const token = '30000000-0000-4000-8000-000000000001';
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${otherTenant}','${sub}','30000000-0000-4000-8000-000000000099',true)`), /SUBMISSION_NOT_FOUND/);
    assert.equal(scalar('SELECT count(*) FROM form_due_diligence_initialization'), '1');
    assert.equal(scalar(`SELECT count(*) FROM form_submission_due_diligence WHERE form_submission_id='${sub}'`), '0');
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','${sub}','${token}',true)`), /PAYMENT_NOT_SUCCESSFUL/);
    assert.equal(scalar(`SELECT count(*) FROM form_submission_due_diligence WHERE form_submission_id='${sub}'`), '0');
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','20000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000004',false)`), /PAYMENT_LIFECYCLE_REQUIRES_MARKER/);
    assert.equal(scalar(`SELECT count(*) FROM form_submission_due_diligence WHERE form_submission_id='20000000-0000-4000-8000-000000000004'`), '0');
    scalar(`UPDATE form_submission SET payment_status='paid' WHERE id='${sub}'`);
    // This is the reconciliation/finalizer race: payment is durable, but DD
    // must not claim before finalization records the one-off ready marker.
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','${sub}','${token}',true)`), /ONE_OFF_NOT_READY/);
    assert.equal(scalar('SELECT count(*) FROM list_form_due_diligence_paid_initialization_work(20)'), '0');
    assert.equal(scalar(`SELECT mark_one_off_form_due_diligence_ready('${tenant}','${sub}')`), 't');
    assert.equal(scalar('SELECT count(*) FROM list_form_due_diligence_paid_initialization_work(20)'), '1');
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','${sub}','${token}',true)`), /"claimed": true/);
    assert.equal(scalar(`SELECT workflow_status FROM form_submission_due_diligence WHERE form_submission_id='${sub}'`), 'new');
    assert.equal(scalar(`SELECT original_form_values->>'answer' FROM form_submission_due_diligence WHERE form_submission_id='${sub}'`), 'yes');
    assert.equal(scalar(`SELECT reviewed_form_values->>'answer' FROM form_submission_due_diligence WHERE form_submission_id='${sub}'`), 'yes');
    assert.equal(scalar(`SELECT field_review_status::text FROM form_submission_due_diligence WHERE form_submission_id='${sub}'`), '{}');
    assert.equal(scalar(`SELECT history_log->0->>'event_type' FROM form_submission_due_diligence WHERE form_submission_id='${sub}'`), 'submission_received');
    const ddId = scalar(`SELECT due_diligence_submission_id FROM form_due_diligence_initialization WHERE form_submission_id='${sub}'`);
    scalar(`SELECT checkpoint_form_due_diligence_actions('${tenant}','${sub}','${token}',ARRAY['email:one'])`);
    scalar(`SELECT finish_form_due_diligence_initialization('${tenant}','${sub}','${token}',false,'known send failure',false)`);
    assert.equal(scalar(`SELECT count(*) FROM form_due_diligence_action_checkpoint WHERE form_submission_due_diligence_id='${ddId}'`), '1');
    scalar(`UPDATE form_due_diligence_initialization SET next_attempt_at = NOW() - INTERVAL '1 second'
      WHERE form_submission_id='${sub}'`);
    const retryToken = '30000000-0000-4000-8000-000000000002';
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','${sub}','${retryToken}',true)`), /"claimed": true/);
    assert.equal(scalar(`SELECT due_diligence_submission_id FROM form_due_diligence_initialization WHERE form_submission_id='${sub}'`), ddId);
    assert.equal(scalar(`SELECT count(*) FROM form_due_diligence_action_checkpoint WHERE form_submission_due_diligence_id='${ddId}'`), '1');
    scalar(`SELECT finish_form_due_diligence_initialization('${tenant}','${sub}','${retryToken}',true)`);
    assert.equal(scalar('SELECT count(*) FROM list_form_due_diligence_paid_initialization_work(20)'), '0');
    // A lease that expires after DD creation is not replay-safe. The bounded
    // reconciliation transition makes it visible as manual attention and a
    // later claim cannot execute the same DD record again.
    const interruptedSub = '20000000-0000-4000-8000-000000000008';
    const interruptedToken = '30000000-0000-4000-8000-000000000008';
    run(psql, conn, { input: `
      INSERT INTO form_submission VALUES (
        '${interruptedSub}','10000000-0000-4000-8000-000000000001',
        '${tenant}','{}','pending','stripe','{}',false
      );
      UPDATE form_submission SET payment_status='paid' WHERE id='${interruptedSub}';
    ` });
    assert.equal(scalar(`SELECT mark_one_off_form_due_diligence_ready('${tenant}','${interruptedSub}')`), 't');
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','${interruptedSub}','${interruptedToken}',true)`), /"claimed": true/);
    const interruptedDdId = scalar(`SELECT due_diligence_submission_id FROM form_due_diligence_initialization WHERE form_submission_id='${interruptedSub}'`);
    scalar(`SELECT checkpoint_form_due_diligence_actions('${tenant}','${interruptedSub}','${interruptedToken}',ARRAY['email:before-crash'])`);
    scalar(`UPDATE form_due_diligence_initialization
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE form_submission_id='${interruptedSub}'`);
    assert.match(scalar('SELECT * FROM mark_expired_paid_form_due_diligence_attention(1)'), /20000000-0000-4000-8000-000000000008/);
    assert.equal(scalar(`SELECT state FROM form_due_diligence_initialization WHERE form_submission_id='${interruptedSub}'`), 'requires_attention');
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','${interruptedSub}','30000000-0000-4000-8000-000000000018',true)`), /REQUIRES_ATTENTION/);
    assert.equal(scalar(`SELECT due_diligence_submission_id FROM form_due_diligence_initialization WHERE form_submission_id='${interruptedSub}'`), interruptedDdId);
    assert.equal(scalar(`SELECT count(*) FROM form_due_diligence_action_checkpoint WHERE form_submission_due_diligence_id='${interruptedDdId}'`), '1');
    // A paid row finalized by a crashing one-off finalizer is claimed exactly
    // once for prerequisite recovery before the independent DD sweep.
    const recoverySub = '20000000-0000-4000-8000-000000000009';
    run(psql, conn, { input: `
      INSERT INTO form_submission VALUES (
        '${recoverySub}','10000000-0000-4000-8000-000000000001',
        '${tenant}','{}','pending','stripe','{}',false
      );
      UPDATE form_submission
         SET payment_status='paid', payment_meta='{"finalized":true}'
       WHERE id='${recoverySub}';
    ` });
    assert.equal(scalar('SELECT count(*) FROM claim_missing_one_off_form_due_diligence_ready(20)'), '0');
    scalar(`UPDATE form_due_diligence_initialization
      SET updated_at = NOW() - INTERVAL '11 minutes'
      WHERE form_submission_id='${recoverySub}'`);
    assert.match(scalar('SELECT * FROM claim_missing_one_off_form_due_diligence_ready(20)'), /20000000-0000-4000-8000-000000000009/);
    assert.equal(scalar('SELECT count(*) FROM claim_missing_one_off_form_due_diligence_ready(20)'), '0');
    assert.equal(scalar(`SELECT state FROM form_due_diligence_one_off_ready_recovery WHERE form_submission_id='${recoverySub}'`), 'processing');
    scalar(`UPDATE form_due_diligence_one_off_ready_recovery
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE form_submission_id='${recoverySub}'`);
    assert.match(scalar('SELECT * FROM mark_expired_missing_one_off_form_due_diligence_ready_attention(1)'), /20000000-0000-4000-8000-000000000009/);
    assert.equal(scalar(`SELECT state FROM form_due_diligence_one_off_ready_recovery WHERE form_submission_id='${recoverySub}'`), 'requires_attention');
    // Configured is_initial wins over array order; without one, the first
    // configured stage wins over the legacy `new` fallback.
    run(psql, conn, { input: `
      INSERT INTO form VALUES
        ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',true,'standard','{}'),
        ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',true,'standard','{}');
      INSERT INTO form_due_diligence_config (form_id,tenant_id,workflow_stages) VALUES
        ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',
         '[{"id":"first"},{"id":"configured","is_initial":true}]'),
        ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',
         '[{"id":"first"},{"id":"later"}]');
      INSERT INTO form_submission VALUES
        ('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','{}',NULL,NULL,'{}',false),
        ('20000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','{}',NULL,NULL,'{}',false);
    ` });
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','20000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000006',false)`), /"initial_stage_id": "configured"/);
    assert.match(scalar(`SELECT claim_form_due_diligence_initialization('${tenant}','20000000-0000-4000-8000-000000000007','30000000-0000-4000-8000-000000000007',false)`), /"initial_stage_id": "first"/);
    // Monthly setup_complete is not DD-ready until its independently durable
    // membership finalizer writes its terminal done marker.
    run(psql, conn, { input: `
      INSERT INTO form_submission VALUES (
        '20000000-0000-4000-8000-000000000005',
        '10000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        '{}','pending','stripe_monthly_card','{}',false
      );
      UPDATE form_submission
         SET payment_status='setup_complete',
             payment_meta='{"monthly_card_state":{"status":"processing"}}'
       WHERE id='20000000-0000-4000-8000-000000000005';
    ` });
    assert.equal(scalar('SELECT count(*) FROM list_form_due_diligence_paid_initialization_work(20)'), '0');
    scalar(`UPDATE form_submission
      SET payment_meta='{"monthly_card_state":{"status":"done"}}'
      WHERE id='20000000-0000-4000-8000-000000000005'`);
    assert.equal(scalar('SELECT count(*) FROM list_form_due_diligence_paid_initialization_work(20)'), '1');
    scalar(`UPDATE form SET due_diligence_required=false
      WHERE id='10000000-0000-4000-8000-000000000001'`);
    assert.equal(scalar('SELECT count(*) FROM list_form_due_diligence_paid_initialization_work(20)'), '0');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
  }
});