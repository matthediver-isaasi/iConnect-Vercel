import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLifecycleCpd } from './memberLifecycleCpdEvidence.js';

const scope = { tenantId: 'tenant', memberId: 'member', now: new Date('2026-11-22T12:00:00Z') };
const award = (extra = {}) => ({
  id: 'award', tenant_id: 'tenant', member_id: 'original', effective_member_id: 'member',
  entry_kind: 'imported_award', points_value: '2.000000', activity_date: '2020-02-29',
  created_at: '2026-11-01T12:00:00Z', ...extra,
});
test('effective owner receives occurrence date, never import or merge date', () => {
  const result = assessLifecycleCpd([award()], scope);
  assert.equal(result.complete, true);
  assert.equal(result.lastOccurredAt, '2020-02-29');
  assert.throws(() => assessLifecycleCpd([award({ effective_member_id: 'original' })], scope));
});
test('unknown date cannot fall back to created, recorded or provider assessment date', () => {
  const result = assessLifecycleCpd([award({
    activity_date: null, evidence_snapshot: { recordedAt: '2026-11-20', evidenceAt: '2026-11-21' },
  })], scope);
  assert.equal(result.complete, false);
  assert.equal(result.lastOccurredAt, null);
  assert.deepEqual(result.reasons, ['cpd_occurrence_date_missing']);
});
test('manual awards use explicit occurrence dates', () => {
  assert.equal(assessLifecycleCpd([award({ entry_kind: 'manual_award' })], scope).lastOccurredAt, '2020-02-29');
});
test('corrections retain original date and use exact decimal arithmetic', () => {
  const root = award({ points_value: '0.3' });
  const correction = (id, value) => award({
    id, entry_kind: 'manual_adjustment', correction_of: root.id,
    points_value: value, activity_date: '2026-11-21',
  });
  assert.equal(assessLifecycleCpd([root, correction('a', '-0.1')], scope).lastOccurredAt, '2020-02-29');
  const zero = assessLifecycleCpd([root, correction('a', '-0.1'), correction('b', '-0.2')], scope);
  assert.equal(zero.complete, true);
  assert.equal(zero.lastOccurredAt, null);
});
test('reversals remove activity without counting reversal timestamp', () => {
  const reversed = award({ id: 'reversal', entry_kind: 'reversal', reversal_of: 'award', points_value: '-2' });
  const result = assessLifecycleCpd([award(), reversed], scope);
  assert.equal(result.complete, true);
  assert.equal(result.lastOccurredAt, null);
});
test('orphan corrections, unknown kinds, negative balances and invalid points hold review', () => {
  for (const rows of [
    [award({ id: 'orphan', entry_kind: 'reversal', reversal_of: 'missing' })],
    [award({ entry_kind: 'new_kind' })],
    [award({ points_value: null })],
    [award(), award({ id: 'c', entry_kind: 'manual_adjustment', correction_of: 'award', points_value: '-3' })],
  ]) assert.equal(assessLifecycleCpd(rows, scope).complete, false);
});
test('cross-tenant, duplicate and wrong effective owner rows are rejected', () => {
  for (const rows of [
    [award({ tenant_id: 'other' })], [award({ effective_member_id: 'other' })],
    [award(), award()], [award({ id: null })],
  ]) assert.throws(() => assessLifecycleCpd(rows, scope));
});
test('QR occurrence dates are supported but reversed snapshots are uncertain', () => {
  const qr = award({
    entry_kind: 'event_award', activity_date: null, award_trigger: 'attendance',
    evidence_type: 'qr_checkin', evidence_snapshot: { type: 'qr_checkin', checkedInAt: '2021-04-10T23:30:00Z' },
  });
  assert.equal(assessLifecycleCpd([qr], { ...scope, timezone: 'Europe/Madrid' }).lastOccurredAt, '2021-04-11');
  qr.evidence_snapshot.checkInReversedAt = '2021-04-11T01:00:00Z';
  assert.equal(assessLifecycleCpd([qr], scope).complete, false);
});
test('missing, impossible and future activity dates are held', () => {
  for (const date of [null, '2021-02-30', '2027-01-01', 'not-a-date']) {
    assert.equal(assessLifecycleCpd([award({ activity_date: date })], scope).complete, false);
  }
});
test('an empty authoritative ledger is not an invented last activity date', () => {
  const result = assessLifecycleCpd([], scope);
  assert.equal(result.complete, true);
  assert.equal(result.lastOccurredAt, null);
});
