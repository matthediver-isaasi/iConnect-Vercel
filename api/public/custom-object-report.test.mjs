import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicCustomReportHandler } from './custom-object-report.js';
import { createReportSharingManager } from '../_lib/customObjectReportSharing.js';
import { reportSharingDb, tenantId, objectId, report } from '../_lib/customObjectReportSharing.fixture.mjs';
const password = 'A strong test password';
function response() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function fixture(options = {}) {
  const db = reportSharingDb(), operations = [];
  const manager = createReportSharingManager({ db, context: { isAuthenticated: true, tenantId, memberId: 'admin' },
    isAdmin: true, baseUrl: 'https://tenant.example', linkKey: 'test-key-not-a-real-secret-32-characters',
    executorFactory: () => ({ validate: async () => {} }) });
  const settings = await manager.change(objectId, { report_id: report.id, enabled: true, password, allow_csv: options.csv ?? false });
  const token = settings.url.split('/').at(-1);
  const handler = createPublicCustomReportHandler({ db, resolveTenant: async () => ({ id: tenantId }),
    limit: async () => {}, executorFactory: args => {
      operations.push(args);
      return {
        validate: async () => {},
        preview: async input => {
          if (options.during) await options.during({ db, manager });
          return { columns: [{ label: 'Department', field_id: 'secret-field' }],
            data: [{ id: 'underlying-record-id', values: ['Clinical'] }], total: 1, page: 1, pageSize: 50, has_more: false,
            sort_job: { id: 'job', status: 'complete', definition: { secret: true }, claim_token: 'lease', requested_by_member_id: 'admin' } };
        },
        export: async () => {
          if (options.during) await options.during({ db, manager });
          return { id: 'job', status: 'complete', csv_text: 'Department\nClinical\n', definition: { secret: true }, requested_by_member_id: 'admin' };
        },
      };
    } });
  const call = async (input, method = 'POST') => {
    const res = response();
    await handler({ method, body: { token, ...input }, headers: {} }, res);
    return res;
  };
  return { db, manager, token, call, operations };
}
test('public requests reveal no report content or metadata before password verification', async () => {
  const f = await fixture();
  for (const input of [{ action: 'unlock' }, { action: 'unlock', password: 'wrong' }, { action: 'preview', grant: 'forged' },
    { action: 'unlock', password, token: `${'f'.repeat(36)}.${'a'.repeat(43)}` }]) {
    const res = await f.call(input);
    assert.ok([401, 404].includes(res.statusCode));
    assert.doesNotMatch(JSON.stringify(res.body), /Department|Clinical|definition|tenant_id/);
    assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.match(res.headers['X-Robots-Tag'], /noindex/);
  }
  assert.equal(f.operations.length, 0);
  assert.equal((await f.call({}, 'GET')).statusCode, 405);
});
test('guest grant exposes only projected cell values and ignores caller-supplied definitions', async () => {
  const f = await fixture(), unlocked = await f.call({ action: 'unlock', password });
  assert.equal(unlocked.statusCode, 200);
  assert.equal(unlocked.body.report.name, report.name);
  assert.equal(unlocked.body.report.allow_csv, false);
  const res = await f.call({ action: 'preview', grant: unlocked.body.access_grant, definition: { malicious: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.columns, [{ label: 'Department' }]);
  assert.deepEqual(res.body.data, [{ id: 'row-0', values: ['Clinical'] }]);
  assert.deepEqual(res.body.sort_job, { id: 'job', status: 'complete' });
  assert.deepEqual(f.operations.at(-1).definition, report.config);
  assert.equal(f.operations.at(-1).isAdmin, undefined);
  assert.equal(f.operations.at(-1).context, undefined, 'public execution must not fabricate an authenticated session');
});
test('disabled CSV is enforced for start, process, status and direct chunk requests', async () => {
  const f = await fixture(), unlocked = await f.call({ action: 'unlock', password });
  for (const export_action of ['start', 'status', 'process', 'chunk']) {
    const res = await f.call({ action: 'export', export_action, job_id: 'known-admin-job',
      chunk_index: 0, grant: unlocked.body.access_grant, allow_csv: true });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.csv_text, undefined);
  }
});
test('revocation during preview or a chunk download prevents the response from releasing data', async () => {
  for (const action of ['preview', 'export']) {
    const f = await fixture({ csv: true, during: async ({ manager }) => manager.change(objectId, { report_id: report.id, action: 'revoke' }) });
    const unlocked = await f.call({ action: 'unlock', password });
    const res = await f.call({ action, export_action: 'chunk', job_id: 'job', chunk_index: 0, grant: unlocked.body.access_grant });
    assert.equal(res.statusCode, 404);
    assert.doesNotMatch(JSON.stringify(res.body), /Clinical|Department|csv_text/);
  }
});
test('deleting or changing the saved report during execution suppresses in-flight results', async () => {
  const f = await fixture({ during: async ({ db }) => { db.tables.system_settings[0].setting_value = '{"reports":[]}'; } });
  const unlocked = await f.call({ action: 'unlock', password });
  const res = await f.call({ action: 'preview', grant: unlocked.body.access_grant });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.data, undefined);
});
test('public responses conceal internal failures and fail closed if shared rate limiting fails', async () => {
  const f = await fixture();
  const handler = createPublicCustomReportHandler({ db: f.db, resolveTenant: async () => ({ id: tenantId }),
    limit: async () => { throw new Error('sensitive database details'); } });
  const res = response();
  await handler({ method: 'POST', body: { action: 'unlock', token: f.token, password } }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /sensitive|database/);
});
