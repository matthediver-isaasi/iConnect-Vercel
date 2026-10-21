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
