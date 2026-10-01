import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDynamicCollectionPrice, collectDynamicPlan, dynamicCollectionDate,
  assertDynamicPayment, reconcileDynamicCollections, resolveDynamicPayment,
} from './gocardlessDynamicCollections.js';
import { resolveInstalmentInvoiceContext } from './membershipInstalmentInvoicing.js';
import { BNMS_ALPHA_TENANT, BNMS_ALPHA_MANIFEST, BNMS_ALPHA_PROCESSING_NOT_BEFORE } from './bnmsAlphaAccounting.js';
import { selectDynamicCollections } from './directDebitDynamicPipeline.js';
import { COLLECTION_BUDGET_MS, runReconciliationPhases } from '../cron/reconcile-gocardless.js';

function fixture({ amount = 12.5, firstDate = '2027-04-02', providerDate = '2027-04-06', end = '2028-03-31' } = {}) {
  const config = { id: 'config', tenant_id: 'tenant', start_mode: 'immediate', structure_scope_type: 'member',
    structure_field_id: null, structure_match_value: null, pricing_model: 'flat', currency: 'GBP',
    dd_enabled: true, dd_monthly_amount: amount, flat_vat_rate: '{"taxType":"OUTPUT2","rate":20}', nominal_code: '200' };
  const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member', status: 'active',
    gocardless_mandate_id: 'MD_TEST', metadata: { dd: {
      collection_policy: { version: 1, end_policy: 'stop', pricing_policy: 'dynamic' }, invoicing_mode: 'per_instalment',
      monthly_amount_minor: 1000, currency: 'GBP', instalment_count: 12, membership_year: '2027',
      commitment: { term_key: 'rolling:2027-04-01', term_start_date: '2027-04-01', term_end_date: end,
        commitment_snapshot: { config: structuredClone(config) } },
    } } };
  const plan = { id: 'plan', tenant_id: 'tenant', billing_agreement_id: 'agreement', status: 'active',
    dynamic_next_collection_date: firstDate,
    provider: 'gocardless', gocardless_mandate_id: 'MD_TEST', metadata: { collection_mode: 'dynamic', dynamic_first_date: firstDate } };
  const rows = { membership_tier_config: [config], membership_billing_agreements: [agreement],
    membership_payment_plans: [plan], membership_monthly_arrears_period: [],
    gocardless_collection_reservations: [], membership_tier_vat_override: [],
    member: [{ id: 'member', tenant_id: 'tenant', country: 'GB' }], member_preference_value: [] };
  const updates = [];
  const calls = [];
  const controls = {};
  const valueAt = (row, key) => key.includes('->>') ? row.metadata?.[key.split('->>')[1]] : row[key];
  const db = {
    from(table) {
      let filters = [], single = false, patch, rowLimit = Infinity, ordering = [];
      const query = {
        select() { return this; }, eq(key, value) { filters.push(row => valueAt(row, key) === value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        is(key, value) { filters.push(row => (row[key] ?? null) === value); return this; },
        or(expression) {
          filters.push(row => expression.split(',').some(condition => {
            const [, key, op, value] = condition.match(/^(.*?)\.(is|eq|lte|gte)\.(.*)$/) || [];
            const actual = valueAt(row, key || '');
            if (op === 'is') return value === 'null' && actual == null;
            if (op === 'eq') return actual != null && String(actual) === value;
            if (op === 'lte') return actual != null && actual <= value;
            if (op === 'gte') return actual != null && actual >= value;
            throw new Error(`Unsupported filter ${condition}`);
          }));
          return this;
        },
        order(key, options = {}) { ordering.push([key, options]); return this; },
        limit(value) { rowLimit = value; return this; },
        lte(key, value) { filters.push(row => row[key] != null && row[key] <= value); return this; },
        update(value) { patch = value; return this; },
        maybeSingle() { single = true; return this; }, single() { single = true; return this; },
        then(resolve, reject) {
          controls.beforeQuery?.({ table, patch, single });
          const data = (rows[table] || []).filter(row => filters.every(fn => fn(row)))
            .sort((a, b) => {
              for (const [key, options] of ordering) {
                if (a[key] === b[key]) continue;
                if (a[key] == null) return options.nullsFirst ? -1 : 1;
                if (b[key] == null) return options.nullsFirst ? 1 : -1;
                return (a[key] < b[key] ? -1 : 1) * (options.ascending === false ? -1 : 1);
              }
              return 0;
            }).slice(0, rowLimit);
          const error = patch && controls.writeError?.(data, patch);
          if (error) return Promise.resolve({ error: { message: error } }).then(resolve, reject);
          if (patch) { updates.push({ table, patch }); for (const row of data) Object.assign(row, patch); }
          return Promise.resolve({ data: single ? data[0] || null : data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, params) {
      if (name === 'reserve_gocardless_dynamic_collection') {
        const target = rows.membership_payment_plans.find(row => row.id === params.p_plan_id);
        if (target.status === 'cancelled') return { error: { message: 'cancelled' } };
        let reservation = rows.gocardless_collection_reservations.find(row => row.plan_id === target.id);
        if (!reservation) {
          reservation = {
            id: target.id === 'plan' ? 'reservation' : `reservation-${target.id}`, tenant_id: target.tenant_id, billing_agreement_id: target.billing_agreement_id, plan_id: target.id,
            collection_number: params.p_collection_number, due_date: params.p_due_date,
            requested_charge_date: params.p_provider_evidence.next_possible_charge_date,
            amount_minor: params.p_price_snapshot.monthly_amount_minor, currency: 'GBP',
            price_snapshot: structuredClone(params.p_price_snapshot), provider_evidence: params.p_provider_evidence,
            status: 'reserved', idempotency_key: params.p_idempotency_key,
          };
          rows.gocardless_collection_reservations.push(reservation);
        }
        return { data: reservation };
      }
      if (name === 'attach_gocardless_dynamic_payment') {
        const reservation = rows.gocardless_collection_reservations.find(row => row.id === params.p_reservation_id);
        Object.assign(reservation, { status: 'submitted', gocardless_payment_id: params.p_payment.id });
        return { data: reservation };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const gc = {
    async getMandate() { return { status: 'active', next_possible_charge_date: providerDate }; },
    async createPayment(request) {
      calls.push(request);
      return { id: 'PM_TEST', amount: request.amountMinor, currency: request.currency, charge_date: request.chargeDate,
        status: 'pending_submission', links: { mandate: request.mandateId } };
    },
  };
  return { config, agreement, plan, rows, db, gc, calls, updates, controls, now: () => new Date('2027-03-29T12:00:00Z') };
}

test('manual scoped selection bypasses next-check only, while retaining Beta holds and exact plan scope', async () => {
  const f = fixture();
  const now = new Date('2027-04-01T12:00:00Z');
  f.plan.dynamic_next_check_at = '2027-04-02T12:00:00Z';
  assert.equal((await selectDynamicCollections(f.db, now)).data.length, 0);
  const manualTiming = { tenantId: f.plan.tenant_id, planId: f.plan.id, dueDate: f.plan.dynamic_next_collection_date };
  assert.equal((await selectDynamicCollections(f.db, now, 100, manualTiming)).data.length, 1);
  assert.equal((await selectDynamicCollections(f.db, now, 100, { ...manualTiming, planId: 'foreign' })).data.length, 0);
  f.plan.metadata.bnms_release_required = true;
  assert.equal((await selectDynamicCollections(f.db, now, 100, manualTiming)).data.length, 0);
  f.plan.metadata.bnms_release_required = false;
  f.plan.collection_stopped_at = '2027-04-01';
  assert.equal((await selectDynamicCollections(f.db, now, 100, manualTiming)).data.length, 0);
});

test('dynamic price follows active flat price, never the consent-time initial amount', async () => {
  const f = fixture();
  assert.equal((await resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f)).monthly_amount_minor, 1250);
  f.config.dd_monthly_amount = 19;
  assert.equal((await resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f)).monthly_amount_minor, 1900);
});

test('overlapping workers retain one reservation and identical provider idempotency identity', async () => {
  const f = fixture();
  await Promise.all([collectDynamicPlan(f.plan, f), collectDynamicPlan(f.plan, f)]);
  assert.equal(f.rows.gocardless_collection_reservations.length, 1);
  assert.ok(f.calls.length > 0);
  for (const request of f.calls) assert.deepEqual(request, f.calls[0]);
  assert.ok(f.calls[0].idempotencyKey);
});

function pilotFixture(providerDate = '2026-10-07') {
  const f = fixture({ amount: 13, firstDate: '2026-10-01', providerDate, end: '2027-09-30' });
  const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
  const member = '33e5d54d-162e-436d-9bff-ec6676d198f9';
  for (const rows of Object.values(f.rows)) for (const row of rows) {
    if (row.tenant_id === 'tenant') row.tenant_id = tenant;
    if (row.member_id === 'member') row.member_id = member;
  }
  f.agreement.member_id = member;
  f.rows.member[0].id = member;
  f.agreement.metadata.dd.commitment.term_start_date = '2026-10-01';
  f.agreement.metadata.dd.commitment.term_key = 'rolling:2026-10-01';
  f.now = () => new Date('2026-10-01T09:30:00Z');
  return f;
}

test('pilot is gated until 10:30 UK, before provider reads or reservation writes, without approval metadata', async () => {
  const f = pilotFixture();
  f.now = () => new Date('2026-09-30T22:59:59.999Z');
  f.gc.getMandate = () => { throw Error('provider must not be read before gate'); };
  const result = await collectDynamicPlan(f.plan, f);
  assert.match(result.detail, /processing starts/);
  assert.equal(f.rows.gocardless_collection_reservations.length, 0);
  assert.equal(f.calls.length, 0);
  f.rows.gocardless_collection_reservations.push({ status: 'reserved' });
  assert.match((await collectDynamicPlan(f.plan, f)).detail, /processing starts/);
});

test('pilot processes at 10:30 UK with authoritative later collection date and stable retry key', async () => {
  const f = pilotFixture();
  const create = f.gc.createPayment;
  let request;
  f.gc.createPayment = async value => { request = value; throw Error('uncertain network'); };
  await assert.rejects(collectDynamicPlan(f.plan, f), /uncertain network/);
  assert.equal(request.chargeDate, '2026-10-07');
  assert.equal(request.amountMinor, 1300);
  f.gc.createPayment = create;
  await collectDynamicPlan(f.plan, f);
  assert.deepEqual(f.calls[0], request);
  assert.equal(f.rows.gocardless_collection_reservations.length, 1);
  assert.equal(f.rows.gocardless_collection_reservations[0].due_date, '2026-10-01');
});

test('pilot fails closed for expired dates, grace-window drift and invalid clocks', async () => {
  const expired = pilotFixture('2026-09-30');
  expired.now = () => new Date('2026-10-01T12:00:00Z');
  await assert.rejects(collectDynamicPlan(expired.plan, expired), /in the past/);
  const late = pilotFixture('2026-10-09');
  await assert.rejects(collectDynamicPlan(late.plan, late), /no safe charge date/);
  const invalid = pilotFixture();
  invalid.now = () => new Date('invalid');
  await assert.rejects(collectDynamicPlan(invalid.plan, invalid), /clock is invalid/);
});

test('beta requires immutable owner-bound release and cannot reserve before London processing boundary', async () => {
  const f = pilotFixture();
  f.agreement.member_id = 'beta-member';
  f.rows.member[0].id = 'beta-member';
  f.plan.metadata.bnms_beta_held = true;
  await assert.rejects(collectDynamicPlan(f.plan, f), /reviewed release/);
  f.rows.bnms_dd_beta_release = [{ tenant_id: f.plan.tenant_id, member_id: 'wrong-owner', plan_id: f.plan.id,
    processing_not_before: '2026-09-30T23:00:00Z' }];
  await assert.rejects(collectDynamicPlan(f.plan, f), /reviewed release/);
  f.rows.bnms_dd_beta_release[0].member_id = 'beta-member';
  f.now = () => new Date('2026-09-30T22:59:59.999Z');
  assert.match((await collectDynamicPlan(f.plan, f)).detail, /processing starts/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows.gocardless_collection_reservations.length, 0);
  f.now = () => new Date('2026-10-01T09:30:00Z');
  await collectDynamicPlan(f.plan, f);
  assert.equal(f.calls[0].chargeDate, '2026-10-07');
  assert.equal(f.calls[0].amountMinor, 1300);
});

test('missing/overlapping scopes, changed currencies and non-consented dynamic pricing fail closed', async () => {
  const f = fixture();
  f.rows.membership_tier_config.push({ ...f.config, id: 'overlap' });
  await assert.rejects(resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f), /exactly one/);
  f.rows.membership_tier_config.length = 1;
  f.config.structure_field_id = 'other';
  await assert.rejects(resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f), /exactly one/);
  f.config.structure_field_id = null; f.config.currency = 'EUR';
  await assert.rejects(resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f), /currency/);
  f.agreement.metadata.dd.collection_policy = null;
  await assert.rejects(resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f), /explicit consent/);
});

test('tiered price uses the persisted purchased field value across replacement bands', async () => {
  const f = fixture();
  Object.assign(f.config, { pricing_model: 'tiered', field_id: 'basis', field_source: 'member', field_name: 'grade' });
  Object.assign(f.agreement.metadata.dd.commitment.commitment_snapshot, {
    config: structuredClone(f.config), pricing: { field_value: 25 },
  });
  f.rows.membership_tier_band = [
    { id: 'new-band', tenant_id: 'tenant', config_id: 'config', min_value: 20, max_value: 30, dd_monthly_amount: 18 },
  ];
  assert.equal((await resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f)).monthly_amount_minor, 1800);
  f.rows.membership_tier_band.push({ ...f.rows.membership_tier_band[0], id: 'overlap' });
  await assert.rejects(resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f), /exactly one matching/);
});

