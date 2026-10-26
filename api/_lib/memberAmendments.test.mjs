import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberAmendmentQuote, currentAmendmentBlockers } from './memberAmendmentQuote.js';
import { createMemberAmendmentsService, memberAmendmentQuoteFingerprint, normalizeAmendmentRequest } from './memberAmendments.js';
import { createMemberAmendmentsHandler } from '../membership/member-amendments.js';
import { amendmentFixture, uuid } from '../../scripts/test-support/member-amendment-fixtures.mjs';

const quote = (f, extra = {}) => buildMemberAmendmentQuote({ ...f, effectiveDate: f.today, ...extra });

test('quotes original full record, actual remaining days and independently rounded delta without mutation', () => {
  const f = amendmentFixture();
  const before = JSON.stringify(f);
  const q = quote(f);
  assert.deepEqual(q.originalFullTerm, { netMinor: 10000, vatMinor: 0, grossMinor: 10000 });
  assert.deepEqual(q.proration, {
    method: 'actual_utc_days_remaining_over_original_term', totalDays: 365, remainingDays: 183,
    rounding: 'nearest_minor_unit_per_net_and_vat_component',
  });
  assert.equal(q.originalRemaining.netMinor, 5014);
  assert.equal(q.targetRemaining.netMinor, 10027);
  assert.equal(q.delta.netMinor, 5013);
  assert.equal(q.status, 'pending_settlement');
  assert.equal(q.entitlementApplied, false);
  assert.equal(q.settlementStatus, 'not_started');
  assert.equal(q.sourceSnapshot, f.current);
  assert.equal(q.term.renewalDate, f.current.membership_renewal_date);
  assert.equal(JSON.stringify(f), before);
});

test('zero delta remains pending_application, negative delta is pending credit, never settled', () => {
  const f = amendmentFixture();
  const zero = quote(f, { config: { ...f.config, flat_cost: 100 } });
  assert.equal(zero.status, 'pending_application');
  assert.equal(zero.financialDirection, 'none');
  assert.match(zero.blockers[0], /explicit zero-difference settlement/);
  const credit = quote(f, { config: { ...f.config, flat_cost: 50 } });
  assert.equal(credit.financialDirection, 'credit');
  assert.equal(credit.status, 'pending_settlement');
});

test('leap year and final-day proration retain anniversary and exact integer minor units', () => {
  const f = amendmentFixture('2024-12-31');
  const q = quote(f);
  assert.equal(q.proration.totalDays, 366);
  assert.equal(q.proration.remainingDays, 1);
  assert.equal(q.originalRemaining.netMinor, 27);
  assert.equal(q.targetRemaining.netMinor, 55);
  assert.equal(q.delta.grossMinor, 28);
});

test('VAT comes only from exact saved tax type; missing tax cache blocks rather than zero fallback', () => {
  const f = amendmentFixture();
  const config = { ...f.config, flat_vat_rate: JSON.stringify({ taxType: 'OUTPUT', name: 'VAT 20%' }) };
  assert.throws(() => quote(f, { config }), /VAT cannot be resolved/);
  const q = quote(f, { config, vatSetting: { setting_value: JSON.stringify({ rates: [{ taxType: 'OUTPUT', effectiveRate: 20 }] }) } });
  assert.equal(q.targetFullTerm.vatMinor, 4000);
  assert.equal(q.targetRemaining.vatMinor, 2005);
});

test('target tiers need explicit own band, original evidence/terms/currency/monthly/discount rules fail closed', () => {
  const f = amendmentFixture();
  const cases = [
    { config: { ...f.config, currency: 'USD' } },
    { config: { ...f.config, is_active: false } },
    { config: { ...f.config, effective_to: '2020-01-01' } },
    { config: { ...f.config, billing_period: 'monthly' } },
    { config: { ...f.config, pricing_model: 'tiered' } },
    { discounts: [{ id: uuid(8) }] },
    { vatOverrides: [{ id: uuid(8) }] },
    { current: { ...f.current, commitment_snapshot: null } },
    { current: { ...f.current, total_with_vat: 99 } },
    { current: { ...f.current, billing_agreement_id: uuid(8) } },
    { current: { ...f.current, payment_status: 'unpaid' } },
    { current: { ...f.current, custom_discount_total: 1 } },
    { current: { ...f.current, prorata_cost: 50 } },
    { current: { ...f.current, term_end_date: '2026-12-30' } },
    { effectiveDate: '2026-02-30' },
    { effectiveDate: '2026-07-03' },
  ];
  for (const extra of cases) assert.throws(() => quote(f, extra), JSON.stringify(extra));
  assert.ok(currentAmendmentBlockers(null, f.today).length);
  const band = { id: uuid(9), tenant_id: f.tenantId, config_id: f.config.id, annual_cost: 150, vat_rate: null };
  const q = quote(f, { config: { ...f.config, pricing_model: 'tiered' }, band });
  assert.equal(q.targetFullTerm.netMinor, 15000);
  assert.throws(() => quote(f, { config: { ...f.config, pricing_model: 'tiered' }, band: { ...band, tenant_id: uuid(99) } }));
});

