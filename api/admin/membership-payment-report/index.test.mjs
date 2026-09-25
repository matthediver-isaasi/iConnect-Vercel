import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMembershipPaymentReport as project, upfrontRenewalProjection, sortPaymentReportRows } from '../../_lib/membershipPaymentReport.js';
import { createMembershipPaymentReportHandler, fetchPaymentReportRows } from './index.js';
import { createReportScheduleResolver, readPaymentReportSchedule } from '../../_lib/membershipPaymentReportSchedules.js';
import { loadStripeCollectionSchedule } from '../../_lib/membershipCollectionSchedule.js';

const today = '2026-06-01';
const member = { id: 'm', tenant_id: 't', first_name: 'Ada', email: 'ada@example.org' };
const history = { id: 'h', tenant_id: 't', member_id: 'm', status: 'active',
  tier_label: 'Personal', term_key: 'term', term_start_date: '2026-01-01',
  term_end_date: '2026-12-31', membership_renewal_date: '2027-01-01',
  billing_agreement_id: 'a', payment_method: 'gocardless', billing_period: 'monthly' };
const agreement = { id: 'a', tenant_id: 't', member_id: 'm', provider: 'gocardless',
  environment: 'sandbox', status: 'active', gocardless_mandate_id: 'mandate' };
const plan = { id: 'p', tenant_id: 't', member_id: 'm', billing_agreement_id: 'a',
  provider: 'gocardless', environment: 'sandbox', status: 'active', interval_unit: 'monthly' };
const payment = { id: 'pay', tenant_id: 't', plan_id: 'p', environment: 'sandbox',
  gocardless_mandate_id: 'mandate', status: 'submitted', charge_date: '2026-06-10' };
const fixture = overrides => ({ tenantId: 't', today, members: [member], history: [history],
  agreements: [agreement], plans: [plan], payments: [payment], ...overrides });

test('personal projection reuses aliases and returns only public fields', () => {
  const [row] = project(fixture());
  assert.equal(row.paymentMethod, 'monthly_direct_debit');
  assert.equal(row.nextPaymentDate, payment.charge_date);
  assert.equal(row.scheduleState, 'confirmed');
  assert.deepEqual(Object.keys(row).sort(), ['memberId', 'name', 'email', 'tier', 'status', 'paymentMethod', 'nextPaymentDate', 'scheduleState'].sort());
});

test('stored method aliases share existing membership normalization', () => {
  for (const [stored, expected] of [
    ['stripe', 'card'], ['card', 'card'], ['card_monthly', 'monthly_card'],
    ['stripe_monthly_card', 'monthly_card'], ['gocardless', 'direct_debit'],
    ['direct_debit_monthly', 'monthly_direct_debit'], ['gocardless_monthly', 'monthly_direct_debit'],
    ['invoice', 'invoice'], ['bank_transfer', 'bank_transfer'], ['unrecognised', 'other'],
  ]) {
    const [row] = project(fixture({ history: [{ ...history, payment_method: stored,
      billing_period: 'annual', billing_agreement_id: null }], plans: [], agreements: [] }));
    assert.equal(row.paymentMethod, expected, stored);
    assert.equal(row.nextPaymentDate, null);
  }
});

test('expired, foreign and organisation terms cannot contaminate a member row', () => {
  const old = { ...history, id: 'old', payment_method: 'card', term_start_date: '2024-01-01', membership_renewal_date: '2025-01-01' };
  assert.equal(project(fixture({ history: [old, history, { ...history, tenant_id: 'other' },
    { ...history, organization_id: 'org' }] })).length, 1);
  assert.equal(project(fixture({ history: [old] })).length, 0);
});

test('earliest evidenced eligible term wins, not history order or stale method', () => {
  const future = { ...history, id: 'future', status: 'scheduled', payment_method: 'invoice',
    billing_agreement_id: null, term_start_date: '2026-08-01' };
  assert.equal(project(fixture({ history: [future, history] }))[0].paymentMethod, 'monthly_direct_debit');
  assert.equal(project(fixture({ history: [history, history] })).length, 1);
  const another = { ...history, id: 'overlap', billing_agreement_id: 'a2' };
  const [earliest] = project(fixture({ history: [history, another],
    agreements: [agreement, { ...agreement, id: 'a2' }],
    plans: [plan, { ...plan, id: 'p2', billing_agreement_id: 'a2' }],
    payments: [payment, { ...payment, id: 'pay2', plan_id: 'p2', charge_date: '2026-06-02' }] }));
  assert.equal(earliest.nextPaymentDate, '2026-06-02');
});

test('pause, stop and completion never expose charge dates', () => {
  for (const status of ['paused', 'cancelled', 'completed', 'suspended']) {
    const [row] = project(fixture({ plans: [{ ...plan, status }] }));
    assert.equal(row.nextPaymentDate, null);
    assert.equal(row.scheduleState, 'not_scheduled');
  }
  assert.equal(project(fixture({ members: [{ ...member, membership_paused: true }] }))[0].nextPaymentDate, null);
});

test('ownership, provider, environment and settlement are not future evidence', () => {
  for (const patch of [{ member_id: 'other' }, { organization_id: 'org' },
    { environment: 'live' }, { provider: 'stripe' }]) {
    assert.equal(project(fixture({ plans: [{ ...plan, ...patch }] }))[0].scheduleState, 'unavailable');
  }
  for (const patch of [{ status: 'confirmed' }, { environment: 'live' },
    { gocardless_mandate_id: 'other' }, { charge_date: '2027-01-01' }, { charge_date: '2026-02-30' }]) {
    assert.equal(project(fixture({ payments: [{ ...payment, ...patch }] }))[0].nextPaymentDate, null);
  }
});

