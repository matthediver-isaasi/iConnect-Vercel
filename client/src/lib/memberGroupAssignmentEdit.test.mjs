import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAssignmentEditForm,
  buildAssignmentEditPayload,
  getAssignmentEditError,
} from './memberGroupAssignmentEdit.js';

test('pre-populates all editable assignment details', () => {
  assert.deepEqual(buildAssignmentEditForm({
    group_role: 'Chair',
    expires_at: '2027-03-04T00:00:00.000Z',
    is_group_admin: true,
    term_start_date: '2026-01-01',
    term_end_date: '2026-12-31',
    term_number: 2,
  }), {
    group_role: 'Chair',
    expires_at: '2027-03-04',
    is_group_admin: true,
    term_start_date: '2026-01-01',
    term_end_date: '2026-12-31',
    term_number: '2',
  });
});

test('supports changing and explicitly clearing nullable dates', () => {
  const changed = buildAssignmentEditPayload({
    group_role: 'Member',
    expires_at: '2027-05-06',
    is_group_admin: false,
    term_start_date: '',
    term_end_date: '',
    term_number: '',
  });
  assert.equal(changed.payload.expires_at, '2027-05-06');
  assert.equal(changed.payload.term_start_date, null);

  const cleared = buildAssignmentEditPayload({
    ...changed.payload,
    expires_at: '',
  });
  assert.equal(cleared.payload.expires_at, null);
});

test('rejects invalid term ranges and term numbers', () => {
  assert.match(buildAssignmentEditPayload({
    group_role: 'Member',
    term_start_date: '2027-02-01',
    term_end_date: '2027-01-01',
  }).error, /before the start date/);

  assert.match(buildAssignmentEditPayload({
    group_role: 'Member',
    term_number: '1.5',
  }).error, /whole number/);
});

test('surfaces the last-active-admin server failure as an actionable message', () => {
  assert.equal(
    getAssignmentEditError(new Error(
      "API Error (409): You can't remove or demote this group's only admin. Promote another member to admin first."
    )),
    "You can't remove or demote this group's only admin. Promote another member to admin first."
  );
});