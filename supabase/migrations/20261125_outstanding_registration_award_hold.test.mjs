import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const sql = fs.readFileSync(new URL('./20261125_outstanding_registration_award_hold.sql', import.meta.url), 'utf8');

test('hold is immutable, service-only, source/event/tenant pinned, and pre-booking', () => {
  assert.match(sql, /GRANT SELECT,INSERT ON public\.outstanding_registration_award_hold TO service_role/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /Award hold cannot attach to an existing registration/);
  assert.match(sql, /LOCK TABLE public\.booking IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/g);
  assert.match(sql, /5fc106677f343951c341536141b7feaf13afe7a7f8cb4265e114e24c4ea68e19/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON public\.outstanding_registration_award_hold/);
});

test('award and replay defense includes writers, durable artifacts, both outboxes and certificate claim', () => {
  for (const name of ['record_event_cpd_points_award', 'record_event_cpd_badge_award',
    'evaluate_event_cpd_points_reprocessing_row', 'claim_attendee_cpd_certificate_delivery',
    'event_cpd_points_outbox', 'event_cpd_badge_outbox', 'member_cpd_points_ledger',
    'member_badge', 'event_cpd_points_award_attempt', 'event_cpd_badge_award_attempt',
    'attendee_cpd_certificate_delivery']) assert.ok(sql.includes(name), name);
  assert.match(sql, /RETURN NULL/);
  assert.match(sql, /registration_only_hold/);
  assert.match(sql, /RAISE EXCEPTION 'Award hold migration .*drift/);
  assert.doesNotMatch(sql, /DISABLE TRIGGER|session_replication_role|DELETE FROM|UPDATE public\.(booking|member|event)/);
});

test('no booking flag, public write grant, generic survey changes or renamed bypass', () => {
  assert.doesNotMatch(sql, /ADD COLUMN|RENAME TO|GRANT .* TO (?:PUBLIC|anon|authenticated)/);
  assert.doesNotMatch(sql, /(?:ALTER|CREATE|UPDATE|DELETE|INSERT).*(?:certificate_survey|form_submission|event_survey)/i);
});