test('tax override uses shared selection matching and freezes rule and basis', async () => {
  const f = fixture();
  f.rows.membership_tier_vat_override.push({ id: 'tax-rule', tenant_id: 'tenant', config_id: 'config',
    field_id: 'core:country', match_value: 'GB', match_condition: 'equals', vat_rate: 'OUTPUT' });
  const price = await resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f);
  assert.equal(price.vat_rate, 'OUTPUT');
  assert.equal(price.tax_basis['core:country'], 'GB');
  assert.equal(price.tax_rule.id, 'tax-rule');
});

test('invoice context uses reservation tax/nominal evidence rather than edited live structures', async () => {
  const f = fixture();
  const price = await resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f);
  f.config.flat_vat_rate = 'CHANGED';
  f.config.nominal_code = '999';
  const context = await resolveInstalmentInvoiceContext({
    agreement: f.agreement, snapshot: { ...price, collection_price_snapshot: price }, db: f.db,
  });
  assert.equal(context.vatRate, '{"taxType":"OUTPUT2","rate":20}');
  assert.equal(context.nominalCode, '200');
});

test('bank holiday provider date is pinned BEFORE request, with intended cadence preserved', async () => {
  const f = fixture();
  await collectDynamicPlan(f.plan, f);
  assert.equal(f.rows.gocardless_collection_reservations[0].due_date, '2027-04-02'); // Good Friday
  assert.equal(f.calls[0].chargeDate, '2027-04-06'); // provider's first available day
  assert.equal(f.calls[0].amountMinor, 1250);
});

