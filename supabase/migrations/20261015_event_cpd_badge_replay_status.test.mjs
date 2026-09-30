import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('./20261015_event_cpd_badge_replay_status.sql', import.meta.url), 'utf8');

test('latest badge replay status is tenant and event scoped and returns aggregates only', () => {
  assert.match(sql, /event_cpd_badge_outbox\(tenant_id,idempotency_key text_pattern_ops\)/);
  assert.match(sql, /WHERE tenant_id=p_tenant_id AND event_type=p_event_type AND event_id=p_event_id/);
  assert.match(sql, /ORDER BY created_at DESC,id DESC/);
  assert.match(sql, /status IN \('pending','processing'\)/);
  assert.match(sql, /status='complete'/);
  assert.match(sql, /status='retry'/);
  assert.match(sql, /status='dead'/);
  assert.match(sql, /idempotency_key LIKE 'badge-replay:'\|\|v_replay\.id::text\|\|':%'/);
  const responseFields = sql.slice(sql.indexOf('jsonb_build_object('), sql.indexOf(') INTO v_status'));
  assert.doesNotMatch(responseFields, /booking_id|member_id|attendee/);
});

test('latest badge replay status is service only', () => {
  assert.match(sql, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_latest_event_cpd_badge_replay_status/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_latest_event_cpd_badge_replay_status[\s\S]*TO service_role/);
});