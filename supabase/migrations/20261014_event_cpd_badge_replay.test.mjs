import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('./20261014_event_cpd_badge_replay.sql', import.meta.url), 'utf8');

test('badge replay is audited, tenant scoped and service only', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.event_cpd_badge_replay/);
  assert.match(sql, /requested_by text NOT NULL/);
  assert.match(sql, /rule_snapshot jsonb NOT NULL/);
  assert.match(sql, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(sql, /event does not belong to tenant/);
  assert.match(sql, /complex event does not belong to tenant/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.enqueue_event_cpd_badge_replay/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.enqueue_event_cpd_badge_replay[\s\S]*TO service_role/);
});

test('one replay rebuilds both trigger types and every supported current attendance source', () => {
  assert.match(sql, /'registration','confirmed_booking'/);
  assert.match(sql, /'attendance','qr_checkin'/);
  assert.match(sql, /FROM complex_event_session_checkin c[\s\S]*JOIN complex_event_session s/);
  assert.match(sql, /FROM attendance_current_outcome o/);
  assert.match(sql, /o\.provider IN \('zoom','teams'\)/);
  assert.match(sql, /o\.status='attended'/);
  assert.match(sql, /'revisionId',o\.outcome_revision_id/);
  assert.match(sql, /'attendanceTargetId',o\.attendance_target_id/);
});

test('replay snapshots saved rules under the shared configuration lock and queues asynchronously', () => {
  const lock = sql.indexOf("p_tenant_id::text||':'||p_event_type||':'||p_event_id::text");
  const snapshot = sql.indexOf('jsonb_agg(to_jsonb(r)');
  assert.ok(lock >= 0 && snapshot > lock);
  assert.match(sql, /INSERT INTO event_cpd_badge_outbox/g);
  assert.match(sql, /ON CONFLICT\(tenant_id,idempotency_key\) DO NOTHING/g);
  assert.doesNotMatch(sql, /INSERT INTO member_badge/);
});