function mockDb(tables) {
  const reads = [];
  const db = {
    reads, rpcCalls: [],
    from(table) {
      const filters = [];
      let ordered = false;
      let range = null;
      const chain = {
        select() { return chain; },
        eq(field, value) { filters.push([field, value, 'eq']); return chain; },
        in(field, value) { filters.push([field, value, 'in']); return chain; },
        lte(field, value) { filters.push([field, value, 'lte']); return chain; },
        order(field) { assert.equal(field, 'id'); ordered = true; return chain; },
        range(start, end) { range = [start, end]; return chain; },
        maybeSingle() { return chain.then((result) => ({ ...result, data: result.data?.[0] || null })); },
        then(resolve) {
          reads.push({ table, filters, ordered, range });
          if (!(table in tables)) return Promise.resolve(resolve({ data: null, error: { code: '42P01' } }));
          let data = tables[table].filter((row) => filters.every(([field, value, op]) =>
            op === 'eq' ? row[field] === value : op === 'in' ? value.includes(row[field]) : row[field] <= value));
          if (ordered) data = data.toSorted((a, b) => a.id.localeCompare(b.id));
          if (range) data = data.slice(range[0], range[1] + 1);
          return Promise.resolve(resolve({ data, error: null }));
        },
      };
      return chain;
    },
    async rpc(name, args) { db.rpcCalls.push({ name, args }); return { data: { amendment: { quote: args.p_quote }, replayed: false } }; },
  };
  return db;
}
function serviceFixture() {
  const f = amendmentFixture();
  const tables = {
    member: [{ id: f.memberId, tenant_id: f.tenantId }],
    member_membership_history: [f.current], membership_tier_config: [f.config],
    membership_tier_band: [], membership_tier_discount: [], membership_tier_vat_override: [],
    system_settings: [], member_membership_amendment: [],
    member_membership_amendment_settlement: [], member_membership_amendment_application: [],
    member_membership_amendment_notification: [],
  };
  const db = mockDb(tables);
  const proof = {
    provider: 'xero', xeroTenantId: uuid(70), sourceInvoiceId: uuid(71),
    contactId: uuid(72), originalPaymentIds: [uuid(73)], originalPaidMinor: 10000,
    originalAmounts: { netMinor: 10000, vatMinor: 0, grossMinor: 10000 },
  };
  const finance = { verifyOriginal: async a => {
    assert.equal(a.tenant_id, f.tenantId);
    assert.equal(a.member_id, f.memberId);
    return structuredClone(proof);
  } };
  return { ...f, db, tables, proof, finance,
    service: createMemberAmendmentsService({ db, now: () => new Date(f.quotedAt), finance }) };
}

test('confirmation re-verifies original funding and rejects a changed payer or payment', async () => {
  for (const change of [
    proof => { proof.contactId = uuid(74); },
    proof => { proof.originalPaymentIds = [uuid(75)]; },
    proof => { proof.xeroTenantId = uuid(76); },
  ]) {
    const f = serviceFixture();
    const preview = await f.service.preview(f.tenantId, f.request);
    assert.equal(preview.quote.fundingEvidence.paidMinor, 10000);
    change(f.proof);
    await assert.rejects(f.service.create(f.tenantId, uuid(7), {
      ...f.request, expectedQuote: preview.expectedQuote, idempotencyKey: 'changed-payment',
    }), { code: 'quote_changed' });
    assert.equal(f.db.rpcCalls.length, 0);
  }
});

test('source provider failure blocks preview and creates no proposal', async () => {
  const f = serviceFixture();
  f.finance.verifyOriginal = async () => { throw Object.assign(new Error('Provider unavailable'), { status: 502 }); };
  await assert.rejects(f.service.preview(f.tenantId, f.request), { status: 502 });
  assert.equal(f.db.rpcCalls.length, 0);
});

