import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { compensateRejectedEventCreditPayment } from '../_lib/eventPaymentPolicyCompensation.js';

const slot = '__complexEventCreditIntentFixture';

async function loadHandler() {
  const entry = resolve('api/public/complex-event-payment-intent.js');
  const virtual = new Map([
    ['stripe', `export default class Stripe { constructor() { return globalThis.${slot}.stripe; } }`],
    ['@supabase/supabase-js', `export const createClient = () => globalThis.${slot}.db;`],
    ['../_lib/tenantResolver.js', `export const resolveTenantFromRequest = async () => ({ id: 'tenant-a' });`],
    ['../_lib/stripeCredentials.js', `export const getStripeCredentials = async () => ({ secret_key: 'sk_test', publishable_key: 'pk_test', is_enabled: true });`],
    ['../_lib/session.js', `export const getSessionMember = async () => ({ id: 'member-a' });`],
    ['../_lib/complexEventPricing.js', `
      export const getTicketClassFromConfig = (rows, id) => rows.find((row) => row.id === id);
      export const resolveTicketPrice = (rows, id) => ({ found: true, price: rows.find((row) => row.id === id).price, currency: 'gbp', name: 'Ticket' });
      export const isTicketVisibleToUser = () => true;
      export const validateDiscountCode = async () => ({ valid: false, reason: 'unused' });
      export const computeDiscountedPrice = (price) => price;
    `],
    ['../_lib/allocationInvitation.js', `export const resolveAllocationInvitation = async () => { throw new Error('unused'); };`],
    ['../_lib/eventPaymentPolicy.js', `
      export const loadEventPaymentPolicy = async () => ({ allowVoucherPayment: true, allowTrainingFundPayment: true });
      export const assertEventPaymentMethodsAllowed = () => {};
    `],
    ['../_lib/voucherExpiryPolicy.js', `
      export const getAllowVoucherUseAfterExpiry = async () => globalThis.${slot}.allowAfterExpiry;
      export const isVoucherUsableForEventDate = (voucher, eventStart, allow) =>
        allow || !voucher.expires_at || !eventStart || new Date(voucher.expires_at) > new Date(eventStart);
    `],
  ]);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'complex-credit-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (virtual.has(args.path)) return { path: args.path, namespace: 'fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          loader: 'js',
          contents: virtual.get(args.path),
        }));
      },
    }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
}

function makeDb({ roleId = 'role-a', fundBalance = 100, voucherRoleIds = [], fundRoleIds = [] } = {}) {
  const tables = {
    complex_event: [{ id: 'event-a', tenant_id: 'tenant-a', title: 'Event', status: 'published', event_state: 'active', start_date: '2027-06-01' }],
    complex_event_ticket_class: [{ id: 'ticket-a', complex_event_id: 'event-a', tenant_id: 'tenant-a', price: 100 }],
    member: [{ id: 'member-a', tenant_id: 'tenant-a', email: 'member@test.invalid', organization_id: 'org-a', role_id: roleId }],
    organization: [{
      id: 'org-a',
      tenant_id: 'tenant-a',
      training_fund_balance: fundBalance,
      training_fund_allowed_role_ids: fundRoleIds,
      voucher_allowed_role_ids: voucherRoleIds,
    }],
    voucher: [{ id: 'voucher-a', organization_id: 'org-a', status: 'active', value: 25, expires_at: '2027-01-01', issued_at: '2026-01-01' }],
  };
  return {
    from(table) {
      const filters = [];
      let singular = false;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push((row) => row[key] === value); return query; },
        in(key, values) { filters.push((row) => values.includes(row[key])); return query; },
        single() { singular = true; return query; },
        maybeSingle() { singular = true; return query; },
        not() { return query; },
        order() { return query; },
        limit() { return query; },
        then(ok, fail) {
          const selected = (tables[table] || []).filter((row) => filters.every((filter) => filter(row)));
          return Promise.resolve({ data: singular ? selected[0] || null : selected, error: null }).then(ok, fail);
        },
        catch(fail) { return query.then((value) => value, fail); },
      };
      return query;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

const handler = await loadHandler();

async function invoke(body, dbOptions, { allowAfterExpiry = true } = {}) {
  const stripeCalls = [];
  globalThis[slot] = {
    db: makeDb(dbOptions),
    stripe: {
      paymentIntents: {
        create: async (payload) => {
          stripeCalls.push(payload);
          return { client_secret: 'pi_test_secret_fixture' };
        },
      },
    },
    allowAfterExpiry,
  };
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'fixture';
  const res = response();
  await handler({
    method: 'POST',
    headers: {},
    body: {
      event_id: 'event-a',
      ticket_class_id: 'ticket-a',
      attendee_count: 1,
      ...body,
    },
  }, res);
  return { res, stripeCalls };
}

for (const [label, credits, expectedMinor] of [
  ['neither credit', {}, 10000],
  ['voucher only', { selected_voucher_ids: ['voucher-a'] }, 7500],
  ['training fund only', { training_fund_amount: 30 }, 7000],
  ['voucher and training fund', { selected_voucher_ids: ['voucher-a'], training_fund_amount: 30 }, 4500],
]) {
  test(`creates exact Stripe amount for ${label}`, async () => {
    const { res, stripeCalls } = await invoke(credits);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.amount, expectedMinor);
    assert.equal(stripeCalls.length, 1);
    assert.equal(stripeCalls[0].amount, expectedMinor);
  });
}

