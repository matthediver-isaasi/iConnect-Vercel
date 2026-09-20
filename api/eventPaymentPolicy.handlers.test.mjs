import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

// These tests execute the real HTTP handlers. Only external/module boundaries
// are replaced, following the isolated handler convention used by this project.
const slot = '__eventPaymentPolicyHandlerFixture';
const importPattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g;
const handlers = {};
const synchronousDependencies = new Set([
  'getTicketClassFromConfig',
  'isTicketVisibleToUser',
  'ticketHasAccessRestrictions',
  'resolveTicketPrice',
  'normalizeRequestedVoucherIds',
]);

async function loadHandler(path) {
  const source = await readFile(path, 'utf8');
  const replacements = new Map();
  for (const [, names, specifier] of source.matchAll(importPattern)) {
    if (specifier.startsWith('node:') || specifier === 'crypto') continue;
    if (/\/eventPaymentPolicy(?:Compensation)?\.js$/.test(specifier)) continue;
    if (specifier === 'stripe') {
      replacements.set(specifier, `export default class StripeProxy { constructor(...args) { return new globalThis.${slot}.Stripe(...args); } }`);
      continue;
    }
    const exports = [];
    if (names.trim().startsWith('{')) {
      for (const entry of names.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)) {
        const [name] = entry.split(/\s+as\s+/);
        if (name === 'supabase') {
          exports.push(`export const ${name} = { from: (...args) => globalThis.${slot}.db.from(...args), rpc: (...args) => globalThis.${slot}.db.rpc(...args) };`);
        } else if (synchronousDependencies.has(name)) {
          exports.push(`export function ${name}(...args) { return globalThis.${slot}.dependency(${JSON.stringify(name)}, args); }`);
        } else {
          exports.push(`export async function ${name}(...args) { return globalThis.${slot}.dependency(${JSON.stringify(name)}, args); }`);
        }
      }
    } else {
      replacements.set(specifier, `export default (...args) => globalThis.${slot}.dependency(${JSON.stringify(names.trim())}, args);`);
      continue;
    }
    replacements.set(specifier, exports.join('\n'));
  }

  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'event-payment-policy-handler-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (replacements.has(args.path)) return { path: args.path, namespace: 'fixture' };
          if (args.path === '@supabase/supabase-js') return { path: args.path, namespace: 'fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          loader: 'js',
          contents: args.path === '@supabase/supabase-js'
            ? `export const createClient = () => globalThis.${slot}.db;`
            : replacements.get(args.path),
        }));
      },
    }],
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  return (await import(`data:text/javascript;base64,${encoded}`)).default;
}

