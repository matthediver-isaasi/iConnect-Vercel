import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRoleMutationAccess } from './roleMutationAccess.js';

test('role writes require authentication and tenant context', async () => {
  assert.equal((await checkRoleMutationAccess(null, async () => false)).status, 401);
  assert.equal((await checkRoleMutationAccess({ isAuthenticated: true }, async () => true)).status, 400);
});

test('role writes reject ordinary members and allow role managers or tenant users', async () => {
  const member = { isAuthenticated: true, tenantId: 'tenant-1' };
  assert.equal((await checkRoleMutationAccess(member, async () => false)).status, 403);
  assert.deepEqual(await checkRoleMutationAccess(member, async () => true), { ok: true });
  assert.deepEqual(await checkRoleMutationAccess({
    ...member,
    tenantUserId: 'tenant-user-1',
  }, async () => false), { ok: true });
});