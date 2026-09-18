import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const run = (command, args, input = '') => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
test('diagnostic RPC preserves metadata, blocks stale unblocking, notes once, and pending selection stays fair', async () => {
  const initdb = executable('initdb'), pgCtl = executable('pg_ctl'), psql = executable('psql');
  assert.ok(initdb && pgCtl && psql, 'Isolated PostgreSQL tools required; no remote fallback');
  const root = await mkdtemp(path.join(tmpdir(), 'gc-form-context-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  try {
    run(initdb, ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const sql = statement => run(psql, args, statement);
    const tenant = '10000000-0000-4000-8000-000000000001';
    const id = '20000000-0000-4000-8000-000000000001';
    const migration = fileURLToPath(new URL('../../supabase/migrations/20261111_form_gocardless_reconciliation_context.sql', import.meta.url));
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form_submission (
        id uuid PRIMARY KEY, tenant_id uuid, payment_status text, payment_provider text,
        payment_meta jsonb, processing_notes jsonb, created_date timestamptz DEFAULT now()
      );
      \\i ${migration}
      INSERT INTO form_submission(id,tenant_id,payment_status,payment_provider,payment_meta,processing_notes)
      VALUES('${id}','${tenant}','pending','gocardless',
        '{"gc_provider_context":{"environment":"sandbox"},"webhook":{"preserve":true}}','[{"kind":"existing"}]');
    `);
    const record = diagnostic => sql(`SET ROLE service_role; SELECT record_form_gocardless_reconciliation('${tenant}','${id}','${JSON.stringify(diagnostic)}');`);
    assert.equal(record({ status: 'retry', attempts: 1 }), 't');
    // A webhook's intervening metadata patch must survive the diagnostic write.
    sql(`UPDATE form_submission SET payment_meta = payment_meta || '{"confirmation":{"preserve":true}}';`);
    assert.equal(record({ status: 'blocked', reason: 'provider_resource_not_found', attempts: 5 }), 't');
    assert.equal(record({ status: 'waiting', attempts: 0 }), 'f');
    assert.equal(record({ status: 'blocked', reason: 'provider_resource_not_found', attempts: 5 }), 'f');
    const result = JSON.parse(sql(`SELECT row_to_json(s) FROM form_submission s WHERE id='${id}';`));
    assert.equal(result.payment_status, 'pending');
    assert.equal(result.payment_meta.gc_provider_context.environment, 'sandbox');
    assert.equal(result.payment_meta.confirmation.preserve, true);
    assert.equal(result.payment_meta.webhook.preserve, true);
    assert.equal(result.processing_notes.length, 2);
    assert.equal(result.processing_notes[1].kind, 'gocardless_reconciliation_blocked');
    sql(`INSERT INTO form_submission(id,tenant_id,payment_status,payment_provider,payment_meta,created_date)
      SELECT ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, '${tenant}',
        'pending','gocardless',CASE WHEN n < 25 THEN '{"gc_reconciliation":{"status":"blocked"}}'::jsonb ELSE '{}'::jsonb END,
        now() + n * interval '1 second' FROM generate_series(2,25) n;`);
    assert.equal(sql(`SELECT count(*) FROM (
      SELECT id FROM form_submission WHERE payment_status='pending'
      AND (payment_meta->'gc_reconciliation'->>'status' IS NULL OR payment_meta->'gc_reconciliation'->>'status' <> 'blocked')
      AND (payment_meta->'gc_reconciliation'->>'next_attempt_at' IS NULL OR payment_meta->'gc_reconciliation'->>'next_attempt_at' <= '2026-09-07T00:00:00.000Z')
      ORDER BY created_date,id LIMIT 1) selected;`), '1');
    sql(`UPDATE form_submission SET payment_status='paid' WHERE id='${id}';`);
    assert.equal(record({ status: 'retry' }), 'f');
    const unauthorized = spawnSync(psql, args, {
      input: `SET ROLE authenticated; SELECT record_form_gocardless_reconciliation('${tenant}','${id}','{"status":"retry"}');`,
      encoding: 'utf8',
    });
    assert.notEqual(unauthorized.status, 0);
    assert.match(unauthorized.stderr, /permission denied/);
  } finally {
    if (started) run(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});