import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCanvasRenewalRecovery } from './canvasRenewalRecovery.js';

function fixture() {
  const owner = { id: 'member', tenant_id: 'tenant' };
  const record = { id: 'term', member_id: owner.id, tenant_id: owner.tenant_id,
    membership_source: 'personal', status: 'pending_payment_setup', payment_status: 'unpaid',
    payment_method: 'stripe', membership_successor_election_id: 'election', membership_payment_quote_id: 'quote' };
  const context = {
    renewal: { state: 'renewal_pending', eligible: false, electionId: 'election' },
    election: { id: 'election', tenant_id: 'tenant', member_id: 'member',
      status: 'reserved', payment_method: 'upfront', payment_quote_id: 'quote', switch_state: 'idle' },
    simulation: { success: true, formRenewal: { state: 'post_grace_renewal' } },
  };
  const calls = [];
  const deps = {
    loadContext: async (_db, args) => { calls.push(['context', args]); return context; },
    routeJourney: async (_db, tenant, args, member) => {
      calls.push(['route', tenant, args, member]);
      return { ...args, journeyMode: 'questionnaire', entryHref: '/FormView?slug=restart' };
    },
  };
  return { owner, record, context, calls, deps };
}
const recover = (f, db = {}) => loadCanvasRenewalRecovery(db, {
  owner: f.owner, selected: { record: f.record }, today: '2026-11-25',
}, f.deps);

test('owned unpaid upfront election receives navigation, not new purchase eligibility', async () => {
  const f = fixture();
  const before = JSON.stringify(f.context);
  assert.deepEqual(await recover(f), { available: true, entryHref: '/FormView?slug=restart' });
  assert.equal(f.calls[1][2].state, 'post_grace_renewal');
  assert.equal(f.calls[1][3], f.owner.id);
  assert.equal(JSON.stringify(f.context), before);
  await assert.rejects(f.calls[0][1].simulate(), /Saved renewal required/);
});

test('ordinary renewal uses the normal form rather than the restart form', async () => {
  const f = fixture();
  f.context.simulation.formRenewal.state = 'renewal';
  assert.equal((await recover(f)).available, true);
  assert.equal(f.calls[1][2].state, undefined);
});

test('paid, retired, paused, recurring, foreign or unbound records do not offer recovery', async () => {
  for (const patch of [
    { payment_status: 'paid' }, { status: 'active' }, { status: 'expired_checkout' },
    { cancelled_for_switch_at: '2026-11-24' }, { billing_agreement_id: 'agreement' },
    { payment_method: 'direct_debit' }, { member_id: 'other' }, { tenant_id: 'other' },
    { membership_source: 'organisation' }, { membership_successor_election_id: null },
  ]) {
    const f = fixture(); Object.assign(f.record, patch);
    assert.deepEqual(await recover(f), { available: false }, JSON.stringify(patch));
    assert.equal(f.calls.length, 0);
  }
  for (const flag of ['membership_paused', 'membership_cancelled']) {
    const f = fixture(); f.owner[flag] = true;
    assert.equal((await recover(f)).available, false);
    assert.equal(f.calls.length, 0);
  }
});

test('stale, paid, switched, foreign or incomplete election evidence fails closed', async () => {
  for (const patch of [
    { status: 'released' }, { id: 'other' }, { tenant_id: 'other' },
    { member_id: 'other' }, { organization_id: 'org' }, { payment_method: 'monthly_card' },
    { payment_quote_id: 'other' }, { switch_state: 'reconciling' },
  ]) {
    const f = fixture(); Object.assign(f.context.election, patch);
    assert.equal((await recover(f)).available, false, JSON.stringify(patch));
  }
  for (const patch of [
    { renewal: { state: 'next_term_purchased' } }, { election: null }, { simulation: null },
  ]) {
    const f = fixture(); Object.assign(f.context, patch);
    assert.equal((await recover(f)).available, false);
  }
  const f = fixture(); f.deps.loadContext = async () => { throw new Error('offline'); };
  assert.equal((await recover(f)).available, false);
});

test('unverified or non-form routes never become recovery links', async () => {
  for (const route of [
    { eligible: false }, { eligible: true, journeyUnavailable: true },
    { eligible: true, journeyMode: 'same_schedule' },
  ]) {
    const f = fixture(); f.deps.routeJourney = async () => route;
    assert.equal((await recover(f)).available, false);
  }
});

test('entry-only discovery requires one tenant/member-scoped pending record', async () => {
  const f = fixture(), calls = [];
  let rows = [f.record];
  const query = {
    select() { return this; }, eq(k, v) { calls.push([k, v]); return this; },
    in(k, v) { calls.push([k, v]); return this; }, is(k, v) { calls.push([k, v]); return this; },
    async limit() { return { data: rows }; },
  };
  const db = { from(table) { assert.equal(table, 'member_membership_history'); return query; } };
  const args = { owner: f.owner, today: '2026-11-25' };
  assert.equal((await loadCanvasRenewalRecovery(db, args, f.deps)).available, true);
  assert.ok(calls.some(([k,v]) => k === 'tenant_id' && v === 'tenant'));
  assert.ok(calls.some(([k,v]) => k === 'member_id' && v === 'member'));
  for (const data of [[], [f.record, f.record]]) {
    rows = data;
    assert.equal((await loadCanvasRenewalRecovery(db, args, f.deps)).available, false);
  }
});
