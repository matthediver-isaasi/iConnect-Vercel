import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['api/event-emails/[eventId].js'], bundle: true, write: false,
  platform: 'node', format: 'esm',
  plugins: [{
    name: 'isolated-services',
    setup(builder) {
      builder.onResolve({ filter: /\/(database|tenantContext|campaignEventSurvey|scheduleReminders)\.js$/ },
        args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `
          export const supabase = { from: (...args) => globalThis.__emailSaveFixture.from(...args) };
          export const getTenantContext = async () => ({ isAuthenticated: true, tenantId: 'fixture-tenant' });
          export const hasAdminAccess = async () => true;
          export const usesEventSurvey = () => false;
          export const resolveEventEmailSurvey = async () => {};
          export const scheduleReminderEmails = async () => globalThis.__emailSaveFixture.schedule('simple');
          export const scheduleComplexEventReminderEmails = async () => globalThis.__emailSaveFixture.schedule('complex');
        `,
      }));
    },
  }],
});
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

for (const complex of [false, true]) {
  for (const editType of ['booking_confirmation', 'reminder', 'follow_up']) {
    test(`${complex ? 'complex' : 'simple'} event: ${editType} edit never schedules`, async () => {
      const rows = [
        { id: 'c', email_type: 'booking_confirmation', body: 'Old', is_complex_event: complex },
        { id: 'r', email_type: 'reminder', body: 'Reminder', timing_type: '1_day_before', is_complex_event: complex },
        { id: 'f', email_type: 'follow_up', body: 'Follow-up', follow_up_scope: 'event',
          follow_up_delay: 1, follow_up_unit: 'hours', is_complex_event: complex },
      ];
      const calls = [];
      globalThis.__emailSaveFixture = {
        from(table) {
          if (table === 'event' || table === 'complex_event') {
            return {
              select() { return this; },
              eq() { return this; },
              async maybeSingle() {
                return { data: table === (complex ? 'complex_event' : 'event') ? { id: 'event' } : null, error: null };
              },
            };
          }
          assert.equal(table, 'event_email');
          let id, patch;
          return {
            select() { return this; },
            eq(key, value) { if (key === 'id') id = value; return this; },
            update(value) { patch = value; return this; },
            async single() { return { data: { ...rows.find(row => row.id === id), ...patch }, error: null }; },
            then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
          };
        },
        schedule(kind) { calls.push(kind); return { requeued: 136, error: 'Example scheduling failure' }; },
      };
      let status, result;
      const response = { status(value) { status = value; return this; }, json(value) { result = value; } };
      const emails = rows.map(row => ({ ...row, body: row.email_type === editType ? 'Updated' : row.body }));
      try {
        await handler({ method: 'PUT', query: { eventId: 'event' }, body: { emails, is_complex_event: complex } }, response);
        assert.equal(status, 200);
        assert.equal(result.savedEmails.length, 3);
        assert.equal(result.savedEmails.find(row => row.email_type === editType).body, 'Updated');
        assert.deepEqual(calls, []);
        assert.equal(result.schedulerError, null);
        assert.equal(result.requeued, 0);
        assert.equal(result.bookingsScheduled, 0);
      } finally {
        delete globalThis.__emailSaveFixture;
      }
    });
  }
}
