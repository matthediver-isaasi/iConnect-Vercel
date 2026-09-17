import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the real handler without loading production database or Outlook clients.
const source = readFileSync(new URL('./sync-outlook-emails.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace('export default async function handler', 'async function handler');

async function run({ states, logError = null, throwLogError = false }) {
  const rows = [];
  const errors = [];
  let syncCalls = 0;
  const connections = states.map((state, i) => ({
    id: `connection-${i}`, tenant_id: 'tenant-1', state,
    last_sync_at: state === 'skip' ? new Date().toISOString() : null,
  }));
  const supabase = {
    from(table) {
      if (table === 'scheduled_task_log') return {
        async insert(row) {
          rows.push(row);
          if (throwLogError) throw logError;
          return { error: logError };
        },
      };
      const query = {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        then(resolve, reject) {
          return Promise.resolve({
            data: table === 'outlook_connection' ? connections : [],
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const handler = runInNewContext(`${source}\nhandler`, {
    supabase,
    async syncEmailsForConnection(connection) {
      syncCalls++;
      if (connection.state === 'fail') throw new Error('Sync failed');
      return { synced: 1, agentOnlySkipped: 0, intraOrgSkipped: 0, errors: [] };
    },
    process: { env: { CRON_SECRET: 'test-only' } },
    console: { log() {}, error(...args) { errors.push(args); } },
    Date,
  });
  const response = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ headers: { authorization: 'Bearer test-only' } }, response);
  return { rows, errors, syncCalls, response };
}

for (const [states, status, processed, skipped, failures] of [
  [['skip'], 'no_action', 0, 1, 0],
  [['ok'], 'success', 1, 0, 0],
  [['fail'], 'failed', 0, 0, 1],
  [['ok', 'fail'], 'partial', 1, 0, 1],
]) {
  test(`Outlook sync writes a schema-compatible ${status} log`, async () => {
    const result = await run({ states });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.task_name, 'outlook_email_sync');
    assert.equal(row.task_display_name, 'Outlook Email Sync');
    assert.equal(row.status, status);
    assert.equal(row.details.processed, processed);
    assert.equal(row.details.skipped, skipped);
    assert.equal(row.details.errors, failures);
    assert.equal(result.syncCalls, processed + failures);
    assert.ok(Number.isInteger(row.duration_ms) && row.duration_ms >= 0);
  });
}

for (const throwLogError of [false, true]) {
  test(`logging failure is visible and does not rerun sync (throws=${throwLogError})`, async () => {
    const logError = { code: '23502', message: 'Log rejected' };
    const result = await run({ states: ['ok'], logError, throwLogError });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body.processed, 1);
    assert.equal(result.syncCalls, 1);
    assert.ok(result.errors.some(args => args[0].includes('Failed to log task') && args[1] === logError));
  });
}