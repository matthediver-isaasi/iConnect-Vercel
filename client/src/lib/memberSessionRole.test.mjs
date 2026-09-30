import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRoleKey,
  normalizeSessionRoleSnapshot,
  stripTrustedMemberProjections,
} from './memberSessionRole.js';

const member = { id: 'm1', tenant_id: 't1', role_id: 'r1' };

test('session roles are ready only with matching non-null role data', () => {
  const ready = normalizeSessionRoleSnapshot({
    status: 'ready',
    member_id: 'm1',
    tenant_id: 't1',
    role_id: 'r1',
    role: { id: 'r1', tenant_id: 't1', name: 'Member' },
  }, member, 'session-1');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.role.name, 'Member');

  for (const invalid of [
    { ...ready, role: null },
    { ...ready, role: { id: 'other' } },
    { ...ready, role: { id: 'r1', tenant_id: 'other' } },
    { ...ready, member_id: 'other' },
  ]) {
    assert.equal(normalizeSessionRoleSnapshot(invalid, member, 'session-1').status, 'error');
  }
});

test('absence alone enables legacy mode and trusted projections never persist', () => {
  assert.equal(normalizeSessionRoleSnapshot(undefined, member, 'session-1').status, 'legacy');
  assert.equal(normalizeSessionRoleSnapshot(null, member, 'session-1').status, 'error');
  assert.deepEqual(stripTrustedMemberProjections({
    ...member,
    sessionRole: { status: 'ready' },
    canvasMemberSnapshot: { values: {} },
  }), member);
});

test('validated response keys remain unique across layout remounts', () => {
  assert.notEqual(createSessionRoleKey('scope'), createSessionRoleKey('scope'));
});