test('dynamic dates explicitly planned; Stripe without verified evidence unavailable', () => {
  const [row] = project(fixture({ payments: [], agreements: [{ ...agreement,
    metadata: { dd: { collection_policy: { version: 1, pricing_policy: 'dynamic' } } } }],
  plans: [{ ...plan, dynamic_next_collection_date: '2026-06-09', metadata: { collection_mode: 'dynamic' } }] }));
  assert.equal(row.scheduleState, 'planned');
  assert.equal(row.nextPaymentDate, '2026-06-09');
  const [stripe] = project(fixture({ history: [{ ...history, payment_method: 'stripe_monthly_card' }],
    agreements: [{ ...agreement, provider: 'stripe', environment: 'test' }],
    plans: [{ ...plan, provider: 'stripe', environment: 'test', next_charge_date: '2026-06-05' }] }));
  assert.equal(stripe.paymentMethod, 'monthly_card');
  assert.equal(stripe.scheduleState, 'unavailable');
});

function database(tables = {}, calls = []) {
  return { from(table) {
    const filters = [];
    return {
      select(columns) {
        if (table === 'member_preference_value') assert.ok(!columns.split(',').includes('tenant_id'), 'preference values have no tenant_id column');
        this.columns = columns; return this;
      },
      eq(key, value) {
        if (table === 'member_preference_value') assert.notEqual(key, 'tenant_id');
        filters.push(row => row[key] === value); return this;
      },
      is(key, value) {
        if (table === 'member_preference_value') assert.notEqual(key, 'tenant_id');
        filters.push(row => (row[key] ?? null) === value); return this;
      },
      in(key, values) {
        if (table === 'member_preference_value') assert.notEqual(key, 'tenant_id');
        filters.push(row => values.includes(row[key])); return this;
      },
      gte(key, value) {
        if (table === 'member_preference_value') assert.notEqual(key, 'tenant_id');
        filters.push(row => row[key] >= value); return this;
      },
      order(key) { assert.equal(key, 'id'); return this; },
      then(resolve, reject) {
        return Promise.resolve({ data: (tables[table] || []).filter(row => filters.every(filter => filter(row))), error: null }).then(resolve, reject);
      },
      range(start, end) { calls.push({ table, start, end }); return Promise.resolve({
        data: (tables[table] || []).filter(row => filters.every(filter => filter(row)))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(start, end + 1)
          .map(row => this.columns === '*' ? row : Object.fromEntries(this.columns.split(',').map(key => [key, row[key]]))), error: null,
      }); },
    };
  } };
}
async function request(deps, query = {}, method = 'GET') {
  const res = { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    send(body) { this.body = body; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await createMembershipPaymentReportHandler({ db: database(), today,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 't', roleId: 'r' }),
    hasAdminAccess: async () => true, hasFeatureAccess: async () => true, ...deps })({ method, query }, res);
  return res;
}

test('direct endpoint enforces authentication, tenant, admin, feature and member exclusions', async () => {
  assert.equal((await request({ getTenantContext: async () => null })).code, 401);
  assert.equal((await request({ getTenantContext: async () => ({ isAuthenticated: true, tenantId: 't', tenantMismatch: true }) })).code, 409);
  assert.equal((await request({ hasAdminAccess: async () => false })).code, 403);
  assert.equal((await request({ hasFeatureAccess: async () => false })).code, 403);
  const response = await request({
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 't', roleId: 'r', memberExcludedFeatures: ['commerce'] }),
    hasFeatureAccess: async (role, feature, exclusions) => {
      assert.equal(feature, 'commerce.membership-payment-report');
      assert.deepEqual(exclusions, ['commerce']); return false;
    },
  });
  assert.equal(response.code, 403);
  assert.equal((await request({}, {}, 'POST')).code, 405);
  for (const query of [{ method: 'bogus' }, { method: ['card'] }, { page: '0' }, { pageSize: '101' }]) {
    assert.equal((await request({}, query)).code, 400);
  }
  for (const query of [
    { method: 'upfront', sortBy: 'nextPaymentDate' },
    { method: 'all', sortBy: 'renewalDate' },
    { method: 'monthly_direct_debit', sortBy: 'renewalDate' },
    { method: 'direct_debit', sortBy: ['nextPaymentDate'] },
    { method: 'upfront', sortBy: 'renewalDate', sortDirection: 'down' },
    { sortDirection: 'desc' },
  ]) assert.equal((await request({}, query)).code, 400, JSON.stringify(query));
});

test('date sorting keeps invalid and missing dates last in both directions, with stable name/id ties', () => {
  const rows = [
    { name: 'Zoe', memberId: 'z', renewalDate: '2026-07-01', nextPaymentDate: '2026-08-01' },
    { name: 'Ada', memberId: 'a2', renewalDate: '2026-06-01', nextPaymentDate: '2026-07-01' },
    { name: 'Ada', memberId: 'a1', renewalDate: '2026-06-01', nextPaymentDate: '2026-07-01' },
    { name: 'Bad', memberId: 'bad', renewalDate: '2026-02-30', nextPaymentDate: 'not-a-date' },
    { name: 'Missing', memberId: 'missing', renewalDate: null, nextPaymentDate: null },
  ];
  assert.deepEqual(sortPaymentReportRows([...rows], 'renewalDate').map(r => r.memberId), ['a1', 'a2', 'z', 'bad', 'missing']);
  assert.deepEqual(sortPaymentReportRows([...rows], 'renewalDate', 'desc').map(r => r.memberId), ['z', 'a1', 'a2', 'bad', 'missing']);
  assert.deepEqual(sortPaymentReportRows([...rows], 'nextPaymentDate', 'desc').map(r => r.memberId), ['z', 'a1', 'a2', 'bad', 'missing']);
  assert.deepEqual(sortPaymentReportRows([...rows]).map(r => r.memberId), ['a1', 'a2', 'bad', 'missing', 'z']);
});

