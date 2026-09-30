import test from 'node:test';
import assert from 'node:assert/strict';
import { directDebitMembershipPresentation, loadDirectDebitMembershipPresentations } from './directDebitMembershipPresentation.js';
import { ALPHA_RECOGNITION_TENANT as tenant } from './alphaMembershipRecognition.js';
import { listPlans, planDetail, buildSummary, exportPlansCsv } from '../admin/gocardless-dd.js';

const today = '2026-09-21';
const history = (patch = {}) => ({
  id: 'history', tenant_id: tenant, member_id: 'member', billing_agreement_id: 'agreement',
  status: 'active', term_start_date: '2026-01-01', term_end_date: '2026-12-31',
  ...patch,
});
const plan = { id: 'plan', tenant_id: tenant, member_id: 'member', billing_agreement_id: 'agreement',
  status: 'first_payment_pending', provider: 'gocardless', collection_stopped_at: today };
const recognition = {
  tenant_id: tenant, member_id: 'member', history_id: 'history', agreement_id: 'agreement',
  effective_from: today, effective_until: '2027-10-01',
};
const project = (record, patch = {}, owner = {}) => directDebitMembershipPresentation({ ...plan, ...patch }, [record], owner, today);

test('verified dated current membership is independent of held unpaid billing, with no mutations', () => {
  const row = history({ payment_status: 'unpaid' });
  const before = structuredClone({ row, plan });
  assert.equal(project(row).displayStatus, 'current');
  assert.equal(project(row).evidence.source, 'membership_history');
  assert.deepEqual({ row, plan }, before);
});

test('administrative recognition is exact, bounded, revocable evidence, not import provenance', () => {
  const row = history({ status: 'pending_payment_setup', term_start_date: '2026-10-01',
    term_end_date: '2027-09-30', membershipRecognition: recognition });
  assert.equal(project(row).displayStatus, 'current');
  assert.equal(project(row).evidence.effectiveFrom, today);
  for (const patch of [{ revoked_at: today }, { member_id: 'wrong' }, { agreement_id: 'wrong' },
    { effective_from: '2026-01-01' }, { effective_until: '2099-01-01' }]) {
    assert.equal(project({ ...row, membershipRecognition: { ...recognition, ...patch } }).current, false);
  }
  for (const day of ['2026-09-20', '2027-10-01']) {
    assert.equal(directDebitMembershipPresentation(plan, [row], {}, day).current, false);
  }
  assert.equal(project({ ...row, membershipRecognition: null, imported: true }).current, false);
});

test('status/date/pause/missing evidence matrix fails closed; mandates never grant entitlement', () => {
  for (const patch of [
    { status: 'paused' }, { status: 'expired' }, { status: 'cancelled' }, { status: 'failed' },
    { status: 'pending_activation' }, { status: 'pending_payment_setup' }, { status: 'unknown' },
    { term_start_date: '2026-10-01' }, { term_end_date: '2026-09-20' },
    { term_start_date: null }, { term_start_date: 'not-a-date' },
    { term_end_date: null }, { term_end_date: '2025-01-01' },
  ]) {
    assert.equal(project(history(patch)).current, false, JSON.stringify(patch));
  }
  assert.equal(project(history(), {}, { membership_paused: true }).current, false);
  assert.equal(project(history(), {}, null).current, false);
  assert.equal(directDebitMembershipPresentation({ ...plan, status: 'active' }, [], {}, today).current, false);
});

test('arrears, failure, cancellation, suspension and completion retain operational priority', () => {
  for (const status of ['payment_grace_period', 'payment_overdue', 'payment_failed', 'failed',
    'cancelled', 'suspended', 'restricted', 'completed', 'paused']) {
    assert.equal(project(history(), { status }).displayStatus, status);
  }
  assert.equal(project(history({ membership_source: 'organisation' })).displayStatus, 'current');
  assert.equal(project(history({ membership_source: 'organisation', status: 'pending_payment_setup',
    membershipRecognition: recognition })).current, false);
});

