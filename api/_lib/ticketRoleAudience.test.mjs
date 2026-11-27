import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketRoleAudienceAllowed } from '../../shared/ticketRoleAudience.mjs';
import { isTicketAccessibleToMember } from './ticketAccess.js';
import { loadFunnelOffer } from './eventFunnelPublic.js';

const base = { visibility_mode: 'members_and_public', role_match_only: true,
  role_ids: ['guest-role', 'former-role'], member_group_ids: ['allowed-group'] };
test('public tickets admit guests while signed-in purchasers must satisfy their role/group audience', () => {
  for (const visibility_mode of ['members_and_public', 'public_only', 'members_only']) {
    const ticketClass = { ...base, visibility_mode };
    for (const identity of [
      { authenticated: false, expected: visibility_mode !== 'members_only' },
      { authenticated: true, roleId: 'guest-role', expected: visibility_mode !== 'public_only' },
      { authenticated: true, roleId: 'former-role', expected: visibility_mode !== 'public_only' },
      { authenticated: true, roleId: 'other-role', expected: false },
      { authenticated: true, expected: false },
      { authenticated: true, roleId: 'other-role', groupIds: ['allowed-group'], expected: visibility_mode !== 'public_only' },
    ]) {
      assert.equal(ticketRoleAudienceAllowed(ticketClass, identity), identity.expected);
      assert.equal(isTicketAccessibleToMember({ ticketClass, isAuthenticated: identity.authenticated,
        memberRoleId: identity.roleId, memberGroupIds: identity.groupIds }), identity.expected);
    }
  }
});
test('public audience does not bypass private or organisation-type requirements', () => {
  assert.equal(isTicketAccessibleToMember({ ticketClass: {
    ...base, visibility_mode: undefined, is_public: true,
  }, isAuthenticated: false }), true);
  for (const ticketClass of [
    { ...base, audience_mode: 'selected_members', selected_member_ids: [] },
    { ...base, organization_type_enabled: true },
    { ...base, visibility_mode: 'members_only' },
    { ...base, visibility_mode: undefined },
  ]) assert.equal(isTicketAccessibleToMember({ ticketClass, isAuthenticated: false }), false);
});
test('an authenticated purchaser without a role never falls back to the public audience', () => {
  assert.equal(isTicketAccessibleToMember({ ticketClass: base, isAuthenticated: true }), false);
  assert.equal(isTicketAccessibleToMember({ ticketClass: base }), false);
  assert.equal(isTicketAccessibleToMember({ ticketClass: { ...base, role_match_only: false } }), true);
  assert.equal(isTicketAccessibleToMember({ ticketClass: { ...base, role_ids: [], member_group_ids: [] } }), true);
});

test('funnel offer discovery uses the same public/member eligibility split', async () => {
  for (const role of [null, 'guest-role', 'other-role', '']) {
    const owner = { tenantId: 'tenant', sessionId: 'session', memberId: role === null ? null : 'member' };
    const snapshot = { session: { revision: 1 }, graph: { nodes: [
      { id: 'source', type: 'source', event: { id: 'event', kind: 'simple' }, ticketIds: ['ticket'], requires: [] },
    ] }, route: { route: ['source'], retainedNodeIds: [] }, holds: [], drafts: {} };
    const db = {
      rpc: async () => ({ data: { revision: 1, eventRemaining: null, tickets: [{ ticketId: 'ticket', remaining: 10 }] } }),
      from(table) {
        const q = {
          select() { return q; }, eq() { return q; },
          maybeSingle: async () => ({ data: table === 'member' ? { id: 'member', role_id: role } : {
            id: 'event', tenant_id: 'tenant', title: 'Conference',
            pricing_config: { ticket_classes: [{ ...base, id: 'ticket' }] },
          } }),
          then(resolve) { return Promise.resolve({ data: [] }).then(resolve); },
        };
        return q;
      },
    };
    const result = await loadFunnelOffer(db, owner, snapshot, 'source');
    assert.equal(result.tickets.length, role === null || role === 'guest-role' ? 1 : 0);
  }
});
