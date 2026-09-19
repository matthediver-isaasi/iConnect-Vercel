import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDynamicCollectionPrice, collectDynamicPlan, dynamicCollectionDate,
  assertDynamicPayment, reconcileDynamicCollections, resolveDynamicPayment,
} from './gocardlessDynamicCollections.js';
import { resolveInstalmentInvoiceContext } from './membershipInstalmentInvoicing.js';

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
    provider: 'gocardless', gocardless_mandate_id: 'MD_TEST', metadata: { collection_mode: 'dynamic', dynamic_first_date: firstDate } };
  const rows = { membership_tier_config: [config], membership_billing_agreements: [agreement],
    membership_payment_plans: [plan], membership_monthly_arrears_period: [],
    gocardless_collection_reservations: [], membership_tier_vat_override: [],
    member: [{ id: 'member', tenant_id: 'tenant', country: 'GB' }], member_preference_value: [] };
  const updates = [];
  const calls = [];
  const db = {
    from(table) {
      let filters = [], single = false, patch;
      const query = {
        select() { return this; }, eq(key, value) { filters.push(row => key.includes('->>') || row[key] === value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        is(key, value) { filters.push(row => (row[key] ?? null) === value); return this; },
        or() { return this; }, order() { return this; }, limit() { return this; }, lte() { return this; },
        update(value) { patch = value; return this; },
        maybeSingle() { single = true; return this; }, single() { single = true; return this; },
        then(resolve, reject) {
          const data = (rows[table] || []).filter(row => filters.every(fn => fn(row)));
          if (patch) { updates.push({ table, patch }); for (const row of data) Object.assign(row, patch); }
          return Promise.resolve({ data: single ? data[0] || null : data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, params) {
      if (name === 'reserve_gocardless_dynamic_collection') {
        if (plan.status === 'cancelled') return { error: { message: 'cancelled' } };
        let reservation = rows.gocardless_collection_reservations[0];
        if (!reservation) {
          reservation = {
            id: 'reservation', tenant_id: 'tenant', billing_agreement_id: agreement.id, plan_id: plan.id,
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
        Object.assign(rows.gocardless_collection_reservations[0], { status: 'submitted', gocardless_payment_id: params.p_payment.id });
        return { data: rows.gocardless_collection_reservations[0] };
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
  return { config, agreement, plan, rows, db, gc, calls, updates, now: () => new Date('2027-03-29T12:00:00Z') };
}

test('dynamic price follows active flat price, never the consent-time initial amount', async () => {
  const f = fixture();
  assert.equal((await resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f)).monthly_amount_minor, 1250);
  f.config.dd_monthly_amount = 19;
  assert.equal((await resolveDynamicCollectionPrice(f.agreement, '2027-04-02', f)).monthly_amount_minor, 1900);
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

test('BNMS pilot first October collection waits for exact window and never uses generic seven-day movement',async()=>{
  for(const providerDate of ['2026-09-30','2026-10-01','2026-10-02']){
    const f=fixture({amount:13,firstDate:'2026-10-01',providerDate,end:'2027-09-30'});
    f.agreement.tenant_id='ff2df806-b321-4254-b651-3af11fccf1db';
    f.agreement.member_id='33e5d54d-162e-436d-9bff-ec6676d198f9';
    f.agreement.metadata.bnms_pilot_approval={source:'task-4533-explicit-user-approval'};
    f.agreement.metadata.dd.commitment.term_start_date='2026-10-01';
    // Match the existing fixture's tenant filters to the pinned pilot.
    f.plan.tenant_id=f.agreement.tenant_id;
    f.config.tenant_id=f.agreement.tenant_id;
    if(providerDate==='2026-10-02'){
      await assert.rejects(collectDynamicPlan(f.plan,f),/exact October 1 cutover missed/);
      assert.equal(f.calls.length,0);
    }else{
      await collectDynamicPlan(f.plan,f);
      assert.equal(f.calls.length,providerDate==='2026-10-01'?1:0);
      if(f.calls.length)assert.equal(f.calls[0].chargeDate,'2026-10-01');
    }
  }
});