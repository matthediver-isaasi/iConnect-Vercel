import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFunnelMemberships, publicMemberships } from './eventFunnelMembership.js';
import { applyFunnelMembershipPreview, complimentaryMembership } from './funnelMembershipEntitlements.js';

const TIER = '00000000-0000-4000-8000-000000000011';
const ORG_TIER = '00000000-0000-4000-8000-000000000012';
const BUYER = '00000000-0000-4000-8000-000000000004';

function fakeDb({ ready = true, tiers = {}, members = [], pending = null, agreements = [] } = {}) {
  const calls = [];
  const builder = table => {
    const filters = {};
    let like = null;
    const rows = () => {
      if (table === 'membership_tier_config') return tiers[filters.id] ? [tiers[filters.id]] : [];
      if (table === 'member') return members.filter(row => (!filters.id || row.id === filters.id)
        && (!like || row.email.toLowerCase() === like.replace(/\\(.)/g, '$1').toLowerCase()));
      if (table === 'membership_billing_agreements') return agreements;
      return [];
    };
    const api = {
      select: () => api, eq: (column, value) => { filters[column] = value; return api; },
      ilike: (_column, value) => { like = value; return api; }, not: () => api,
      limit: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
    };
    return api;
  };
  return {
    calls,
    from: table => { calls.push(table); return builder(table); },
    rpc: async (name, args) => {
      calls.push(name);
      if (name === 'event_funnel_membership_ready') return { data: ready, error: null };
      if (name === 'pending_event_funnel_membership') return { data: pending?.(args) ?? null, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  };
}
const node = (membership, requires = []) => ({ id: 'm', type: 'membership', requires, membership });
const snapshot = (membershipNode, memberId = BUYER) => ({
  session: { member_id: memberId }, graph: { entry: 'source', nodes: [{ id: 'source', type: 'source' }, membershipNode] },
});
const plan = { lines: [{ nodeId: 'source', registrations: [
  { id: 'b1', row: { attendee_email: 'Buyer@Example.test' } }, { id: 'b2', row: { attendee_email: 'a_b@example.test' } },
  { id: 'b3', row: { attendee_email: 'buyer@example.test ' } }] }] };
const route = { acceptedMembershipNodeIds: ['m'] };

test.beforeEach(() => { process.env.EVENT_FUNNEL_MEMBERSHIP_ENTITLEMENTS_ENABLED = 'true'; });
test.after(() => { delete process.env.EVENT_FUNNEL_MEMBERSHIP_ENTITLEMENTS_ENABLED; });

test('no accepted offers needs no lookups', async () => {
  const db = fakeDb();
  assert.deepEqual(await resolveFunnelMemberships({ db, tenantId: 't', snapshot: snapshot(node({})), route: {}, plan }), []);
  assert.deepEqual(db.calls, []);
});

test('accepted offers fail closed when the rollout is off or the database is not ready', async () => {
  const membership = { scheduleId: TIER, scope: 'member', recipientMode: 'purchaser' };
  process.env.EVENT_FUNNEL_MEMBERSHIP_ENTITLEMENTS_ENABLED = 'false';
  await assert.rejects(resolveFunnelMemberships({ db: fakeDb(), tenantId: 't', snapshot: snapshot(node(membership)), route, plan }), { code: 'MEMBERSHIP_UNAVAILABLE' });
  process.env.EVENT_FUNNEL_MEMBERSHIP_ENTITLEMENTS_ENABLED = 'true';
  await assert.rejects(resolveFunnelMemberships({ db: fakeDb({ ready: false }), tenantId: 't', snapshot: snapshot(node(membership)), route, plan }), { code: 'MEMBERSHIP_UNAVAILABLE' });
});

test('purchaser, organisation and attendee recipients are resolved before payment', async () => {
  const tiers = { [TIER]: { id: TIER, name: 'Individual', structure_scope_type: 'member', is_active: true },
    [ORG_TIER]: { id: ORG_TIER, name: 'Corporate', structure_scope_type: 'organization', is_active: true } };
  const members = [{ id: BUYER, email: 'buyer@example.test', organization_id: 'org-1' }, { id: 'm2', email: 'a_b@example.test' }];
  const db = fakeDb({ tiers, members });
  const purchaser = await resolveFunnelMemberships({ db, tenantId: 't', route, plan,
    snapshot: snapshot(node({ scheduleId: TIER, scope: 'member', recipientMode: 'purchaser' })) });
  assert.deepEqual(purchaser[0].recipients, [{ kind: 'member', id: BUYER, bookingIds: ['b1', 'b2', 'b3'] }]);
  assert.deepEqual(purchaser[0].qualifyingNodeIds, ['source']);
  const org = await resolveFunnelMemberships({ db, tenantId: 't', route, plan,
    snapshot: snapshot(node({ scheduleId: ORG_TIER, scope: 'organization', recipientMode: 'purchaser' })) });
  assert.deepEqual(org[0].recipients, [{ kind: 'organization', id: 'org-1', bookingIds: ['b1', 'b2', 'b3'] }]);
  const attendees = await resolveFunnelMemberships({ db, tenantId: 't', route, plan,
    snapshot: snapshot(node({ scheduleId: TIER, scope: 'member', recipientMode: 'attendees' }, ['source'])) });
  assert.deepEqual(attendees[0].recipients, [
    { kind: 'member', id: BUYER, bookingIds: ['b1', 'b3'] }, { kind: 'member', id: 'm2', bookingIds: ['b2'] }]);
  assert.deepEqual(publicMemberships(attendees), [{ nodeId: 'm', scheduleName: 'Individual', scope: 'member', recipientMode: 'attendees', recipientCount: 2 }]);
});

test('unavailable tiers and recipients are explained without charging', async () => {
  const member = { scheduleId: TIER, scope: 'member', recipientMode: 'attendees' };
  const tiers = { [TIER]: { id: TIER, name: 'Individual', structure_scope_type: 'member', is_active: true } };
  await assert.rejects(resolveFunnelMemberships({ db: fakeDb({ tiers: { [TIER]: { ...tiers[TIER], is_active: false } } }), tenantId: 't', route, plan,
    snapshot: snapshot(node(member)) }), { code: 'MEMBERSHIP_UNAVAILABLE' });
  await assert.rejects(resolveFunnelMemberships({ db: fakeDb({ tiers: { [TIER]: { ...tiers[TIER], structure_scope_type: 'organization' } } }), tenantId: 't', route, plan,
    snapshot: snapshot(node(member)) }), { code: 'MEMBERSHIP_UNAVAILABLE' });
  await assert.rejects(resolveFunnelMemberships({ db: fakeDb({ tiers }), tenantId: 't', route, plan,
    snapshot: snapshot(node(member), null) }), { code: 'MEMBERSHIP_RECIPIENT_UNAVAILABLE' });
  await assert.rejects(resolveFunnelMemberships({ db: fakeDb({ tiers, members: [{ id: BUYER, email: 'buyer@example.test' }] }), tenantId: 't', route, plan,
    snapshot: snapshot(node(member)) }), error => error.code === 'MEMBERSHIP_RECIPIENT_UNAVAILABLE' && /One named attendee/.test(error.message));
  const orgTier = { [ORG_TIER]: { id: ORG_TIER, name: 'Corporate', structure_scope_type: 'organization', is_active: true } };
  await assert.rejects(resolveFunnelMemberships({ db: fakeDb({ tiers: orgTier, members: [{ id: BUYER, email: 'b' }] }), tenantId: 't', route, plan,
    snapshot: snapshot(node({ scheduleId: ORG_TIER, scope: 'organization', recipientMode: 'purchaser' })) }), { code: 'MEMBERSHIP_RECIPIENT_UNAVAILABLE' });
});

test('membership preview waives only the base fee once and defers to proposal coverage', async () => {
  const entitlement = { id: 'e1', order_id: 'o1', scope: 'member', schedule_id: TIER, benefit_snapshot: { scheduleName: 'Individual' } };
  const sim = { success: true, member: { id: BUYER }, config: { id: TIER, name: 'Individual' }, finalCost: 40, vatAmount: 8, totalWithVat: 48, steps: [] };
  const applied = await applyFunnelMembershipPreview(fakeDb({ pending: () => entitlement }), 't', sim, 'member');
  assert.equal(applied.totalWithVat, 0);
  assert.deepEqual(applied.funnelMembership, { entitlementId: 'e1', scheduleId: TIER, scope: 'member', orderId: 'o1',
    scheduleName: 'Individual', originalBaseNetMinor: 4000, originalBaseVatMinor: 800 });
  assert.equal(complimentaryMembership(applied), applied.funnelMembership);
  const proposal = { ...sim, proposalMembership: { entitlementId: 'p1' } };
  const db = fakeDb({ pending: () => entitlement });
  assert.equal(await applyFunnelMembershipPreview(db, 't', proposal, 'member'), proposal);
  assert.deepEqual(db.calls, []);
  assert.equal(await applyFunnelMembershipPreview(fakeDb(), 't', sim, 'member'), sim);
  await assert.rejects(applyFunnelMembershipPreview(fakeDb({ pending: () => entitlement, agreements: [{ id: 'a' }] }), 't', sim, 'member'),
    { code: 'FUNNEL_MEMBERSHIP_AGREEMENT_REVIEW' });
});
