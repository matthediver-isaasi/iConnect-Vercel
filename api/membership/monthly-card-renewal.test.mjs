import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./monthly-card.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function handlePost('))
  .replace("const Stripe = (await import('stripe')).default;", 'const Stripe = StripeStub;');

test('fixed elected card reserves agreement and history before provider effects and retains interrupted Checkout', async () => {
  const tables = { member_membership_history: [], membership_billing_agreements: [] };
  const events = [];
  let failBind = true;
  const db = { from(table) {
    let action, payload, filters = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      insert(value) { action = 'insert'; payload = value; return query; },
      update(value) { action = 'update'; payload = value; return query; },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      async maybeSingle() { return execute(); }, async single() { return execute(); },
    };
    function execute() {
      if (action === 'insert') {
        const record = { id: `${table}-id`, created_at: new Date().toISOString(), ...payload };
        tables[table].push(record); events.push(`insert:${table}`);
        return { data: record };
      }
      const row = tables[table].find(row => filters.every(([key, value]) => row[key] === value)) || null;
      if (action === 'update') {
        if (failBind) return { error: { code: 'failed' } };
        Object.assign(row, payload);
      }
      return { data: row };
    }
    return query;
  } };
  const providerKeys = [];
  const session = { id: 'cs_fixture', url: 'https://checkout.example.test/session' };
  const context = vm.createContext({
    console: { error() {} }, Date, supabase: db,
    STATUS: { PAYMENT_SETUP_REQUIRED: 'payment_setup_required' },
    CARD_PLAN_KIND: 'monthly_card',
    loadMember: async () => ({ id: 'member', tenant_id: 'tenant' }),
    getStripeCredentials: async () => ({ secret_key: 'sk_test_fixture' }),
    resolveCardMonthlyOffer: () => ({ currency: 'GBP', monthlyAmount: 10, instalmentCount: 12 }),
    checkApproval: async () => ({ blocked: false }),
    findOpenAgreementForYear: async () => null,
    buildCardAgreementSnapshot: () => ({ currency: 'GBP', monthly_amount_minor: 1000,
      monthly_amount: 10, instalment_count: 12, plan_total: 120 }),
    findOrCreateStripeCustomer: async () => {
      assert.equal(tables.member_membership_history.length, 1);
      assert.equal(tables.membership_billing_agreements.length, 1);
      return { id: 'cus_fixture' };
    },
    StripeStub: class { checkout = { sessions: {
      async create(_params, options) { providerKeys.push(options.idempotencyKey); return session; },
      async expire() { assert.fail('reserved sessions must not be expired on local failure'); },
    } }; },
  });
  vm.runInContext(body, context);
  const req = { body: { action: 'start', memberId: 'member' }, headers: { host: 'example.test' },
    membershipPaymentContext: { source: 'form-renewal', electionId: 'election',
      electionCreatedAt: new Date().toISOString(), simulation: {
        success: true, config: { id: 'config', start_mode: 'fixed_date' },
        membershipYear: { label: '2027' }, annualCost: 120,
        paymentSchedule: { term_start_date: '2027-01-01', term_end_date: '2027-12-31' },
      } } };
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } });
  const first = response();
  await context.handlePost(req, first, 'tenant');
  assert.equal(first.statusCode, 500);
  failBind = false;
  const retry = response();
  await context.handlePost(req, retry, 'tenant');
  assert.equal(retry.body.checkoutUrl, session.url);
  assert.equal(providerKeys.length, 2);
  assert.equal(providerKeys[0], providerKeys[1]);
  assert.equal(events.length, 2, 'retry creates neither another agreement nor another history');
});