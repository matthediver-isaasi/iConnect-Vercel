import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalReportHandler, createInternalReportService } from './internalCustomObjectReports.js';
import { createReportShareAccess, createReportSharingManager } from './customObjectReportSharing.js';
import { reportSharingDb, tenantId, objectId, report } from './customObjectReportSharing.fixture.mjs';

const roleId = '44444444-4444-4444-8444-444444444444';
const memberId = '55555555-5555-4555-8555-555555555555';
const owner = { isAuthenticated: true, tenantId, tenantUserId: 'owner' };
const member = { isAuthenticated: true, tenantId, memberId, roleId };
const response = () => ({ statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
async function fixture({ csv = false, allowed = true } = {}) {
  const db = reportSharingDb(), calls = [];
  db.tables.role = [{ id: roleId, tenant_id: tenantId, is_tenant_admin: false }];
  db.tables.member = [{ id: memberId, tenant_id: tenantId, role_id: roleId, login_enabled: true }];
  const engine = args => {
    calls.push(args);
    return { validate: async () => {}, preview: async () => ({
      sort_job: { id: 'job', status: 'complete', claim_token: 'SECRET' },
      columns: [{ label: 'Department', field_id: 'SECRET' }],
      data: [{ id: 'private-record-id', values: ['Imaging'] }], total: 1, page: 1, pageSize: 50,
    }), export: async input => input.action === 'chunk' ? { csv_text: 'Department\r\nImaging\r\n' }
      : { id: 'export', status: 'complete', chunk_count: 1, claim_token: 'SECRET' } };
  };
  const admin = createInternalReportService({ db, context: owner, canManageLinks: true, canManageRoles: true, executorFactory: engine });
  const link = await admin.link(objectId, report.id, true);
  const share = db.tables.custom_object_report_share[0];
  db.tables.custom_object_report_role_access = [{ tenant_id: tenantId, share_id: share.id, role_id: roleId,
    can_view: allowed, can_download: csv, revision: 1 }];
  const service = createInternalReportService({ db, context: member, executorFactory: engine });
  return { db, calls, engine, admin, service, share, link, body: { object_id: objectId, report_id: report.id } };
}
test('internal publication never enables passwordless external access, and ordinary roles default denied', async () => {
  const f = await fixture({ allowed: false });
  assert.equal(f.share.enabled, false);
  assert.equal(f.share.password_required, true);
  assert.equal(f.link.url, `/internal-reports/${objectId}/${report.id}`);
  assert.equal(f.link.ready, true);
  assert.deepEqual((await f.service.catalog()).reports, []);
  await assert.rejects(f.service.view({ ...f.body, action: 'unlock', password: 'ignored' }), e => e.status === 403);
  await assert.rejects(f.service.link(objectId, report.id, true), e => e.status === 403);
  await assert.rejects(f.service.rolePermissions(roleId), e => e.status === 403);
  await assert.rejects(f.service.setRolePermissions(roleId, []), e => e.status === 403);
});
test('signed-in grants only project saved cells and cannot be used by another principal, role, tenant or public link', async () => {
  const f = await fixture();
  const opened = await f.service.view({ ...f.body, action: 'unlock', definition: { injected: true } });
  assert.equal(opened.report.name, report.name);
  assert.equal(opened.report.allow_csv, false);
  assert.equal(f.db.tables.custom_object_report_share_grant[0].channel, 'internal');
  const payload = await f.service.view({ ...f.body, action: 'preview', preview_action: 'start', grant: opened.access_grant });
  assert.deepEqual(payload.data, [{ id: 'row-0', values: ['Imaging'] }]);
  assert.equal(JSON.stringify(payload).includes('SECRET'), false);
  assert.equal(JSON.stringify(payload).includes('private-record-id'), false);
  assert.deepEqual(f.calls.at(-1).definition, report.config);
  assert.equal(f.calls.at(-1).context, undefined);
  const another = createInternalReportService({ db: f.db, context: { ...member, memberId: 'another' }, executorFactory: f.engine });
  f.db.tables.member.push({ id: 'another', tenant_id: tenantId, role_id: roleId });
  await assert.rejects(another.view({ ...f.body, action: 'check', grant: opened.access_grant }), e => e.status === 409);
  const outside = createInternalReportService({ db: f.db, context: { ...owner, tenantId: 'outside' }, executorFactory: f.engine });
  await assert.rejects(outside.view({ ...f.body, action: 'check', grant: opened.access_grant }), e => e.status === 404);
  const manager = createReportSharingManager({ db: f.db, context: owner, isAdmin: true, baseUrl: 'https://example.test',
    linkKey: 'a-safe-test-key-which-is-not-a-secret', executorFactory: f.engine });
  const external = await manager.change(objectId, { report_id: report.id, enabled: true, password_required: false, acknowledge_public: true });
  const access = createReportShareAccess({ db: f.db, tenantId, token: external.url.split('/').at(-1) });
  await assert.rejects(access.authorize(opened.access_grant), e => e.status === 401);
  const publicGrant = await access.unlock();
  await assert.rejects(f.service.view({ ...f.body, action: 'check', grant: publicGrant.grant }), e => e.status === 409);
});
test('CSV is independently denied at every export stage and allowed only for the current report role', async () => {
  const f = await fixture(), opened = await f.service.view({ ...f.body, action: 'unlock' });
  for (const action of ['start', 'status', 'process', 'chunk']) {
    await assert.rejects(f.service.view({ ...f.body, action: 'export', export_action: action, grant: opened.access_grant }), e => e.status === 403);
  }
  f.db.tables.custom_object_report_role_access[0].can_download = true;
  const allowed = await f.service.view({ ...f.body, action: 'export', export_action: 'chunk', grant: opened.access_grant });
  assert.match(allowed.csv_text, /Imaging/);
});
test('permission revocation, login disable and role reassignment during execution fence data and CSV responses', async () => {
  for (const change of ['view', 'download', 'login', 'role']) {
    const f = await fixture({ csv: true }), opened = await f.service.view({ ...f.body, action: 'unlock' });
    const factory = args => ({ validate: async () => {}, export: async () => {
      if (change === 'view') f.db.tables.custom_object_report_role_access[0].can_view = false;
      if (change === 'download') f.db.tables.custom_object_report_role_access[0].can_download = false;
      if (change === 'login') f.db.tables.member[0].login_enabled = false;
      if (change === 'role') f.db.tables.member[0].role_id = 'ungranted';
      return { csv_text: 'MUST NOT ESCAPE' };
    } });
    const service = createInternalReportService({ db: f.db, context: member, executorFactory: factory });
    await assert.rejects(service.view({ ...f.body, action: 'export', export_action: 'chunk', grant: opened.access_grant }),
      e => [403,409].includes(e.status));
  }
});
test('permission revisions, grant expiry and untrusted saved edits require fresh authorization', async () => {
  const f = await fixture(), opened = await f.service.view({ ...f.body, action: 'unlock' });
  f.db.tables.custom_object_report_role_access[0].revision++;
  await assert.rejects(f.service.view({ ...f.body, action: 'check', grant: opened.access_grant }), e => e.status === 409);
  const fresh = await f.service.view({ ...f.body, action: 'unlock' });
  const expired = createInternalReportService({ db: f.db, context: member, executorFactory: f.engine, now: () => new Date('2099-01-01') });
  await assert.rejects(expired.view({ ...f.body, action: 'check', grant: fresh.access_grant }), e => e.status === 409);
  f.db.tables.system_settings[0].setting_value = JSON.stringify({ reports: [{ ...report, name: 'Untrusted expanded report' }] });
  await assert.rejects(f.service.view({ ...f.body, action: 'check', grant: fresh.access_grant }), e => e.status === 404);
  await assert.rejects(f.admin.setRolePermissions(roleId, [{ ...f.body, can_view: true, can_download: false, expected_revision: 2 }]), e => e.status === 409);
  const manager = createReportSharingManager({ db: f.db, context: owner, isAdmin: true, baseUrl: '', executorFactory: f.engine });
  await manager.change(objectId, { report_id: report.id, action: 'sync' });
  await assert.rejects(f.service.view({ ...f.body, action: 'check', grant: fresh.access_grant }), e => e.status === 409);
  assert.equal((await f.service.view({ ...f.body, action: 'unlock' })).report.name, 'Untrusted expanded report');
});
test('role catalogue lists saved reports without granting access; role writes are scoped and bounded', async () => {
  const f = await fixture();
  assert.equal((await f.admin.rolePermissions(roleId)).reports[0].revision, 1);
  assert.equal((await f.service.catalog()).reports.length, 1);
  await f.admin.setRolePermissions(roleId, [{ ...f.body, can_view: false, can_download: false, expected_revision: 1 }]);
  assert.equal(f.db.calls.at(-1).name, 'set_internal_report_role_access');
  assert.equal(f.db.calls.at(-1).args.p_tenant_id, tenantId);
  await assert.rejects(f.admin.setRolePermissions('foreign', []), e => e.status === 404);
  await assert.rejects(f.admin.setRolePermissions(roleId, [{ ...f.body, can_view: false, can_download: true, expected_revision: 1 }]), e => e.status === 400);
  await assert.rejects(f.admin.setRolePermissions(roleId, [{ ...f.body, can_view: true, can_download: false }]), e => e.status === 400);
});
test('HTTP management routes need actual admin capabilities; signed-out and mismatched-host callers get no metadata', async () => {
  const f = await fixture();
  for (const context of [null, { ...member, tenantFromHost: { id: 'foreign' } }]) {
    const handler = createInternalReportHandler({ db: f.db, getContext: async () => context, executorFactory: f.engine });
    const res = response();
    await handler({ method: 'POST', query: { resource: 'view' }, body: { ...f.body, action: 'unlock' } }, res);
    assert.equal(res.statusCode, context ? 403 : 401);
    assert.equal(JSON.stringify(res.body).includes(report.name), false);
    assert.equal(res.headers['CDN-Cache-Control'], 'no-store');
  }
  for (const resource of ['link', 'permissions']) {
    const handler = createInternalReportHandler({ db: f.db, getContext: async () => member, adminCheck: async () => false,
      featureCheck: async () => true, schemaCheck: async () => ({ canManageSchema: true }), executorFactory: f.engine });
    const res = response();
    await handler({ method: 'POST', query: { resource }, body: { ...f.body, role_id: roleId, changes: [] } }, res);
    assert.equal(res.statusCode, 403);
  }
});
