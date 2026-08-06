// Task e1476154: unit coverage for the pure group-admin event ACTION
// authorization decision (duplicate, delete-preview, delete, attendee admin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGroupAdminEventAction } from './groupAdminEventWrite.js';

const TENANT = 'tenant-1';
const GROUP = 'group-1';
const adminGroups = [{ groupId: GROUP, simpleEnabled: true, complexEnabled: false }];

const eventRow = (over = {}) => ({ id: 'ev-1', member_group_id: GROUP, tenant_id: TENANT, ...over });

test('group admin may act on own group simple event', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow(), table: 'event', tenantId: TENANT, adminGroups });
  assert.deepEqual(r, { ok: true });
});

test('group admin may act on own group complex event (no type flag needed)', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow(), table: 'complex_event', tenantId: TENANT, adminGroups });
  assert.deepEqual(r, { ok: true });
});

test('caller with no administered groups is denied', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow(), table: 'event', tenantId: TENANT, adminGroups: [] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('missing event -> 404', () => {
  const r = evaluateGroupAdminEventAction({ row: null, table: 'event', tenantId: TENANT, adminGroups });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('event in another tenant is denied', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow({ tenant_id: 'tenant-2' }), table: 'event', tenantId: TENANT, adminGroups });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('event owned by a group the caller does not administer is denied', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow({ member_group_id: 'group-2' }), table: 'event', tenantId: TENANT, adminGroups });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('tenant-wide event (no member_group_id) is denied', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow({ member_group_id: null }), table: 'event', tenantId: TENANT, adminGroups });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('duplicate (requireTypeEnabled) allowed when the per-type flag is on', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow(), table: 'event', tenantId: TENANT, adminGroups, requireTypeEnabled: true });
  assert.deepEqual(r, { ok: true });
});

test('duplicate of complex event denied when complex_events_enabled is off', () => {
  const r = evaluateGroupAdminEventAction({ row: eventRow(), table: 'complex_event', tenantId: TENANT, adminGroups, requireTypeEnabled: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /multi-session/);
});

test('duplicate of complex event allowed when complexEnabled is on', () => {
  const groups = [{ groupId: GROUP, simpleEnabled: false, complexEnabled: true }];
  const r = evaluateGroupAdminEventAction({ row: eventRow(), table: 'complex_event', tenantId: TENANT, adminGroups: groups, requireTypeEnabled: true });
  assert.deepEqual(r, { ok: true });
});

test('duplicate of simple event denied when events_enabled is off', () => {
  const groups = [{ groupId: GROUP, simpleEnabled: false, complexEnabled: true }];
  const r = evaluateGroupAdminEventAction({ row: eventRow(), table: 'event', tenantId: TENANT, adminGroups: groups, requireTypeEnabled: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});
