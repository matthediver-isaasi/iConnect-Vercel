import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('./20261012_event_cpd_points_awards.sql', import.meta.url), 'utf8');

test('ledger is tenant scoped, decimal safe, signed and immutable', () => {
  assert.match(sql, /CREATE TABLE public\.member_cpd_points_ledger/);
  assert.match(sql, /points_value numeric\(20,6\) NOT NULL/);
  assert.match(sql, /entry_kind IN \('event_award','reversal'\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.member_cpd_points_ledger/);
  assert.match(sql, /CPD points ledger entries are immutable/);
  assert.match(sql, /ALTER TABLE public\.member_cpd_points_ledger ENABLE ROW LEVEL SECURITY/);
});

test('simple and complex rules validate decimal values and ticket ownership', () => {
  assert.match(sql, /NEW\.event_type='event'/);
  assert.match(sql, /jsonb_array_elements\([\s\S]*pricing_config->'ticket_classes'/);
  assert.match(sql, /FROM complex_event_ticket_class/);
  assert.match(sql, /\^\[0-9\]\{1,14\}\(\[\.\]\[0-9\]\{1,6\}\)\?\$/);
  assert.match(sql, /points_value >= 0/);
  assert.match(sql, /\(tenant_id,event_type,event_id,ticket_id\) WHERE ticket_id IS NOT NULL AND active/);
});

test('registration and QR/Zoom/Teams attendance use independent points hooks', () => {
  assert.match(sql, /CREATE TRIGGER enqueue_event_cpd_points_booking AFTER INSERT OR UPDATE OF status ON public\.booking/);
  assert.match(sql, /CREATE TRIGGER enqueue_event_cpd_points_complex_booking AFTER INSERT OR UPDATE OF status ON public\.complex_event_booking/);
  assert.match(sql, /CREATE TRIGGER enqueue_event_cpd_points_simple_checkin AFTER INSERT OR UPDATE OF checked_in_at ON public\.booking/);
  assert.match(sql, /CREATE TRIGGER enqueue_event_cpd_points_complex_checkin AFTER INSERT OR UPDATE OF checked_in_at ON public\.complex_event_session_checkin/);
  assert.match(sql, /NEW\.provider NOT IN \('zoom','teams'\)/);
  assert.match(sql, /CREATE TRIGGER enqueue_event_cpd_points_online_attendance AFTER INSERT ON public\.attendance_outcome_transition/);
  assert.doesNotMatch(sql, /event_cpd_badge_outbox/);
});

test('transactional award handles precedence, cancellation, unmatched and cross tenant', () => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.record_event_cpd_points_award');
  const body = sql.slice(start, sql.indexOf('END $$;', start));
  assert.match(body, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(body, /v_status:='skipped_cancelled'/);
  assert.match(body, /v_status:='skipped_unmatched'/);
  assert.match(body, /'skipped_cross_tenant'/);
  assert.match(body, /NOT EXISTS \(SELECT 1 FROM event_cpd_points_rule x[\s\S]*x\.ticket_id=v_ticket/);
  assert.match(body, /v_rule\.trigger_type IS DISTINCT FROM p_attempt->>'trigger_type'/);
  assert.match(body, /INSERT INTO member_cpd_points_ledger[\s\S]*INSERT INTO event_cpd_points_award_attempt/);
});

test('award occurrence and delivery keys are retry idempotent', () => {
  assert.match(sql, /UNIQUE\(tenant_id,idempotency_key,delivery_attempt\)/);
  assert.match(sql, /status NOT IN \('pending_evidence','error'\)/);
  assert.match(sql, /COALESCE\(max\(delivery_attempt\),0\)\+1/);
  assert.match(sql, /uq_member_cpd_points_event_occurrence/);
  assert.match(sql, /v_occurrence:=v_event_type\|\|':'\|\|v_event_id\|\|':'\|\|v_booking_type/);
  assert.match(sql, /ON CONFLICT\(tenant_id,idempotency_key\) DO NOTHING/g);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
});

test('cancellation, QR reversal and online downgrade append policy follow-ups', () => {
  assert.match(sql, /'booking_cancellation','qr_reversal','attendance_downgrade','manual'/);
  assert.match(sql, /CREATE TRIGGER followup_event_cpd_points_booking AFTER UPDATE OF status ON public\.booking/);
  assert.match(sql, /CREATE TRIGGER followup_event_cpd_points_complex_booking AFTER UPDATE OF status ON public\.complex_event_booking/);
  assert.match(sql, /CREATE TRIGGER followup_event_cpd_points_simple_qr AFTER UPDATE OF check_in_reversed_at ON public\.booking/);
  assert.match(sql, /CREATE TRIGGER followup_event_cpd_points_online_downgrade/);
  assert.match(sql, /append_event_cpd_points_reversal/);
  assert.match(
    sql,
    /evidence_snapshot->>'attendanceTargetId'=NEW\.attendance_target_id::text/,
    'an unrelated attendance target must not reverse this award',
  );
});

test('reconfirmation gets new delivery work while occurrence remains exactly once', () => {
  assert.match(sql, /'registration:'\|\|v_type\|\|':'\|\|NEW\.id\|\|':'\|\|clock_timestamp\(\)::text/);
  assert.match(sql, /uq_member_cpd_points_event_occurrence/);
});

test('controlled tenant and event scoped replay supports registration and current attendance', () => {
  assert.match(sql, /CREATE TABLE public\.event_cpd_points_replay/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.enqueue_event_cpd_points_replay/);
  assert.match(sql, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(sql, /FROM attendance_current_outcome o/);
  assert.match(sql, /FROM complex_event_session_checkin c/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.enqueue_event_cpd_points_replay/);
});

test('current evidence is revalidated and reversals append follow-up history', () => {
  assert.match(sql, /v_checked IS DISTINCT FROM v_queued/);
  assert.match(sql, /v_checked<=v_reversed/);
  assert.match(sql, /FROM attendance_current_outcome[\s\S]*FOR UPDATE/);
  assert.match(sql, /v_current_revision::text IS DISTINCT FROM \(v_evidence->>'revisionId'\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reverse_event_cpd_points_award/);
  assert.match(sql, /'reversal',-v_award\.points_value/);
  assert.match(sql, /CREATE TABLE public\.event_cpd_points_followup/);
  assert.match(sql, /uq_member_cpd_points_reversal/);
});

test('all mutating and processing RPCs are service-role only', () => {
  for (const name of [
    'replace_event_cpd_points_rules',
    'record_event_cpd_points_award',
    'reverse_event_cpd_points_award',
  ]) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const body = sql.slice(start, sql.indexOf('END $$;', start));
    assert.ok(start >= 0);
    assert.match(body, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}`));
  }
  assert.match(sql, /FROM PUBLIC,anon,authenticated/);
});