test('provider working-day shift across term end and missed notice windows cannot charge', async () => {
  const f = fixture({ end: '2027-04-05' });
  await assert.rejects(collectDynamicPlan(f.plan, f), /no safe charge date/);
  assert.equal(f.calls.length, 0);
  const missed = fixture({ providerDate: '2027-04-12' });
  await assert.rejects(collectDynamicPlan(missed.plan, missed), /no safe charge date/);
  assert.equal(missed.calls.length, 0);
});

test('provider notice window is not prematurely locked to an initial price', async () => {
  const f = fixture({ providerDate: '2027-04-01' });
  assert.match((await collectDynamicPlan(f.plan, f)).detail, /Waiting/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows.gocardless_collection_reservations.length, 0);
});

test('network uncertainty retries identical reserved amount/date/key, despite active price changes', async () => {
  const f = fixture();
  const create = f.gc.createPayment;
  let failedRequest;
  f.gc.createPayment = async request => { failedRequest = request; throw new Error('network uncertainty'); };
  await assert.rejects(collectDynamicPlan(f.plan, f), /network uncertainty/);
  f.config.dd_monthly_amount = 99;
  f.gc.createPayment = create;
  await collectDynamicPlan(f.plan, f);
  assert.deepEqual(f.calls[0], failedRequest);
});