test('upfront sorting filters then sorts entire result before page, CSV follows selected direction', async () => {
  const specs = [
    ['z', 'Zoe', '2027-01-01'], ['a2', 'Ada', '2026-09-01'],
    ['a1', 'Ada', '2026-09-01'], ['n', 'NoDate', '2028-01-01'],
  ];
  const db = database({
    member: specs.map(([id, first_name]) => ({ ...member, id, first_name })),
    member_membership_history: specs.map(([id, , membership_renewal_date]) => ({
      ...history, id: `h-${id}`, member_id: id, payment_method: 'upfront',
      billing_agreement_id: null, billing_period: 'annual', membership_renewal_date,
      term_end_date: null,
    })),
  });
  const options = { method: 'upfront', sortBy: 'renewalDate', pageSize: '2' };
  const asc = await request({ db }, { ...options, page: '2', sortDirection: 'asc' });
  assert.deepEqual(asc.body.rows.map(r => r.memberId), ['z', 'n']);
  assert.equal(asc.body.total, 4);
  const desc = await request({ db }, { ...options, page: '1', sortDirection: 'desc' });
  assert.deepEqual(desc.body.rows.map(r => r.memberId), ['n', 'z']);
  const csv = await request({ db }, { ...options, page: '2', format: 'csv', sortDirection: 'desc' });
  assert.equal(csv.code, 200);
  assert.deepEqual([...csv.body.matchAll(/^(Zoe|Ada|NoDate),/gm)].map(match => match[1]),
    ['NoDate', 'Zoe', 'Ada', 'Ada']);
  const defaultOrder = await request({ db }, { method: 'upfront' });
  assert.deepEqual(defaultOrder.body.rows.map(r => r.memberId), ['a1', 'a2', 'n', 'z']);
});

test('monthly DD next payment sorting spans pages and sends CSV in same order', async () => {
  const specs = [['late', 'Zoe', '2026-07-01'], ['soon', 'Ada', '2026-06-10'],
    ['none', 'NoDate', null]];
  const db = database({
    member: specs.map(([id, first_name]) => ({ ...member, id, first_name })),
    member_membership_history: specs.map(([id]) => ({
      ...history, id: `h-${id}`, member_id: id, billing_agreement_id: `a-${id}`,
    })),
    membership_billing_agreements: specs.map(([id]) => ({ ...agreement, id: `a-${id}`, member_id: id })),
    membership_payment_plans: specs.map(([id]) => ({ ...plan, id: `p-${id}`, member_id: id, billing_agreement_id: `a-${id}` })),
    gocardless_payments: specs.filter(([, , date]) => date).map(([id, , charge_date]) => ({
      ...payment, id: `pay-${id}`, plan_id: `p-${id}`, charge_date,
    })),
  });
  const deps = { db, resolveSchedules: async () => new Map(), loadDirectDebit: async () => new Map() };
  const options = { method: 'monthly_direct_debit', sortBy: 'nextPaymentDate' };
  const asc = await request(deps, { ...options, sortDirection: 'asc', pageSize: '1', page: '2' });
  assert.deepEqual(asc.body.rows.map(r => r.memberId), ['late']);
  const desc = await request(deps, { ...options, sortDirection: 'desc' });
  assert.deepEqual(desc.body.rows.map(r => r.memberId), ['late', 'soon', 'none']);
  const csv = await request(deps, { ...options, format: 'csv', sortDirection: 'desc' });
  assert.deepEqual([...csv.body.matchAll(/^(Zoe|Ada|NoDate),/gm)].map(match => match[1]),
    ['Zoe', 'Ada', 'NoDate']);
});

test('full dataset exceeds 1000, filters before paging, deterministic unknown dates last', async () => {
  const members = Array.from({ length: 1101 }, (_, i) => ({ ...member, id: `m${String(i).padStart(4, '0')}`, first_name: `Name${String(i).padStart(4, '0')}` }));
  const histories = members.map((m, i) => ({ ...history, id: `h${m.id}`, member_id: m.id,
    payment_method: i === 1100 ? 'invoice' : 'card', billing_agreement_id: null, billing_period: 'annual' }));
  const calls = [];
  const db = database({ member: [...members, { ...member, id: 'foreign', tenant_id: 'foreign' }],
    member_membership_history: histories }, calls);
  assert.equal((await fetchPaymentReportRows(db, 'member', '*', 't')).length, 1101);
  assert.ok(calls.some(call => call.start === 1000));
  const filtered = await request({ db }, { method: 'invoice', pageSize: '1' });
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.rows[0].memberId, 'm1100');
  const second = await request({ db }, { page: '2', pageSize: '100' });
  assert.equal(second.body.total, 1101);
  assert.equal(second.body.rows[0].memberId, 'm0100');
  const rows = project(fixture({ members: [member, { ...member, id: 'n', first_name: 'A' }],
    history: [history, { ...history, id: 'n', member_id: 'n', billing_agreement_id: null, payment_method: 'invoice' }] }));
  assert.deepEqual(rows.map(row => row.memberId), ['m', 'n']);
});

