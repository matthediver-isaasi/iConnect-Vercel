import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberDateTerm, previewMemberDateExtension } from './memberDateMembershipTerm.js';

const input = () => ({
  tenantId: 'tenant', memberId: 'member', startDate: '2026-11-08', value: '2028-06-30',
  field: { id: 'course', tenant_id: 'tenant', entity_scope: 'member',
    field_type: 'date', is_active: true, label: 'Course end date' },
});

test('arbitrary course length has an inclusive end and independent snapshot', () => {
  const source = input();
  const term = buildMemberDateTerm(source);
  assert.equal(term.term_end_date, '2028-06-30');
  assert.equal(term.membership_renewal_date, '2028-07-01');
  assert.equal(term.term_duration_months, null);
  source.value = '2029-06-30';
  assert.equal(term.term_source_snapshot.end_date, '2028-06-30');
});
test('date boundaries include leap day, year end and single-day terms', () => {
  for (const [end, next] of [['2028-02-29', '2028-03-01'], ['2027-12-31', '2028-01-01']]) {
    assert.equal(buildMemberDateTerm({ ...input(), value: end }).membership_renewal_date, next);
  }
  assert.equal(buildMemberDateTerm({ ...input(), value: input().startDate }).term_end_date, input().startDate);
});
test('reject missing, malformed, coerced and expired dates', () => {
  for (const value of [null, '', '2027-02-29', '2028-06-30T00:00:00Z', '30/06/2028', '2025-01-01', 1790000000]) {
    assert.throws(() => buildMemberDateTerm({ ...input(), value }));
  }
});
test('field must be active, date-based, tenant-owned and member-scoped', () => {
  for (const patch of [{ tenant_id: 'other' }, { entity_scope: 'organization' },
    { is_active: false }, { field_type: 'text' }, { custom_object_id: 'object' }, { id: null }]) {
    assert.throws(() => buildMemberDateTerm({ ...input(), field: { ...input().field, ...patch } }));
  }
});
test('grace must be explicit valid days', () => {
  for (const graceDays of [-1, 1.5, '30', Infinity]) assert.throws(() => buildMemberDateTerm({ ...input(), graceDays }));
  assert.equal(buildMemberDateTerm({ ...input(), graceDays: 90 }).term_source_snapshot.grace_days, 90);
});
test('manual extension requires reason and preserves the original start and snapshot', () => {
  const current = buildMemberDateTerm(input());
  const extension = previewMemberDateExtension({ current, newEndDate: '2029-06-30', reason: ' Course extended ' });
  assert.equal(extension.previous_end_date, '2028-06-30');
  assert.equal(extension.term_start_date, '2026-11-08');
  assert.equal(extension.reason, 'Course extended');
  assert.equal(current.term_end_date, '2028-06-30');
  for (const newEndDate of ['2028-06-30', '2027-06-30']) {
    assert.throws(() => previewMemberDateExtension({ current, newEndDate, reason: 'Test' }));
  }
  assert.throws(() => previewMemberDateExtension({ current, newEndDate: '2029-06-30', reason: '' }));
});