test('provider success followed by local attachment failure leaves a durable fence and replays one provider identity', async () => {
  const f = fixture();
  const realRpc = f.db.rpc.bind(f.db);
  let failAttachment = true;
  f.db.rpc = async (name, params) => {
    if (name === 'attach_gocardless_dynamic_payment' && failAttachment) {
      return { error: { message: 'local attachment transaction failed' } };
    }
    return realRpc(name, params);
  };
  await assert.rejects(collectDynamicPlan(f.plan, f), /local attachment transaction failed/);
  const reservation = f.rows.gocardless_collection_reservations[0];
  assert.equal(reservation.status, 'reserved');
  assert.equal(f.calls.length, 1);
  failAttachment = false;
  f.config.dd_monthly_amount = 99;
  await collectDynamicPlan(f.plan, f);
  assert.equal(f.rows.gocardless_collection_reservations.length, 1);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], f.calls[0], 'Replayed provider request must retain the identical idempotency key, date and amount');
  assert.equal(reservation.status, 'submitted');
  assert.equal(reservation.gocardless_payment_id, 'PM_TEST');
});

test('subscription-less webhook repairs provider-success/local-attach gap using exact reservation identity', async () => {
  const f = fixture();
  f.gc.createPayment = async () => { throw new Error('crash'); };
  await assert.rejects(collectDynamicPlan(f.plan, f), /crash/);
  f.gc.getPayment = async () => ({
    id: 'PM_RECOVERED', amount: 1250, currency: 'GBP', charge_date: '2027-04-06', status: 'confirmed',
    links: { mandate: 'MD_TEST' },
    metadata: { tenant_id: 'tenant', plan_id: 'plan', collection_reservation_id: 'reservation' },
  });
  const recovered = await resolveDynamicPayment('PM_RECOVERED', f);
  assert.equal(recovered.plan.id, 'plan');
  assert.equal(f.rows.gocardless_collection_reservations[0].gocardless_payment_id, 'PM_RECOVERED');
});