test('service tenant-scopes every read, lists immutable current-term history and quotes through tracked RPC only', async () => {
  const f = serviceFixture();
  const list = await f.service.list(f.tenantId, f.memberId);
  assert.equal(list.current.id, f.current.id);
  assert.equal(list.capabilities.apply, true);
  assert.equal(list.capabilities.automatedCashRefund, false);
  const preview = await f.service.preview(f.tenantId, f.request);
  assert.equal(preview.canCreate, true);
  const created = await f.service.create(f.tenantId, uuid(7), { ...f.request, expectedQuote: preview.expectedQuote, idempotencyKey: 'request-123' });
  assert.equal(created.replayed, false);
  assert.equal(f.db.rpcCalls.length, 1);
  assert.equal(f.db.rpcCalls[0].name, 'propose_member_membership_amendment');
  for (const read of f.db.reads) assert.ok(read.filters.some(([key, value]) => key === 'tenant_id' && value === f.tenantId));
  await assert.rejects(f.service.list(uuid(99), f.memberId), /Member not found/);
});

test('preview and quote reject fixed-date or cadence-switch scope before proposal creation', async () => {
  for (const change of [
    f => { f.config.start_mode = 'fixed_date'; },
    f => { f.config.billing_period = 'monthly'; },
    f => { f.current.term_duration_months = 6; },
    f => { f.current.term_key = 'fixed:2026'; },
  ]) {
    const f = serviceFixture();
    change(f);
    const preview = await f.service.preview(f.tenantId, f.request);
    assert.equal(preview.canCreate, false);
    assert.equal(preview.quote, null);
    assert.equal(f.db.rpcCalls.length, 0);
  }
});

test('create replays exact payload before loading changed current config; reused key differs => conflict', async () => {
  const f = serviceFixture();
  const expectedQuote = (await f.service.preview(f.tenantId, f.request)).expectedQuote;
  const request = { ...normalizeAmendmentRequest(f.request), expectedQuote };
  f.tables.member_membership_amendment.push({
    tenant_id: f.tenantId, member_id: f.memberId, idempotency_key: 'request-123', request,
  });
  f.tables.membership_tier_config = [];
  assert.equal((await f.service.create(f.tenantId, uuid(7), { ...f.request, expectedQuote, idempotencyKey: 'request-123' })).replayed, true);
  await assert.rejects(f.service.create(f.tenantId, uuid(7), { ...f.request, expectedQuote, reason: 'Different', idempotencyKey: 'request-123' }), { status: 409 });
  assert.equal(f.db.rpcCalls.length, 0);
});

test('confirmation requires preview fingerprint and detects repricing; fingerprint ignores only quotedAt and key ordering', async () => {
  const f = serviceFixture();
  const preview = await f.service.preview(f.tenantId, f.request);
  const reordered = Object.fromEntries(Object.entries(preview.quote).reverse());
  assert.equal(memberAmendmentQuoteFingerprint({ ...reordered, quotedAt: 'different' }), preview.expectedQuote);
  await assert.rejects(f.service.create(f.tenantId, uuid(7), { ...f.request, idempotencyKey: 'request-123' }), { code: 'expected_quote_required' });
  f.config.flat_cost = 201;
  await assert.rejects(f.service.create(f.tenantId, uuid(7), { ...f.request, expectedQuote: preview.expectedQuote, idempotencyKey: 'request-123' }), { code: 'quote_changed', status: 409 });
  f.current.payment_status = 'unpaid';
  await assert.rejects(f.service.create(f.tenantId, uuid(7), { ...f.request, expectedQuote: preview.expectedQuote, idempotencyKey: 'request-123' }), { code: 'quote_changed', status: 409 });
  assert.equal(f.db.rpcCalls.length, 0);
});

test('paged history does not hide an overlapping current record beyond the PostgREST default page', async () => {
  const f = serviceFixture();
  f.tables.member_membership_history = Array.from({ length: 1100 }, (_, i) => ({
    ...f.current, id: uuid(100 + i), status: i === 0 || i === 1099 ? 'active' : 'expired',
  }));
  const response = await f.service.preview(f.tenantId, f.request);
  assert.equal(response.canCreate, false);
  assert.match(response.blockers[0], /Overlapping/);
  const pages = f.db.reads.filter((read) => read.table === 'member_membership_history');
  assert.deepEqual(pages.map((read) => read.range), [[0, 499], [500, 999], [1000, 1499]]);
  assert.ok(pages.every((read) => read.ordered));
});

