import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFormMembershipRenewalContext } from './formMembershipRenewalContext.js';
import { snapshotFormMembershipPayment, createReservedFormMembershipIntent,
  historyFromFormPaymentSnapshot, loadFormMembershipPaymentQuote } from './formMembershipPaymentQuote.js';
import { buildAgreementSnapshot, buildMonthlyBillingRequest, computeSubscriptionCollectionDate, resolveDdOffer } from './gocardlessDirectDebit.js';
import { previewFormMembershipRenewal } from './formMembershipRenewalDryRun.js';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { incentiveFieldsFromSavedQuote } from './membershipIncentiveSnapshot.js';
import { saveFormMembershipPaymentQuote } from './formMembershipPaymentQuote.js';

function fixture({ paused = false, election = null, now = '2026-11-01T00:00:00Z' } = {}) {
  const config = { id: 'structure', tenant_id: 'tenant', start_mode: 'fixed_date',
    structure_scope_type: 'member', billing_period: 'annual', renewal_open_days: 60, renewal_grace_days: 7,
    pricing_model: 'flat', online_card_payment: true, dd_enabled: true,
    dd_policy_version: 1, dd_collection_end_policy: 'continue', dd_pricing_policy: 'fixed',
    dd_monthly_amount: 10, dd_instalment_count: 12, currency: 'GBP' };
  const predecessor = { id: 'prior', tenant_id: 'tenant', member_id: 'member',
    term_start_date: '2026-01-01', term_end_date: '2026-12-31', status: 'active', payment_status: 'paid',
    renewal_policy_snapshot: config };
  const tables = { member: [{ id: 'member', tenant_id: 'tenant', membership_paused: paused }],
    member_membership_history: [predecessor], membership_billing_agreements: [],
    membership_tier_config: [config], membership_successor_election: election ? [election] : [] };
  const db = {
    rpc: async () => ({ data: true }),
    from(table) {
      let rows = tables[table];
      return {
        select() { return this; }, order() { return this; },
        eq(k, v) { rows = rows.filter(row => row[k] === v); return this; },
        async range(first, last) { return { data: structuredClone(rows.slice(first, last + 1)) }; },
      };
    },
  };
  const calls = [];
  const simulate = async (tenant, owner, options) => {
    calls.push({ tenant, owner, options });
    return { success: true, config, annualCost: 120, finalCost: 120, totalWithVat: 120,
      currency: 'GBP', vatAmount: 0,
      membershipYear: { label: '2027', start: new Date('2027-01-01'), end: new Date('2027-12-31') } };
  };
  return { db, config, predecessor, calls, tables, options: { tenantId: 'tenant', memberId: 'member', simulate, now: new Date(now) } };
}