test('cancellation and arrears block submission, including revalidation after provider read', async () => {
  const f = fixture();
  f.rows.membership_monthly_arrears_period.push({ id: 'arrear', tenant_id: 'tenant', plan_id: 'plan', settled_at: null });
  await assert.rejects(collectDynamicPlan(f.plan, f), /arrears/);
  f.rows.membership_monthly_arrears_period.length = 0;
  const original = f.gc.getMandate;
  f.gc.getMandate = async () => { const result = await original(); f.plan.status = 'cancelled'; return result; };
  await assert.rejects(collectDynamicPlan(f.plan, f), /cancelled/);
  assert.equal(f.calls.length, 0);
});

test('month-end cadence remains anchored; mismatched provider identity never accepted', () => {
  assert.equal(dynamicCollectionDate('2028-01-31', 2), '2028-02-29');
  assert.equal(dynamicCollectionDate('2028-01-31', 3), '2028-03-31');
  const reservation = { amount_minor: 1000, currency: 'GBP', requested_charge_date: '2027-04-06' };
  const payment = { id: 'PM', amount: 1000, currency: 'GBP', charge_date: '2027-04-06', links: { mandate: 'MD' } };
  assert.doesNotThrow(() => assertDynamicPayment(reservation, payment, 'MD'));
  for (const patch of [{ amount: 1001 }, { currency: 'EUR' }, { charge_date: '2027-04-07' }, { links: { mandate: 'OTHER' } }]) {
    assert.throws(() => assertDynamicPayment(reservation, { ...payment, ...patch }, 'MD'), /does not match/);
  }
});

test('scheduler persists fair retry backoff and respects elapsed-time budget', async () => {
  const f = fixture();
  f.rows.membership_tier_config.length = 0;
  const result = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(result.blocked, 1);
  assert.match(f.plan.dynamic_collection_error, /exactly one/);
  assert.equal(f.plan.dynamic_next_check_at, '2027-03-29T13:00:00.000Z');
  let clockCalls = 0;
  const noTime = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc, clock: () => clockCalls++ * 50000 });
  assert.equal(noTime.processed + noTime.blocked, 0);
});

function addOtherTenant(f) {
  const other = fixture();
  for (const [table, rows] of Object.entries(other.rows)) {
    for (const row of rows) {
      row.tenant_id = 'other-tenant';
      if (row.id) row.id = `other-${row.id}`;
      if (row.billing_agreement_id) row.billing_agreement_id = `other-${row.billing_agreement_id}`;
      if (row.member_id) row.member_id = `other-${row.member_id}`;
    }
    f.rows[table].push(...rows);
  }
  return other.plan;
}

function batchFixture(count, latencyMs = 2500) {
  const f = fixture();
  for (let i = 1; i < count; i++) {
    f.rows.membership_payment_plans.push({ ...structuredClone(f.plan), id: `plan-${i}` });
  }
  let elapsed = 0, active = 0;
  const payments = new Map();
  f.clock = () => elapsed;
  f.gc.createPayment = async request => {
    assert.equal(active++, 0, 'provider submissions must remain sequential');
    await Promise.resolve();
    elapsed += latencyMs;
    f.calls.push(structuredClone(request));
    if (!payments.has(request.idempotencyKey)) payments.set(request.idempotencyKey, {
      id: `PM-${payments.size}`, amount: request.amountMinor, currency: request.currency,
      charge_date: request.chargeDate, status: 'pending_submission', links: { mandate: request.mandateId },
    });
    active--;
    return payments.get(request.idempotencyKey);
  };
  return { ...f, payments, clientForTenant: async () => f.gc };
}

test('production cron budget submits beyond three sequentially, retains 30s reserve and resumes untouched rows', async () => {
  const old = batchFixture(70);
  assert.equal((await reconcileDynamicCollections({ ...old, budgetMs: 35000 })).processed, 3);

  const f = batchFixture(70);
  const held = [
    { ...structuredClone(f.plan), id: 'held-beta', metadata: {
      ...f.plan.metadata, bnms_beta_held: true, bnms_release_required: true,
    } },
    { ...structuredClone(f.plan), id: 'stopped', collection_stopped_at: '2027-03-28T00:00:00Z' },
  ];
  const heldBefore = structuredClone(held);
  f.rows.membership_payment_plans.unshift(...held);
  const unattempted = f.rows.membership_payment_plans.slice(63);
  const before = structuredClone(unattempted);
  const results = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };
  await runReconciliationPhases(results, {
    clock: f.clock,
    complete: async () => ({ completed: 0, notified: 0, errors: 0 }),
    collect: options => reconcileDynamicCollections({ ...f, ...options }),
    stages: [],
  });
  assert.equal(results.repaired, 61);
  assert.equal(results.errors, 0);
  assert.equal(f.clock(), 152500, 'stop starting plans once less than 30s remains');
  assert.deepEqual(unattempted, before, 'no reservations, errors or next-check changes for unattempted plans');
  assert.deepEqual(held, heldBefore);
  assert.equal(f.rows.gocardless_collection_reservations.length, 61);
  const next = await reconcileDynamicCollections({ ...f, budgetMs: COLLECTION_BUDGET_MS });
  assert.equal(next.processed, 9);
  assert.equal(f.payments.size, 70);
  assert.equal(f.calls.length, 70);
  assert.deepEqual(held, heldBefore);
  assert.equal((await reconcileDynamicCollections({ ...f, budgetMs: COLLECTION_BUDGET_MS })).processed, 0);
  assert.equal(f.calls.length, 70, 'replaying a completed batch cannot create duplicates');
});

