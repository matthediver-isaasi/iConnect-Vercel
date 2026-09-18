import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyInstalmentCount, monthlyActivationSchedule, simulateMonthlySuccessor,
  assertMonthlyCollectionsWithinTerm, reserveRollingMonthlyRenewal, assertTrustedMonthlyTerm, sendRollingMonthlyNotice,
} from './rollingMonthlyRenewal.js';
import { buildCardAgreementSnapshot, resolveCardMonthlyOffer, ensureStripeCardCancellationBoundary } from './stripeMonthlyCard.js';
import { buildAgreementSnapshot, resolveDdOffer, ensureSubscriptionForAgreement, computeSubscriptionCollectionDate } from './gocardlessDirectDebit.js';
import { computeRenewalWindow, decideRenewalAction, executeAutoRenewal } from './gocardlessDdRenewals.js';
import { resolveCardAutoRenew, executeCardAutoRenewal } from './stripeCardRenewals.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture({ period = 'annual', start = '2026-09-15', price = 20, vat = 0, id = 'config-original' } = {}) {
  return {
    success: true,
    config: {
      id, start_mode: 'immediate', billing_period: period, structure_scope_type: 'member',
      currency: 'GBP', pricing_model: 'flat', dd_enabled: true, card_monthly_enabled: true,
      dd_monthly_amount: price, dd_instalment_count: 12, dd_auto_renew: true,
    },
    membershipYear: { label: `rolling:${start}`, start: new Date(`${start}T00:00:00Z`) },
    annualCost: 240, finalCost: 240, totalWithVat: 240, vatAmount: 0,
    vatRatePercent: vat, currency: 'GBP', tierLabel: 'Individual',
  };
}

function snapshotFor(provider, sim = fixture()) {
  const offer = provider === 'stripe' ? resolveCardMonthlyOffer(sim) : resolveDdOffer(sim);
  return provider === 'stripe'
    ? buildCardAgreementSnapshot({ offer, simResult: sim, acceptedAt: '2026-09-15T10:00:00Z' })
    : buildAgreementSnapshot({ offer, simResult: sim, acceptedAt: '2026-09-15T10:00:00Z' });
}

