import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outboxMigration = fileURLToPath(
  new URL('./20261020_form_due_diligence_field_mapping_workflow_outbox.sql', import.meta.url),
);
const atomicMigration = fileURLToPath(
  new URL('./20261021_form_due_diligence_field_mapping_outbox_atomic.sql', import.meta.url),
);
const scopeMigration = fileURLToPath(
  new URL('./20261022_form_due_diligence_field_mapping_outbox_preference_scope.sql', import.meta.url),
);

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('atomic preference mapping SQL rejects a cross-tenant field before any write', { timeout: 45_000 }, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) return t.skip('PostgreSQL command-line tools are unavailable');

  const root = await mkdtemp(path.join(tmpdir(), 'dd-pref-scope-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  const port = String(35000 + (process.pid % 10000));
  const conn = ['-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'];
  let started = false;
  try {
    run('mkdir', ['-p', socket]);
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    run(psql, conn, { input: `
      CREATE EXTENSION pgcrypto; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form_submission_due_diligence (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
      CREATE TABLE organization (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text, email text, invoicing_email text,
        phone text, website_url text, description text, logo_url text, invoicing_address text, address jsonb
      );
      CREATE TABLE preference_field (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_scope text NOT NULL, is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE organization_preference_value (
        organization_id uuid NOT NULL, field_id uuid NOT NULL, value text, updated_at timestamptz,
        PRIMARY KEY (organization_id, field_id)
      );
      INSERT INTO form_submission_due_diligence VALUES
        ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');
      INSERT INTO organization VALUES
        ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');
      INSERT INTO preference_field VALUES
        ('40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','organization',true);
    ` });
    run(psql, [...conn, '-f', outboxMigration]);
    run(psql, [...conn, '-f', atomicMigration]);
    run(psql, [...conn, '-f', scopeMigration]);

    const rejected = spawnSync(psql, conn, {
      encoding: 'utf8',
      input: `SELECT apply_form_due_diligence_field_mapping_with_outbox(
        '20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        'preference:cross-tenant:0', 'preference',
        '30000000-0000-4000-8000-000000000001',
        '{}',
        '40000000-0000-4000-8000-000000000001', 'forbidden'
      );`,
    });
    assert.notEqual(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stderr, /organization preference field is not tenant-owned/);

    const scalar = input => run(psql, [...conn, '-t', '-A'], { input });
    assert.equal(scalar('SELECT count(*) FROM organization_preference_value'), '0');
    assert.equal(scalar('SELECT count(*) FROM form_due_diligence_field_mapping_workflow_outbox'), '0');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
  }
});