test('list pages structures, bands and amendment history beyond default API row caps', async () => {
  const f = serviceFixture();
  f.tables.membership_tier_config = Array.from({ length: 1101 }, (_, i) => ({ ...f.config, id: uuid(100 + i) }));
  f.tables.membership_tier_band = Array.from({ length: 1101 }, (_, i) => ({
    id: uuid(2000 + i), tenant_id: f.tenantId, config_id: uuid(100 + i), annual_cost: 200,
  }));
  f.tables.member_membership_amendment = Array.from({ length: 1101 }, (_, i) => ({
    id: uuid(4000 + i), tenant_id: f.tenantId, member_id: f.memberId, source_record_id: f.current.id,
    created_at: f.quotedAt,
  }));
  const list = await f.service.list(f.tenantId, f.memberId);
  assert.equal(list.structures.length, 1101);
  assert.ok(list.structures.every((structure) => structure.bands.length === 1));
  assert.equal(list.history.length, 1101);
  assert.equal(list.currentTermHistory.length, 1101);
  for (const table of ['membership_tier_config', 'membership_tier_band', 'member_membership_amendment']) {
    assert.deepEqual(f.db.reads.filter((read) => read.table === table).map((read) => read.range),
      [[0, 499], [500, 999], [1000, 1499]]);
  }
});

test('migration absence is explicit; unsafe settlement and missing idempotency blocked', async () => {
  const f = serviceFixture();
  delete f.tables.member_membership_amendment;
  await assert.rejects(f.service.list(f.tenantId, f.memberId), { status: 503, code: 'migration_required' });
  assert.throws(() => normalizeAmendmentRequest({ ...f.request, settlementChoice: 'refund' }), /Only settlementChoice/);
  await assert.rejects(f.service.create(f.tenantId, uuid(7), f.request), { status: 400 });
});

async function callHandler(context, options = {}) {
  let called = false;
  const handler = createMemberAmendmentsHandler({
    db: {rpc:async()=>({error:{code:'PGRST202'}})}, getContext: async () => context, isAdmin: async () => options.admin !== false,
    hasFinance: async (...args) => { assert.deepEqual(args[2], context.memberExcludedFeatures || []); return options.finance !== false; },
    service: { list: async () => { called = true; return { ok: true }; } },
  });
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: options.method || 'GET', query: { memberId: uuid(2) }, body: options.body }, res);
  return { res, called };
}

test('endpoint requires authenticated matching tenant admin and finance permissions including member exclusions', async () => {
  const context = { isAuthenticated: true, tenantId: uuid(1), memberId: uuid(2), roleId: uuid(9), memberExcludedFeatures: ['commerce.monthly-finance-report'] };
  for (const [ctx, opts, status] of [
    [null, {}, 401], [{ ...context, tenantMismatch: true }, {}, 409],
    [context, { admin: false }, 403], [context, { finance: false }, 403],
    [{ ...context, tenantId: null }, {}, 403],
    [{ ...context, memberId: null }, {}, 403],
  ]) {
    const result = await callHandler(ctx, opts);
    assert.equal(result.res.statusCode, status);
    assert.equal(result.called, false);
  }
  assert.equal((await callHandler(context)).res.statusCode, 200);
  assert.equal((await callHandler(context, { method: 'POST', body: { action: 'apply' } })).res.statusCode, 400);
  assert.equal((await callHandler(context, { method: 'DELETE' })).res.statusCode, 405);
});

test('every settlement/application/recovery action retains server finance gate and audit identity', async () => {
  const context = { isAuthenticated: true, tenantId: uuid(1), tenantUserId: uuid(7), roleId: uuid(9) };
  const calls = [];
  const service = Object.fromEntries(['settle', 'reconcile', 'apply', 'notify'].map(action => [
    action, async (tenant, actor, input) => {
      calls.push({ action, tenant, actor, amendmentId: input.amendmentId });
      return { settlement: null, application: null, notifications: [] };
    },
  ]));
  const result = () => ({ statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } });
  for (const action of Object.keys(service)) {
    const req = { method: 'POST', body: { action, amendmentId: uuid(60), tenantId: uuid(99), actorId: uuid(99) } };
    const allowed = createMemberAmendmentsHandler({ db: {}, getContext: async () => context,
      isAdmin: async () => true, hasFinance: async () => true, service });
    const denied = createMemberAmendmentsHandler({ db: {}, getContext: async () => context,
      isAdmin: async () => true, hasFinance: async () => false, service });
    const deniedResponse = result();
    await denied(req, deniedResponse);
    assert.equal(deniedResponse.statusCode, 403);
    const response = result();
    await allowed(req, response);
    assert.equal(response.statusCode, 200);
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.tenant === context.tenantId && call.actor === context.tenantUserId));
});
