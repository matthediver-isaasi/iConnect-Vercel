import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityResponseFromProbes, teamsCapabilityFromProbes } from './eventCpdAttendanceCapabilities.js';

test('Teams capability fails closed when any required schema probe is absent', () => {
  assert.equal(teamsCapabilityFromProbes({
    attendanceTarget: true, teamsBinding: false, complexEventFields: true,
  }).available, false);
  assert.match(teamsCapabilityFromProbes({
    attendanceTarget: false, teamsBinding: true, complexEventFields: true,
  }).warning, /migration/i);
});

test('Teams capability is available only with all required foundations', () => {
  assert.deepEqual(teamsCapabilityFromProbes({
    attendanceTarget: true, teamsTargetFields: true, teamsBinding: true, complexEventFields: true,
  }), { available: true, warning: null });
});

test('provider capability response aggregates safe setup warnings', () => {
  const response = capabilityResponseFromProbes({});
  assert.equal(response.qr.available, false);
  assert.equal(response.zoom.available, false);
  assert.equal(response.teams.available, false);
  assert.equal(response.warnings.length, 3);
});