for (const method of ['monthly_card', 'direct_debit']) {
  test(`${method} form re-entry preserves pending election after successor history has started`, async () => {
    const f = fixture();
    const { simulation } = await loadFormMembershipRenewalContext(f.db, f.options);
    const election = { id: 'elected', tenant_id: 'tenant', member_id: 'member', previous_term_id: 'prior',
      status: 'reserved', origin: 'form', payment_method: method,
      term_start_date: '2027-01-01', term_end_date: '2027-12-31',
      quote: { payerMemberId: 'member', simulation } };
    f.tables.membership_successor_election.push(election);
    f.tables.member_membership_history.push({ id: 'next', tenant_id: 'tenant', member_id: 'member',
      term_start_date: '2027-01-01', term_end_date: '2027-12-31', status: 'pending_payment_setup',
      payment_status: 'unpaid', membership_successor_election_id: election.id, billing_agreement_id: 'agreement' });
    f.tables.membership_billing_agreements.push({ id: 'agreement', tenant_id: 'tenant', member_id: 'member',
      status: 'payment_setup_required', membership_successor_election_id: election.id });
    const api = readFileSync(new URL('../forms/membership-payment.js', import.meta.url), 'utf8');
    const start = api.indexOf('async function handlePost(');
    const handler = api.slice(start, api.indexOf('\nasync function ', start + 1)).replaceAll('import(', '__import(');
    for (const date of ['2027-01-01', '2027-01-12']) {
      const options = { ...f.options, now: new Date(date) };
      const restored = await loadFormMembershipRenewalContext(f.db, options);
      assert.equal(restored.election.id, election.id);
      assert.deepEqual(restored.simulation, simulation);
      assert.equal(restored.renewal.currentEnd, '2026-12-31');
      let routed = false;
      class Clock extends Date { constructor(value) { super(value ?? `${date}T12:00:00Z`); } }
      const sandbox = vm.createContext({ Date: Clock,
        getMemberById: async () => ({ id: 'member', tenant_id: 'tenant' }),
        renewalContext: () => loadFormMembershipRenewalContext(f.db, options),
        resolveDirectDebitOption: async () => ({}), resolveCardMonthlyOption: async () => ({}),
        checkApproval: async () => ({ blocked: false }),
        reserveFormSuccessor: async context => {
          assert.equal(context.election.id, election.id); return context.election;
        },
        __import: async () => ({ default: async (req, res) => {
          routed = true;
          assert.equal(req.membershipPaymentContext.electionId, election.id);
          assert.deepEqual(req.membershipPaymentContext.simulation, simulation);
          return res.json({ resumed: true });
        } }),
      });
      vm.runInContext(handler, sandbox);
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
      await sandbox.handlePost({ body: { memberId: 'member', action:
        method === 'monthly_card' ? 'start_monthly_card' : 'start_direct_debit' } }, res, 'tenant');
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(routed, true);
    }
    f.tables.member[0].membership_paused = true;
    assert.equal((await loadFormMembershipRenewalContext(f.db,
      { ...f.options, now: new Date('2027-01-12') })).simulation, null);
  });
}

test('agent preview uses real successor pricing and collection builders without external effects', async () => {
  const f = fixture();
  const { simulation } = await loadFormMembershipRenewalContext(f.db, f.options);
  const input = { evidence: { tenantId: 'tenant', memberId: 'member', histories: [f.predecessor],
    agreements: [], successorConfig: f.config }, simulation, now: '2026-11-01' };
  const original = JSON.stringify(input);
  const upfront = previewFormMembershipRenewal({ ...input, method: 'upfront' });
  assert.equal(upfront.proposedEffects[1].amountMinor, 12000);
  assert.equal(upfront.proposedEffects[1].paymentTiming, 'immediate');
  assert.equal(upfront.successor.activation, 'scheduled');
  assert.equal(upfront.successor.end, '2027-12-31');
  const dd = previewFormMembershipRenewal({ ...input, method: 'direct_debit',
    providerEarliestChargeDate: '2026-11-05' });
  assert.equal(dd.proposedEffects[1].initialCollectionMinor, 0);
  assert.equal(dd.proposedEffects[1].settledPayment, false);
  assert.equal(dd.proposedEffects[2].requestedFirstDate, '2027-01-01');
  assert.equal(dd.proposedEffects[2].actualExpectedCollectionDate, null);
  assert.deepEqual(dd.executedEffects, []);
  const delayed = previewFormMembershipRenewal({ ...input, method: 'direct_debit',
    providerEarliestChargeDate: '2027-01-07' });
  assert.equal(delayed.proposedEffects[2].requestedFirstDate, '2027-01-07');
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(previewFormMembershipRenewal({ ...input, method: 'direct_debit',
    evidence: { ...input.evidence, paused: true } }).proposedEffects, []);
  const ddEvidence = structuredClone(input.evidence);
  ddEvidence.histories[0].billing_agreement_id = 'old-dd';
  ddEvidence.histories[0].payment_status = 'partially_paid';
  ddEvidence.agreements = [{ id: 'old-dd', tenant_id: 'tenant', member_id: 'member',
    status: 'active', provider: 'gocardless', metadata: { dd: {
      collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'fixed' },
    } } }];
  const reverse = previewFormMembershipRenewal({ ...input, evidence: ddEvidence, method: 'upfront' });
  assert.equal(reverse.assessment.state, 'continuing_arrangement');
  assert.equal(reverse.currentTerm.paymentStatus, 'partially_paid');
  assert.equal(reverse.currentTerm.existingAgreementPreserved, true);
  assert.equal(reverse.currentTerm.alterInstalments, false);
  assert.equal(reverse.proposedEffects[1].amountMinor, 12000);
});

