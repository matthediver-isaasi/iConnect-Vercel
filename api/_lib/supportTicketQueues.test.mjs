import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isInternalNote,
  filterInternalNotesForViewer,
  classifyTicketQueue,
  getTicketLastActivity,
  QUEUE_NEEDS_ATTENTION,
  QUEUE_WAITING_ON_MEMBER,
  QUEUE_RESOLVED,
  QUEUE_CLOSED,
} from './supportTicketQueues.js';

const member = (over = {}) => ({
  id: 'm1',
  is_admin_response: false,
  created_date: '2026-07-01T10:00:00Z',
  ...over,
});
const admin = (over = {}) => ({
  id: 'a1',
  is_admin_response: true,
  created_date: '2026-07-01T11:00:00Z',
  ...over,
});
const note = (over = {}) => ({
  id: 'n1',
  is_admin_response: true,
  is_internal_note: true,
  created_date: '2026-07-01T12:00:00Z',
  ...over,
});

test('isInternalNote only true for explicit flag', () => {
  assert.equal(isInternalNote(note()), true);
  assert.equal(isInternalNote(admin()), false);
  assert.equal(isInternalNote(member()), false);
  assert.equal(isInternalNote({ is_internal_note: 'true' }), false);
  assert.equal(isInternalNote(null), false);
});

test('filterInternalNotesForViewer strips notes for non-staff, keeps for staff', () => {
  const rows = [member(), admin(), note()];
  assert.deepEqual(
    filterInternalNotesForViewer(rows, false).map((r) => r.id),
    ['m1', 'a1']
  );
  assert.deepEqual(
    filterInternalNotesForViewer(rows, true).map((r) => r.id),
    ['m1', 'a1', 'n1']
  );
  // Rows missing the column entirely (legacy dev DB) are always kept
  const legacy = [{ id: 'x' }];
  assert.deepEqual(filterInternalNotesForViewer(legacy, false), legacy);
  assert.deepEqual(filterInternalNotesForViewer([], false), []);
  assert.deepEqual(filterInternalNotesForViewer(null, false), []);
});

test('resolved/closed tickets classify by status regardless of replies', () => {
  assert.equal(classifyTicketQueue({ status: 'resolved' }, [member()]), QUEUE_RESOLVED);
  assert.equal(classifyTicketQueue({ status: 'closed' }, [admin()]), QUEUE_CLOSED);
});

test('open ticket with no responses needs attention', () => {
  assert.equal(classifyTicketQueue({ status: 'open' }, []), QUEUE_NEEDS_ATTENTION);
  assert.equal(classifyTicketQueue({ status: 'open' }, null), QUEUE_NEEDS_ATTENTION);
});

test('open ticket with only member replies needs attention', () => {
  assert.equal(
    classifyTicketQueue({ status: 'in_progress' }, [member()]),
    QUEUE_NEEDS_ATTENTION
  );
});

test('staff replied last => waiting on member', () => {
  assert.equal(
    classifyTicketQueue({ status: 'open' }, [member(), admin()]),
    QUEUE_WAITING_ON_MEMBER
  );
});

test('member replied after staff => needs attention', () => {
  const rows = [
    admin({ created_date: '2026-07-01T09:00:00Z' }),
    member({ created_date: '2026-07-01T10:00:00Z' }),
  ];
  assert.equal(classifyTicketQueue({ status: 'open' }, rows), QUEUE_NEEDS_ATTENTION);
});

test('internal notes are ignored for classification', () => {
  // Member replied last among visible entries; a later internal note must not
  // flip the ticket to waiting-on-member.
  const rows = [
    admin({ created_date: '2026-07-01T09:00:00Z' }),
    member({ created_date: '2026-07-01T10:00:00Z' }),
    note({ created_date: '2026-07-01T12:00:00Z' }),
  ];
  assert.equal(classifyTicketQueue({ status: 'open' }, rows), QUEUE_NEEDS_ATTENTION);

  // Only internal notes => still no admin reply => needs attention.
  assert.equal(
    classifyTicketQueue({ status: 'open' }, [note()]),
    QUEUE_NEEDS_ATTENTION
  );
});

test('classification is order-independent (sorts by created_date)', () => {
  const rows = [
    member({ created_date: '2026-07-01T10:00:00Z' }),
    admin({ created_date: '2026-07-01T11:00:00Z' }),
  ];
  assert.equal(
    classifyTicketQueue({ status: 'open' }, [...rows].reverse()),
    QUEUE_WAITING_ON_MEMBER
  );
});

test('getTicketLastActivity picks the most recent timestamp incl. notes', () => {
  const ticket = { created_date: '2026-07-01T08:00:00Z' };
  assert.equal(getTicketLastActivity(ticket, []), new Date('2026-07-01T08:00:00Z').getTime());
  assert.equal(
    getTicketLastActivity(ticket, [member(), note({ created_date: '2026-07-02T00:00:00Z' })]),
    new Date('2026-07-02T00:00:00Z').getTime()
  );
  // Missing/invalid dates tolerated
  assert.equal(getTicketLastActivity({}, [{ created_date: 'nonsense' }]), 0);
});