test('database failure gives explicit error, not an empty success', async () => {
  const result = await request({ db: { from() { throw new Error('Database unavailable'); } } });
  assert.equal(result.code, 500);
  assert.match(result.body.error, /could not be loaded/);
});

test('fixed GC verifies tenant credentials, environment, subscription identity and state', async () => {
  const request = { tenantId: 't', today, agreement, plan: { ...plan, gocardless_subscription_id: 'sub' } };
  const credentials = { source: 'tenant', tenantId: 't', environment: 'sandbox', accessToken: 'test-only' };
  const subscription = { id: 'sub', status: 'active', links: { mandate: 'mandate' },
    upcoming_payments: [{ charge_date: '2026-06-04' }] };
  const read = (creds = credentials, sub = subscription) => readPaymentReportSchedule(request, {
    getGcCredentials: async () => creds,
    createGcClient: () => ({ getSubscription: async () => sub }),
  });
  assert.equal((await read()).nextConfirmedDate, '2026-06-04');
  for (const patch of [{ source: 'platform-env' }, { tenantId: 'foreign' }, { environment: 'live' }]) {
    assert.equal((await read({ ...credentials, ...patch })).evidence, 'unavailable');
  }
  for (const patch of [{ id: 'foreign' }, { links: { mandate: 'foreign' } }, { status: 'paused' }]) {
    assert.equal((await read(credentials, { ...subscription, ...patch })).evidence, 'unavailable');
  }
  assert.equal((await read(credentials, { ...subscription, status: 'cancelled' })).nextConfirmedDate, null);
});

test('real Stripe loader semantics supply future timing, reject mode/customer mismatches and inactive schedules', async () => {
  const request = { tenantId: 't', today,
    agreement: { ...agreement, provider: 'stripe', environment: 'test', stripe_subscription_id: 'sub', stripe_customer_id: 'cus' },
    plan: { ...plan, provider: 'stripe', environment: 'test', stripe_subscription_id: 'sub' } };
  const subscription = { id: 'sub', customer: 'cus', livemode: false, status: 'active',
    collection_method: 'charge_automatically', current_period_end: Date.parse('2026-06-03') / 1000,
    items: { data: [{ price: { recurring: { interval: 'month', interval_count: 1 } } }] } };
  const read = patch => readPaymentReportSchedule(request, {
    getStripeCredentials: async () => ({ test_secret_key: 'test-only' }),
    loadStripe: args => loadStripeCollectionSchedule({ ...args,
      createClient: async () => ({ subscriptions: { retrieve: async () => ({ ...subscription, ...patch }) } }) }),
  });
  assert.equal((await read({})).nextConfirmedDate, '2026-06-03');
  for (const patch of [{ customer: 'foreign' }, { livemode: true }, { id: 'foreign' }]) {
    assert.equal((await read(patch)).evidence, 'unavailable');
  }
  assert.equal((await read({ status: 'canceled' })).nextConfirmedDate, null);
});

const fixedInput = () => fixture({ payments: [], plans: [{ ...plan, gocardless_subscription_id: 'sub' }] });

test('provider cache is owner/lifecycle/environment scoped and failures explicitly unavailable', async () => {
  let calls = 0;
  const resolve = createReportScheduleResolver({ load: async () => {
    calls++; return { nextConfirmedDate: '2026-06-03', evidence: 'provider_subscription' };
  } });
  const input = fixedInput();
  await resolve(input); await resolve(input);
  assert.equal(calls, 1);
  await resolve({ ...input, plans: [{ ...input.plans[0], status: 'cancelled' }] });
  assert.equal(calls, 1);
  await resolve({ ...input, plans: [{ ...input.plans[0], environment: 'live' }],
    agreements: [{ ...agreement, environment: 'live' }] });
  assert.equal(calls, 2);
  const failing = createReportScheduleResolver({ load: async () => { throw new Error('provider outage'); } });
  const schedules = await failing(input);
  assert.equal(project({ ...input, providerSchedules: schedules })[0].scheduleState, 'unavailable');
});

test('provider reads are bounded and global ordering uses all eligible evidence before paging', async () => {
  const input = fixedInput();
  const members = Array.from({ length: 7 }, (_, i) => ({ ...member, id: `m${i}` }));
  const data = { ...input, members,
    history: members.map((m, i) => ({ ...history, id: `h${i}`, member_id: m.id, billing_agreement_id: `a${i}` })),
    agreements: members.map((m, i) => ({ ...agreement, id: `a${i}`, member_id: m.id })),
    plans: members.map((m, i) => ({ ...plan, id: `p${i}`, member_id: m.id, billing_agreement_id: `a${i}`, gocardless_subscription_id: `sub${i}` })) };
  let calls = 0; let active = 0; let peak = 0;
  const resolve = createReportScheduleResolver({ concurrency: 2, maxCalls: 5, load: async request => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(done => setTimeout(done, 2)); active--;
    return { nextConfirmedDate: `2026-06-${String(10 - Number(request.plan.id.slice(1))).padStart(2, '0')}`, evidence: 'provider_subscription' };
  } });
  const providerSchedules = await resolve(data);
  assert.equal(calls, 5); assert.equal(peak, 2);
  const rows = project({ ...data, providerSchedules });
  assert.equal(rows[0].memberId, 'm4');
  assert.equal(rows.at(-1).scheduleState, 'unavailable');
  const all = createReportScheduleResolver({ load: async request => ({
    nextConfirmedDate: `2026-06-${String(10 - Number(request.plan.id.slice(1))).padStart(2, '0')}`,
    evidence: 'provider_subscription',
  }) });
  const ordered = project({ ...data, providerSchedules: await all(data) });
  assert.deepEqual(ordered.slice(0, 2).map(row => row.memberId), ['m6', 'm5']);
});