// Isolated PostgREST fixture: all mutations stay in these arrays. Unique keys
// model the database's final agreement/term guards, including concurrent calls.
function memoryDb(seed = {}) {
  const tables = clone(seed);
  const operations = [];
  return {
    tables, operations,
    from(table) {
      tables[table] ||= [];
      let filters = [], mode = 'select', payload, one = false;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push((row) => row[key] === value); return query; },
        or(expression) {
          const match = expression.match(/(effective_from|effective_to)\.(lte|gte)\.(.+)$/);
          if (match) filters.push((row) => !row[match[1]] || (match[2] === 'lte' ? row[match[1]] <= match[3] : row[match[1]] >= match[3]));
          return query;
        },
        insert(value) { mode = 'insert'; payload = clone(value); return query; },
        upsert(value) { mode = 'upsert'; payload = clone(value); return query; },
        update(value) { mode = 'update'; payload = clone(value); return query; },
        maybeSingle() { one = true; return query; },
        single() { one = true; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            operations.push({ table, mode, payload: clone(payload || null) });
            let rows = tables[table].filter((row) => filters.every((filter) => filter(row)));
            if (mode === 'insert') {
              const collision = tables[table].some((row) => (
                table === 'membership_billing_agreements'
                  ? row.idempotency_key === payload.idempotency_key
                  : table === 'membership_dd_renewals'
                    ? row.previous_agreement_id === payload.previous_agreement_id && row.renewal_year === payload.renewal_year
                     : ['member_membership_history', 'organisation_membership_history'].includes(table)
                       && row.tenant_id === payload.tenant_id && row.member_id === payload.member_id
                       && row.organization_id === payload.organization_id
                      && row.membership_year === payload.membership_year
              ));
              if (collision) return { data: null, error: { code: '23505', message: 'unique term' } };
              const row = { id: `${table}-${tables[table].length + 1}`, ...payload };
              tables[table].push(row); rows = [row];
            }
            if (mode === 'update') rows.forEach((row) => Object.assign(row, payload));
            if (mode === 'upsert') {
              const row = tables[table].find((r) => r.previous_agreement_id === payload.previous_agreement_id && r.renewal_year === payload.renewal_year);
              if (row) Object.assign(row, payload);
              else tables[table].push(payload);
              rows = [row || payload];
            }
            return { data: clone(one ? rows[0] || null : rows), error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

for (const provider of ['stripe', 'gocardless']) {
  test(`${provider}: 12/3/1 month commitments remain independent of monthly collections and survive edits`, () => {
    for (const [period, duration, renewal] of [
      ['annual', 12, '2027-09-15'], ['quarterly', 3, '2026-12-15'], ['monthly', 1, '2026-10-15'],
    ]) {
      const sim = fixture({ period });
      const snapshot = snapshotFor(provider, sim);
      assert.equal(snapshot.instalment_count, duration);
      assert.equal(snapshot.commitment.term_duration_months, duration);
      assert.equal(snapshot.commitment.membership_renewal_date, renewal);
      assert.equal(snapshot.commitment.commitment_snapshot.payment_frequency, 'monthly');
      sim.config.dd_monthly_amount = 25;
      sim.config.billing_period = 'monthly';
      assert.equal(snapshot.monthly_amount, 20);
      assert.equal(snapshot.commitment.commitment_snapshot.config.dd_monthly_amount, 20);
      assert.equal(snapshot.commitment.membership_renewal_date, renewal);
    }
  });
  test(`${provider}: taxed agreed gross instalments yield matching net/VAT commitment`, () => {
    const snapshot = snapshotFor(provider, fixture({ price: 24, vat: 20 }));
    const amounts = snapshot.commitment.commitment_snapshot.amounts;
    assert.deepEqual([amounts.final_cost, amounts.vat_amount, amounts.total_with_vat], [240, 48, 288]);
    assert.equal(snapshot.plan_total, 288);
  });
}

test('fixed schedules preserve configured instalment count; rolling shorter plans do not shorten membership', () => {
  assert.equal(monthlyInstalmentCount({ start_mode: 'fixed_date', billing_period: 'monthly', dd_instalment_count: 12 }), 12);
  const sim = fixture();
  sim.config.dd_instalment_count = 6;
  const snapshot = snapshotFor('stripe', sim);
  assert.equal(snapshot.instalment_count, 6);
  assert.equal(snapshot.commitment.membership_renewal_date, '2027-09-15');
});

test('monthly Jan 31 term clamps to February and resumes original anchor in successor', async () => {
  const snapshot = snapshotFor('stripe', fixture({ period: 'monthly', start: '2028-01-31' }));
  assert.equal(snapshot.commitment.membership_renewal_date, '2028-02-29');
  const result = await simulateMonthlySuccessor({
    tenantId: 'tenant', memberId: 'member', snapshot,
    resolveConfig: async () => fixture({ period: 'monthly' }).config,
    simulate: async () => fixture({ period: 'monthly' }),
  });
  const next = snapshotFor('stripe', result);
  assert.equal(next.commitment.term_start_date, '2028-02-29');
  assert.equal(next.commitment.membership_renewal_date, '2028-03-31');
});

test('late cron resolves only the saved renewal boundary and rejects missing/overlapping successors', async () => {
  const snapshot = snapshotFor('gocardless');
  const config = { ...fixture({ price: 25, id: 'next' }).config, tenant_id: 'tenant', effective_from: '2027-01-01', effective_to: '2027-12-31' };
  const db = memoryDb({ membership_tier_config: [config] });
  let options;
  const result = await simulateMonthlySuccessor({
    tenantId: 'tenant', memberId: 'member', snapshot, db,
    simulate: async (_tenant, _member, opts) => { options = opts; return fixture({ price: 25, id: 'next' }); },
  });
  assert.equal(options.asOfDate, '2027-09-15');
  assert.equal(options.termStartDate, '2027-09-15');
  assert.equal(result.membershipYear.label, 'rolling:2027-09-15');
  assert.equal(result.config.dd_monthly_amount, 25);
  db.tables.membership_tier_config.push({ ...config, id: 'overlap' });
  await assert.rejects(simulateMonthlySuccessor({
    tenantId: 'tenant', memberId: 'member', snapshot, db, simulate: async () => assert.fail('no speculative quote'),
  }), /overlapping/);
  db.tables.membership_tier_config = [];
  await assert.rejects(simulateMonthlySuccessor({
    tenantId: 'tenant', memberId: 'member', snapshot, db, simulate: async () => assert.fail('no stale-price fallback'),
  }), /No eligible membership structure/);
});

test('renewal decision uses saved boundary/consent, not a newly edited auto-renew checkbox', () => {
  const snapshot = snapshotFor('stripe');
  assert.equal(computeRenewalWindow(snapshot).yearEnd.toISOString().slice(0, 10), '2027-09-15');
  assert.equal(resolveCardAutoRenew({ success: true, config: { dd_auto_renew: false } }, snapshot), true);
  snapshot.auto_renew = false;
  assert.equal(resolveCardAutoRenew({ success: true, config: { dd_auto_renew: true } }, snapshot), false);
  const decision = decideRenewalAction({
    snapshot, expectedKind: 'monthly_card', planStatus: 'active', autoRenew: false,
    renewalRow: { status: 'notice_sent', mode: 'auto' }, today: new Date('2027-09-15'),
  });
  assert.equal(decision.action, 'await_confirmation');
});

test('pending payment and manual approvals never activate early; consent date is not callback date', () => {
  const snapshot = snapshotFor('stripe');
  assert.deepEqual(monthlyActivationSchedule(snapshot, false, new Date('2026-09-14')), { status: null });
  assert.deepEqual(monthlyActivationSchedule(snapshot, true, new Date('2026-09-14')), {
    status: 'scheduled', scheduled_activation_date: '2026-09-15',
  });
  assert.deepEqual(monthlyActivationSchedule(snapshot, true, new Date('2026-11-30')), { status: 'active' });
  assert.equal(snapshot.commitment.term_start_date, '2026-09-15');
});

test('DD delayed schedule cannot charge beyond saved term, but ordinary monthly collection is valid', () => {
  const snapshot = snapshotFor('gocardless');
  assert.doesNotThrow(() => assertMonthlyCollectionsWithinTerm(snapshot, '2026-09-20', 12));
  assert.throws(() => assertMonthlyCollectionsWithinTerm(snapshot, '2026-10-20', 12), /outside the agreed/);
  assert.throws(() => assertMonthlyCollectionsWithinTerm(snapshot, '2026-09-14', 12), /outside the agreed/);
});

test('legacy immediate snapshot without dated commitment fails closed', async () => {
  await assert.rejects(assertTrustedMonthlyTerm(memoryDb(), 'tenant', { start_mode: 'immediate' }), /review is required/);
});

function renewalFixture(provider) {
  const rail = provider === 'stripe' ? 'card' : 'dd';
  const prior = snapshotFor(provider);
  const previousAgreement = {
    id: 'prior-agreement', tenant_id: 'tenant', member_id: 'member', provider,
    stripe_customer_id: 'cus_saved', environment: 'test',
    metadata: { [rail]: prior },
  };
  const db = memoryDb({
    member_membership_history: [{
      id: 'prior-history', tenant_id: 'tenant', member_id: 'member',
      billing_agreement_id: previousAgreement.id, membership_year: 'rolling:2026-09-15',
    }],
    membership_billing_agreements: [previousAgreement],
  });
  const successor = fixture({ price: 25, start: '2027-09-15', id: 'next-config' });
  successor.previousTerm = prior.commitment;
  return { db, prior, previousAgreement, successor, rail };
}

test('concurrent reservation creates one history; cross-provider loser cannot reach collection', async () => {
  const { db, previousAgreement, successor } = renewalFixture('stripe');
  const args = {
    db, tenantId: 'tenant', memberId: 'member', previousAgreement,
    snapshot: snapshotFor('stripe', successor), provider: 'stripe', idempotencyKey: 'same-term',
  };
  const [a, b] = await Promise.all([reserveRollingMonthlyRenewal(args), reserveRollingMonthlyRenewal(args)]);
  assert.equal(a.agreement.id, b.agreement.id);
  assert.equal(db.tables.member_membership_history.length, 2);
  assert.equal(a.snapshot.commitment.previous_term_id, 'prior-history');
  await assert.rejects(reserveRollingMonthlyRenewal({
    ...args, provider: 'gocardless', idempotencyKey: 'dd-same-term',
    snapshot: snapshotFor('gocardless', successor),
  }), /another payment agreement/);
});

for (const startMode of ['immediate', 'fixed_date']) {
  for (const pricingPolicy of ['fixed', 'dynamic']) {
    test(`organisation ${startMode} ${pricingPolicy} continuation preserves owner, consent and retry terms`, async () => {
      const sim = fixture();
      Object.assign(sim.config, {
        structure_scope_type: 'organization', start_mode: startMode,
        membership_start_month: 9, membership_start_day: 15,
        dd_policy_version: 1, dd_collection_end_policy: 'continue',
        dd_pricing_policy: pricingPolicy, dd_invoicing_mode: 'per_instalment',
      });
      sim.membershipYear.end = new Date('2027-09-14');
      if (startMode === 'fixed_date') sim.membershipYear.label = '2026/2027';
      const prior = snapshotFor('gocardless', sim);
      const previousAgreement = {
        id: 'previous-org', tenant_id: 'tenant', organization_id: 'organization', provider: 'gocardless',
        metadata: { dd: prior }, billing_contact_email: 'billing@example.test', dd_payer: 'billing_contact',
      };
      const successor = clone(sim);
      Object.assign(successor.config, {
        id: 'org-next', tenant_id: 'tenant', dd_monthly_amount: 25,
        effective_from: '2027-09-15', effective_to: null,
        // Changes to the catalogue policy cannot change this agreement.
        dd_collection_end_policy: 'stop', dd_pricing_policy: pricingPolicy === 'fixed' ? 'dynamic' : 'fixed',
      });
      successor.membershipYear = {
        label: startMode === 'fixed_date' ? '2027/2028' : 'rolling:2027-09-15',
        start: new Date('2027-09-15'), end: new Date('2028-09-14'),
      };
      const db = memoryDb({
        membership_tier_config: [successor.config],
        membership_billing_agreements: [previousAgreement],
        organisation_membership_history: [{
          id: 'previous-history', tenant_id: 'tenant', organization_id: 'organization',
          billing_agreement_id: previousAgreement.id, membership_year: sim.membershipYear.label,
        }],
      });
      let collections = 0;
      const used = new Set();
      const args = {
        tenantId: 'tenant', organizationId: 'organization', previousAgreement,
        renewalRow: { mode: 'auto', status: 'notice_sent' },
        deps: {
          db, now: () => new Date('2027-09-16'),
          simulate: async (_tenant, owner, options) => {
            assert.equal(owner, 'organization');
            assert.equal(options.asOfDate, '2027-09-15');
            return successor;
          },
          findMandate: async ({ organizationId, memberId }) => {
            assert.equal(organizationId, 'organization');
            assert.equal(memberId, undefined);
            return { mandateId: 'MD-organisation', customerId: 'CU-org' };
          },
          ensureSubscription: async (agreement) => {
            assert.equal(db.tables.organisation_membership_history.length, 2);
            assert.equal(agreement.organization_id, 'organization');
            assert.equal(agreement.billing_contact_email, 'billing@example.test');
            assert.equal(agreement.metadata.dd.collection_policy.end_policy, 'continue');
            assert.equal(agreement.metadata.dd.collection_policy.pricing_policy, pricingPolicy);
            assert.equal(agreement.metadata.dd.monthly_amount, 25);
            if (!used.has(agreement.id)) collections++;
            used.add(agreement.id);
            return { created: true };
          },
          activateMembership: async () => {}, sendEmail: async () => ({ sent: true }),
        },
      };
      assert.equal((await executeAutoRenewal(args)).renewed, true);
      successor.config.dd_monthly_amount = 99;
      assert.equal((await executeAutoRenewal(args)).renewed, true);
      assert.equal(collections, 1);
      assert.equal(db.tables.organisation_membership_history.length, 2);
      assert.equal(db.tables.membership_dd_renewals[0].organization_id, 'organization');
      assert.equal(db.tables.membership_dd_renewals[0].member_id, undefined);
    });
  }
}

for (const provider of ['stripe', 'gocardless']) {
  test(`${provider}: reserve before provider; delayed retry uses the first committed price without duplicate term`, async () => {
    const { db, previousAgreement, successor } = renewalFixture(provider);
    let calls = 0, quoteCalls = 0;
    const keyResults = new Map();
    const assertReserved = () => {
      assert.equal(db.tables.member_membership_history.length, 2, 'history exists before provider call');
      assert.equal(db.tables.membership_billing_agreements.length, 2, 'agreement exists before provider call');
    };
    const common = {
      db, now: () => new Date('2027-09-16T10:00:00Z'),
      resolveConfig: async () => { quoteCalls++; return successor.config; },
      simulate: async () => successor,
      sendEmail: async (event) => {
        assert.equal(event, 'renewal_confirmed');
        assertReserved();
        return { sent: true };
      },
    };
    const stripe = {
      customers: { retrieve: async () => ({ id: 'cus_saved' }) },
      paymentMethods: { list: async () => ({ data: [{ id: 'pm_saved', type: 'card' }] }) },
      products: { create: async () => { assertReserved(); return { id: 'product' }; } },
      subscriptions: { retrieve: async () => ({ id: 'sub_renewal' }), create: async (params, opts) => {
        assertReserved();
        assert.equal(params.items[0].price_data.unit_amount, 2500);
        assert.equal(params.items[0].price_data.product, 'product');
        assert.ok(params.cancel_at <= new Date('2028-09-15').getTime() / 1000);
        if (!keyResults.has(opts.idempotencyKey)) { calls++; keyResults.set(opts.idempotencyKey, clone(params)); }
        else assert.deepEqual(params, keyResults.get(opts.idempotencyKey), 'provider request is identical on retry');
        return { id: 'sub_renewal' };
      } },
    };
    const deps = provider === 'stripe' ? {
      ...common, getStripe: async () => ({ stripe, environment: 'test' }),
      ensurePlan: async () => {},
    } : {
      ...common,
      findMandate: async () => ({ mandateId: 'MD_saved', customerId: 'CU_saved' }),
      ensureSubscription: async (agreement) => {
        assertReserved();
        assert.equal(agreement.metadata.dd.monthly_amount, 25);
        if (!keyResults.has(agreement.id)) { calls++; keyResults.set(agreement.id, true); }
        return { created: true };
      },
      activateMembership: async () => {},
    };
    const execute = provider === 'stripe' ? executeCardAutoRenewal : executeAutoRenewal;
    const args = {
      tenantId: 'tenant', memberId: 'member', previousAgreement,
      renewalRow: { mode: 'auto', status: 'notice_sent' }, deps,
    };
    assert.equal((await execute(args)).renewed, true);
    successor.config.dd_monthly_amount = 99;
    successor.config.billing_period = 'monthly';
    deps.now = () => new Date('2027-09-18T10:00:00Z');
    assert.equal((await execute(args)).renewed, true);
    assert.equal(calls, 1);
    assert.equal(quoteCalls, 1, 'retry recovers immutable reservation rather than a fresh configuration');
    assert.equal(db.tables.member_membership_history.length, 2);
    assert.equal(db.tables.member_membership_history[1].membership_renewal_date, '2028-09-15');
  });
  test(`${provider}: no automatic charge before boundary or without consent`, async () => {
    const { db, previousAgreement } = renewalFixture(provider);
    const execute = provider === 'stripe' ? executeCardAutoRenewal : executeAutoRenewal;
    const args = {
      tenantId: 'tenant', memberId: 'member', previousAgreement,
      renewalRow: { mode: 'auto' },
      deps: { db, now: () => new Date('2027-09-14'), simulate: () => assert.fail('not due') },
    };
    assert.equal((await execute(args)).renewed, false);
    previousAgreement.metadata[provider === 'stripe' ? 'card' : 'dd'].auto_renew = false;
    if (provider === 'gocardless') previousAgreement.metadata.dd.collection_policy.end_policy = 'stop';
    args.deps.now = () => new Date('2027-09-15');
    assert.equal((await execute(args)).renewed, false);
    assert.equal(db.tables.member_membership_history.length, 1);
  });
}

test('late Stripe Checkout callback caps schedule at saved boundary without reanchoring dates', async () => {
  const snapshot = snapshotFor('stripe');
  const boundary = new Date('2027-09-15').getTime() / 1000;
  const billingAnchor = new Date('2026-09-20').getTime() / 1000;
  let update;
  let savedSchedule;
  let updates = 0;
  const stripe = {
    subscriptions: { retrieve: async () => ({
      id: 'sub', metadata: { kind: 'monthly_card', agreement_id: 'agreement' },
      billing_cycle_anchor: billingAnchor, items: { data: [{ price: { id: 'price' } }] },
      schedule: savedSchedule?.id,
    }) },
    subscriptionSchedules: {
      create: async () => ({ id: 'schedule', phases: [{ start_date: billingAnchor }] }),
      retrieve: async () => savedSchedule,
      update: async (_id, params) => { updates++; update = params; savedSchedule = { id: 'schedule', ...params }; return savedSchedule; },
    },
  };
  const result = await ensureStripeCardCancellationBoundary({
    agreement: { id: 'agreement', metadata: { card: snapshot } }, session: { subscription: 'sub' }, stripe,
  });
  assert.equal(result.cancelAt, boundary);
  assert.equal(update.phases[0].end_date, boundary);
  assert.equal(snapshot.commitment.term_start_date, '2026-09-15');
  await ensureStripeCardCancellationBoundary({
    agreement: { id: 'agreement', metadata: { card: snapshot } }, session: { subscription: 'sub' }, stripe,
  });
  assert.equal(updates, 1, 'callback replay observes the saved finite schedule');
});

test('GoCardless reordered callbacks reuse established subscription without reading edited tier pricing', async () => {
  const snapshot = snapshotFor('gocardless');
  const agreement = {
    id: 'agreement', tenant_id: 'tenant', member_id: 'member',
    metadata: { dd: snapshot }, gocardless_mandate_id: 'MD_saved',
  };
  // The existing plan lookup is keyed with the production deterministic key.
  const { buildIdempotencyKey } = await import('./gocardless.js');
  const db = memoryDb({
    membership_payment_plans: [{
      id: 'plan', idempotency_key: buildIdempotencyKey('dd-sub', agreement.id, snapshot.membership_year),
      gocardless_subscription_id: 'SB_saved', amount_minor: 2000,
      start_date: '2026-09-20', instalments_total: 12,
    }],
  });
  const result = await ensureSubscriptionForAgreement(agreement, {
    db, gc: { createSubscription: async () => assert.fail('no duplicate subscription') },
    now: () => new Date('2027-03-01'),
  });
  assert.equal(result.plan.amount_minor, 2000);
  assert.equal(result.created, false);
  assert.equal(db.operations.filter((op) => op.table === 'membership_tier_config').length, 0);
  assert.equal(snapshot.commitment.membership_renewal_date, '2027-09-15');
  const futureSchedule = computeSubscriptionCollectionDate(snapshot, '2026-09-01', null, '2026-09-02');
  assert.equal(futureSchedule.startDate, '2026-09-15', 'future agreed commencement bounds the earliest collection');
});

test('notice ledger claims concurrently and retries failed delivery without authorizing renewal', async () => {
  const db = memoryDb();
  let deliveries = 0;
  const args = {
    db, tenantId: 'tenant', agreement: { id: 'agreement', member_id: 'member' },
    renewalYear: 'rolling:2027-09-15', mode: 'auto', eventKey: 'renewal_notice',
    now: new Date('2027-08-20'),
    sendEmail: async () => { deliveries++; return { sent: true }; },
  };
  const outcomes = await Promise.all([sendRollingMonthlyNotice(args), sendRollingMonthlyNotice(args)]);
  assert.equal(deliveries, 1);
  assert.equal(outcomes.filter((result) => result.sent).length, 1);
  assert.equal(db.tables.membership_dd_renewals[0].status, 'notice_sent');
  const failedArgs = {
    ...args, renewalYear: 'rolling:2027-12-15', sendEmail: async () => ({ sent: false, reason: 'fixture email unavailable' }),
  };
  await assert.rejects(sendRollingMonthlyNotice(failedArgs), /email unavailable/);
  assert.equal(db.tables.membership_dd_renewals[1].status, 'notice_error');
  assert.equal((await sendRollingMonthlyNotice({ ...failedArgs, sendEmail: args.sendEmail })).sent, true);
  assert.equal(db.tables.membership_dd_renewals[1].status, 'notice_sent');
});