// This mock implements reads only; any write/provider call fails immediately.
function database(tables, failure) {
  return { from(table) {
    const filters = [];
    let single = false;
    const result = () => {
      if (table === failure) return { error: { message: 'fixture read failure' } };
      const data = (tables[table] || []).filter(r => filters.every(f => f(r)));
      return { data: single ? data[0] || null : structuredClone(data) };
    };
    const query = {
      select() { return this; }, order() { return this; }, limit() { return this; },
      eq(k, v) { filters.push(r => r[k] === v); return this; },
      in(k, v) { filters.push(r => v.includes(r[k])); return this; },
      maybeSingle() { single = true; return this; },
      range(start, end) { const r = result(); return Promise.resolve(r.error ? r : { data: r.data.slice(start, end + 1) }); },
      then(resolve) { resolve(result()); },
    };
    return query;
  } };
}
function tables() {
  const now = new Date().toISOString().slice(0, 10);
  return {
    member: [{ id: 'member', tenant_id: tenant, email: 'member@fixture.invalid' }],
    membership_billing_agreements: [{ id: 'agreement', tenant_id: tenant, member_id: 'member', provider: 'gocardless' }],
    membership_payment_plans: [{ ...plan }],
    member_membership_history: [history({ term_start_date: now, term_end_date: `${Number(now.slice(0, 4)) + 1}-12-31` })],
  };
}

test('CSV matches current and unverified historical membership display filters without altering financial status', async () => {
  const data = tables(), db = database(data);
  const res = { setHeader() {}, status() { return this; }, send(body) { this.body = body; return this; } };
  await exportPlansCsv(res, tenant, { displayStatus: 'current' }, db);
  assert.match(res.body, /,Current,Awaiting first payment,/);
  data.bnms_dd_alpha_adoption = [{
    id: 'adoption', tenant_id: tenant, member_id: 'member', agreement_id: 'agreement',
    plan_id: 'plan', history_id: 'history',
  }];
  data.member_membership_history[0].status = 'pending_payment_setup';
  for (const query of [
    { displayStatus: 'membership_unverified' },
    { status: 'first_payment_pending', displayStatus: 'membership_unverified' },
  ]) {
    assert.equal((await listPlans(tenant, query, db)).total, 1);
    await exportPlansCsv(res, tenant, query, db);
    assert.match(res.body, /,Membership status unverified,Awaiting first payment,/);
  }
  await exportPlansCsv(res, tenant, { displayStatus: 'first_payment_pending' }, db);
  assert.equal(res.body.split('\r\n').length, 2);
});

test('Beta and unheld pilot use supplemental recognition without changing collection or pending contracts', async () => {
  for (const cohort of ['beta', 'pilot']) {
    const data = tables();
    const held = cohort === 'beta';
    data.membership_payment_plans[0].status = held ? 'first_payment_pending' : 'mandate_pending';
    data.membership_payment_plans[0].collection_stopped_at = held ? today : null;
    data.member_membership_history = [history({
      status: 'pending_payment_setup', payment_status: 'unpaid', term_start_date: '2026-10-01',
      term_end_date: '2027-09-30', membership_renewal_date: '2027-10-01',
    })];
    data[`bnms_dd_${cohort}_adoption`] = [{
      id: 'adoption', tenant_id: tenant, member_id: 'member', agreement_id: 'agreement', plan_id: 'plan', history_id: 'history',
    }];
    data.bnms_membership_recognition_beta_pilot = [{ ...recognition, cohort }];
    const before = structuredClone(data);
    const load = day => loadDirectDebitMembershipPresentations(database(data), tenant, data.membership_payment_plans, day);
    assert.equal((await load(today)).get('plan').displayStatus, 'current');
    assert.equal((await load('2027-09-30')).get('plan').displayStatus, 'current');
    assert.equal((await load('2027-10-01')).get('plan').displayStatus, 'membership_unverified');
    assert.deepEqual(data, before);
    data.member[0].membership_paused = true;
    assert.equal((await load(today)).get('plan').current, false);
    data.member[0].membership_paused = false;
    data.bnms_membership_recognition_beta_pilot[0].revoked_at = today;
    assert.equal((await load(today)).get('plan').current, false);
    data.bnms_membership_recognition_beta_pilot[0].revoked_at = null;
    data.bnms_membership_recognition_beta_pilot[0].member_id = 'wrong-owner';
    await assert.rejects(load(today), /ownership/);
  }
});

