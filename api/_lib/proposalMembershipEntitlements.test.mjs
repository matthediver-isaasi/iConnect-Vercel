import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProposalMembershipPreview, assertProposalMembershipInvoice, proposalMembershipHistoryFields } from './proposalMembershipEntitlements.js';
import { freezeMembershipBenefit } from '../../shared/proposalMembershipEntitlements.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const schedule = '33333333-3333-4333-8333-333333333333';
const grant = { id: '44444444-4444-4444-8444-444444444444', tenant_id: tenant,
  organization_id: org, schedule_id: schedule, quote_id: 'quote', quote_version_id: 'version',
  benefit_snapshot: freezeMembershipBenefit({ id: schedule, tenant_id: tenant, name: 'Annual' }, tenant) };
const sim = { success: true, org: { id: org }, config: { id: schedule }, finalCost: 120, vatAmount: 24, totalWithVat: 144, annualCost: 200 };
const chain = result => {
  const query = { then(resolve) { return Promise.resolve(result).then(resolve); } };
  for (const name of ['select', 'eq', 'not', 'limit']) query[name] = () => query;
  query.single = async () => result;
  return query;
};

test('preview is read-only, keeps normal renewal pricing and refuses committed agreements', async () => {
  const previous = process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED;
  process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED = 'true';
  try {
    const db = {
      rpc: async (name, args) => {
        assert.equal(name, 'pending_proposal_membership_entitlement');
        assert.deepEqual(args, { p_tenant: tenant, p_organization: org, p_schedule: schedule });
        return { data: grant };
      },
      from: table => {
        assert.equal(table, 'membership_billing_agreements');
        return chain({ data: [] });
      },
    };
    const result = await applyProposalMembershipPreview(db, tenant, sim);
    assert.equal(result.finalCost, 0);
    assert.equal(result.totalWithVat, 0);
    assert.equal(result.annualCost, 200);
    assert.equal(sim.finalCost, 120);
    assert.equal(result.proposalMembership.originalBaseNetMinor, 12000);
    assert.equal(proposalMembershipHistoryFields(result).proposal_membership.entitlementId, grant.id);
    assert.equal(await applyProposalMembershipPreview({ ...db, rpc: async () => ({ data: null }) }, tenant, sim), sim);
    assert.equal(await applyProposalMembershipPreview({}, tenant, { ...sim, existingRecord: { id: 'existing' } }).then(r => r.finalCost), 120);
    await assert.rejects(applyProposalMembershipPreview({ ...db, from: () => chain({ data: [{ id: 'agreement' }] }) }, tenant, sim), /payment agreement already exists/);
    await assert.rejects(applyProposalMembershipPreview({ ...db, rpc: async () => ({ error: { message: 'unavailable' } }) }, tenant, sim), /Could not verify/);
  } finally {
    if (previous === undefined) delete process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED;
    else process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED = previous;
  }
});

test('invoice guard blocks base-fee recharging and permits add-on-only invoices', async () => {
  const previous = process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED;
  process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED = 'true';
  try {
    const source = { sourceType: 'organisation_membership_history', sourceId: 'history' };
    const db = total => ({ from: () => chain({ data: { proposal_membership: {}, final_cost: total, total_with_vat: total } }) });
    await assert.rejects(assertProposalMembershipInvoice(db(0), tenant, source, 0), /No membership invoice/);
    await assert.rejects(assertProposalMembershipInvoice(db(25), tenant, source, 25), /separately approved add-on/);
    await assertProposalMembershipInvoice(db(25), tenant, source, 0);
  } finally {
    if (previous === undefined) delete process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED;
    else process.env.PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED = previous;
  }
});
