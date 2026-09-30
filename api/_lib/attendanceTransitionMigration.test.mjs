import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../../supabase/migrations/20260830_attendance_transition_outbox.sql', import.meta.url),
  'utf8',
);

test('attendance replacement preserves its RPC contract and atomically enqueues new revisions', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION replace_attendance_report_snapshot\s*\(\s*p_tenant_id uuid, p_provider text, p_idempotency_key text, p_snapshot jsonb\s*\)\s*RETURNS TABLE\(target_id uuid, sync_run_id uuid\)/);
  const newRevisionBranch = migration.match(/IF v_current_fingerprint IS DISTINCT FROM v_fingerprint THEN([\s\S]*?)END IF;/)?.[1] || '';
  assert.match(newRevisionBranch, /INSERT INTO attendance_outcome_revision/);
  assert.match(newRevisionBranch, /INSERT INTO attendance_outcome_transition/);
  assert.match(newRevisionBranch, /INSERT INTO attendance_transition_outbox/);
});

test('a correction back to a previously seen result creates a new revision', () => {
  assert.match(migration, /DROP CONSTRAINT %I/);
  assert.match(migration, /pg_get_constraintdef\(c\.oid\) ILIKE '%result_fingerprint%'/);
  assert.match(migration, /v_current_fingerprint IS DISTINCT FROM v_fingerprint/);
  assert.doesNotMatch(
    migration,
    /WHERE r\.tenant_id=p_tenant_id[\s\S]{0,300}r\.result_fingerprint=v_fingerprint/,
  );
});

test('transition payload is provider-neutral and carries workflow identifiers', () => {
  for (const field of [
    "'event'", "'target'", "'booking'", "'member'", "'ticket'", "'provider'",
    "'durationSeconds'", "'thresholdMinutes'", "'status'", "'revision'",
  ]) {
    assert.ok(migration.includes(field), `missing transition payload field ${field}`);
  }
});

test('outbox claims include stale-processing recovery and skip locked concurrency', () => {
  assert.match(migration, /status='processing' AND o\.locked_at < now\(\) - interval '10 minutes'/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /status='published'/);
  assert.match(migration, /THEN 'dead' ELSE 'retry'/);
});

test('blocked workflow recovery acknowledges without replay and requeues the outbox', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION acknowledge_attendance_workflow_delivery/);
  assert.match(migration, /Tenant admin acknowledged without replay/);
  assert.match(migration, /delivery_key IN \(v_transition_key,v_once_key\)/);
  assert.match(migration, /o\.status IN \('retry','dead'\)[\s\S]*FOR UPDATE OF o/);
  assert.match(migration, /SET status='pending', attempts=0/);
  assert.match(migration, /status IN \('retry','dead'\)/);
  assert.match(migration, /recovery state changed/);
  assert.match(migration, /operator_acknowledged_without_replay/);
  assert.match(migration, /will not be replayed/);
});