test('provider timeout returns promptly and keeps global concurrency bounded', async () => {
  let calls = 0;
  let finish;
  const resolve = createReportScheduleResolver({ budgetMs: 5, concurrency: 1,
    load: () => { calls++; return new Promise(done => { finish = done; }); } });
  assert.equal((await resolve(fixedInput())).get('p').evidence, 'unavailable');
  await resolve(fixedInput());
  assert.equal(calls, 1);
  finish({ evidence: 'unavailable', nextConfirmedDate: null });
});

test('deleted identities are excluded before projection and provider requests, not null emails or disabled logins', async () => {
  for (const email of ['deleted_abc-123@deleted.local', 'DELETED_identity@DELETED.LOCAL']) {
    const input = { ...fixedInput(), members: [{ ...member, email }] };
    let calls = 0;
    assert.deepEqual(project({ ...input, collectScheduleRequest: () => calls++ }), []);
    await createReportScheduleResolver({ load: async () => { calls++; return {}; } })(input);
    assert.equal(calls, 0);
  }
  for (const patch of [{ email: null }, { membership_paused: true }, { login_enabled: false }]) {
    assert.equal(project(fixture({ members: [{ ...member, ...patch }] })).length, 1);
  }
  const db = database({ member: [{ ...member, email: 'deleted_m@deleted.local' }],
    member_membership_history: [history], membership_billing_agreements: [agreement], membership_payment_plans: [plan] });
  const resolveSchedules = async input => { assert.deepEqual(input.members, []); return new Map(); };
  const json = await request({ db, resolveSchedules });
  assert.equal(json.body.total, 0);
  assert.deepEqual(json.body.rows, []);
  const csv = await request({ db, resolveSchedules }, { format: 'csv' });
  assert.equal(csv.body, '\ufeffMember,Email,Tier,Status,Payment method,Next payment,Schedule,Current expiry,Renewal date,Renewal basis,Payment arrangement,Next structure,Structure review,Next payment amount,Currency,Payment amount basis\r\n');
});