test('60 days early resolves full successor year from saved policy and quotes full upfront price', async () => {
  const f = fixture();
  const before = structuredClone(f.predecessor);
  const { renewal, simulation } = await loadFormMembershipRenewalContext(f.db, f.options);
  assert.equal(renewal.state, 'eligible_renewal');
  assert.equal(renewal.successorStart, '2027-01-01');
  assert.equal(renewal.successorEnd, '2027-12-31');
  assert.equal(f.calls[0].options.asOfDate, '2027-01-01');
  assert.equal(simulation.totalWithVat, 120);
  assert.equal(simulation.paymentSchedule.status, 'scheduled');
  assert.deepEqual(f.predecessor, before);
  const frozen = snapshotFormMembershipPayment(simulation, []);
  assert.equal(frozen.simResult.paymentSchedule.term_start_date, '2027-01-01');
  assert.equal(frozen.simResult.totalWithVat, 120);
});

test('early DD authorization is mandate-only and collection lower bound follows successor, including delayed authorization', async () => {
  const f = fixture();
  const { simulation } = await loadFormMembershipRenewalContext(f.db, f.options);
  const snapshot = buildAgreementSnapshot({
    offer: resolveDdOffer(simulation), simResult: simulation, acceptedAt: '2026-11-01T00:00:00Z',
  });
  assert.equal(buildMonthlyBillingRequest({ snapshot }).paymentAmountMinor, undefined);
  assert.equal(snapshot.commitment.term_start_date, '2027-01-01');
  assert.equal(computeSubscriptionCollectionDate(snapshot, '2026-11-05', null, '2026-11-01').startDate, '2027-01-01');
  assert.equal(computeSubscriptionCollectionDate(snapshot, '2027-01-07', null, '2027-01-03').startDate, '2027-01-07');
  assert.equal(f.predecessor.payment_status, 'paid');
});

test('a reserved quote cannot resume a paused membership and is not repriced', async () => {
  const election = { id: 'election', tenant_id: 'tenant', member_id: 'member', previous_term_id: 'prior',
    status: 'reserved', payment_method: 'upfront', quote: { simulation: { totalWithVat: 123 } } };
  const f = fixture({ election });
  const pending = await loadFormMembershipRenewalContext(f.db, f.options);
  assert.equal(pending.renewal.state, 'renewal_pending');
  assert.equal(pending.simulation.totalWithVat, 123);
  assert.equal(f.calls.length, 0);
  const paused = fixture({ election, paused: true });
  assert.deepEqual(await loadFormMembershipRenewalContext(paused.db, paused.options),
    { renewal: { state: 'paused', eligible: false }, simulation: null });
});

test('early upfront intent takes the full successor amount immediately; callback-first recovery keeps saved dates', async () => {
  const f = fixture();
  const { simulation } = await loadFormMembershipRenewalContext(f.db, f.options);
  simulation.formRenewalElectionId = 'elected';
  const quote = snapshotFormMembershipPayment(simulation, []);
  quote.paymentIntentParams = { amount: 12000, currency: 'gbp',
    metadata: { tenant_id: 'tenant', member_id: 'member', membership_year: '2027' } };
  const reservation = { id: 'saved', tenant_id: 'tenant', member_id: 'member',
    created_at: '2026-11-01T00:00:00Z', quote };
  const bindings = [];
  const db = {
    rpc: async (name, args) => { bindings.push({ name, args }); return { data: true }; },
    from() { return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: reservation }; } }; },
  };
  let charged;
  const stripe = { paymentIntents: { async create(params, options) {
    assert.equal(params.amount, 12000);
    assert.equal(params.capture_method, undefined, 'not a deferred/manual capture');
    assert.equal(options.idempotencyKey, 'membership-quote:saved');
    charged = { id: 'pi_saved', ...params };
    // Simulate the signed webhook arriving before the browser-side bind.
    const loaded = await loadFormMembershipPaymentQuote(db, charged);
    const history = historyFromFormPaymentSnapshot(loaded);
    assert.equal(history.term_start_date, '2027-01-01');
    assert.equal(history.term_end_date, '2027-12-31');
    assert.equal(history.status, 'scheduled');
    assert.equal(history.membership_successor_election_id, 'elected');
    assert.equal(history.total_with_vat, 120);
    return charged;
  } } };
  assert.equal((await createReservedFormMembershipIntent(db, stripe, reservation, '2026-11-01')).id, 'pi_saved');
  assert.equal(bindings.length, 2, 'webhook and response bind the same intent');
  assert.ok(bindings.every(entry => entry.args.p_payment_intent_id === 'pi_saved'));
  assert.equal(f.predecessor.term_end_date, '2026-12-31');
});