test('larger time allowance still caps a batch at 100 even when caller requests more', async () => {
  const f = batchFixture(105, 0);
  const before = structuredClone(f.rows.membership_payment_plans.slice(100));
  const first = await reconcileDynamicCollections({ ...f, limit: 1000, budgetMs: COLLECTION_BUDGET_MS });
  assert.equal(first.processed, 100);
  assert.equal(f.calls.length, 100);
  assert.deepEqual(f.rows.membership_payment_plans.slice(100), before);
  assert.equal((await reconcileDynamicCollections({ ...f, budgetMs: COLLECTION_BUDGET_MS })).processed, 5);
  assert.equal(f.payments.size, 105);
});

test('larger batch continues after ambiguous acceptance and replays the same provider identity after backoff', async () => {
  const f = batchFixture(8);
  const rpc = f.db.rpc;
  let failAttach = true;
  f.db.rpc = (name, params) => name === 'attach_gocardless_dynamic_payment'
    && params.p_reservation_id === 'reservation' && failAttach
    ? Promise.resolve({ error: { message: 'attachment unavailable' } }) : rpc(name, params);
  const first = await reconcileDynamicCollections({ ...f, budgetMs: COLLECTION_BUDGET_MS });
  assert.equal(first.processed, 7);
  assert.equal(first.blocked, 1);
  assert.equal(first.errors, 1);
  assert.equal(f.payments.size, 8, 'provider accepted even though attachment failed');
  assert.equal(f.rows.gocardless_collection_reservations[0].status, 'reserved');
  assert.equal((await reconcileDynamicCollections({ ...f, budgetMs: COLLECTION_BUDGET_MS })).processed, 0);
  assert.equal(f.calls.length, 8, 'failure retains retry backoff');
  failAttach = false;
  f.config.dd_monthly_amount = 99;
  f.now = () => new Date('2027-03-29T13:00:00Z');
  const retry = await reconcileDynamicCollections({ ...f, budgetMs: COLLECTION_BUDGET_MS });
  assert.equal(retry.processed, 1);
  assert.equal(retry.errors, 0);
  assert.deepEqual(f.calls[8], f.calls[0], 'reserved amount/date/idempotency key survive retry');
  assert.equal(f.payments.size, 8);
  assert.equal(f.rows.gocardless_collection_reservations.length, 8);
  assert.equal(f.rows.gocardless_collection_reservations[0].status, 'submitted');
});

test('held plans are filtered before limit; released provenance and another tenant still submit', async () => {
  const f = fixture();
  addOtherTenant(f);
  f.plan.metadata.bnms_beta_held = true; // provenance is not a hold predicate
  f.plan.metadata.bnms_release_required = false;
  const held = Array.from({ length: 120 }, (_, i) => ({
    ...structuredClone(f.plan), id: `held-${i}`,
    collection_stopped_at: i % 2 ? null : '2026-09-01T00:00:00Z',
    metadata: { ...f.plan.metadata, bnms_release_required: i % 2 ? true : false },
  }));
  const before = structuredClone(held);
  f.rows.membership_payment_plans.unshift(...held);
  const result = await reconcileDynamicCollections({ ...f, limit: 2, clientForTenant: async () => f.gc });
  assert.equal(result.processed, 2);
  assert.equal(result.errors, 0);
  assert.deepEqual(held, before);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(new Set(f.calls.map(call => call.metadata.tenant_id)), new Set(['tenant', 'other-tenant']));
  assert.equal(f.rows.gocardless_collection_reservations.length, 2);
});

test('new hold at scoped selection or direct reload causes no provider or bookkeeping effects', async () => {
  for (const atReload of [false, true]) {
    const f = fixture();
    let reads = 0;
    f.controls.beforeQuery = ({ table, patch, single }) => {
      if (table !== 'membership_payment_plans' || patch) return;
      reads++;
      if (atReload ? single : reads === 2) {
        f.plan.collection_stopped_at = '2027-03-29T12:00:00Z';
        f.plan.metadata.bnms_release_required = true;
      }
    };
    const result = await reconcileDynamicCollections({ ...f, clientForTenant: async () => {
      throw new Error('held plan must not access provider');
    } });
    assert.equal(result.processed, 0);
    assert.equal(result.errors, atReload ? 1 : 0);
    assert.equal(f.plan.dynamic_next_check_at, undefined);
    assert.equal(f.calls.length, 0);
    assert.equal(f.rows.gocardless_collection_reservations.length, 0);
  }
});

