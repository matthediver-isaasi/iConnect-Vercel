import test from 'node:test';
import assert from 'node:assert/strict';
import { eventAttendancePolicy, resolveInheritedPolicy } from './attendancePolicy.js';

test('session or agenda inherits its enabled Zoom policy and threshold', () => {
  const parent = {
    attendance_tracking_enabled: true,
    attendance_provider: 'zoom',
    attendance_threshold_minutes: 15,
  };
  assert.deepEqual(resolveInheritedPolicy(parent, { attendance_policy_override: false }), {
    enabled: true, provider: 'zoom', thresholdMinutes: 15, supported: true,
  });
  assert.deepEqual(eventAttendancePolicy(parent), {
    enabled: true, provider: 'zoom', thresholdMinutes: 15, supported: true,
  });
});

test('an override can disable an inherited policy or select Teams', () => {
  const parent = {
    attendance_tracking_enabled: true, attendance_provider: 'zoom', attendance_threshold_minutes: 15,
  };
  assert.equal(resolveInheritedPolicy(parent, {
    attendance_policy_override: true, attendance_tracking_enabled: false,
    attendance_provider: 'zoom', attendance_threshold_minutes: 5,
  }).enabled, false);
  const policy = resolveInheritedPolicy(parent, {
    attendance_policy_override: true, attendance_tracking_enabled: true,
    attendance_provider: 'teams', attendance_threshold_minutes: 5,
  });
  assert.equal(policy.supported, true);
  assert.equal(policy.thresholdMinutes, 5);
});