test('actual form create request charges the full successor while current paid history remains unchanged', async () => {
  const f = fixture();
  const resolved = await loadFormMembershipRenewalContext(f.db, f.options);
  const before = structuredClone(f.predecessor);
  const api = readFileSync(new URL('../forms/membership-payment.js', import.meta.url), 'utf8');
  const start = api.indexOf('async function handlePost(');
  const handler = api.slice(start, api.indexOf('\nasync function ', start + 1)).replaceAll('import(', '__import(');
  let saved, charged;
  const stripe = { paymentIntents: { async create(params, options) {
    charged = { params, options };
    return { id: 'pi_successor', client_secret: 'fixture-only' };
  } } };
  const db = { async rpc(name, args) {
    if (name === 'save_elected_form_membership_quote') {
      saved = { id: 'quote', tenant_id: 'tenant', member_id: 'member',
        created_at: new Date().toISOString(), quote: args.p_quote };
      return { data: saved };
    }
    assert.equal(name, 'bind_form_membership_payment_quote');
    return { data: true };
  } };
  const credentials = {
    getStripeCredentials: async () => ({ secret_key: 'sk_test_fixture', publishable_key: 'pk_test_fixture' }),
    prepareRequiredStripeCustomer: async () => ({ ok: true, customer: { id: 'customer' } }),
  };
  const context = vm.createContext({
    console, Date, supabase: db, STRIPE_MIN_CENTS: { gbp: 30 },
    getMemberById: async () => ({ id: 'member', tenant_id: 'tenant' }),
    renewalContext: async () => resolved,
    snapshotFormMembershipPayment, saveFormMembershipPaymentQuote,
    createReservedFormMembershipIntent, incentiveFieldsFromSavedQuote,
    computeAddonTotals: () => ({ subtotal: 0, vat: 0, total: 0 }),
    isZeroDueMembership: sim => sim.totalWithVat === 0,
    checkApproval: async () => ({ blocked: false }),
    reserveFormSuccessor: async () => ({ id: 'election', quote: {
      payerMemberId: 'member', simulation: resolved.simulation, addonLines: [],
    } }),
    async __import(path) {
      if (path.includes('stripeCredentials')) return credentials;
      if (path === 'stripe') return { default: class { constructor() { return stripe; } } };
      if (path.includes('monthly-card')) return { annualPaymentBlockedByOpenPlan: async args => {
        assert.equal(args.yearLabel, '2027', 'old-term DD may not block the successor');
        return null;
      } };
      throw new Error(`Unexpected import ${path}`);
    },
  });
  vm.runInContext(handler, context);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await context.handlePost({ body: { action: 'create_payment', memberId: 'member',
    configId: 'browser-cannot-replace-successor', fieldOverrides: {} } }, response, 'tenant');
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(charged.params.amount, 12000);
  assert.equal(charged.params.capture_method, undefined);
  assert.equal(saved.quote.simResult.paymentSchedule.term_start_date, '2027-01-01');
  assert.equal(saved.quote.simResult.paymentSchedule.term_end_date, '2027-12-31');
  assert.equal(saved.quote.simResult.paymentSchedule.status, 'scheduled');
  assert.deepEqual(f.predecessor, before);
});