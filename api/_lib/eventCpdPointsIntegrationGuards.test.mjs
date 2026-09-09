import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('admin points API serializes database numerics as text on GET and PUT', async () => {
  const source = await read('../admin/event-cpd-points-rules.js');
  const conversions = source.match(/points_value: rule\.points_value == null \? null : String\(rule\.points_value\)/g) || [];
  assert.equal(conversions.length, 2);
  assert.match(source, /\[1-9\]\\d\{0,13\}/);
  assert.match(source, /\\d\{1,6\}/);
  assert.match(source, /detectEventCpdAttendanceCapabilities/);
  assert.match(source, /attendance_capabilities: attendanceCapabilities/);
});

test('workflow, badge and points processors are started in one independent settlement group', async () => {
  const source = await read('../cron/process-attendance-transitions.js');
  const start = source.indexOf('Promise.allSettled([');
  const end = source.indexOf(']);', start);
  const group = source.slice(start, end);
  assert.match(group, /processAttendanceTransitionOutbox/);
  assert.match(group, /processCpdBadgeOutbox/);
  assert.match(group, /processCpdPointsOutbox/);
});

test('controlled replay route requires admin scope, reason and bounded booking ids', async () => {
  const source = await read('../admin/event-cpd-points-replay.js');
  assert.match(source, /hasAdminAccess/);
  assert.match(source, /reason\.length > 500/);
  assert.match(source, /bookingIds\.length > 1000/);
  assert.match(source, /enqueue_event_cpd_points_replay/);
});

test('badge replay route is admin-only, tenant scoped and delegates eligibility to the database', async () => {
  const source = await read('../admin/event-cpd-badge-replay.js');
  assert.match(source, /hasAdminAccess/);
  assert.match(source, /context\.tenantId/);
  assert.match(source, /enqueue_event_cpd_badge_replay/);
  assert.doesNotMatch(source, /badge_id|trigger|booking_ids|evidence/);
  assert.match(source, /status\(202\)/);
});

test('badge replay status is refreshable without starting another replay', async () => {
  const source = await read('../admin/event-cpd-badge-replay.js');
  assert.match(source, /\['GET', 'POST'\]\.includes\(req\.method\)/);
  assert.match(source, /get_latest_event_cpd_badge_replay_status/);
  assert.match(source, /p_tenant_id: context\.tenantId/);
  assert.match(source, /return res\.status\(200\)\.json\(\{ sync: data \|\| null \}\)/);
});