#!/usr/bin/env node
// Explicitly authorized rollback-only production integration test. Never COMMIT.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDestination, EVENT } from './annual-meeting-destination.mjs';
const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const SOURCE_HASH = '5fc106677f343951c341536141b7feaf13afe7a7f8cb4265e114e24c4ea68e19';
const sql = fs.readFileSync('supabase/migrations/20261125_outstanding_registration_award_hold.sql', 'utf8');
assert.match(sql, /^BEGIN;\n/);
assert.match(sql, /\nCOMMIT;\s*$/);
const body = sql.replace(/^BEGIN;\n/, '').replace(/\nCOMMIT;\s*$/, '');
assert.doesNotMatch(body, /^\s*(COMMIT|ROLLBACK|BEGIN TRANSACTION)\s*;/im);
const client = await connectDestination();
let tests = 0;
let completed = false;
let migrationWasPresent;
const fixtureIds = [];
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='60s'");
  const present = (await client.query("SELECT to_regclass('public.outstanding_registration_award_hold') AS name")).rows[0].name;
  migrationWasPresent = Boolean(present);
  if (!present) await client.query(body);
  await client.query("SET LOCAL ROLE service_role");
  await client.query("SELECT set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
  assert.equal((await client.query('SELECT current_user AS role,auth.role() AS auth')).rows[0].role, 'service_role');
  assert.equal((await client.query('SELECT auth.role() AS auth')).rows[0].auth, 'service_role');
  const baseline = (await client.query('SELECT to_jsonb(b) AS row FROM booking b WHERE tenant_id=$1 AND event_id=$2 AND status=$3 AND member_id IS NOT NULL ORDER BY id LIMIT 1', [TENANT, EVENT, 'confirmed'])).rows[0]?.row;
  assert.ok(baseline, 'An authentic existing booking is required for rollback-only fixture');
  const heldId = randomUUID(), normalId = randomUUID();
  fixtureIds.push(heldId, normalId);
  const reference = `TEST-4850-${heldId}`;
  async function rejected(label, operation, pattern = /Registration-only import award hold/) {
    await client.query('SAVEPOINT rejection');
    let error;
    try { await operation(); } catch (e) { error = e; }
    await client.query('ROLLBACK TO SAVEPOINT rejection');
    await client.query('RELEASE SAVEPOINT rejection');
    assert.ok(error, `${label} unexpectedly succeeded`);
    assert.match(error.message, pattern, label);
    tests++;
  }
  async function hold(id, ref = reference) {
    return client.query(`INSERT INTO outstanding_registration_award_hold
      (booking_id,tenant_id,event_id,source_sha256,booking_reference) VALUES($1,$2,$3,$4,$5)`,
    [id, TENANT, EVENT, SOURCE_HASH, ref]);
  }
  async function booking(id, ref) {
    const value = { ...baseline, id, booking_reference: ref, booking_group_reference: ref,
      payment_method: 'admin_import', ticket_price: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    return client.query('INSERT INTO booking SELECT (jsonb_populate_record(NULL::booking,$1::jsonb)).*', [JSON.stringify(value)]);
  }
  await rejected('cannot attach existing', () => hold(baseline.id), /existing registration/);
  await rejected('missing booking rejected by deferred validation', async () => {
    await hold(randomUUID()); await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }, /foreign key|exact import-owned booking/);
  await hold(heldId);
  await booking(heldId, reference);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  tests++;
  await rejected('immutable delete', () => client.query('DELETE FROM outstanding_registration_award_hold WHERE booking_id=$1', [heldId]), /permission denied|immutable/);
  await rejected('immutable update', () => client.query('UPDATE outstanding_registration_award_hold SET source_sha256=$1 WHERE booking_id=$2', [SOURCE_HASH, heldId]), /permission denied|immutable/);
  await rejected('cannot change ownership', async () => {
    await client.query("UPDATE booking SET payment_method='card' WHERE id=$1", [heldId]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }, /exact import-owned booking/);
  for (const table of ['event_cpd_points_outbox', 'event_cpd_badge_outbox']) {
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE booking_id=$1`, [heldId])).rows[0].n, 0);
    // BEFORE guards must suppress a direct replay enqueue even with no other fields.
    assert.equal((await client.query(`INSERT INTO ${table}(booking_id) VALUES($1) RETURNING id`, [heldId])).rowCount, 0);
    tests++;
  }
  for (const table of ['member_cpd_points_ledger', 'member_badge',
    'event_cpd_points_award_attempt', 'event_cpd_badge_award_attempt',
    'attendee_cpd_certificate_delivery']) {
    await rejected(`service direct ${table}`, () => client.query(`INSERT INTO ${table}(booking_id) VALUES($1)`, [heldId]), /Registration-only import award hold|permission denied/);
    // SECURITY DEFINER writers run as owner: exercise that layer as well.
    await client.query('RESET ROLE');
    await rejected(`owner direct ${table}`, () => client.query(`INSERT INTO ${table}(booking_id) VALUES($1)`, [heldId]));
    await client.query('SET LOCAL ROLE service_role');
  }
  const attempt = { tenant_id: TENANT, event_id: EVENT, event_type: 'event', booking_type: 'booking',
    booking_id: heldId, idempotency_key: `test:${heldId}`, trigger_type: 'registration', status: 'awarded' };
  for (const writer of ['record_event_cpd_points_award', 'record_event_cpd_badge_award']) {
    await rejected(writer, () => client.query(`SELECT ${writer}($1::jsonb)`, [JSON.stringify(attempt)]));
  }
  await rejected('certificate claim', () => client.query(`SELECT claim_attendee_cpd_certificate_delivery(
    $1,'standard',$2,$3,$4,'rollback-test','test@example.invalid','{}',false,'attendee')`,
  [TENANT, heldId, randomUUID(), '0'.repeat(64)]));
  const evaluate = async id => (await client.query("SELECT evaluate_event_cpd_points_reprocessing_row($1,'booking',$2,$3) AS value", [TENANT, id, EVENT])).rows[0].value;
  const evaluation = await evaluate(heldId);
  assert.equal(evaluation.outcome, 'registration_only_hold');
  assert.equal(Number(evaluation.proposed_points), 0);
  tests++;
  const scope = { mode: 'selected', registrations: [{ booking_source: 'standard', booking_id: heldId, event_id: EVENT }] };
  const preview = (await client.query('SELECT preview_event_cpd_points_reprocessing($1,$2::jsonb) AS value', [TENANT, JSON.stringify(scope)])).rows[0].value;
  assert.equal(preview.totals.eligible, 0);
  assert.equal(preview.rows[0].outcome, 'registration_only_hold');
  tests++;
  await rejected('points replay confirmation', () => client.query(
    'SELECT confirm_event_cpd_points_reprocessing($1,$2,$3::jsonb,$4,$5,$6)',
    [TENANT, 'rollback-test', JSON.stringify(scope), preview.digest, 'Rollback-only hold verification', randomUUID()]),
  /no eligible registrations/);
  await client.query("SELECT enqueue_event_cpd_badge_replay($1,'event',$2,$3,'rollback-test')", [TENANT, EVENT, randomUUID()]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM event_cpd_badge_outbox WHERE booking_id=$1', [heldId])).rows[0].n, 0);
  tests++;
  // Normal independent booking retains native queue behavior and eligibility.
  await booking(normalId, `TEST-4850-${normalId}`);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  assert.equal((await client.query('SELECT outstanding_registration_is_held($1) AS value', [normalId])).rows[0].value, false);
  for (const table of ['event_cpd_points_outbox', 'event_cpd_badge_outbox']) {
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE booking_id=$1`, [normalId])).rows[0].n, 1);
  }
  assert.notEqual((await evaluate(normalId)).outcome, 'registration_only_hold');
  const normalAttempt = { ...attempt, booking_id: normalId, member_id: baseline.member_id,
    idempotency_key: `test:${normalId}`, evidence_type: 'confirmed_booking', evidence_id: normalId };
  const normalAward = (await client.query('SELECT to_jsonb(record_event_cpd_points_award($1::jsonb)) AS value', [JSON.stringify(normalAttempt)])).rows[0].value;
  assert.equal(normalAward.status, 'awarded', 'Normal cohort keeps its configured registration award');
  tests++;
  assert.deepEqual((await client.query('SELECT to_jsonb(b) AS row FROM booking b WHERE id=$1', [baseline.id])).rows[0].row, baseline);
  tests++;
  completed = true;
} finally {
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM booking WHERE id=ANY($1::uuid[])', [fixtureIds])).rows[0].n, 0, 'Rollback removed all fixture bookings');
  if (migrationWasPresent !== undefined) {
    assert.equal(Boolean((await client.query("SELECT to_regclass('public.outstanding_registration_award_hold') AS name")).rows[0].name),
      migrationWasPresent, 'Rollback preserved original migration state');
  }
  await client.end();
}
if (completed) console.log(JSON.stringify({ tests, service_role: true, result: 'passed', rollback_verified: true, persistent_writes: 0 }));