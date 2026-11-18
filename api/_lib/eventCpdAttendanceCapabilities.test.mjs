import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityResponseFromProbes, teamsCapabilityFromProbes, detectEventCpdAttendanceCapabilities } from './eventCpdAttendanceCapabilities.js';

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
    attendanceTarget: true, teamsTargetFields: true, teamsBinding: true, teamsMeetingFields: true,
  }), { available: true, warning: null });
});

for (const installed of [false, true]) {
  test(`Teams probes respect migration boundary (installed=${installed})`, async () => {
    const calls = [];
    const db = { from(table) { return { select(columns) {
      calls.push([table, columns]);
      assert.notEqual(table, 'complex_event');
      if (!installed) assert.doesNotMatch(columns, /provider_connection_id|online_provider/);
      return { limit: async () => ({ error: !installed && table === 'teams_attendance_binding'
        ? { code: 'PGRST205' } : null }) };
    } }; } };
    const response = await detectEventCpdAttendanceCapabilities(db);
    assert.equal(response.teams.available, installed);
    assert.equal(response.zoom.available, true);
    assert.equal(response.qr.available, true);
    if (installed) for (const table of ['event', 'complex_event_session', 'event_agenda_item']) {
      assert.ok(calls.some(([name, columns]) => name === table && columns.includes('online_provider')));
    }
  });
}

test('capability infrastructure errors remain visible', async () => {
  const db = { from() { return { select() { return { limit: async () => ({
    error: { code: '42501', message: 'permission denied' },
  }) }; } }; } };
  await assert.rejects(detectEventCpdAttendanceCapabilities(db), { code: '42501' });
});

test('provider capability response aggregates safe setup warnings', () => {
  const response = capabilityResponseFromProbes({});
  assert.equal(response.qr.available, false);
  assert.equal(response.zoom.available, false);
  assert.equal(response.teams.available, false);
  assert.equal(response.warnings.length, 3);
});