import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAssignmentToken,
  assignmentWindowState,
  isAssignmentOpen,
  assignmentClosedMessage,
  assignmentSubmissionRejection,
  respondentKeyInput,
  requiresAssignmentLink,
} from './surveyAssignment.js';

const NOW = new Date('2026-08-04T12:00:00Z');

test('token is long, url-safe and unique', () => {
  const a = generateAssignmentToken();
  const b = generateAssignmentToken();
  assert.match(a, /^[A-Za-z0-9_-]{30,}$/);
  assert.notEqual(a, b);
});

test('non-active status is archived regardless of window', () => {
  assert.equal(assignmentWindowState({ status: 'archived' }, NOW), 'archived');
  assert.equal(assignmentWindowState(null, NOW), 'archived');
  assert.equal(
    assignmentWindowState({ status: 'archived', opens_at: '2026-01-01T00:00:00Z' }, NOW),
    'archived'
  );
});

test('open when active with no bounds', () => {
  assert.equal(assignmentWindowState({ status: 'active' }, NOW), 'open');
  assert.ok(isAssignmentOpen({ status: 'active' }, NOW));
});

test('not_open_yet before opens_at', () => {
  const a = { status: 'active', opens_at: '2026-08-05T00:00:00Z' };
  assert.equal(assignmentWindowState(a, NOW), 'not_open_yet');
});

test('closed after closes_at', () => {
  const a = { status: 'active', closes_at: '2026-08-01T00:00:00Z' };
  assert.equal(assignmentWindowState(a, NOW), 'closed');
});

test('open inside the window; boundaries inclusive', () => {
  const a = {
    status: 'active',
    opens_at: '2026-08-01T00:00:00Z',
    closes_at: '2026-08-10T00:00:00Z',
  };
  assert.equal(assignmentWindowState(a, NOW), 'open');
  assert.equal(assignmentWindowState(a, new Date('2026-08-01T00:00:00Z')), 'open');
  assert.equal(assignmentWindowState(a, new Date('2026-08-10T00:00:00Z')), 'open');
});

test('invalid date strings are treated as unbounded', () => {
  const a = { status: 'active', opens_at: 'not-a-date', closes_at: '' };
  assert.equal(assignmentWindowState(a, NOW), 'open');
});

test('submission gate: open public assignment passes', () => {
  const a = { status: 'active', access_mode: 'public' };
  assert.equal(assignmentSubmissionRejection(a, { now: NOW }), null);
});

test('submission gate: window rejections carry 403 + ASSIGNMENT_CLOSED', () => {
  for (const a of [
    { status: 'archived' },
    { status: 'active', opens_at: '2026-08-05T00:00:00Z' },
    { status: 'active', closes_at: '2026-08-01T00:00:00Z' },
  ]) {
    const r = assignmentSubmissionRejection(a, { now: NOW });
    assert.equal(r.status, 403);
    assert.equal(r.code, 'ASSIGNMENT_CLOSED');
    assert.ok(r.error);
  }
});

test('submission gate: authenticated access mode requires a tenant session', () => {
  const a = { status: 'active', access_mode: 'authenticated' };
  const rejected = assignmentSubmissionRejection(a, { now: NOW, hasTenantSession: false });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.code, 'ASSIGNMENT_AUTH_REQUIRED');
  assert.equal(assignmentSubmissionRejection(a, { now: NOW, hasTenantSession: true }), null);
});

test('submission gate: window check runs before auth check', () => {
  const a = { status: 'active', access_mode: 'authenticated', closes_at: '2026-08-01T00:00:00Z' };
  assert.equal(assignmentSubmissionRejection(a, { now: NOW, hasTenantSession: false }).code, 'ASSIGNMENT_CLOSED');
});

test('respondent dedupe key is scoped per assignment, stable per context', () => {
  const direct = respondentKeyInput('t1', 'f1', null, 'a@example.com');
  const assignedA = respondentKeyInput('t1', 'f1', 'as1', 'a@example.com');
  const assignedB = respondentKeyInput('t1', 'f1', 'as2', 'a@example.com');
  // Same respondent, different assignments -> different keys (respond once PER event).
  assert.notEqual(assignedA, assignedB);
  // Direct context differs from any assignment context.
  assert.notEqual(direct, assignedA);
  // Same context is deterministic (concurrent duplicates collide on the unique index).
  assert.equal(assignedA, respondentKeyInput('t1', 'f1', 'as1', 'a@example.com'));
  // Different tenants/forms never collide even with crafted identities.
  assert.notEqual(respondentKeyInput('t1', 'f1', null, 'x'), respondentKeyInput('t1', 'f2', null, 'x'));
});

test('direct path is blocked exactly when active assignments exist', () => {
  assert.equal(requiresAssignmentLink(0), false);
  assert.equal(requiresAssignmentLink(undefined), false);
  assert.equal(requiresAssignmentLink(1), true);
  assert.equal(requiresAssignmentLink(3), true);
});

test('closed messages per state', () => {
  assert.equal(assignmentClosedMessage('open'), null);
  assert.match(assignmentClosedMessage('not_open_yet'), /not open yet/);
  assert.match(assignmentClosedMessage('closed'), /no longer accepting/);
  assert.match(assignmentClosedMessage('archived'), /no longer available/);
});