test('CSV exports full filtered batches in JSON order, excluding deleted and foreign identities', async () => {
  const members = Array.from({ length: 1105 }, (_, i) => ({
    ...member, id: `m${String(i).padStart(4, '0')}`, first_name: `Person ${String(i).padStart(4, '0')}`,
    email: i === 0 ? 'deleted_m0@deleted.local' : i === 1 ? null : member.email,
    membership_paused: i === 2, login_enabled: false,
  }));
  const histories = members.map((m, i) => ({ ...history, id: `h${m.id}`, member_id: m.id,
    payment_method: i === 1104 ? 'invoice' : 'card', billing_agreement_id: null, billing_period: 'annual' }));
  const calls = [];
  const db = database({
    member: [...members, { ...member, id: 'foreign', tenant_id: 'foreign' }],
    member_membership_history: [...histories, { ...history, id: 'foreign', member_id: 'foreign', tenant_id: 'foreign' }],
  }, calls);
  const resolveSchedules = async input => {
    assert.equal(input.members.length, 1104);
    return new Map();
  };
  const csv = await request({ db, resolveSchedules }, { format: 'csv', method: 'card', page: '2', pageSize: '1' });
  assert.equal(csv.code, 200);
  assert.equal(csv.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.match(csv.headers['Content-Disposition'], /membership-payment-report-card-2026-06-01.csv/);
  assert.equal(csv.headers['Cache-Control'], 'private, no-store');
  const lines = csv.body.slice(1).trimEnd().split('\r\n');
  assert.equal(lines.length, 1104);
  assert.ok(calls.some(call => call.table === 'member' && call.start === 1000));
  assert.ok(calls.some(call => call.table === 'member_membership_history' && call.start === 1000));
  assert.doesNotMatch(csv.body, /deleted_|foreign|mandate|sandbox/);
  assert.match(lines[1], /^Person 0001,Unknown,/);
  assert.match(lines[2], /,Paused,Card,Unknown,Not Scheduled,/);
  const json = await request({ db, resolveSchedules }, { method: 'card', page: '2', pageSize: '100' });
  assert.equal(json.body.total, 1103);
  assert.deepEqual(lines.slice(101, 201).map(line => line.split(',')[0]), json.body.rows.map(row => row.name));
});

test('CSV uses readable dates, preserves accents, escapes quotes/newlines and neutralises formulas', async () => {
  const db = database({
    member: [{ ...member, first_name: '=Zoë, "Test"\nNext', email: '+mail@example.org' }],
    member_membership_history: [{ ...history, tier_label: '@Tier\r\nTwo' }],
    membership_billing_agreements: [agreement], membership_payment_plans: [plan], gocardless_payments: [payment],
  });
  const csv = await request({ db, resolveSchedules: async () => new Map() }, { format: 'csv' });
  assert.equal(csv.body, '\ufeffMember,Email,Tier,Status,Payment method,Next payment,Schedule,Current expiry,Renewal date,Renewal basis,Payment arrangement,Next structure,Structure review,Next payment amount,Currency,Payment amount basis\r\n'
    + `"'=Zoë, ""Test"" Next",'+mail@example.org,'@Tier Two,Current,Monthly Direct Debit,10 Jun 2026,Confirmed,,,,,,Review required — collection structure unavailable,,,Review required — next amount unavailable\r\n`);
});

test('CSV defaults to alphabetical order when no date sort is requested', async () => {
  const members = [{ ...member, first_name: 'Zed' }, { ...member, id: 'n', first_name: 'Alpha' }];
  const db = database({ member: members,
    member_membership_history: [history, { ...history, id: 'hn', member_id: 'n', billing_agreement_id: null, payment_method: 'invoice' }],
    membership_billing_agreements: [agreement], membership_payment_plans: [plan], gocardless_payments: [payment] });
  const csv = await request({ db, resolveSchedules: async () => new Map() }, { format: 'csv' });
  assert.deepEqual(csv.body.split('\r\n').slice(1, 3).map(line => line.split(',')[0]), ['Alpha', 'Zed']);
});

test('CSV enforces authorization before any reads and failures never send attachment headers', async () => {
  const db = { from() { throw new Error('Must not read'); } };
  for (const [deps, status] of [
    [{ getTenantContext: async () => null }, 401],
    [{ getTenantContext: async () => ({ isAuthenticated: true, tenantId: 't', tenantMismatch: true }) }, 409],
    [{ hasAdminAccess: async () => false }, 403],
    [{ hasFeatureAccess: async () => false }, 403],
  ]) {
    const response = await request({ db, ...deps }, { format: 'csv' });
    assert.equal(response.code, status);
    assert.deepEqual(response.headers, {});
  }
  for (const deps of [
    { db },
    { resolveSchedules: async () => { throw new Error('Resolution failed'); } },
  ]) {
    const response = await request(deps, { format: 'csv' });
    assert.equal(response.code, 500);
    assert.deepEqual(response.headers, {});
    assert.match(response.body.error, /could not be loaded/);
  }
  assert.equal((await request({}, { format: ['csv'] })).code, 400);
  assert.equal((await request({}, { format: 'pdf' })).code, 400);
});

const bnms = 'ff2df806-b321-4254-b651-3af11fccf1db';
const upfront = { ...history, tenant_id: bnms, payment_method: 'upfront', billing_period: 'annual',
  term_start_date: null, membership_renewal_date: null, term_key: null, billing_agreement_id: null,
  membership_year: '2025/2026', payment_status: 'paid', currency: 'GBP', config_id: null,
  term_duration_months: null, commitment_snapshot: null, final_cost: null, total_with_vat: null,
  notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill' }) };
const legacyFixture = overrides => fixture({ tenantId: bnms, members: [{ ...member, tenant_id: bnms }],
  history: [upfront], ...overrides });

test('search is bounded and validated before database reads for JSON and CSV', async () => {
  const db = { from() { throw new Error('Must not read invalid search'); } };
  for (const search of [['Ada'], {}, 42, 'a'.repeat(201)]) {
    for (const format of ['json', 'csv']) {
      const response = await request({ db }, { search, format });
      assert.equal(response.code, 400);
      assert.match(response.body.error, /Search/);
    }
  }
});

test('literal case-insensitive search spans fetch batches, methods, totals and full CSV', async () => {
  const members = Array.from({ length: 1105 }, (_, i) => ({
    ...member, id: `m${String(i).padStart(4, '0')}`, first_name: `Person ${i}`,
    last_name: 'Example', email: `person${i}@example.invalid`,
  }));
  members[1100].first_name = 'Zoë *_%[x],()\\';
  members[1101].email = 'SAMPLE@EXAMPLE.INVALID';
  const histories = members.map(m => ({ ...history, id: `h${m.id}`, member_id: m.id,
    payment_method: m.id === 'm1101' ? 'invoice' : 'card', billing_agreement_id: null, billing_period: 'annual' }));
  const deps = { db: database({
    member: [...members, { ...member, id: 'deleted', first_name: 'Sample', email: 'deleted_x@deleted.local' },
      { ...member, id: 'foreign', tenant_id: 'foreign', first_name: 'Sample' }],
    member_membership_history: [...histories,
      { ...history, id: 'deleted', member_id: 'deleted' },
      { ...history, id: 'foreign', member_id: 'foreign', tenant_id: 'foreign' }],
  }), resolveSchedules: async () => new Map() };
  for (const search of ['  sample@EXAMPLE  ', 'SAMPLE']) {
    const result = await request(deps, { search, pageSize: '1' });
    assert.equal(result.body.total, 1);
    assert.equal(result.body.rows[0].memberId, 'm1101');
    assert.equal((await request(deps, { search, method: 'card' })).body.total, 0);
    assert.equal((await request(deps, { search, method: 'invoice' })).body.total, 1);
  }
  for (const search of ['zoË', '*', '_', '%', '[x]', ',()', '\\', 'Example']) {
    const result = await request(deps, { search, pageSize: '1' });
    assert.equal(result.body.total, search === 'Example' ? 1105 : 1, search);
  }
  const filtered = await request(deps, { search: 'Person 10', method: 'card', pageSize: '1', page: '2' });
  const csv = await request(deps, { search: 'Person 10', method: 'card', format: 'csv', pageSize: '1', page: '2' });
  const lines = csv.body.trimEnd().split('\r\n');
  assert.equal(lines.length - 1, filtered.body.total);
  assert.ok(filtered.body.total > 25);
  assert.equal(lines[2].split(',')[0], filtered.body.rows[0].name);
  assert.equal((await request(deps, { search: '   ', method: 'invoice' })).body.total, 1);
  assert.equal((await request(deps, { search: 'no match' })).body.total, 0);
});

test('search finds current reviewed upfront member in both methods but never extends expiry', async () => {
  const deps = { today: '2026-09-24', db: database({
    member: [{ ...member, tenant_id: bnms, email: 'sample@example.invalid' }],
    member_membership_history: [{ ...upfront, term_end_date: '2026-09-29' }],
  }), getTenantContext: async () => ({ isAuthenticated: true, tenantId: bnms, roleId: 'r' }),
  resolveSchedules: async () => new Map() };
  for (const method of ['all', 'upfront']) {
    const result = await request(deps, { search: 'SAMPLE@', method });
    assert.equal(result.body.total, 1);
    assert.equal(result.body.rows[0].paymentMethod, 'upfront');
    assert.equal(result.body.rows[0].nextPaymentDate, null);
    assert.equal(result.body.rows[0].scheduleState, 'not_scheduled');
    assert.equal((await request({ ...deps, today: '2026-09-29' }, { search: 'sample', method })).body.total, 1);
    assert.equal((await request({ ...deps, today: '2026-09-30' }, { search: 'sample', method })).body.total, 0);
  }
});

test('reviewed upfront records preserve unknown dates/amounts and never request providers', async () => {
  for (const cost of [null, 109]) {
    const input = legacyFixture({ history: [{ ...upfront, final_cost: cost, total_with_vat: cost }] });
    let calls = 0;
    const schedules = await createReportScheduleResolver({ load: async () => { calls++; } })(input);
    const [row] = project({ ...input, providerSchedules: schedules });
    assert.equal(row.paymentMethod, 'upfront');
    assert.equal(row.nextPaymentDate, null);
    assert.equal(row.scheduleState, 'not_scheduled');
    assert.equal(calls, 0);
    assert.equal(project({ ...input, today: '2026-12-31' }).length, 1);
    assert.equal(project({ ...input, today: '2027-01-01' }).length, 0);
  }
});

test('legacy fallback rejects invalid evidence, foreign tenants, organisations and deleted identities', () => {
  for (const patch of [{ notes: null }, { notes: '{invalid' }, { notes: '{"source":"unreviewed"}' },
    { payment_status: 'unpaid' }, { status: 'expired' }, { status: 'cancelled' },
    { membership_year: '2026/2027' }, { currency: 'EUR' }, { tier_label: '' },
    { config_id: 'config' }, { term_duration_months: 12 }, { commitment_snapshot: {} },
    { billing_agreement_id: 'a' }, { term_end_date: '2026-02-30' },
    { term_end_date: '2025-12-31' }, { term_end_date: '2027-01-01' },
    { final_cost: 100 }, { final_cost: -1, total_with_vat: -1 },
    { organization_id: 'org' }, { membership_source: 'organisation' }, { tenant_id: 'foreign' }]) {
    assert.equal(project(legacyFixture({ history: [{ ...upfront, ...patch }] })).length, 0, JSON.stringify(patch));
  }
  assert.equal(project(fixture({ history: [{ ...upfront, tenant_id: 't' }] })).length, 0);
  assert.equal(project(legacyFixture({ members: [{ ...member, tenant_id: bnms, email: 'deleted_m@deleted.local' }] })).length, 0);
});

test('current and scheduled terms beat legacy fallback; duplicate legacy choice is deterministic', () => {
  const other = { ...upfront, id: 'a', tier_label: 'Chosen' };
  for (const histories of [[upfront, other], [other, upfront]]) {
    assert.equal(project(legacyFixture({ history: histories }))[0].tier, 'Chosen');
    for (const status of ['active', 'scheduled']) {
      const term = { ...history, tenant_id: bnms, status, payment_method: 'invoice', billing_agreement_id: null };
      const rows = project(legacyFixture({ history: [...histories, term] }));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].paymentMethod, 'invoice');
    }
  }
});

