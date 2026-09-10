import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFormInvoiceSettlementHandler, signSettlementPlan, verifySettlementPlan,
} from './form-invoice-settlement.js';

function fixture({ context, finance = true, submission, result } = {}) {
  const filters = [];
  const calls = [];
  const row = submission === null ? null : submission || {
    id: 'submission-1',
    payment_meta: {
      membership: { quote: { target: 'member' } },
      membership_result: { history_id: 'history-1', table: 'member_membership_history' },
    },
  };
  const preview = result || {
    invoice_id: 'invoice-1', invoice_number: 'INV-8896',
    stripe_payment_intent_id: 'pi_full_identifier', amount: 61, currency: 'GBP',
    account: '120', balance: 61, settlement_state: 'retry',
    provider_context: { xero_tenant_id: 'company-1' },
    payment_recorded: false, annotation_recorded: true,
  };
  const db = {
    from(table) {
      assert.equal(table, 'form_submission');
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        filter(key, op, value) { filters.push([key, value]); return query; },
        async maybeSingle() { return { data: row, error: null }; },
      };
      return query;
    },
  };
  const handler = createFormInvoiceSettlementHandler({
    db, getContext: async () => context || { isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1' },
    isAdmin: async (ctx) => ctx.admin !== false,
    hasFinance: async () => finance,
    signingSecret: () => 'test-signing-key',
    settle: async (args) => {
      calls.push(args);
      return args.dryRun ? { ...preview } : {
        ...preview, balance: 0, settlement_state: 'done', payment_recorded: true,
      };
    },
  });
  async function request(body = {}, method = 'POST') {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    await handler({
      method, body: {
        recordId: 'history-1', table: 'member_membership_history',
        expectedProviderContext: preview.provider_context, ...body,
      },
    }, res);
    return res;
  }
  return { request, calls, filters, preview };
}

test('recovery defaults to read-only and scopes the lookup to the session tenant', async () => {
  const f = fixture();
  const res = await f.request({ tenantId: 'attacker-tenant' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].dryRun, true);
  assert.equal(f.calls[0].tenantId, 'tenant-1');
  assert.ok(f.filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant-1'));
  assert.ok(res.body.planToken);
});

test('execution requires an authentic recent inspection and explicit exact account', async () => {
  const f = fixture();
  assert.equal((await f.request({ execute: true, expectedAccount: '120' })).statusCode, 409);
  const inspection = await f.request();
  const planToken = inspection.body.planToken;
  assert.equal((await f.request({ execute: true, planToken, expectedAccount: 'wrong' })).statusCode, 409);
  const repaired = await f.request({ execute: true, planToken, expectedAccount: '120' });
  assert.equal(repaired.statusCode, 200);
  assert.equal(repaired.body.result.settlement_state, 'done');
  assert.equal(f.calls.filter((args) => args.dryRun === false).length, 1);
});

test('changed provider evidence invalidates a signed inspection', async () => {
  const f = fixture();
  const { body } = await f.request();
  f.preview.balance = 20;
  const res = await f.request({ execute: true, planToken: body.planToken, expectedAccount: '120' });
  assert.equal(res.statusCode, 409);
  assert.equal(f.calls.filter((args) => !args.dryRun).length, 0);
});

test('accounting company confirmation is required even for traceability-only repair', async () => {
  const f = fixture();
  const { body } = await f.request();
  for (const expectedProviderContext of [undefined, { xero_tenant_id: 'different-company' }]) {
    const res = await f.request({ execute: true, planToken: body.annotationPlanToken, annotationOnly: true, expectedProviderContext });
    assert.equal(res.statusCode, 409);
  }
  assert.ok(f.calls.every((args) => args.dryRun));
});

test('independent annotation repair is allowed with missing clearing configuration, never requesting payment', async () => {
  const f = fixture({ result: {
    invoice_id: 'invoice-1', stripe_payment_intent_id: 'pi_full_identifier',
    provider_context: { xero_tenant_id: 'company-1' },
    account: null, balance: 61, settlement_state: 'blocked', error: 'Missing clearing account',
    payment_recorded: false, annotation_recorded: false,
  } });
  const { body } = await f.request();
  const res = await f.request({ execute: true, planToken: body.annotationPlanToken, annotationOnly: true });
  assert.equal(res.statusCode, 200);
  const execution = f.calls.find((args) => !args.dryRun);
  assert.equal(execution.annotationOnly, true);
  assert.equal(execution.expectedAccount, undefined);
});

test('signed annotation-only authority cannot be escalated into payment settlement', async () => {
  const f = fixture();
  const { body } = await f.request({ annotationOnly: true });
  assert.equal(body.annotationPlanToken, undefined);
  const escalated = await f.request({ execute: true, planToken: body.planToken, expectedAccount: '120' });
  assert.equal(escalated.statusCode, 409);
  assert.ok(f.calls.every((args) => args.dryRun));
  const annotation = await f.request({ execute: true, planToken: body.planToken, annotationOnly: true });
  assert.equal(annotation.statusCode, 200);
  assert.equal(f.calls.find((args) => !args.dryRun).annotationOnly, true);
});

test('missing configuration is visible and cannot execute', async () => {
  const f = fixture({ result: { account: null, settlement_state: 'blocked', error: 'Configure the Stripe clearing account' } });
  const { body } = await f.request();
  assert.match(body.result.error, /clearing account/);
  assert.equal((await f.request({ execute: true, planToken: body.planToken, expectedAccount: '120' })).statusCode, 409);
  assert.ok(f.calls.every((args) => args.dryRun));
});

test('auth, finance permission, cross-tenant absence, and linkage errors fail before provider reads', async () => {
  for (const [options, code] of [
    [{ context: { isAuthenticated: false } }, 401],
    [{ context: { isAuthenticated: true, tenantId: 'tenant-1', admin: false } }, 403],
    [{ finance: false }, 403],
    [{ submission: null }, 404],
  ]) {
    const f = fixture(options);
    assert.equal((await f.request()).statusCode, code);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.request({ table: 'organisation_membership_history' })).statusCode, 409);
  assert.equal(f.calls.length, 0);
});

test('targeted originating submission lookup is supported, while malformed execute never writes', async () => {
  const f = fixture();
  const res = await f.request({ submissionId: 'submission-1', recordId: undefined, table: undefined });
  assert.equal(res.statusCode, 200);
  assert.ok(f.filters.some(([key, value]) => key === 'id' && value === 'submission-1'));
  assert.equal((await f.request({ execute: 'true' })).statusCode, 400);
  assert.equal((await f.request({}, 'GET')).statusCode, 405);
  assert.ok(f.calls.every((args) => args.dryRun));
});

test('preview signatures reject tampering, changed scope, expiry and future timestamps', () => {
  const now = 1_800_000_000_000;
  const token = signSettlementPlan('tenant:invoice:account', 'key', now);
  assert.equal(verifySettlementPlan(token, 'tenant:invoice:account', 'key', now), true);
  assert.equal(verifySettlementPlan(token, 'other:invoice:account', 'key', now), false);
  assert.equal(verifySettlementPlan(token, 'tenant:invoice:account', 'wrong', now), false);
  assert.equal(verifySettlementPlan(token, 'tenant:invoice:account', 'key', now + 16 * 60_000), false);
  assert.equal(verifySettlementPlan(token, 'tenant:invoice:account', 'key', now - 1), false);
  assert.equal(verifySettlementPlan('bad', 'tenant:invoice:account', 'key', now), false);
});