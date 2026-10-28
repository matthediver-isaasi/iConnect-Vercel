import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { evaluateAttendance, normalizeParticipantKey, buildAttendanceSnapshotIdempotencyKey } from './attendanceEngine.js';
import { eventAttendancePolicy } from './attendancePolicy.js';

const source = fs.readFileSync(new URL('./zoomAttendanceService.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\n/gm, '')
  .replace(/export /g, '');

async function run(durations, { nextPage = false, enabled = true } = {}) {
  const snapshots = [], ledger = [];
  let requests = 0;
  const context = vm.createContext({
    console: { log() {}, error() {} }, URL, Date,
    normalizeParticipantKey, buildAttendanceSnapshotIdempotencyKey, eventAttendancePolicy,
    legacyBookingMatch: candidates => candidates?.length === 1 ? candidates[0] : null,
    getZoomAccessTokenForTenant: async () => 'fixture',
    persistAttendanceSyncState: async () => {},
    persistAttendanceReport: async (_, snapshot) => { snapshots.push(snapshot); return {}; },
    supabase: { from(table) {
      const result = { data: table === 'event'
        ? { attendance_tracking_enabled: enabled, attendance_provider: 'zoom', attendance_threshold_minutes: 20 }
        : table === 'booking' ? [{ id: 'booking', attendee_email: 'fixture@example.test' }] : [], error: null };
      const builder = {
        select() { return this; }, eq() { return this; }, delete() { return this; },
        single: async () => result,
        insert(rows) { ledger.push(...rows); return this; },
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
      };
      return builder;
    } },
    fetch: async () => {
      requests++;
      return { ok: true, json: async () => ({
        participants: durations.map((duration, i) => ({
          user_email: 'fixture@example.test', duration,
          join_time: `2026-01-01T12:${String(i).padStart(2, '0')}:00Z`,
        })),
        next_page_token: nextPage ? 'more' : '',
      }) };
    },
  });
  vm.runInContext(source, context);
  const result = await context.syncAttendanceForMeeting({
    tenantId: 'tenant', eventId: 'event', zoomMeetingId: '123', zoomType: 'meeting', isComplexEvent: false,
  });
  return { result, snapshots, ledger, requests };
}

for (const [durations, expected, seconds] of [
  [[20], 'below_threshold', 20],
  [[1199], 'below_threshold', 1199],
  [[1200], 'attended', 1200],
  [[599, 600], 'below_threshold', 1199],
  [[600, 600], 'attended', 1200],
]) {
  test(`Zoom report ${durations.join('+')} seconds: ${expected}`, async () => {
    const { snapshots, ledger } = await run(durations);
    const report = snapshots[0];
    const [outcome] = evaluateAttendance({ ...report, thresholdMinutes: 20, syncStatus: 'succeeded' });
    assert.equal(outcome.status, expected);
    assert.equal(outcome.durationSeconds, seconds);
    assert.equal(ledger[0].duration_minutes, Math.round(durations[0] / 60));
    assert.equal('duration_seconds' in ledger[0], false);
  });
}
test('partial paginated reports never replace attendance', async () => {
  const { result, snapshots, ledger, requests } = await run([1200], { nextPage: true });
  assert.equal(result.success, false);
  assert.equal(requests, 20);
  assert.equal(snapshots.length, 0);
  assert.equal(ledger.length, 0);
});
test('disabled attendance makes no provider requests or writes', async () => {
  const result = await run([1200], { enabled: false });
  assert.equal(result.requests, 0);
  assert.equal(result.snapshots.length, 0);
});

const scheduler = fs.readFileSync(new URL('../zoom/attendance-auto-sync.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default ', '');
for (const [method, bearer, env, status] of [
  ['GET', 'cron', { CRON_SECRET: 'cron', ZOOM_AUTO_SYNC_SECRET: 'legacy' }, 200],
  ['POST', 'legacy', { CRON_SECRET: 'cron', ZOOM_AUTO_SYNC_SECRET: 'legacy' }, 200],
  ['GET', 'legacy', { CRON_SECRET: 'cron', ZOOM_AUTO_SYNC_SECRET: 'legacy' }, 401],
  ['GET', null, {}, 403],
  ['DELETE', 'cron', { CRON_SECRET: 'cron' }, 405],
]) {
  test(`scheduler ${method} ${bearer}: ${status}`, async () => {
    let queries = 0;
    const context = vm.createContext({
      process: { env }, console: { log() {}, error() {} },
      supabase: { from() {
        queries++;
        const q = { then(resolve) { return Promise.resolve({ data: [] }).then(resolve); } };
        for (const name of ['select', 'not', 'lt', 'lte', 'gt', 'eq', 'or']) q[name] = () => q;
        return q;
      } },
    });
    vm.runInContext(scheduler, context);
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await context.handler({ method, headers: { authorization: bearer && `Bearer ${bearer}` } }, res);
    assert.equal(res.code, status);
    assert.equal(queries > 0, status === 200);
  });
}
test('deployment schedules authenticated Zoom processing every ten minutes', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url)));
  assert.deepEqual(config.crons.filter(c => c.path === '/api/zoom/attendance-auto-sync'), [
    { path: '/api/zoom/attendance-auto-sync', schedule: '*/10 * * * *' },
  ]);
});
