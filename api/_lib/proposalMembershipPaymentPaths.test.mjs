import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuardedPortalMembershipIntent } from './membershipVoucherSettlement.js';
import { membershipIncentiveSnapshot } from './membershipIncentiveSnapshot.js';

test('fee-link reservation denial stops before any charge or provider claim', async () => {
  const calls = [];
  const db = { async rpc(name) { calls.push(name); return { error: { message: 'reserved by another checkout' } }; } };
  const stripe = { paymentIntents: { create() { throw new Error('must never charge'); } } };
  await assert.rejects(createGuardedPortalMembershipIntent(db, stripe, {
    tenantId: 'tenant', organizationId: 'org', token: { id: 'token', cost_breakdown: {
      proposalMembership: { entitlementId: 'grant' },
    } },
  }, { amount: 3000 }), /reserved by another checkout/);
  assert.deepEqual(calls, ['reserve_proposal_membership_fee_token']);
});

test('emailed fee simulation preserves grant and fee-token identity into history', () => {
  const source = readFileSync(new URL('../public/membership-fees/[token].js', import.meta.url), 'utf8');
  const renewal = source.slice(source.indexOf('export function simulationFromRenewalQuote'), source.indexOf('export function publicFeeBreakdown'));
  const saved = new Function('simulationFromFeeCommitment', `${renewal.replace('export function', 'function')}; return savedFeeSimulation;`)(() => null);
  const proposalMembership = { entitlementId: 'grant', scheduleId: 'schedule', originalBaseNetMinor: 10000, originalBaseVatMinor: 2000 };
  const sim = saved({ id: 'token', membership_year: '2027', final_cost: 30, currency: 'GBP', cost_breakdown: {
    proposalMembership, totalWithVat: 36, renewalQuote: {
      config: { id: 'schedule' }, membershipYear: { label: '2027', start: '2027-01-01', end: '2027-12-31' },
    },
  } });
  assert.deepEqual(membershipIncentiveSnapshot(sim).proposal_membership, { ...proposalMembership, feeTokenId: 'token' });
  assert.equal(sim.totalWithVat, 36, 'payable add-ons retain their saved amount');
});

test('workflow add-on failure returns failure before a history can be inserted', async () => {
  const source = readFileSync(new URL('./workflows.js', import.meta.url), 'utf8');
  const start = source.indexOf('    let addonLines = [];', source.indexOf('async function executeCreateMembershipAction'));
  const end = source.indexOf('    const zeroDue =', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end).replace("await import('./membershipAddons.js')", 'adapter');
  const invoke = new Function('adapter', `return (async () => { const tenantId='tenant', organizationId='org', targetYearLabel='2027'; ${block} throw new Error('Reached history creation'); })();`);
  const result = await invoke({ async loadAddonLines() { throw new Error('lookup unavailable'); }, computeAddonTotals() { throw new Error('must not continue'); } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Approved add-ons could not be verified/);
});

test('event booking benefit fee link is reserved before any charge', async () => {
  const calls = [];
  const db = { async rpc(name) { calls.push(name); return { error: { message: 'reserved by another checkout' } }; } };
  const stripe = { paymentIntents: { create() { throw new Error('must never charge'); } } };
  await assert.rejects(createGuardedPortalMembershipIntent(db, stripe, {
    tenantId: 'tenant', organizationId: 'org', token: { id: 'token', cost_breakdown: {
      funnelMembership: { entitlementId: 'grant', scope: 'organization' },
    } },
  }, { amount: 3000 }), /Event booking membership reservation failed/);
  assert.deepEqual(calls, ['reserve_event_funnel_membership_fee_token']);
});