test('list/detail/summary/current filter parity and awaiting filter exclusion with read-only mocks', async () => {
  const data = tables(), before = structuredClone(data), db = database(data);
  const list = await listPlans(tenant, { status: 'current', pageSize: 1 }, db);
  assert.equal(list.total, 1);
  const detail = await planDetail(tenant, 'plan', { status() { throw new Error('unexpected HTTP error'); } }, { db });
  const summary = await buildSummary(tenant, { db });
  assert.deepEqual(list.plans[0].membershipPresentation, detail.plan.membershipPresentation);
  assert.equal(summary.currentMembers, list.total);
  assert.equal(summary.byStatus.first_payment_pending, 1, 'raw API preserved');
  assert.equal((await listPlans(tenant, { displayStatus: 'first_payment_pending' }, db)).total, 0);
  assert.equal((await listPlans(tenant, { status: 'first_payment_pending' }, db)).total, 1, 'legacy raw filter preserved');
  assert.equal(detail.plan.status, 'first_payment_pending');
  assert.equal(detail.plan.collection_stopped_at, today);
  assert.equal(detail.plan.collectionPresentation.held, true);
  assert.deepEqual(data, before);
});

test('current filtering precedes pagination and preserves organization support', async () => {
  const data = tables();
  data.member_membership_history[0].status = 'pending_activation';
  data.organization = [{ id: 'org', tenant_id: tenant }];
  data.membership_billing_agreements.push({ id: 'oa', tenant_id: tenant, organization_id: 'org', provider: 'gocardless' });
  data.membership_payment_plans.push({ ...plan, id: 'op', member_id: null, organization_id: 'org', billing_agreement_id: 'oa' });
  data.organisation_membership_history = [{ ...data.member_membership_history[0], id: 'oh', member_id: null,
    organization_id: 'org', billing_agreement_id: 'oa', status: 'active' }];
  const result = await listPlans(tenant, { status: 'current', pageSize: 1 }, database(data));
  assert.equal(result.total, 1);
  assert.equal(result.plans[0].id, 'op');
});

test('history and recognition read errors surface instead of false current or empty success', async () => {
  for (const failure of ['member_membership_history', 'organisation_membership_history', 'bnms_dd_alpha_membership_recognition']) {
    await assert.rejects(loadDirectDebitMembershipPresentations(database(tables(), failure), tenant, [plan]), /lookup|recognition/i);
  }
  const data = tables();
  data.bnms_dd_alpha_membership_recognition = [{ ...recognition, member_id: 'wrong' }];
  await assert.rejects(loadDirectDebitMembershipPresentations(database(data), tenant, [plan]), /ownership/);
});

test('current filtering retains deleted-member, cross-tenant and provider exclusions', async () => {
  for (const mutate of [
    data => { data.member[0].email = 'deleted_member@deleted.local'; },
    data => { data.member[0].tenant_id = 'another-tenant'; },
    data => { data.membership_payment_plans[0].provider = 'stripe'; },
    data => { data.membership_billing_agreements[0].provider = 'stripe'; },
  ]) {
    const data = tables();
    mutate(data);
    assert.equal((await listPlans(tenant, { status: 'current' }, database(data))).total, 0);
    assert.equal((await buildSummary(tenant, { db: database(data) })).currentMembers, 0);
  }
});

test('canonical Alpha/Beta/pilot adoption distinguishes historic unknown entitlement from genuine joiners', async () => {
  for (const source of ['bnms_dd_alpha_adoption', 'bnms_dd_beta_adoption', 'bnms_dd_pilot_adoption']) {
    const data = tables();
    data.member_membership_history[0].status = 'pending_activation';
    data[source] = [{ id: 'adoption', tenant_id: tenant, member_id: 'member',
      agreement_id: 'agreement', plan_id: 'plan', history_id: 'history' }];
    for (const status of ['first_payment_pending', 'mandate_pending', 'active']) {
      data.membership_payment_plans[0].status = status;
      const db = database(data);
      const result = await listPlans(tenant, { displayStatus: 'membership_unverified', pageSize: 1 }, db);
      assert.equal(result.total, 1);
      assert.equal(result.plans[0].membershipPresentation.historicalImport.source, source);
      assert.equal(result.plans[0].membershipPresentation.current, false);
      for (const filter of ['current', 'first_payment_pending', 'mandate_pending', 'active', 'pending_activation']) {
        assert.equal((await listPlans(tenant, { displayStatus: filter }, db)).total, 0, `${source} ${filter}`);
      }
      const summary = await buildSummary(tenant, { db });
      assert.equal(summary.byDisplayStatus.membership_unverified, 1);
      assert.equal(summary.pendingActivations, 0);
      const detail = await planDetail(tenant, 'plan', {}, { db });
      assert.deepEqual(detail.plan.membershipPresentation, result.plans[0].membershipPresentation);
    }
    data.membership_payment_plans[0].status = 'payment_overdue';
    assert.equal((await listPlans(tenant, { displayStatus: 'payment_overdue' }, database(data))).total, 1);
    delete data[source];
    data.membership_payment_plans[0].status = 'first_payment_pending';
    data.membership_payment_plans[0].metadata = { bnms_release_required: true, bnms_beta_held: true };
    const fresh = await listPlans(tenant, { displayStatus: 'first_payment_pending' }, database(data));
    assert.equal(fresh.total, 1, 'unverified arbitrary metadata cannot establish historical import');
    assert.equal(fresh.plans[0].membershipPresentation.historicalImport, null);
    assert.equal((await buildSummary(tenant, { db: database(data) })).pendingActivations, 1);
  }
});