test('endpoint selects legacy evidence and uses one full dataset for totals, filters, pages and CSV', async () => {
  const members = Array.from({ length: 1003 }, (_, i) => ({ ...member, tenant_id: bnms,
    id: `m${String(i).padStart(4, '0')}`, first_name: `Person ${String(i).padStart(4, '0')}` }));
  const histories = members.map((m, i) => ({ ...(i < 1000 ? upfront : history), tenant_id: bnms,
    member_id: m.id, id: `h${m.id}`, ...(i < 1000 ? {} : {
      payment_method: ['card', 'invoice', 'gocardless'][i - 1000], billing_agreement_id: null }) }));
  const db = database({ member: members, member_membership_history: histories });
  const deps = { db, resolveSchedules: async () => new Map(),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: bnms, roleId: 'r' }) };
  const all = await request(deps);
  assert.equal(all.body.total, 1003);
  assert.ok(all.body.methods.some(m => m.value === 'upfront' && m.label === 'Upfront'));
  const filtered = await request(deps, { method: 'upfront', page: '2', pageSize: '100' });
  assert.equal(filtered.body.total, 1000);
  assert.equal(filtered.body.rows.length, 100);
  assert.equal(filtered.body.rows[0].memberId, 'm0100');
  const csv = await request(deps, { method: 'upfront', format: 'csv', pageSize: '1' });
  const lines = csv.body.trimEnd().split('\r\n');
  assert.equal(lines.length, 1001);
  assert.equal(lines[0], '\ufeffMember,Email,Tier,Status,Payment method,Membership renewal,Next structure,"Next renewal amount (projected, incl. VAT)",Currency');
  assert.match(lines[1], /,Upfront,01 Jan 2027,Review required — no uniquely named applicable structure,Review required — next structure unresolved,$/);
  assert.deepEqual(lines.slice(101, 201).map(line => line.split(',')[0]), filtered.body.rows.map(row => row.name));
});

