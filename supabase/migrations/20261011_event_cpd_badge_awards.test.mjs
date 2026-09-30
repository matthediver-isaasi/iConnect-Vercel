import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('./20261011_event_cpd_badge_awards.sql', import.meta.url), 'utf8');

test('CPD rule migration archives before validating live ticket and badge references', () => {
  const archiveGuard = sql.indexOf("IF TG_OP='UPDATE' AND NOT NEW.active THEN");
  const eventValidation = sql.indexOf("IF NEW.event_type='event' THEN");
  assert.ok(archiveGuard >= 0 && archiveGuard < eventValidation);
  assert.match(sql, /NEW\.ticket_id := OLD\.ticket_id/);
  assert.match(sql, /NEW\.badge_name_snapshot := OLD\.badge_name_snapshot/);
});

test('CPD rule migration makes ticket scope trigger-independent', () => {
  assert.match(sql, /\(tenant_id,event_type,event_id,ticket_id\) WHERE ticket_id IS NOT NULL AND active/);
  assert.doesNotMatch(sql, /\(tenant_id,event_type,event_id,trigger_type,ticket_id\) WHERE ticket_id IS NOT NULL AND active/);
});

test('member badge eligibility validation runs only when inserting an award', () => {
  assert.match(sql, /CREATE TRIGGER validate_event_cpd_member_badge BEFORE INSERT ON public\.member_badge/);
  assert.doesNotMatch(sql, /validate_event_cpd_member_badge BEFORE INSERT OR UPDATE/);
});

test('final provider-neutral transitions transactionally enqueue CPD independently', () => {
  assert.match(sql, /CREATE TRIGGER enqueue_event_cpd_online_attendance\s+AFTER INSERT ON public\.attendance_outcome_transition/);
  assert.match(sql, /NEW\.provider NOT IN \('zoom','teams'\)/);
  assert.match(sql, /NEW\.status NOT IN \('attended','below_threshold','absent'\)/);
  assert.match(sql, /NEW\.booking_id::text\|\|':'\|\|NEW\.attendance_target_id::text\|\|':'\|\|\s+NEW\.outcome_revision_id::text/);
});

test('QR trigger builds table-specific snapshots and keys each check-in generation', () => {
  assert.match(sql, /IF TG_TABLE_NAME='booking' THEN[\s\S]*?v_snapshot:=jsonb_build_object/);
  assert.match(sql, /v_key:='attendance:qr:'\|\|v_type\|\|':'\|\|v_evidence\|\|':'\|\|NEW\.checked_in_at::text/);
  assert.doesNotMatch(sql, /CASE WHEN TG_TABLE_NAME='booking'[\s\S]*NEW\.session_id/);
});

test('award and attempt are committed by one restricted RPC', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.record_event_cpd_badge_award\(p_attempt jsonb\)/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(v_tenant::text\|\|':cpd-attempt:'\|\|v_key,0\)\)/);
  assert.match(sql, /INSERT INTO member_badge\([\s\S]*INSERT INTO event_cpd_badge_award_attempt\(/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_event_cpd_badge_award\(jsonb\) FROM PUBLIC,anon,authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_event_cpd_badge_award\(jsonb\) TO service_role/);
});

test('configuration and award RPCs use PostgREST auth.role service-role guards', () => {
  for (const name of ['replace_event_cpd_badge_rules', 'record_event_cpd_badge_award']) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const body = sql.slice(start, sql.indexOf('END $$;', start));
    assert.ok(start >= 0);
    assert.match(body, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    assert.match(body, /RAISE EXCEPTION 'service_role is required'/);
  }
  assert.doesNotMatch(sql, /request\.jwt\.claim\.role|current_user <> 'service_role'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.replace_event_cpd_badge_rules\(uuid,text,uuid,jsonb\) FROM PUBLIC,anon,authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.replace_event_cpd_badge_rules\(uuid,text,uuid,jsonb\) TO service_role/);
});

test('award RPC resolves effective rules only after sharing the replacement event lock', () => {
  const rpcStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.record_event_cpd_badge_award');
  const rpcEnd = sql.indexOf('END $$;', rpcStart);
  const body = sql.slice(rpcStart, rpcEnd);
  const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended(\n    v_tenant::text||':'||v_event_type||':'||v_event_id::text,0))");
  const resolution = body.indexOf('FROM event_cpd_badge_rule r');
  assert.ok(lock >= 0 && resolution > lock);
  assert.match(body, /r\.ticket_id=v_ticket_id[\s\S]*r\.ticket_id IS NULL[\s\S]*NOT EXISTS \([\s\S]*override_rule\.ticket_id=v_ticket_id/);
  assert.match(body, /v_rule_trigger IS DISTINCT FROM \(p_attempt->>'trigger_type'\)/);
  assert.match(body, /WHERE b\.id=v_badge AND b\.tenant_id=v_tenant AND b\.is_active/);
  assert.doesNotMatch(body, /v_rule uuid := NULLIF\(p_attempt->>'rule_id'/);
});

test('award RPC locks bookings and revalidates each attendance generation', () => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.record_event_cpd_badge_award');
  const body = sql.slice(start, sql.indexOf('END $$;', start));
  assert.match(body, /FROM booking WHERE id=v_booking_id AND tenant_id=v_tenant FOR UPDATE/);
  assert.match(body, /FROM complex_event_booking WHERE id=v_booking_id AND tenant_id=v_tenant FOR UPDATE/);
  assert.match(body, /v_booking_checked_at IS DISTINCT FROM v_queued_checked_at/);
  assert.match(body, /FROM complex_event_session_checkin c[\s\S]*FOR UPDATE OF c/);
  assert.match(body, /v_current_checked_at IS DISTINCT FROM v_queued_checked_at/);
  assert.match(body, /FROM attendance_current_outcome[\s\S]*FOR UPDATE/);
  assert.match(body, /\(v_evidence->>'status'\) IS DISTINCT FROM 'attended'/);
  assert.match(body, /v_current_revision::text IS DISTINCT FROM \(v_evidence->>'revisionId'\)/);
});