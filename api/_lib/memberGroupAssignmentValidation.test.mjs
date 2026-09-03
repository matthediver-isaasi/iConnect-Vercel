import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemberGroupAssignmentPatch } from './memberGroupAssignmentValidation.js';

test('accepts setting and clearing assignment dates', () => {
  assert.deepEqual(validateMemberGroupAssignmentPatch({
    expires_at: '2027-05-06',
    term_start_date: null,
    term_end_date: null,
    term_number: null,
  }), { ok: true });
});

test('rejects impossible dates and reversed term ranges', () => {
  assert.match(validateMemberGroupAssignmentPatch({ expires_at: '2027-02-30' }).error, /valid date/);
  assert.match(validateMemberGroupAssignmentPatch({
    term_start_date: '2027-05-02',
    term_end_date: '2027-05-01',
  }).error, /before the start date/);
});

test('rejects invalid role and term number values', () => {
  assert.match(validateMemberGroupAssignmentPatch({ group_role: '' }).error, /role is required/);
  assert.match(validateMemberGroupAssignmentPatch({ term_number: 0 }).error, /whole number/);
});