import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportSharingManager, createReportShareAccess, hashReportPassword, verifyReportPassword,
  reportShareDigest, limitReportShareRequests } from './customObjectReportSharing.js';
import { reportSharingDb, tenantId, objectId, report } from './customObjectReportSharing.fixture.mjs';
const password = 'A strong test password';
export function fixture() {
  const db = reportSharingDb();
  const manager = createReportSharingManager({ db, context: { isAuthenticated: true, tenantId, tenantUserId: 'admin' },
    isAdmin: true, baseUrl: 'https://tenant.example', linkKey: 'test-key-not-a-real-secret-32-characters',
    executorFactory: () => ({ validate: async () => {} }) });
  const change = input => manager.change(objectId, { report_id: report.id, ...input });
  const access = state => createReportShareAccess({ db, tenantId, token: state.url.split('/').at(-1) });
  return { db, manager, change, access };
}
test('password hashes are salted, timing-safe verified, length-limited and never reversible plaintext', async () => {
  const hash = await hashReportPassword(password);
  assert.notEqual(hash, await hashReportPassword(password));
  assert.equal(await verifyReportPassword(password, hash), true);
  assert.equal(await verifyReportPassword('wrong', hash), false);
  assert.equal(await verifyReportPassword(password, 'bad hash'), false);
  await assert.rejects(hashReportPassword('short'), /12/);
});
test('sharing defaults off, requires an admin and password, and returns no hashes or authority definitions', async () => {
  const f = fixture();
  assert.deepEqual(await f.manager.get(objectId, report.id), { can_manage: true, enabled: false, password_required: true, allow_csv: false, url: null });
  assert.throws(() => createReportSharingManager({ db: f.db, context: { isAuthenticated: true, tenantId }, isAdmin: false }), /Administrator/);
  assert.throws(() => createReportSharingManager({ db: f.db, context: { tenantId }, isAdmin: true }), /Authentication/);
  await assert.rejects(f.change({ enabled: true }), /password/);
  const state = await f.change({ enabled: true, password, definition: { malicious: true } });
  assert.equal(state.password_required, true);
  assert.equal(state.allow_csv, false);
  assert.deepEqual(f.db.tables.custom_object_report_share[0].definition, report.config);
  assert.equal(JSON.stringify(state).includes('password_hash'), false);
  assert.equal(JSON.stringify(f.db.tables.custom_object_report_share).includes(state.url.split('/').at(-1)), false);
  assert.equal((await f.manager.get(objectId, report.id)).url, state.url);
  assert.equal(reportShareDigest(state.url.split('/').at(-1)), f.db.tables.custom_object_report_share[0].token_hash);
});
test('password changes, CSV permission changes, rotation, revocation and re-enabling invalidate old access', async () => {
  const f = fixture();
  let state = await f.change({ enabled: true, password, allow_csv: true });
  const firstAccess = f.access(state);
  const first = await firstAccess.unlock(password);
  await assert.rejects(firstAccess.unlock('wrong'), e => e.status === 401);
  assert.equal((await firstAccess.authorize(first.grant)).share.allow_csv, true);
  const url = state.url;
  state = await f.change({ password: 'An updated test password' });
  assert.equal(state.url, url, 'password changes revoke grants without replacing the URL');
  await assert.rejects(firstAccess.authorize(first.grant), e => e.status === 401);
  await assert.rejects(firstAccess.unlock(password), e => e.status === 401);
  const updated = await firstAccess.unlock('An updated test password');
  state = await f.change({ allow_csv: false });
  await assert.rejects(firstAccess.authorize(updated.grant), e => e.status === 401);
  state = await f.change({ action: 'rotate' });
  assert.notEqual(state.url, url);
  await assert.rejects(firstAccess.unlock('An updated test password'), e => e.status === 404);
  const rotated = f.access(state);
  const grant = await rotated.unlock('An updated test password');
  await f.change({ action: 'revoke' });
  await assert.rejects(rotated.authorize(grant.grant), e => e.status === 404);
  const reenabled = await f.change({ enabled: true });
  assert.notEqual(reenabled.url, state.url);
});
test('password-free access needs explicit disclosure acknowledgement and remains scoped to its tenant', async () => {
  const f = fixture();
  await assert.rejects(f.change({ enabled: true, password_required: false }), /Confirm/);
  const state = await f.change({ enabled: true, password_required: false, acknowledge_public: true });
  const grant = await f.access(state).unlock();
  assert.ok(grant.grant);
  assert.notEqual(f.db.tables.custom_object_report_share_grant[0].token_hash, grant.grant);
  const foreign = createReportShareAccess({ db: f.db, tenantId: 'foreign', token: state.url.split('/').at(-1) });
  await assert.rejects(foreign.authorize(grant.grant), e => e.status === 404);
  const expired = createReportShareAccess({ db: f.db, tenantId, token: state.url.split('/').at(-1), now: () => new Date('2099-01-01') });
  await assert.rejects(expired.authorize(grant.grant), e => e.status === 401);
});
test('untrusted saved-definition edits fail closed until an administrator synchronizes the saved report', async () => {
  const f = fixture();
  const state = await f.change({ enabled: true, password });
  const access = f.access(state), initial = await access.unlock(password);
  const amended = { ...report, name: 'Updated report', config: { ...report.config, include_empty: false } };
  f.db.tables.system_settings[0].setting_value = JSON.stringify({ reports: [amended] });
  await assert.rejects(access.authorize(initial.grant), e => e.status === 404);
  await f.change({ action: 'sync' });
  await assert.rejects(access.authorize(initial.grant), e => e.status === 401);
  const latest = await access.unlock(password);
  assert.equal(latest.share.name, amended.name);
  f.db.tables.system_settings[0].setting_value = '{"reports":[]}';
  await assert.rejects(access.authorize(latest.grant), e => e.status === 404);
});
test('settings use a revision compare-and-swap instead of overwriting concurrent revocation', async () => {
  const f = fixture();
  await f.change({ enabled: true, password });
  f.db.beforeUpdate = () => { f.db.tables.custom_object_report_share[0].revision++; f.db.tables.custom_object_report_share[0].enabled = false; };
  await assert.rejects(f.change({ allow_csv: true }), e => e.status === 409);
  assert.equal(f.db.tables.custom_object_report_share[0].enabled, false);
});
test('administrators can revoke a link even when the server signing key is unavailable', async () => {
  const f = fixture(), state = await f.change({ enabled: true, password });
  const oldAccess = f.access(state), grant = await oldAccess.unlock(password);
  const manager = createReportSharingManager({ db: f.db, context: { isAuthenticated: true, tenantId, tenantUserId: 'admin' },
    isAdmin: true, baseUrl: 'https://tenant.example', linkKey: '' });
  const settings = await manager.get(objectId, report.id);
  assert.equal(settings.enabled, true);
  assert.equal(settings.url, null);
  await manager.change(objectId, { report_id: report.id, action: 'revoke' });
  await assert.rejects(oldAccess.authorize(grant.grant), e => e.status === 404);
});
test('shared atomic rate limiting is namespaced, limits spraying and fails closed when unavailable', async () => {
  const db = reportSharingDb();
  await limitReportShareRequests(db, tenantId, 'secret-link', { headers: {}, socket: { remoteAddress: 'test-client' } }, true);
  assert.equal(db.calls.length, 3);
  assert.equal(JSON.stringify(db.calls).includes('secret-link'), false);
  assert.ok(db.calls.every(call => call.name === 'consume_sales_quote_public_rate_limit'));
  db.rpc = async () => ({ data: true });
  await assert.rejects(limitReportShareRequests(db, tenantId, 'link', {}, false), e => e.status === 429);
  db.rpc = async () => ({ error: { message: 'offline' } });
  await assert.rejects(limitReportShareRequests(db, tenantId, 'link', {}, true), e => e.status === 503);
});
