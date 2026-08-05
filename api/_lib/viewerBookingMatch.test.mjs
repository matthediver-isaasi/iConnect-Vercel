import test from 'node:test';
import assert from 'node:assert/strict';
import { pickViewerBooking, emailExactIlikePattern, normalizeEmail } from './viewerBookingMatch.js';

const VIEWER = { memberId: 'viewer-1', email: 'A.Hernandez@yorksj.ac.uk' };

const b = (over) => ({
  id: over.id,
  member_id: over.member_id ?? null,
  attendee_email: over.attendee_email ?? null,
  status: over.status ?? 'confirmed',
  created_at: over.created_at ?? '2026-01-01T00:00:00Z',
});

test('attendee-email match wins even when member_id is someone else (booker)', () => {
  const picked = pickViewerBooking(
    [b({ id: 'x', member_id: 'booker-9', attendee_email: 'a.hernandez@yorksj.ac.uk' })],
    VIEWER
  );
  assert.equal(picked?.id, 'x');
});

test('attendee match is case-insensitive both ways', () => {
  const picked = pickViewerBooking(
    [b({ id: 'x', attendee_email: 'A.HERNANDEZ@YORKSJ.AC.UK' })],
    { memberId: 'viewer-1', email: 'a.hernandez@yorksj.ac.uk' }
  );
  assert.equal(picked?.id, 'x');
});

test('attendee match beats a booker-only member_id match', () => {
  const picked = pickViewerBooking(
    [
      b({ id: 'booker-row', member_id: 'viewer-1', attendee_email: 'someone.else@x.org', created_at: '2026-03-01T00:00:00Z' }),
      b({ id: 'attendee-row', member_id: 'booker-9', attendee_email: 'a.hernandez@yorksj.ac.uk', created_at: '2026-01-01T00:00:00Z' }),
    ],
    VIEWER
  );
  assert.equal(picked?.id, 'attendee-row');
});

test('falls back to member_id (booker) match when no attendee match', () => {
  const picked = pickViewerBooking(
    [b({ id: 'mine', member_id: 'viewer-1', attendee_email: 'guest@x.org' })],
    VIEWER
  );
  assert.equal(picked?.id, 'mine');
});

test('most recent wins within a group; cancelled ignored; none -> null', () => {
  const picked = pickViewerBooking(
    [
      b({ id: 'old', attendee_email: VIEWER.email, created_at: '2026-01-01T00:00:00Z' }),
      b({ id: 'new', attendee_email: VIEWER.email, created_at: '2026-04-16T14:45:28Z' }),
      b({ id: 'newest-cancelled', attendee_email: VIEWER.email, created_at: '2026-05-01T00:00:00Z', status: 'cancelled' }),
    ],
    VIEWER
  );
  assert.equal(picked?.id, 'new');

  assert.equal(pickViewerBooking([b({ id: 'z', member_id: 'other', attendee_email: 'other@x.org' })], VIEWER), null);
  assert.equal(pickViewerBooking([], VIEWER), null);
  assert.equal(pickViewerBooking(null, VIEWER), null);
});

test('no viewer email -> attendee matching skipped, member_id still works', () => {
  const rows = [b({ id: 'mine', member_id: 'viewer-1' }), b({ id: 'null-email', attendee_email: null })];
  assert.equal(pickViewerBooking(rows, { memberId: 'viewer-1', email: '' })?.id, 'mine');
  // blank attendee_email never matches a blank viewer email
  assert.equal(pickViewerBooking([b({ id: 'null-email', attendee_email: null })], { memberId: 'm', email: '' }), null);
});

test('emailExactIlikePattern escapes LIKE metacharacters and rejects unsafe input', () => {
  assert.equal(emailExactIlikePattern('A.B@x.org '), 'a.b@x.org');
  // _ and % must be escaped so the pattern is exact equality, not a wildcard.
  assert.equal(emailExactIlikePattern('jo_n@x.org'), 'jo\\_n@x.org');
  assert.equal(emailExactIlikePattern('a%b@x.org'), 'a\\%b@x.org');
  assert.equal(emailExactIlikePattern('a\\b@x.org'), 'a\\\\b@x.org');
  // PostgREST filter-value breakers fall back to member_id-only matching.
  assert.equal(emailExactIlikePattern('a,b@x.org'), null);
  assert.equal(emailExactIlikePattern('a(b)@x.org'), null);
  assert.equal(emailExactIlikePattern(''), null);
  assert.equal(emailExactIlikePattern(null), null);
});

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  A@B.Org '), 'a@b.org');
  assert.equal(normalizeEmail(null), '');
});