test('execution and bookkeeping errors stay visible, continue other tenants and retain retry backoff', async () => {
  const f = fixture();
  const other = addOtherTenant(f);
  f.rows.membership_tier_config = f.rows.membership_tier_config.filter(row => row.tenant_id !== 'tenant');
  f.controls.writeError = data => data.includes(f.plan) && 'Beta collection requires reviewed release';
  const result = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(result.processed, 1);
  assert.equal(result.blocked, 1);
  assert.equal(result.errors, 2);
  assert.match(result.details[0].error, /exactly one/);
  assert.match(result.details[1].error, /Record dynamic collection error: Beta/);
  assert.equal(f.plan.dynamic_next_check_at, undefined);
  assert.equal(other.dynamic_next_check_at, '2027-03-29T13:00:00.000Z');
  f.controls.writeError = null;
  const retried = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(retried.errors, 1);
  assert.equal(f.plan.dynamic_next_check_at, '2027-03-29T13:00:00.000Z');
  const backedOff = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(backedOff.errors + backedOff.processed, 0);
});

test('provider acceptance with attach/outcome failure retries retained reservation and identical request', async () => {
  const f = fixture();
  const rpc = f.db.rpc;
  let failAttach = true;
  f.db.rpc = (name, params) => name === 'attach_gocardless_dynamic_payment' && failAttach
    ? Promise.resolve({ error: { message: 'attachment unavailable' } }) : rpc(name, params);
  f.controls.writeError = () => 'bookkeeping unavailable';
  const result = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(result.errors, 2);
  assert.equal(f.plan.dynamic_next_check_at, undefined);
  failAttach = false;
  f.controls.writeError = null;
  const retry = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(retry.processed, 1);
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(f.rows.gocardless_collection_reservations.length, 1);
});

test('successful submission with failed bookkeeping remains visible and later rows run', async () => {
  const f = fixture();
  addOtherTenant(f);
  f.controls.writeError = data => data.includes(f.plan) && 'bookkeeping unavailable';
  const result = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(result.processed, 2);
  assert.equal(result.errors, 1);
  assert.match(result.details[0].error, /Clear dynamic collection error/);
  assert.equal(f.calls.length, 2);
});

test('pre-gate skip does not report repaired and retry is capped at 10:30 UK', async () => {
  const f = pilotFixture();
  f.now = () => new Date('2026-10-01T09:29:59Z');
  const result = await reconcileDynamicCollections({ ...f, clientForTenant: async () => {
    throw new Error('no provider before gate');
  } });
  assert.equal(result.skipped, 1);
  assert.equal(result.processed + result.errors, 0);
  assert.equal(f.plan.dynamic_next_check_at, '2026-10-01T09:30:00.000Z');
  f.now = () => new Date('2026-10-01T09:30:00Z');
  const ready = await reconcileDynamicCollections({ ...f, clientForTenant: async () => f.gc });
  assert.equal(ready.processed, 1);
  assert.equal(ready.errors, 0);
});

test('pilot accepts provider dates after the processing gate, while unrelated plans retain existing behavior', async () => {
  for (const providerDate of ['2026-10-01', '2026-10-02', '2026-10-08']) {
    const f = pilotFixture(providerDate);
    await collectDynamicPlan(f.plan, f);
    assert.equal(f.calls[0].chargeDate, providerDate);
  }
  const other = fixture({ firstDate: '2026-10-01', providerDate: '2026-10-01' });
  other.now = () => new Date('2026-09-25T12:00:00Z');
  await collectDynamicPlan(other.plan, other);
  assert.equal(other.calls.length, 1);
});