test('binds authoritative credit deductions into Stripe metadata', async () => {
  const { stripeCalls } = await invoke({
    selected_voucher_ids: ['voucher-a'],
    training_fund_amount: 30,
  });
  assert.equal(stripeCalls[0].metadata.gross_total_minor, '10000');
  assert.equal(stripeCalls[0].metadata.training_fund_minor, '3000');
  assert.equal(stripeCalls[0].metadata.voucher_minor, '2500');
  assert.equal(stripeCalls[0].metadata.credit_member_id, 'member-a');
  assert.equal(stripeCalls[0].metadata.credit_organization_id, 'org-a');
  assert.equal(stripeCalls[0].metadata.credit_voucher_count, '1');
  assert.match(stripeCalls[0].metadata.credit_binding_sha256, /^[a-f0-9]{64}$/);
  assert.equal(stripeCalls[0].metadata.event_credit_voucher_ids, 'voucher-a');
  assert.equal(stripeCalls[0].metadata.event_credit_voucher_order_manual, 'false');
  assert.equal(stripeCalls[0].metadata.event_credit_training_fund_minor, '3000');
  assert.equal(stripeCalls[0].metadata.member_email, 'member@test.invalid');
  assert.equal(stripeCalls[0].receipt_email, 'member@test.invalid');
});

test('actual intent metadata satisfies the booking compensation verifier', async () => {
  const { stripeCalls } = await invoke({
    selected_voucher_ids: ['voucher-a'],
    training_fund_amount: 30,
  });
  let refunded = 0;
  const result = await compensateRejectedEventCreditPayment({
    paymentIntent: {
      id: 'pi_fixture',
      status: 'succeeded',
      metadata: stripeCalls[0].metadata,
      receipt_email: stripeCalls[0].receipt_email,
    },
    expectedIntentId: 'pi_fixture',
    tenantId: 'tenant-a',
    eventId: 'event-a',
    purchaserEmail: 'member@test.invalid',
    expectedCreditSnapshot: {
      voucherIds: ['voucher-a'],
      voucherOrderManual: false,
      trainingFundAmount: 30,
    },
    refundSucceeded: async () => { refunded += 1; },
  });
  assert.deepEqual(result, { ok: true, compensated: true, action: 'refunded' });
  assert.equal(refunded, 1);
});

test('rejects role-restricted and overdrawn credits without contacting Stripe', async () => {
  const restricted = await invoke(
    { selected_voucher_ids: ['voucher-a'] },
    { roleId: 'role-b', voucherRoleIds: ['role-a'] },
  );
  assert.equal(restricted.res.statusCode, 403);
  assert.equal(restricted.stripeCalls.length, 0);

  const overdrawn = await invoke(
    { training_fund_amount: 30 },
    { fundBalance: 20 },
  );
  assert.equal(overdrawn.res.statusCode, 400);
  assert.match(overdrawn.res.body.error, /Insufficient training fund/);
  assert.equal(overdrawn.stripeCalls.length, 0);
});

test('rejects invalid requested vouchers rather than silently charging full price', async () => {
  const { res, stripeCalls } = await invoke({ selected_voucher_ids: ['missing'] });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /invalid or unavailable/);
  assert.equal(stripeCalls.length, 0);
});

test('rejects a voucher that expires before the event when tenant policy requires it', async () => {
  const { res, stripeCalls } = await invoke(
    { selected_voucher_ids: ['voucher-a'] },
    {},
    { allowAfterExpiry: false },
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /expire before the event/);
  assert.equal(stripeCalls.length, 0);
});