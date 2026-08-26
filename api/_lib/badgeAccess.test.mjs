// Authorization tests for the badge library write gate (Task #3282).
// The gate must key on the `admin.badges` RBAC feature — NOT generic admin
// (admin.role-management) — so a role granted Badge Management but denied
// Role Management can write, and vice versa cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBadgeWriteAccess, checkMemberBadgeTargetAccess, BADGE_FEATURE_KEY } from './badgeAccess.js';

// hasFeatureAccess stub factory: allowedKeys maps roleId -> Set of allowed keys.
function featureChecker(allowedByRole) {
  return async (roleId, key) => {
    const allowed = allowedByRole[roleId];
    return !!allowed && allowed.has(key);
  };
}

test('unauthenticated context is rejected with 401', async () => {
  const result = await checkBadgeWriteAccess({ isAuthenticated: false }, {
    hasFeatureAccess: async () => true,
  });
  assert.deepEqual(result, { ok: false, status: 401, error: 'Authentication required' });
});

test('missing context is rejected with 401', async () => {
  const result = await checkBadgeWriteAccess(null, { hasFeatureAccess: async () => true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('tenant user (admin dashboard session) always allowed', async () => {
  const result = await checkBadgeWriteAccess(
    { isAuthenticated: true, tenantUserId: 'tu-1', roleId: null },
    { hasFeatureAccess: async () => { throw new Error('should not be called'); } }
  );
  assert.deepEqual(result, { ok: true });
});

test('member role allowed admin.badges (but denied role-management) can write', async () => {
  const check = featureChecker({ 'role-badges-only': new Set([BADGE_FEATURE_KEY]) });
  const result = await checkBadgeWriteAccess(
    { isAuthenticated: true, tenantUserId: null, roleId: 'role-badges-only' },
    { hasFeatureAccess: check }
  );
  assert.deepEqual(result, { ok: true });
});

test('member role denied admin.badges is rejected with 403 even if otherwise admin', async () => {
  // Role has role-management (generic admin) but admin.badges was unticked.
  const check = featureChecker({ 'role-admin-no-badges': new Set(['admin.role-management']) });
  const result = await checkBadgeWriteAccess(
    { isAuthenticated: true, tenantUserId: null, roleId: 'role-admin-no-badges' },
    { hasFeatureAccess: check }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('gate checks exactly the admin.badges key', async () => {
  let seen = null;
  await checkBadgeWriteAccess(
    { isAuthenticated: true, tenantUserId: null, roleId: 'r1' },
    { hasFeatureAccess: async (roleId, key) => { seen = [roleId, key]; return true; } }
  );
  assert.deepEqual(seen, ['r1', 'admin.badges']);
});

test('tenant users and members can access their own badge target', async () => {
  assert.deepEqual(
    await checkMemberBadgeTargetAccess({ isAuthenticated: true, tenantId: 't1', tenantUserId: 'tu1' }, 'm2'),
    { ok: true },
  );
  assert.deepEqual(
    await checkMemberBadgeTargetAccess({ isAuthenticated: true, tenantId: 't1', memberId: 'm1' }, 'm1'),
    { ok: true },
  );
});

test('cross-member badge access requires member-management permission', async () => {
  const denied = await checkMemberBadgeTargetAccess(
    { isAuthenticated: true, tenantId: 't1', memberId: 'm1', roleId: 'r1' },
    'm2',
    { checkCrossMemberPermissions: async () => ({ hasCrossMemberAccess: false }) },
  );
  assert.deepEqual(denied, { ok: false, status: 403, error: 'Member management access required' });

  const allowed = await checkMemberBadgeTargetAccess(
    { isAuthenticated: true, tenantId: 't1', memberId: 'm1', roleId: 'r2' },
    'm2',
    { checkCrossMemberPermissions: async () => ({ hasCrossMemberAccess: true }) },
  );
  assert.deepEqual(allowed, { ok: true });
});
