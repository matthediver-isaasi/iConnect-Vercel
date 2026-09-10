import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeFormMembership,
  isDefinitiveInvoiceCreateRejection,
} from './formMembershipFinalize.js';

function scenario(invoiceState) {
  const progress = {
    status: 'created',
    history_id: 'history-1',
    table: 'member_membership_history',
    entity_id: 'member-1',
    invoice_state: invoiceState,
    invoice_claimed_at: invoiceState === 'processing' ? '2027-01-01T00:00:00.000Z' : null,
    settlement_state: 'blocked',
    workflow_state: 'done',
  };
  const submission = {
    id: 'submission-1',
    tenant_id: 'tenant-1',
    form_id: 'form-1',
    payment_provider: 'stripe',
    payment_reference: 'pi_form_1',
    payment_meta: {
      membership: { quote: { config_id: 'config-1', membership_year: '2027', target: 'member' } },
      membership_result: progress,
    },
  };
  const history = {
    id: 'history-1',
    tenant_id: 'tenant-1',
    member_id: 'member-1',
    accounting_provider: 'xero',
    accounting_invoice_id: 'invoice-1',
    accounting_invoice_number: 'INV-1',
  };
  const rpcCalls = [];
  const db = {
    rpcCalls,
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      Object.assign(progress, args.p_patch);
      return { data: { ok: true, membership_result: { ...progress } }, error: null };
    },
    from(table) {
      const q = {
        select() { return q; },
        eq() { return q; },
        maybeSingle: async () => ({ data: table.includes('membership_history') ? history : submission, error: null }),
      };
      return q;
    },
  };
  return { db, submission, progress };
}

for (const state of ['retry', 'processing']) {
  test(`finalizer resumes ${state} invoice progress from already-linked history`, async () => {
    const { db, submission, progress } = scenario(state);
    const result = await finalizeFormMembership({ supabase: db, submission });
    assert.equal(result.alreadyProcessed, undefined);
    assert.equal(result.invoiceState, 'done');
    assert.equal(progress.invoice_state, 'done');
    const recovery = db.rpcCalls.find((call) => call.args.p_patch?.invoice_state === 'done');
    assert.ok(recovery, 'expected exact progress CAS for recovered linkage');
    assert.equal(recovery.args.p_expected.invoice_state, state);
    if (state === 'processing') {
      assert.equal(recovery.args.p_expected.invoice_claimed_at, '2027-01-01T00:00:00.000Z');
    }
  });
}

test('only definitive create rejections are safely recreated after a fresh claim', () => {
  assert.equal(isDefinitiveInvoiceCreateRejection({ status: 400 }), true);
  assert.equal(isDefinitiveInvoiceCreateRejection({ response: { status: 422 } }), true);
  assert.equal(isDefinitiveInvoiceCreateRejection({ statusCode: 408 }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection({ status: 409 }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection({ response: { status: 429 } }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection({ code: 'ETIMEDOUT' }), false);
  assert.equal(isDefinitiveInvoiceCreateRejection(new Error('socket closed')), false);
});