import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareHistoricalBooking, validateReconciliationEvidence } from './verify-outstanding-registrations.mjs';

test('reviewed additive survey revision preserves old fields and exact approved row', () => {
  const old = { id: 'one', status: 'confirmed', created_at: '2026-09-28T21:00:00.000Z' };
  const approved = { ...old, survey_invitation_revision: 0 };
  const live = { ...approved, created_at: '2026-09-28T21:00:00+00:00' };
  const columns = [{ column_name: 'created_at', data_type: 'timestamp with time zone' }];
  assert.deepEqual(compareHistoricalBooking(old, live, approved, columns), ['survey_invitation_revision']);
  assert.throws(() => compareHistoricalBooking(old, { ...live, status: 'cancelled' }, { ...approved, status: 'cancelled' }, columns), /changed/);
  assert.throws(() => compareHistoricalBooking(old, { ...live, survey_invitation_revision: 1 }, approved, columns), /changed/);
  assert.throws(() => compareHistoricalBooking(old, { ...live, unrelated: null }, { ...approved, unrelated: null }, columns), /Unreviewed/);
});

const root = 'private/annual-meeting/';
const files = ['outstanding-final-manifest.json', 'outstanding-verified.json', 'outstanding-independent-baseline.json'];
test('drift acknowledgment cannot waive actual core checks', { skip: !files.every(f => fs.existsSync(root + f)) && 'Private operator evidence not distributed' }, () => {
  const [manifest, evidence, baseline] = files.map(f => JSON.parse(fs.readFileSync(root + f)));
  assert.throws(() => validateReconciliationEvidence(manifest, evidence, baseline), /acknowledgment/);
  const audit = validateReconciliationEvidence(manifest, evidence, baseline, true);
  assert.equal(audit.filter(r => !r.Changed).length, 29);
  for (const mutate of [
    e => { e.cohort_artifacts.member_cpd_points_ledger = 1; },
    e => { delete e.cohort_artifacts.campaign_survey_delivery; },
    e => { e.holds_verified--; },
    e => { e.bookings.find(b => b.id === manifest.report.rows.find(r => r.disposition === 'ready').planned_booking.id).status = 'cancelled'; },
    e => { e.bookings.find(b => b.id === baseline.bookings[0].id).attendee_email = 'changed@example.invalid'; },
    e => { e.tables.member_cpd_points_ledger.sha256 = 'changed'; e.changed_artifact_tables.push('member_cpd_points_ledger'); },
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.throws(() => validateReconciliationEvidence(manifest, changed, baseline, true));
  }
});