test('Current and pending-activation summary/filter parity with duplicates, preserving raw filters', async () => {
  const data = tables();
  data.member_membership_history.push({ ...data.member_membership_history[0], id: 'z-pending', status: 'pending_activation' });
  data.membership_payment_plans.push({ ...data.membership_payment_plans[0], id: 'duplicate-plan' });
  const db = database(data);
  for (const status of ['first_payment_pending', 'mandate_pending', 'active']) {
    data.membership_payment_plans.forEach(p => { p.status = status; });
    const summary = await buildSummary(tenant, { db });
    assert.equal(summary.currentPlans, 2, 'label explicitly counts plans, not unique people');
    assert.equal(summary.pendingActivations, 0);
    assert.equal((await listPlans(tenant, { displayStatus: 'current', pageSize: 1 }, db)).total, 2);
    assert.equal((await listPlans(tenant, { displayStatus: status }, db)).total, 0);
    assert.equal((await listPlans(tenant, { status }, db)).total, 2);
    assert.equal((await listPlans(tenant, { displayStatus: 'pending_activation' }, db)).total, 0);
  }
});

test('summary and exact display filters reconcile 249 current plus 11 unverified eligible plans', async () => {
  const data = {
    member: [],
    membership_billing_agreements: [],
    membership_payment_plans: [],
    member_membership_history: [],
    bnms_dd_beta_adoption: [],
  };
  const now = new Date().toISOString().slice(0, 10);
  const end = `${Number(now.slice(0, 4)) + 1}-12-31`;
  for (let n = 0; n < 259; n++) {
    const imported = n >= 248;
    const memberId = imported ? `import-member-${n}` : `current-member-${Math.min(n, 247)}`;
    const agreementId = `agreement-${n}`;
    const planId = `plan-${String(n).padStart(3, '0')}`;
    const historyId = `history-${n}`;
    if (!data.member.some(m => m.id === memberId)) {
      data.member.push({ id: memberId, tenant_id: tenant, email: `${memberId}@fixture.invalid` });
    }
    data.membership_billing_agreements.push({
      id: agreementId, tenant_id: tenant, member_id: memberId, provider: 'gocardless',
    });
    data.membership_payment_plans.push({
      id: planId, tenant_id: tenant, member_id: memberId, billing_agreement_id: agreementId,
      provider: 'gocardless', status: imported ? 'first_payment_pending' : 'active',
      updated_at: `2026-01-${String((n % 28) + 1).padStart(2, '0')}`,
      collection_stopped_at: imported ? now : null,
    });
    data.member_membership_history.push({
      id: historyId, tenant_id: tenant, member_id: memberId, billing_agreement_id: agreementId,
      status: imported ? 'pending_activation' : 'active',
      term_start_date: now, term_end_date: end,
    });
    if (imported) {
      data.bnms_dd_beta_adoption.push({
        id: `adoption-${n}`, tenant_id: tenant, member_id: memberId,
        agreement_id: agreementId, plan_id: planId, history_id: historyId,
      });
    }
  }
  // A second plan for one current member proves totals count plans, not people.
  data.membership_billing_agreements.push({
    id: 'agreement-duplicate', tenant_id: tenant, member_id: 'current-member-0', provider: 'gocardless',
  });
  data.membership_payment_plans.push({
    id: 'plan-duplicate', tenant_id: tenant, member_id: 'current-member-0',
    billing_agreement_id: 'agreement-duplicate', provider: 'gocardless', status: 'mandate_pending',
    updated_at: '2026-02-01',
  });
  data.member_membership_history.push({
    id: 'history-duplicate', tenant_id: tenant, member_id: 'current-member-0',
    billing_agreement_id: 'agreement-duplicate', status: 'active',
    term_start_date: now, term_end_date: end,
  });
  // Ineligible rows must not inflate the total or any display bucket.
  data.member.push({ id: 'deleted', tenant_id: tenant, email: 'deleted_fixture@deleted.local' });
  data.membership_billing_agreements.push({
    id: 'agreement-deleted', tenant_id: tenant, member_id: 'deleted', provider: 'gocardless',
  });
  data.membership_payment_plans.push({
    id: 'plan-deleted', tenant_id: tenant, member_id: 'deleted',
    billing_agreement_id: 'agreement-deleted', provider: 'gocardless', status: 'active',
  });
  data.member.push({ id: 'stripe-member', tenant_id: tenant, email: 'stripe@fixture.invalid' });
  data.membership_billing_agreements.push({
    id: 'agreement-stripe', tenant_id: tenant, member_id: 'stripe-member', provider: 'stripe',
  });
  data.membership_payment_plans.push({
    id: 'plan-stripe', tenant_id: tenant, member_id: 'stripe-member',
    billing_agreement_id: 'agreement-stripe', provider: 'stripe', status: 'active',
  });

  const before = structuredClone(data);
  const db = database(data);
  const summary = await buildSummary(tenant, { db });
  assert.equal(summary.totalPlans, 260);
  assert.equal(summary.byDisplayStatus.current, 249);
  assert.equal(summary.byDisplayStatus.membership_unverified, 11);
  assert.equal(Object.values(summary.byDisplayStatus).reduce((sum, count) => sum + count, 0), summary.totalPlans);

  const current = await listPlans(tenant, { displayStatus: 'current', page: 2, pageSize: 100 }, db);
  assert.equal(current.total, 249);
  assert.equal(current.plans.length, 100);
  assert.equal(current.hasMore, true);
  const unverified = await listPlans(tenant, {
    displayStatus: 'membership_unverified', q: 'import-member', pageSize: 20,
  }, db);
  assert.equal(unverified.total, 11);
  assert.equal(unverified.hasMore, false);
  assert.ok(unverified.plans.every(p => p.collectionPresentation.held));
  assert.deepEqual(data, before, 'summary, filtering, search and paging remain read-only');
});