test('renewal projection uses trusted ISO dates, rollover and unique dated selectors only', () => {
  const config = { id: 'c', tenant_id: 't', name: 'Next structure', structure_scope_type: 'member',
    structure_field_id: 'class', structure_match_value: 'Full', effective_from: '2026-12-10' };
  const input = { tenantId: 't', member, record: { term_end_date: '2026-12-09' },
    configs: [config], preferences: [{ tenant_id: 't', member_id: 'm', field_id: 'class', value: 'full' }] };
  assert.equal(upfrontRenewalProjection(input).renewalDate, '2026-12-10');
  assert.equal(upfrontRenewalProjection(input).renewalLabel, 'Expected renewal');
  assert.equal(upfrontRenewalProjection(input).nextStructureId, 'c');
  for (const record of [{ term_end_date: '12/9/26' }, { term_end_date: '2026-02-30' }, {}]) {
    assert.equal(upfrontRenewalProjection({ ...input, record }).renewalLabel, 'Renewal date missing');
  }
  for (const [end, next] of [['2026-12-31', '2027-01-01'], ['2028-02-28', '2028-02-29']]) {
    assert.equal(upfrontRenewalProjection({ ...input, record: { term_end_date: end } }).renewalDate, next);
  }
  assert.equal(upfrontRenewalProjection({ ...input, record: {
    term_end_date: '2026-12-09', membership_renewal_date: '2026-12-15',
  } }).renewalLabel, 'Saved renewal date');
  for (const patch of [{ tenant_id: 'foreign' }, { effective_from: '2026-12-11' },
    { effective_to: '2026-12-09' }, { structure_match_value: 'Other' }, { is_active: false }]) {
    assert.equal(upfrontRenewalProjection({ ...input, configs: [{ ...config, ...patch }] }).nextStructureId, null);
  }
  assert.match(upfrontRenewalProjection({ ...input, configs: [config, { ...config, id: 'overlap' }] }).nextStructureState, /overlapping/);
});

test('endpoint joins tenant-owned members and selector definitions without a preference tenant column', async () => {
  const config = { id: 'c', tenant_id: bnms, name: 'Matched future', structure_scope_type: 'member',
    structure_field_id: 'field', structure_match_value: 'Full' };
  const tables = {
    member: [{ ...member, tenant_id: bnms }, { ...member, id: 'foreign', tenant_id: 'other' }],
    member_membership_history: [{ ...upfront, term_end_date: '2026-12-09' }],
    membership_tier_config: [config],
    preference_field: [{ id: 'field', tenant_id: bnms }],
    member_preference_value: [
      { id: 'v', member_id: 'm', field_id: 'field', value: 'Full' },
      { id: 'foreign-value', member_id: 'foreign', field_id: 'field', value: 'Wrong' },
    ],
  };
  const run = async overrides => request({ db: database({ ...tables, ...overrides }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: bnms, roleId: 'r' }),
    resolveSchedules: async () => new Map() });
  const matched = await run({});
  assert.equal(matched.code, 200);
  assert.equal(matched.body.rows[0].nextStructureName, 'Matched future');
  for (const overrides of [
    { preference_field: [{ id: 'field', tenant_id: 'other' }] },
    { member_preference_value: [{ id: 'foreign-value', member_id: 'foreign', field_id: 'field', value: 'Full' }] },
    { membership_tier_config: [{ ...config, tenant_id: 'other' }] },
    { member_preference_value: [{ id: 'v', member_id: 'm', field_id: 'foreign-field', value: 'Full' }] },
  ]) {
    const result = await run(overrides);
    assert.equal(result.code, 200);
    assert.equal(result.body.rows[0].nextStructureId, null);
  }
});

test('endpoint and CSV expose expected upfront dates without provider collection or commitments', async () => {
  const deps = { db: database({
    member: [{ ...member, tenant_id: bnms, membership_paused: true }],
    member_membership_history: [{ ...upfront, term_end_date: '2026-12-09' }],
    membership_tier_config: [{ id: 'future', tenant_id: bnms, name: 'Future personal',
      structure_scope_type: 'member', effective_from: '2026-12-10',
      currency: 'GBP', pricing_model: 'flat', flat_cost: 125, flat_vat_rate: '20% VAT' }],
  }), getTenantContext: async () => ({ isAuthenticated: true, tenantId: bnms, roleId: 'r' }),
  resolveSchedules: async () => new Map() };
  const result = await request(deps, { method: 'upfront' });
  const row = result.body.rows[0];
  assert.equal(row.status, 'paused');
  assert.equal(row.currentExpiryDate, '2026-12-09');
  assert.equal(row.renewalDate, '2026-12-10');
  assert.equal(row.nextPaymentDate, null);
  assert.equal(row.nextStructureName, 'Future personal');
  assert.equal(row.nextRenewalAmount, 150);
  assert.equal(row.nextRenewalCurrency, 'GBP');
  const csv = await request(deps, { method: 'upfront', format: 'csv' });
  assert.equal(csv.body, '\ufeffMember,Email,Tier,Status,Payment method,Membership renewal,Next structure,"Next renewal amount (projected, incl. VAT)",Currency\r\n'
    + 'Ada,ada@example.org,Personal,Paused,Upfront,10 Dec 2026,Future personal,150.00,GBP\r\n');
});