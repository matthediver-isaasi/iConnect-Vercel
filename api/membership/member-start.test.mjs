import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberStartHandler } from './member-start.js';
import { createMemberStartService } from '../_lib/memberStart.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { isAuthenticated: true, tenantId: id(1), tenantUserId: id(2), roleId: id(3) };
const response = () => ({ code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

test('all discovery, confirmation and resume actions require tenant admin and finance authorization', async () => {
  for (const scenario of [
    { ctx: null, code: 401 }, { ctx: { ...context, tenantMismatch: true }, code: 409 },
    { ctx: context, admin: false, code: 403 }, { ctx: context, finance: false, code: 403 },
  ]) {
    const res = response();
    const handler = createMemberStartHandler({ db: {}, getContext: async () => scenario.ctx,
      isAdmin: async () => scenario.admin !== false, hasFinance: async () => scenario.finance !== false,
      service: { list() { assert.fail('unauthorized service invocation'); } } });
    await handler({ method: 'GET', query: { memberId: id(4) } }, res);
    assert.equal(res.code, scenario.code);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});
test('resume accepts only a member/request identity and returns pending without claiming payment', async () => {
  const res = response();
  const handler = createMemberStartHandler({ db: {}, getContext: async () => context, isAdmin: async () => true, hasFinance: async () => true,
    service: { async resume(tenantId, input) {
      assert.equal(tenantId, context.tenantId);
      assert.deepEqual(input, { memberId: id(4), requestId: id(5) });
      return { accounting_pending: true, record: { payment_status: 'unpaid' } };
    } } });
  await handler({ method: 'POST', body: { action: 'resume', memberId: id(4), requestId: id(5), paymentMode: 'free' } }, res);
  assert.equal(res.code, 202);
  assert.equal(res.body.record.payment_status, 'unpaid');
});
function fixture() {
  const saved = { id: id(5), tenant_id: id(1), member_id: id(4), record_id: id(6), actor_id: id(2),
    request: { memberId: id(4), paymentMode: 'invoice', reason: 'Approved new purchase' },
    quote: { invoice: { provider: 'xero', organizationName: 'Member', invoicingEmail: 'member@example.invalid' }, totalWithVat: 100,
      finalCost: 100, vatAmount: 0, currency: 'GBP', membershipYear: 'rolling:2026-01-01', tierLabel: 'Selected' } };
  const record = { id: id(6), tenant_id: id(1), member_id: id(4), payment_status: 'unpaid', status: 'pending_payment_setup' };
  const tables = { member_membership_start: [saved], member_membership_history: [record] };
  const db = { from(table) {
    const filters = [];
    return { select() { return this; }, eq(k, v) { filters.push([k, v]); return this; },
      async maybeSingle() { return { data: (tables[table] || []).find(row => filters.every(([k, v]) => row[k] === v)) || null, error: null }; } };
  } };
  return { db, saved, record };
}
test('saved-request resume is tenant/member bound, uses original invoice quote, and never inserts history', async () => {
  const { db, saved } = fixture();
  const calls = [];
  const service = createMemberStartService({ db, invoice: async payload => { calls.push(payload); return { accounting_request_id: id(7), accounting_pending: true }; } });
  await assert.rejects(service.resume(id(9), { memberId: id(4), requestId: id(5) }), /not found/);
  await assert.rejects(service.resume(id(1), { memberId: id(9), requestId: id(5) }), /not found/);
  const a = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  const b = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  assert.equal(a.record.id, b.record.id);
  assert.equal(a.request.status, 'accounting_pending');
  assert.equal(calls[0].args.accountingSource.sourceId, saved.record_id);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].args.accountingSource.totalMinor, 10000);
  assert.equal(calls[0].provider, 'xero');
});
test('provider ambiguity keeps durable history unpaid, surfaces review and resumes same source', async () => {
  const { db, record } = fixture();
  let calls = 0;
  const service = createMemberStartService({ db, invoice: async () => { calls++; throw new Error('provider timeout'); } });
  const result = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  assert.equal(result.reconciliation_required, true);
  assert.equal(result.record, record);
  assert.equal(record.payment_status, 'unpaid');
  assert.equal(calls, 1);
});
test('zero-due resume dispatches existing paid workflow and reports failed delivery as pending', async () => {
  const { db, saved, record } = fixture();
  saved.request.paymentMode = 'free'; record.payment_status = 'paid';
  const service = createMemberStartService({ db, invoice: () => assert.fail('free must not invoice'),
    fireFree: async ({ row, source }) => { assert.equal(row.id, record.id); assert.equal(source, 'admin_member_start_free'); throw new Error('delivery interrupted'); } });
  const result = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  assert.equal(result.request.status, 'notification_pending');
  assert.equal(result.record.payment_status, 'paid');
});
for (const paymentMode of ['stripe_upfront', 'stripe_monthly', 'direct_debit', 'member_choice']) test(`${paymentMode}: admin resume/reload returns the same canonical member link without initiating any provider effect`, async () => {
  const { db, saved, record } = fixture();
  saved.request.paymentMode = paymentMode;
  const link = { token: 'stable-member-link' };
  const originalFrom = db.from;
  db.from = table => table === 'membership_fee_token' ? {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: link, error: null }; },
  } : originalFrom(table);
  const service = createMemberStartService({ db, invoice: () => assert.fail('member must authorize the provider payment') });
  const first = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  const reloaded = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  assert.equal(first.paymentUrl, '/membership-fees/stable-member-link');
  assert.equal(reloaded.request.paymentUrl, first.paymentUrl);
  assert.equal(first.request.paymentMode, paymentMode);
  assert.equal(first.request.status, 'awaiting_member_authorization');
  if (paymentMode === 'member_choice') {
    link.cost_breakdown = { memberStart: { quote: { paymentMode: 'stripe_monthly' } } };
    assert.equal((await service.resume(id(1), { memberId: id(4), requestId: id(5) })).request.paymentMode, 'stripe_monthly');
  }
  assert.equal(record.payment_status, 'unpaid');
  record.billing_agreement_id = id(7);
  const inFlight = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  assert.equal(inFlight.request.status, 'pending_payment');
  record.payment_status = 'paid';
  assert.equal((await service.resume(id(1), { memberId: id(4), requestId: id(5) })).request.status, 'completed');
  record.payment_status = 'unpaid';
  link.expires_at = '2020-01-01T00:00:00Z';
  const expired = await service.resume(id(1), { memberId: id(4), requestId: id(5) });
  assert.equal(expired.request.status, 'reconciliation_required');
  assert.equal(expired.reconciliation_required, true);
  assert.equal(expired.paymentUrl, first.paymentUrl);
});
test('list/preview require versioned database payment authority and show explicit unavailability without affecting invoice/free', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const config = { id: id(3), tenant_id: id(1), structure_scope_type: 'member', is_active: true,
    billing_period: 'annual', start_mode: 'immediate', effective_from: '2020-01-01', pricing_model: 'flat',
    currency: 'GBP', flat_cost: 100, online_card_payment: true, card_monthly_enabled: true,
    dd_enabled: true, dd_monthly_amount: 10, dd_instalment_count: 10, dd_auto_renew: false };
  let ready = false;
  const db = {
    async rpc(name) {
      if (name === 'member_start_payment_capabilities') return ready
        ? { data: { version: ready === 2 ? 2 : 1, memberChoice: ready === 2 }, error: null } : { error: { code: 'PGRST202' } };
      assert.equal(name, 'member_start_state');
      return { data: { member: { id: id(4), email: 'member@example.test' }, blockers: [], fingerprint: 'unchanged' }, error: null };
    },
    from(table) {
      const rows = table === 'membership_tier_config' ? [config] : [];
      const chain = { select() { return chain; }, eq() { return chain; }, order() { return chain; }, range() { return chain; },
        async maybeSingle() { return { data: rows[0] || null, error: null }; },
        then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); } };
      return chain;
    },
  };
  const service = createMemberStartService({ db, queueEnabled: () => true, getProvider: async () => ({ name: 'xero' }),
    stripeCredentials: async () => ({ is_enabled: true, secret_key: 'isolated', publishable_key: 'isolated' }),
    ddCredentials: async () => ({ accessToken: 'isolated' }), address: async () => null, nominal: async () => null });
  const unavailable = await service.list(id(1), id(4));
  assert.deepEqual(unavailable.structures[0].paymentModes, ['invoice']);
  assert.match(unavailable.structures[0].paymentOptions.find(p => p.mode === 'stripe_upfront').reason, /migration is required/);
  const preview = await service.preview(id(1), { memberId: id(4), configId: id(3), paymentMode: 'stripe_upfront', startDate: today, reason: 'Explicit new purchase' });
  assert.equal(preview.canCreate, false);
  ready = true;
  const available = await service.list(id(1), id(4));
  assert.deepEqual(available.structures[0].paymentModes, ['stripe_upfront', 'stripe_monthly', 'direct_debit', 'invoice']);
  assert.equal(available.capabilities.paymentAuthorityVersion, 1);
  const input = { memberId: id(4), configId: id(3), paymentMode: 'member_choice', startDate: today, reason: 'Member chooses a frozen payment quote' };
  await assert.rejects(service.preview(id(1), input), { code: 'migration_required' });
  ready = 2;
  const choicePreview = await service.preview(id(1), input);
  assert.equal(choicePreview.canCreate, true, JSON.stringify(choicePreview));
  assert.equal(choicePreview.quote.paymentMode, 'member_choice');
  assert.deepEqual(choicePreview.quote.paymentChoices.map(p => p.mode), ['stripe_upfront', 'stripe_monthly', 'direct_debit']);
  assert.deepEqual(choicePreview.quote.paymentChoices.map(p => p.quote.totalWithVat), [100, 100, 100]);
  const originalFingerprint = choicePreview.expectedQuote;
  config.dd_monthly_amount = 15;
  const changed = await service.preview(id(1), input);
  assert.notEqual(changed.expectedQuote, originalFingerprint);
  assert.deepEqual(changed.quote.paymentChoices.map(p => p.quote.totalWithVat), [100, 150, 150]);
  config.online_card_payment = false;
  config.card_monthly_enabled = false;
  const ddOnly = await service.preview(id(1), input);
  assert.deepEqual(ddOnly.quote.paymentChoices.map(p => p.mode), ['direct_debit']);
  config.dd_enabled = false;
  assert.equal((await service.preview(id(1), input)).canCreate, false);
});