test('displayStatus is exact while legacy pending_activation status retains activation-flag compatibility', async () => {
  const data = tables();
  data.member_membership_history[0].status = 'pending_activation';
  data.membership_payment_plans[0].status = 'active';
  data.membership_payment_plans.push({
    ...data.membership_payment_plans[0],
    id: 'literal-pending',
    status: 'pending_activation',
    member_id: 'literal-member',
    billing_agreement_id: 'literal-agreement',
  });
  data.membership_billing_agreements.push({
    id: 'literal-agreement', tenant_id: tenant, member_id: 'literal-member', provider: 'gocardless',
  });
  data.member.push({ id: 'literal-member', tenant_id: tenant, email: 'literal@fixture.invalid' });

  const db = database(data);
  const exact = await listPlans(tenant, { displayStatus: 'pending_activation' }, db);
  assert.equal(exact.total, 1);
  assert.equal(exact.plans[0].id, 'literal-pending');
  assert.equal(exact.plans[0].activation_pending, false);

  const legacy = await listPlans(tenant, { status: 'pending_activation' }, db);
  assert.equal(legacy.total, 1);
  assert.equal(legacy.plans[0].id, 'plan');
  assert.equal(legacy.plans[0].membershipPresentation.displayStatus, 'active');

  for (const status of ['active', 'first_payment_pending', 'mandate_pending']) {
    const result = await listPlans(tenant, { displayStatus: status }, db);
    assert.ok(result.plans.every(row => row.membershipPresentation.displayStatus === status));
  }
});

test('canonical adoption ownership mismatches, ambiguous evidence and read errors fail explicitly', async () => {
  const adoption = { id: 'a', tenant_id: tenant, member_id: 'member', agreement_id: 'agreement', plan_id: 'plan', history_id: 'history' };
  for (const patch of [{ member_id: 'other' }, { agreement_id: 'other' }, { history_id: 'missing' }]) {
    const data = tables();
    data.bnms_dd_beta_adoption = [{ ...adoption, ...patch }];
    await assert.rejects(loadDirectDebitMembershipPresentations(database(data), tenant, [plan]), /ownership/);
  }
  const data = tables();
  data.bnms_dd_beta_adoption = [adoption];
  data.bnms_dd_pilot_adoption = [adoption];
  await assert.rejects(loadDirectDebitMembershipPresentations(database(data), tenant, [plan]), /Ambiguous/);
  await assert.rejects(loadDirectDebitMembershipPresentations(database(tables(), 'bnms_dd_beta_adoption'), tenant, [plan]), /lookup/);
});