import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendancePolicyPayload,
  resolveAttendancePolicy,
  validateAttendancePolicy,
} from './attendancePolicy.js';

test('an inherited target resolves the event policy', () => {
  const effective = resolveAttendancePolicy(
    {
      attendance_tracking_enabled: true,
      attendance_provider: 'zoom',
      attendance_threshold_minutes: 30,
    },
    {
      attendance_policy_inherit: true,
      attendance_tracking_enabled: false,
    },
  );
  assert.equal(effective.attendance_tracking_enabled, true);
  assert.equal(effective.attendance_threshold_minutes, 30);
});

test('a target override replaces the event policy', () => {
  const effective = resolveAttendancePolicy(
    { attendance_tracking_enabled: true, attendance_threshold_minutes: 30 },
    {
      attendance_policy_inherit: false,
      attendance_tracking_enabled: true,
      attendance_provider: 'zoom',
      attendance_threshold_minutes: 10,
    },
  );
  assert.equal(effective.attendance_threshold_minutes, 10);
  assert.equal(effective.attendance_policy_inherit, false);
});

test('enabled tracking requires an online Zoom target', () => {
  const policy = {
    attendance_tracking_enabled: true,
    attendance_provider: 'zoom',
    attendance_threshold_minutes: 5,
  };
  assert.equal(validateAttendancePolicy(policy, { isOnline: true }).length, 1);
  assert.deepEqual(validateAttendancePolicy(policy, {
    isOnline: true,
    zoomMeetingId: '123',
  }), []);
});

test('disabled event policies retain a valid threshold and clear the provider', () => {
  assert.deepEqual(attendancePolicyPayload({
    attendance_tracking_enabled: false,
    attendance_provider: 'zoom',
    attendance_threshold_minutes: 15,
  }), {
    attendance_tracking_enabled: false,
    attendance_provider: null,
    attendance_threshold_minutes: 15,
  });
});

test('enabled Teams tracking requires stable meeting and organiser identity', () => {
  const policy = {
    attendance_tracking_enabled: true,
    attendance_provider: 'teams',
    attendance_threshold_minutes: 5,
  };
  assert.equal(validateAttendancePolicy(policy, {
    isOnline: true,
    teamsOnlineMeetingId: 'meeting-id',
    teamsJoinWebUrl: 'https://teams.microsoft.com/l/meetup-join/test',
  }).length, 1);
  assert.deepEqual(validateAttendancePolicy(policy, {
    isOnline: true,
    teamsOnlineMeetingId: 'meeting-id',
    teamsJoinWebUrl: 'https://teams.microsoft.com/l/meetup-join/test',
    teamsOrganiserMicrosoftUserId: 'organiser-id',
    teamsOutlookConnectionId: 'connection-id',
  }), []);
});