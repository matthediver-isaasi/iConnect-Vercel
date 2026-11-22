import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMemberOrganisationLoginAccess } from './organisationLoginGate.js';
import { computeEffectiveLoginStatus } from './memberLoginResolver.js';
import { isMemberSessionFenceRevoked } from './session.js';

function dbFor(member) {
  return { from(table) {
    const q = { select() { return q; }, eq() { return q; },
      maybeSingle: async () => ({ data: table === 'member' ? member : null, error: null }),
    }; return q;
  } };
}
test('archived member sessions fail on the current row without altering team access', async () => {
  for (const state of ['archived', 'minimised', 'deleted']) {
    const member = { id: 'member', tenant_id: 'tenant', lifecycle_state: state, lifecycle_generation: 3 };
    const db = dbFor(member);
    const portal = await evaluateMemberOrganisationLoginAccess({
      supabase: db, memberId: 'member', tenantId: 'tenant', checkMembershipCancellation: true,
    });
    assert.equal(portal.blocked, true);
    assert.deepEqual(portal.causes, ['member_archived']);
    const team = await evaluateMemberOrganisationLoginAccess({
      supabase: db, memberId: 'member', tenantId: 'tenant', checkMembershipCancellation: false,
    });
    assert.equal(team.blocked, false);
    assert.equal(team.lifecycleGeneration, 0);
  }
});
test('restore never resurrects pre-archive member sessions', () => {
  assert.equal(isMemberSessionFenceRevoked({ memberLifecycleGeneration: 0 }, { lifecycleGeneration: 1 }), true);
  assert.equal(isMemberSessionFenceRevoked({ memberLifecycleGeneration: 1 }, { lifecycleGeneration: 1 }), false);
  assert.equal(isMemberSessionFenceRevoked({}, { lifecycleGeneration: 0 }), false);
});
test('effective login status surfaces archived access independently of login permission', () => {
  const result = computeEffectiveLoginStatus({ id: 'member', lifecycle_state: 'archived', login_enabled: true });
  assert.equal(result.canLogin, false);
  assert.equal(result.reason, 'member_archived');
});
