import test from 'node:test';
import assert from 'node:assert/strict';
import { bnmsOctoberRecovery, assertBnmsOctoberPreparation, runBnmsOctoberInvoice } from './accountingBnmsOctoberRecovery.js';

function fixture() {
  const row = { id: 'queue', tenant_id: 'ff2df806-b321-4254-b651-3af11fccf1db',
    provider: 'xero', source_type: 'gocardless_payment', operation: 'invoice', company_id: 'company',
    snapshot: {
      evidence: {
        ddAccountingMigration: { planId: 'plan', snapshot: {
          source: 'bnms_alpha_approved_existing_bank', revenue_account_code: '200',
        } },
        payment: { plan_id: 'plan', environment: 'live', status: 'confirmed', charge_date: '2026-10-06',
          gocardless_payment_id: 'PM-test', amount_minor: 1300, currency: 'GBP' },
      },
      invoice: { args: { idempotencyKey: 'old-inv', paymentIdempotencyKey: 'old-pay' } },
      payment: { collection: { reference: 'GoCardless DD: PM-test' } },
    },
    resolved_snapshot: { importedOctoberRecovery: true,
      invoice: { envelope: { operationKey: 'op-key', expected: { contactId: 'contact' } } },
      payment: { envelope: { operationKey: 'op-key' } } },
  };
  let operation = null;
  const calls = [];
  const db = {
    from() { return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: operation, error: null }; } }; },
    async rpc(name, args) {
      calls.push(name);
      if (name.endsWith('_claim_invoice')) {
        assert.equal(operation, null);
        operation = { id: 'op', claim_token: 'test-token', invoice_id: null, request_identity: args.p_identity };
        return { data: { id: 'op', token: 'test-token' } };
      }
      assert.equal(args.p_token, operation.claim_token);
      operation.invoice_id = args.p_invoice;
      return { data: { linked: true } };
    },
  };
  const adapter = {
    async assertBinding() { calls.push('binding'); },
    async createInvoice() { calls.push('post'); return { id: 'inv' }; },
    async readInvoice() { calls.push('read'); return { result: { id: 'inv' } }; },
    async discoverInvoice() { calls.push('discover'); return { outcome: 'found', result: { id: 'inv' } }; },
  };
  return { row, db, adapter, calls, setOperation(value) { operation = value; } };
}

for (const source of ['bnms_alpha_approved_existing_bank', 'bnms_manual_95_existing_bank']) {
  test(`${source}: October confirmed collection is not historical invoice backfill`, async () => {
    const f = fixture();
    f.row.snapshot.evidence.ddAccountingMigration.snapshot.source = source;
    assert.ok(await assertBnmsOctoberPreparation(f));
    assert.deepEqual(f.calls, []);
    const result = await runBnmsOctoberInvoice(f);
    assert.equal(result.id, 'inv');
    const prefix = source.startsWith('bnms_alpha') ? 'bnms_alpha' : 'bnms_manual';
    assert.deepEqual(f.calls, ['binding', `${prefix}_claim_invoice`, 'post', `${prefix}_link_invoice`]);
    f.calls.length = 0;
    await runBnmsOctoberInvoice(f);
    assert.deepEqual(f.calls, ['binding', 'read', `${prefix}_link_invoice`]);
  });
}

test('historical, future, failed, sandbox, wrong tenant and payment-only requests stay held', () => {
  for (const mutate of [
    r => r.snapshot.evidence.payment.charge_date = '2026-09-06',
    r => r.snapshot.evidence.payment.charge_date = '2026-11-06',
    r => r.snapshot.evidence.payment.status = 'failed',
    r => r.snapshot.evidence.payment.environment = 'sandbox',
    r => r.tenant_id = 'other',
    r => r.operation = 'payment',
    r => r.snapshot.evidence.ddAccountingMigration.planId = 'other',
  ]) {
    const { row } = fixture(); mutate(row);
    assert.throws(() => bnmsOctoberRecovery(row), /OUT_OF_SCOPE/);
  }
});
test('only the exact pre-invoice validation throttle can resolve legacy uncertainty', async () => {
  const f = fixture(), e = f.row.snapshot.evidence;
  e.legacyWriteUncertain = true;
  for (const error of [null, 'timeout', 'HTTP 429', '[Xero invoice-create] HTTP 429 (non-JSON response): ']) {
    e.payment.accounting_sync_error = error;
    assert.throws(() => bnmsOctoberRecovery(f.row), /LEGACY_WRITE_REQUIRES_REVIEW/);
  }
  e.payment.accounting_sync_error = '[Xero bnms-pilot-account-validation] HTTP 429 (non-JSON response): ';
  assert.ok(await assertBnmsOctoberPreparation(f));
  f.setOperation({ invoice_id: null });
  await assert.rejects(assertBnmsOctoberPreparation(f), /PRIOR_OPERATION/);
});
test('a legacy or different queue owner cannot create an invoice', async () => {
  const f = fixture();
  f.setOperation({ request_identity: { queueRequestId: 'other' } });
  await assert.rejects(runBnmsOctoberInvoice(f), /OWNER_MISMATCH/);
  assert.deepEqual(f.calls, ['binding']);
});
test('uncertain provider write discovers rather than posting again', async () => {
  const f = fixture();
  f.adapter.createInvoice = async () => { throw new Error('timeout'); };
  await assert.rejects(runBnmsOctoberInvoice(f), /timeout/);
  f.calls.length = 0;
  assert.equal((await runBnmsOctoberInvoice({ ...f, discover: true })).outcome, 'found');
  assert.deepEqual(f.calls, ['binding', 'discover', 'bnms_alpha_link_invoice']);
});
test('failed final ledger write remains an uncertain outcome', async () => {
  const f = fixture(), rpc = f.db.rpc;
  f.db.rpc = async (name, args) => name.endsWith('_link_invoice') ? { error: true } : rpc(name, args);
  await assert.rejects(runBnmsOctoberInvoice(f), error => {
    assert.equal(error.definitelyNotWritten, undefined);
    return /LINK_FAILED/.test(error.message);
  });
});
test('definite throttle rejection reuses its own ledger claim on retry', async () => {
  const f = fixture();
  let attempts = 0;
  f.adapter.createInvoice = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('rate limit'), {
      status: 429, definitelyNotWritten: true,
    });
    return { id: 'inv' };
  };
  await assert.rejects(runBnmsOctoberInvoice(f), error => error.definitelyNotWritten === true);
  assert.equal((await runBnmsOctoberInvoice(f)).id, 'inv');
  assert.equal(f.calls.filter(name => name === 'bnms_alpha_claim_invoice').length, 1);
});