function fixture({
  voucher = true,
  trainingFund = true,
  omitSettings = false,
  settingsData = 'normal',
  settingTenant = 'tenant-a',
  requestTenant = 'tenant-a',
  extraSettings = [],
  authenticatedMember = { id: 'member-a', tenant_id: 'tenant-a', email: 'member@example.test', organization_id: null },
  paymentIntent = null,
  refundFails = false,
} = {}) {
  const event = { id: 'event-a', tenant_id: 'tenant-a', title: 'Event', status: 'published', event_state: 'active' };
  const settings = omitSettings ? [] : [
    { tenant_id: settingTenant, setting_key: 'event_allow_voucher_payment', setting_value: String(voucher) },
    { tenant_id: settingTenant, setting_key: 'event_allow_training_fund_payment', setting_value: String(trainingFund) },
    ...extraSettings,
  ];
  const rows = {
    event: [event],
    complex_event: [event],
    system_settings: settings,
    member: authenticatedMember ? [authenticatedMember] : [],
    organization: [],
    booking: [],
    complex_event_booking: [],
    complex_event_ticket_class: [],
  };
  const calls = [];
  const effects = [];
  const db = {
    from(table) {
      calls.push({ table, action: 'from' });
      let filters = [];
      let singular = false;
      let write = null;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push((row) => row[key] === value); return query; },
        ilike(key, value) { filters.push((row) => String(row[key] || '').toLowerCase() === String(value).toLowerCase()); return query; },
        in(key, values) { filters.push((row) => values.includes(row[key])); return query; },
        limit() { return query; },
        single() { singular = true; return query; },
        maybeSingle() { singular = true; return query; },
        insert(value) { write = { action: 'insert', value }; effects.push({ table, ...write }); return query; },
        update(value) { write = { action: 'update', value }; effects.push({ table, ...write }); return query; },
        delete() { write = { action: 'delete' }; effects.push({ table, ...write }); return query; },
        then(ok, fail) {
          if (table === 'system_settings' && settingsData === 'error') {
            return Promise.resolve({ data: null, error: new Error('settings unavailable') }).then(ok, fail);
          }
          if (table === 'system_settings' && settingsData === 'undefined') {
            return Promise.resolve({ data: undefined, error: null }).then(ok, fail);
          }
          const selected = (rows[table] || []).filter((row) => filters.every((filter) => filter(row)));
          return Promise.resolve({
            data: singular ? selected[0] || null : selected,
            error: null,
          }).then(ok, fail);
        },
        catch(fail) { return query.then((value) => value, fail); },
      };
      return query;
    },
  };

  const state = {
    db,
    calls,
    effects,
    providerCalls: 0,
    Stripe: class {
      constructor() { state.providerCalls += 1; }
      paymentIntents = {
        create: async (params) => {
          state.providerCalls += 1;
          state.createdPaymentIntentParams = params;
          return { id: 'pi-test', client_secret: 'pi-test_secret-test' };
        },
        retrieve: async () => {
          state.providerCalls += 1;
          return paymentIntent;
        },
        cancel: async () => {
          state.providerCalls += 1;
          if (refundFails) throw new Error('cancel failed');
          return {};
        },
      };
      refunds = {
        create: async () => {
          state.providerCalls += 1;
          if (refundFails) throw new Error('refund failed');
          return {};
        },
      };
    },
    dependency(name, args = []) {
      if (name === 'resolveTenantFromRequest') return { id: requestTenant };
      if (name === 'getTenantContext') return { tenantId: requestTenant };
      if (name === 'getStripeCredentials') {
        state.providerCalls += 1;
        return { secret_key: 'sk_test_fixture', publishable_key: 'pk_test_fixture', is_enabled: true };
      }
      if (name === 'findOrCreateStripeCustomer') return { id: 'cus-fixture' };
      if (name === 'getSessionMember') return authenticatedMember;
      if (name === 'normalizeRequestedVoucherIds') return args[0] || [];
      if (name === 'getTicketClassFromConfig') return null;
      if (name === 'isTicketVisibleToUser') return true;
      if (name === 'ticketHasAccessRestrictions') return false;
      if (name === 'resolveTicketPrice') return { found: false, price: 0, currency: 'gbp' };
      throw new Error(`Unexpected dependency before policy rejection: ${name}`);
    },
  };
  state.fetch = async (url, options = {}) => {
    state.providerCalls += 1;
    if (String(url).includes('/payment_intents/') && (!options.method || options.method === 'GET')) {
      return { ok: true, json: async () => paymentIntent };
    }
    if (refundFails) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return state;
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

async function invoke(kind, state, body) {
  globalThis[slot] = state;
  globalThis.fetch = (...args) => globalThis[slot].fetch(...args);
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'fixture-key';
  const path = kind === 'simple'
    ? resolve('api/functions/[functionName].js')
    : resolve(`api/public/${kind}.js`);
  handlers[kind] ||= await loadHandler(path);
  const req = {
    method: 'POST',
    query: kind === 'simple' ? { functionName: body.functionName || 'createOneOffEventBooking' } : {},
    headers: { host: 'fixture.invalid' },
    body,
  };
  const res = response();
  await handlers[kind](req, res);
  return res;
}

const mixedSimple = {
  eventId: 'event-a',
  memberEmail: 'member@example.test',
  attendees: [{ email: 'member@example.test', first_name: 'Member', last_name: 'Test' }],
  ticketsRequired: 1,
  totalCost: 20,
  paymentMethod: 'card',
  selectedVoucherIds: ['voucher-a'],
  trainingFundAmount: 5,
};
const mixedComplex = {
  event_id: 'event-a',
  payment_method: 'card',
  selected_voucher_ids: ['voucher-a'],
  training_fund_amount: 5,
  items: [{ ticket_class_id: 'ticket-a', attendees: [{ email: 'member@example.test' }] }],
};

for (const [label, config, expected] of [
  ['both disabled', { voucher: false, trainingFund: false }, /Voucher payment/],
  ['voucher disabled', { voucher: false, trainingFund: true }, /Voucher payment/],
  ['training fund disabled', { voucher: true, trainingFund: false }, /Training fund payment/],
]) {
  test(`simple booking rejects mixed credits when ${label} before writes/providers`, async () => {
    const state = fixture(config);
    const res = await invoke('simple', state, mixedSimple);
    assert.match(res.body.error, expected);
    assert.deepEqual(state.effects, []);
    assert.equal(state.providerCalls, 0);
  });

  test(`complex booking rejects mixed credits when ${label} before writes/providers`, async () => {
    const state = fixture(config);
    const res = await invoke('complex-event-booking', state, mixedComplex);
    assert.match(res.body.error, expected);
    assert.deepEqual(state.effects, []);
    assert.equal(state.providerCalls, 0);
  });
}

test('all four policy combinations and absent defaults are enforced by real payment initiation handler', async () => {
  const cases = [
    { voucher: false, trainingFund: false, allowed: false },
    { voucher: false, trainingFund: true, allowed: false },
    { voucher: true, trainingFund: false, allowed: false },
    { voucher: true, trainingFund: true, allowed: true },
    { omitSettings: true, allowed: true },
  ];
  for (const config of cases) {
    const state = fixture(config);
    const res = await invoke('simple', state, {
      functionName: 'createStripePaymentIntent',
      amount: 10,
      metadata: { event_id: 'event-a' },
      selectedVoucherIds: ['voucher-a'],
      trainingFundAmount: 5,
    });
    assert.equal(state.providerCalls > 0, config.allowed, JSON.stringify(res.body));
    assert.deepEqual(state.effects, []);
  }
});

test('simple payment initiation binds tenant, purchaser and original credits in Stripe metadata', async () => {
  const state = fixture();
  const res = await invoke('simple', state, {
    functionName: 'createStripePaymentIntent',
    amount: 10,
    memberEmail: 'MEMBER@example.test',
    metadata: { event_id: 'event-a', tenant_id: 'attacker-tenant' },
    selectedVoucherIds: ['voucher-b', 'voucher-a'],
    voucherOrderManual: true,
    trainingFundAmount: 5.125,
  });
  assert.equal(res.body.success, true);
  assert.deepEqual(state.createdPaymentIntentParams.metadata, {
    event_id: 'event-a',
    tenant_id: 'tenant-a',
    member_email: 'member@example.test',
    event_credit_voucher_ids: 'voucher-a,voucher-b',
    event_credit_voucher_order_manual: 'true',
    event_credit_training_fund_minor: '513',
  });
});

test('complex payment initiation rejects disabled mixed credits before Stripe', async () => {
  const state = fixture({ voucher: false, trainingFund: false });
  const res = await invoke('complex-event-payment-intent', state, {
    event_id: 'event-a',
    ticket_class_id: 'ticket-a',
    selected_voucher_ids: ['voucher-a'],
    training_fund_amount: 5,
  });
  assert.match(res.body.error, /Voucher payment/);
  assert.equal(state.providerCalls, 0);
  assert.deepEqual(state.effects, []);
});

test('no-credit bookings do not read event-credit policy settings', async () => {
  const simpleState = fixture({ settingsData: 'error' });
  const simpleRes = await invoke('simple', simpleState, {
    ...mixedSimple,
    memberEmail: 'missing@example.test',
    selectedVoucherIds: [],
    trainingFundAmount: 0,
  });
  assert.match(simpleRes.body.error, /Member not found/);
  assert.equal(simpleState.calls.some((call) => call.table === 'system_settings'), false);

  const complexState = fixture({ settingsData: 'error' });
  const complexRes = await invoke('complex-event-booking', complexState, {
    ...mixedComplex,
    selected_voucher_ids: [],
    training_fund_amount: 0,
  });
  assert.match(complexRes.body.error, /Invalid ticket class/);
  assert.equal(complexState.calls.some((call) => call.table === 'system_settings'), false);
});

function paidIntent(overrides = {}) {
  return {
    id: 'pi-credit-race',
    status: 'succeeded',
    amount: 1000,
    currency: 'gbp',
    receipt_email: 'member@example.test',
    metadata: {
      tenant_id: 'tenant-a',
      event_id: 'event-a',
      member_email: 'member@example.test',
      event_credit_voucher_ids: 'voucher-a',
      event_credit_voucher_order_manual: 'false',
      event_credit_training_fund_minor: '500',
    },
    ...overrides,
  };
}

for (const kind of ['simple', 'complex-event-booking']) {
  test(`${kind} safely refunds a bound paid intent after a policy race`, async () => {
    const state = fixture({
      voucher: false,
      trainingFund: false,
      paymentIntent: paidIntent(),
    });
    const body = kind === 'simple'
      ? { ...mixedSimple, stripePaymentIntentId: 'pi-credit-race' }
      : { ...mixedComplex, stripe_payment_intent_id: 'pi-credit-race' };
    const res = await invoke(kind, state, body);
    assert.equal(res.body.refunded, true, JSON.stringify(res.body));
    assert.match(res.body.error, /automatically refunded/);
    assert.deepEqual(state.effects, []);
    assert.ok(state.providerCalls >= 2);
  });

  test(`${kind} exposes compensation failure without mutating credits or bookings`, async () => {
    const state = fixture({
      voucher: false,
      trainingFund: false,
      paymentIntent: paidIntent(),
      refundFails: true,
    });
    const body = kind === 'simple'
      ? { ...mixedSimple, stripePaymentIntentId: 'pi-credit-race' }
      : { ...mixedComplex, stripe_payment_intent_id: 'pi-credit-race' };
    const res = await invoke(kind, state, body);
    assert.equal(res.body.refund_failed, true);
    assert.match(res.body.error, /could not be automatically reversed/);
    assert.deepEqual(state.effects, []);
  });
}

test('invented credits cannot refund an otherwise bound simple-event payment', async () => {
  const state = fixture({
    voucher: false,
    trainingFund: false,
    paymentIntent: paidIntent({
      metadata: {
        ...paidIntent().metadata,
        event_credit_voucher_ids: '',
        event_credit_training_fund_minor: '0',
      },
    }),
  });
  const res = await invoke('simple', state, {
    ...mixedSimple,
    stripePaymentIntentId: 'pi-credit-race',
  });
  assert.equal(res.body.refund_failed, true);
  assert.match(res.body.error, /could not be automatically reversed/);
  // Stripe client + retrieval occurred, but no refund provider call.
  assert.equal(state.providerCalls, 3);
  assert.deepEqual(state.effects, []);
});

for (const settingsData of ['error', 'undefined']) {
  test(`real booking handlers fail closed on ${settingsData} settings response`, async () => {
    for (const [kind, body] of [['simple', mixedSimple], ['complex-event-booking', mixedComplex]]) {
      const state = fixture({ settingsData });
      const res = await invoke(kind, state, body);
      assert.match(res.body.error, /temporarily unavailable/);
      assert.equal(state.providerCalls, 0);
      assert.deepEqual(state.effects, []);
    }
  });
}

test('settings from another tenant cannot disable the request tenant', async () => {
  const state = fixture({
    voucher: false,
    trainingFund: false,
    settingTenant: 'tenant-b',
    requestTenant: 'tenant-a',
  });
  const res = await invoke('simple', state, {
    functionName: 'createStripePaymentIntent',
    amount: 10,
    metadata: { event_id: 'event-a' },
    selectedVoucherIds: ['voucher-a'],
    trainingFundAmount: 5,
  });
  assert.equal(res.body.success, true, JSON.stringify(res.body));
  assert.ok(state.providerCalls > 0);
});

test('settings from another tenant cannot authorize methods disabled for the request tenant', async () => {
  const state = fixture({
    voucher: false,
    trainingFund: false,
    settingTenant: 'tenant-a',
    requestTenant: 'tenant-a',
    extraSettings: [
      { tenant_id: 'tenant-b', setting_key: 'event_allow_voucher_payment', setting_value: 'true' },
      { tenant_id: 'tenant-b', setting_key: 'event_allow_training_fund_payment', setting_value: 'true' },
    ],
  });
  const res = await invoke('simple', state, {
    functionName: 'createStripePaymentIntent',
    amount: 10,
    metadata: { event_id: 'event-a' },
    selectedVoucherIds: ['voucher-a'],
    trainingFundAmount: 5,
  });
  assert.match(res.body.error, /Voucher payment is not enabled/);
  assert.equal(state.providerCalls, 0);
});

test('existing allocation refund authorization guard remains unchanged', async () => {
  const source = await readFile(resolve('api/public/complex-event-booking.js'), 'utf8');
  assert.match(source, /refundBoundAllocationPayment/);
  assert.match(source, /runAuthorizedCardCompensation/);
  assert.match(source, /cardPaymentAuthorizedForCompensation/);
});