import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTeamsAttendanceRecords,
  teamsBookingFactsFromRows,
  teamsBindingPayloadFromTarget,
  teamsIdentityFromRow,
} from './teamsAttendanceService.js';
import { persistAttendanceReport } from './attendanceEngine.js';
import {
  fetchTeamsAttendance,
  graphGetAll,
  resolveOnlineMeetingId,
  TeamsGraphError,
} from './teamsGraphClient.js';

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('Graph collection follows pagination and retries 429 using Retry-After', async () => {
  const requests = [];
  const waits = [];
  const fetchImpl = async url => {
    requests.push(url);
    if (requests.length === 1) return response(429, {}, { 'retry-after': '2' });
    if (requests.length === 2) {
      return response(200, { value: [{ id: 'one' }], '@odata.nextLink': 'https://graph.test/page-2' });
    }
    return response(200, { value: [{ id: 'two' }] });
  };
  const rows = await graphGetAll('/collection', 'token', {
    fetchImpl, sleepImpl: async milliseconds => waits.push(milliseconds),
  });
  assert.deepEqual(rows.map(row => row.id), ['one', 'two']);
  assert.deepEqual(waits, [2000]);
  assert.equal(requests[1], requests[0]);
  assert.equal(requests[2], 'https://graph.test/page-2');
});

test('Graph 401 and 403 are explicit consent errors, not pending absence', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      graphGetAll('/collection', 'token', { fetchImpl: async () => response(status, {}) }),
      error => error instanceof TeamsGraphError
        && error.code === 'consent_required'
        && error.retryable === false,
    );
  }
});

test('missing and delayed reports are retryable pending results', async () => {
  await assert.rejects(
    fetchTeamsAttendance({
      token: 'token', organiserMicrosoftUserId: 'organiser', onlineMeetingId: 'meeting',
      fetchImpl: async () => response(200, { value: [] }),
    }),
    error => error.code === 'report_pending' && error.retryable,
  );
  await assert.rejects(
    fetchTeamsAttendance({
      token: 'token', organiserMicrosoftUserId: 'organiser', onlineMeetingId: 'meeting',
      fetchImpl: async () => response(404, {}),
    }),
    error => error.code === 'report_pending' && error.retryable,
  );
});

test('a supplied stable meeting identity is validated in the organiser boundary', async () => {
  const urls = [];
  const id = await resolveOnlineMeetingId({
    token: 'token', organiserMicrosoftUserId: 'organiser/user', onlineMeetingId: 'meeting#id',
    fetchImpl: async url => {
      urls.push(url);
      return response(200, { id: 'meeting#id' });
    },
  });
  assert.equal(id, 'meeting#id');
  assert.match(urls[0], /users\/organiser%2Fuser\/onlineMeetings\/meeting%23id/);

  await assert.rejects(resolveOnlineMeetingId({
    token: 'token', organiserMicrosoftUserId: 'different', onlineMeetingId: 'meeting#id',
    fetchImpl: async () => response(404, {}),
  }), error => error.code === 'meeting_not_found' && error.retryable === false);
});

test('Teams records preserve reconnect intervals and anonymous unmatched identity', () => {
  const intervals = normalizeTeamsAttendanceRecords([
    {
      id: 'record-1',
      identity: { id: 'user-1', displayName: 'Known', emailAddress: ' Person@Example.com ' },
      attendanceIntervals: [
        { joinDateTime: '2026-01-01T10:00:00Z', leaveDateTime: '2026-01-01T10:01:00Z' },
        { joinDateTime: '2026-01-01T10:02:00Z', leaveDateTime: '2026-01-01T10:03:30Z' },
      ],
    },
    {
      id: 'record-anon',
      identity: { displayName: 'Anonymous' },
      totalAttendanceInSeconds: 15,
    },
  ]);
  assert.equal(intervals.length, 3);
  assert.equal(intervals[0].participantKey, 'person@example.com');
  assert.equal(intervals[0].durationSeconds, 60);
  assert.equal(intervals[1].durationSeconds, 90);
  assert.equal(intervals[2].participantKey, 'provider:record-anon');
  assert.equal(intervals[2].email, null);
});

test('persisted Teams identity creates a safe missing-binding recovery payload', () => {
  const identity = teamsIdentityFromRow({
    teams_online_meeting_id: 'meeting-1',
    teams_join_web_url: 'https://teams.example/join',
    teams_outlook_connection_id: 'connection-1',
    teams_organiser_microsoft_user_id: 'organiser-1',
  });
  assert.deepEqual(identity, {
    onlineMeetingId: 'meeting-1',
    joinWebUrl: 'https://teams.example/join',
    connectionId: 'connection-1',
    organiserMicrosoftUserId: 'organiser-1',
  });
  const payload = teamsBindingPayloadFromTarget('tenant-1', {
    type: 'event', id: 'target-1', eventId: 'event-1',
    scheduledEndAt: '2026-01-01T12:00:00Z', teamsIdentity: identity,
  });
  assert.equal(payload.tenant_id, 'tenant-1');
  assert.equal(payload.online_meeting_id, 'meeting-1');
  assert.equal(payload.enabled, true);
  assert.equal(teamsIdentityFromRow({ teams_online_meeting_id: 'only-one-field' }), null);
  assert.equal(teamsIdentityFromRow({
    teams_online_meeting_id: 'meeting-1',
    teams_outlook_connection_id: 'connection-1',
    teams_organiser_microsoft_user_id: 'organiser-1',
    teams_meeting_lifecycle: 'detached',
  }), null);
  assert.equal(teamsBindingPayloadFromTarget('tenant-1', { teamsIdentity: null }), null);
});

test('Teams booking identity reaches the atomic attendance outcome snapshot', async () => {
  const bookingFacts = teamsBookingFactsFromRows([{
    id: 'booking-1',
    member_id: 'member-1',
    ticket_class_id: 'ticket-1',
    attendee_email: 'member@example.com',
  }], 'booking');
  let snapshot = null;
  const db = {
    rpc: async (_name, args) => {
      snapshot = args.p_snapshot;
      return { data: [{ target_id: 'target-1', sync_run_id: 'run-1' }], error: null };
    },
  };
  await persistAttendanceReport(db, {
    tenantId: 'tenant-1',
    provider: 'teams',
    target: {
      type: 'event',
      id: 'event-1',
      eventId: 'event-1',
      providerTargetId: 'meeting-1',
      providerTargetType: 'online_meeting',
      thresholdMinutes: 1,
    },
    bookings: bookingFacts.bookings,
    intervals: [{
      participantKey: 'member@example.com',
      intervalKey: 'record-1',
      durationSeconds: 120,
    }],
    matches: [{
      participantKey: 'member@example.com',
      bookingType: 'booking',
      bookingId: 'booking-1',
      matchStatus: 'matched',
      matchedBy: 'email',
    }],
    idempotencyKey: 'teams-member-identity',
  });
  assert.equal(snapshot.outcomes[0].memberId, 'member-1');
  assert.equal(snapshot.outcomes[0].ticketId, 'ticket-1');
});