function alphaCollectionFixture(providerDate = '2026-10-02') {
  const f = fixture({ firstDate: '2026-10-01', providerDate, end: '2027-09-30' });
  for (const rows of Object.values(f.rows)) {
    for (const row of rows) if (row.tenant_id === 'tenant') row.tenant_id = BNMS_ALPHA_TENANT;
  }
  f.agreement.gocardless_customer_id = 'CU_ALPHA';
  f.agreement.metadata.dd.commitment.term_start_date = '2026-10-01';
  const adoption = { id: 'alpha-adoption', tenant_id: BNMS_ALPHA_TENANT, member_id: f.agreement.member_id,
    agreement_id: f.agreement.id, plan_id: f.plan.id, mandate_id: f.agreement.gocardless_mandate_id,
    customer_id: 'CU_ALPHA', manifest_sha256: BNMS_ALPHA_MANIFEST };
  f.rows.bnms_dd_alpha_adoption = [adoption];
  f.rows.bnms_dd_alpha_release = [{ adoption_id: adoption.id, tenant_id: BNMS_ALPHA_TENANT,
    member_id: f.agreement.member_id, plan_id: f.plan.id, processing_not_before: BNMS_ALPHA_PROCESSING_NOT_BEFORE,
    evidence: { adoptionId: adoption.id, agreementId: f.agreement.id, memberId: f.agreement.member_id, planId: f.plan.id } }];
  f.now = () => new Date('2026-10-01T09:30:00Z');
  return f;
}

test('automatic pilot and released alpha wait until exactly 10:30 UK without changing release evidence', async () => {
  for (const makeFixture of [pilotFixture, alphaCollectionFixture]) {
    for (const instant of ['2026-09-30T22:59:59Z', '2026-09-30T23:00:00Z', '2026-10-01T09:29:59Z']) {
      const f = makeFixture();
      const releaseEvidence = structuredClone(f.rows.bnms_dd_alpha_release);
      f.now = () => new Date(instant);
      f.gc.getMandate = async () => assert.fail('No provider read before automatic gate');
      const result = await collectDynamicPlan(f.plan, f);
      assert.equal(result.skipped, true);
      assert.match(result.detail, /10:30 UK/);
      assert.equal(result.nextCheckAt, '2026-10-01T09:30:00.000Z');
      assert.equal(f.calls.length, 0);
      assert.equal(f.rows.gocardless_collection_reservations.length, 0);
      assert.deepEqual(f.rows.bnms_dd_alpha_release, releaseEvidence);
    }
    const ready = makeFixture();
    ready.now = () => new Date('2026-10-01T09:30:00Z');
    await collectDynamicPlan(ready.plan, ready);
    assert.equal(ready.calls.length, 1);
  }
});

test('held Beta stays blocked at the automatic gate, including manual timing', async () => {
  const f = pilotFixture();
  f.agreement.member_id = 'beta-member';
  f.plan.metadata.bnms_beta_held = true;
  f.plan.metadata.bnms_release_required = true;
  f.gc.getMandate = async () => assert.fail('Held Beta must not read provider');
  await assert.rejects(collectDynamicPlan(f.plan, f), /collection hold/);
  assert.equal((await selectDynamicCollections(f.db, f.now())).data.length, 0);
  assert.equal((await selectDynamicCollections(f.db, f.now(), 100, {
    tenantId: f.plan.tenant_id, planId: f.plan.id, dueDate: '2026-10-01',
  })).data.length, 0);
  assert.equal(f.calls.length, 0);
});

test('alpha identity gate prevents provider reads and reservations before automatic start even without held metadata', async () => {
  const f = alphaCollectionFixture();
  let reads = 0, reservations = 0;
  f.gc.getMandate = async () => { reads++; throw Error('must not read'); };
  f.db.rpc = async () => { reservations++; throw Error('must not reserve'); };
  f.now = () => new Date('2026-09-30T22:59:59.999Z');
  assert.match((await collectDynamicPlan(f.plan, f)).detail, /1 October/);
  assert.equal(reads, 0); assert.equal(reservations, 0); assert.equal(f.calls.length, 0);
});

test('alpha missing release or changed owner/gate fails closed before provider reads', async () => {
  for (const change of [
    f => { f.rows.bnms_dd_alpha_release = []; },
    f => { f.rows.bnms_dd_alpha_release[0].processing_not_before = '2026-09-01T00:00:00Z'; },
    f => { f.rows.bnms_dd_alpha_adoption[0].agreement_id = 'other'; },
    f => { f.rows.bnms_dd_alpha_release[0].evidence.agreementId = 'other'; },
    f => { f.rows.bnms_dd_alpha_adoption = []; f.plan.metadata.bnms_alpha_held = true; },
  ]) {
    const f = alphaCollectionFixture(); change(f);
    let reads = 0;
    f.gc.getMandate = async () => { reads++; throw Error('must not read'); };
    await assert.rejects(collectDynamicPlan(f.plan, f), /[Aa]lpha/);
    assert.equal(reads, 0); assert.equal(f.calls.length, 0);
  }
});

test('alpha respects provider dates after gate and the existing seven-day safety window', async () => {
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-08']) {
    const f = alphaCollectionFixture(date);
    await collectDynamicPlan(f.plan, f);
    assert.equal(f.calls[0].chargeDate, date);
  }
  const late = alphaCollectionFixture('2026-10-09');
  await assert.rejects(collectDynamicPlan(late.plan, late));
  assert.equal(late.calls.length, 0);
});