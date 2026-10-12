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
          export const getTenantContext = async () => ({});
          export const hasAdminAccess = async () => false;
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
  for (const editReminder of [false, true]) {
    test(`${complex ? 'complex' : 'simple'} event: ${editReminder ? 'reminder edit schedules' : 'confirmation edit skips scheduling'}`, async () => {
      const rows = [
        { id: 'c', email_type: 'booking_confirmation', body: 'Old', is_complex_event: complex },
        { id: 'r', email_type: 'reminder', body: 'Reminder', timing_type: '1_day_before', is_complex_event: complex },
      ];
      const calls = [];
      globalThis.__emailSaveFixture = {
        from(table) {
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
      const emails = rows.map(row => ({ ...row, body: row.id === (editReminder ? 'r' : 'c') ? 'Updated' : row.body }));
      try {
        await handler({ method: 'PUT', query: { eventId: 'event' }, body: { emails, is_complex_event: complex } }, response);
        assert.equal(status, 200);
        assert.equal(result.savedEmails.length, 2);
        assert.equal(result.savedEmails.find(row => row.id === (editReminder ? 'r' : 'c')).body, 'Updated');
        assert.deepEqual(calls, editReminder ? [complex ? 'complex' : 'simple'] : []);
        assert.equal(result.schedulerError, editReminder ? 'Example scheduling failure' : null);
      } finally {
        delete globalThis.__emailSaveFixture;
      }
    });
  }
}
