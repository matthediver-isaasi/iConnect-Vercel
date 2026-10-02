import test from 'node:test';
import assert from 'node:assert/strict';
import { approveHistoricalEventInvoiceRecovery, resolveHistoricalEventInvoiceRecovery,
  reconcileEventInvoices, processEventInvoiceRecovery, validHistoricalRecoveryEvidence } from './eventInvoiceRecovery.js';

const snapshot = () => ({
  version: 1, provider: { connectionId: 'historical-connection', xeroTenantId: 'org' },
  contact: { email: 'original@example.test' }, paymentMethod: 'stripe', amount: 166.67, currency: 'GBP',
  invoice: { Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', LineAmountTypes: 'Inclusive',
    Contact: { ContactID: 'original-contact' }, Date: '2026-11-01', DueDate: '2026-11-01',
    LineItems: [{ Description: 'Original booking', UnitAmount: 166.67, Quantity: 1,
      TaxType: 'OUTPUT2', TaxAmount: 27.78, AccountCode: '200' }] },
  settlement: { paymentIntentId: 'pi_isolated', status: 'succeeded', amount: 166.67, currency: 'GBP',
    accountCode: '090', paidAt: '2026-11-01T12:00:00Z', livemode: true },
});
const evidence = () => ({ version: 1, kind: 'approved_repair_manifest', environment: 'live',
  approvalReference: 'isolated-reviewed-manifest', approvedBy: 'isolated-finance',
  approvedAt: '2026-11-02T00:00:00Z', provenance: ['original payment and exact reviewed purchaser'],
  paymentIntentId: 'pi_isolated' });

test('historical approval requires explicit provenance/live mode/exact PI and gross amount', async () => {
  assert.equal(validHistoricalRecoveryEvidence(snapshot(), evidence()), true);
  for (const e of [{ ...evidence(), environment: 'test' }, { ...evidence(), provenance: [] },
    { ...evidence(), paymentIntentId: 'pi_other' }, { ...evidence(), kind: 'current_catalogue' },
    { ...evidence(), approvalReference: '' }]) {
    assert.equal(validHistoricalRecoveryEvidence(snapshot(), e), false);
  }
  for (const s of [
    { ...snapshot(), settlement: { ...snapshot().settlement, livemode: false } },
    { ...snapshot(), settlement: { ...snapshot().settlement, livemode: undefined } },
    { ...snapshot(), invoice: { ...snapshot().invoice, LineAmountTypes: 'Exclusive' } },
  ]) assert.equal(validHistoricalRecoveryEvidence(s, evidence()), false);
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: { status: 'approved' } }; } };
  await assert.rejects(() => approveHistoricalEventInvoiceRecovery({
    db, candidate: { operationId: 'operation' }, snapshot: snapshot(), evidence: { ...evidence(), environment: 'test' },
  }), /Invalid approved historical/);
  assert.equal(calls.length, 0);
  await approveHistoricalEventInvoiceRecovery({ db, candidate: { operationId: 'operation' }, snapshot: snapshot(), evidence: evidence() });
  assert.equal(calls[0][0], 'event_invoice_recovery_approve_historical');
  assert.equal(calls[0][1].p_snapshot.invoice.LineAmountTypes, 'Inclusive');
});

test('bounded runner reconstructs then consumes persisted approval before sole writer', async () => {
  const calls = [];
  let claim = 0;
  const db = { rpc: async (name, args) => {
    calls.push([name, args]);
    if (name.endsWith('_sweep')) return { data: 3 };
    if (name.endsWith('_automatic_candidates')) return { data: [] };
    if (name.endsWith('_hydrate_historical')) return { data: 1 };
    if (name.endsWith('_claim')) {
      if (claim++) return { data: null };
      return { data: { id: 'original-operation', tenant_id: 'tenant', source: 'booking',
        booking_group_reference: 'original-group', snapshot: snapshot(), lease_token: 'fence', attempts: 1 } };
    }
    return { data: true };
  } };
  let invoices = 0; let payments = 0;
  const result = await reconcileEventInvoices({ db, providerFactory: async () => ({
    findInvoices: async () => [], findPayments: async () => [], validateInvoice() {}, validatePayment() {},
    createInvoice: async () => { invoices++; return { InvoiceID: 'invoice', InvoiceNumber: 'number', AmountPaid: 0, AmountDue: 166.67 }; },
    createPayment: async () => { payments++; return { PaymentID: 'payment' }; },
  }) });
  assert.deepEqual(result, { swept: 3, hydrated: 1, complete: 1, retry: 0, needs_review: 0 });
  assert.equal(invoices, 1); assert.equal(payments, 1);
  assert.deepEqual(calls.slice(0, 5).map(([name]) => name), [
    'event_invoice_recovery_heartbeat', 'event_invoice_recovery_sweep',
    'event_invoice_recovery_automatic_candidates', 'event_invoice_recovery_hydrate_historical', 'event_invoice_recovery_claim',
  ]);
  assert.deepEqual(calls[3][1], { p_limit: 20, p_id: null });
  assert.ok(!calls.some(([name]) => name.endsWith('_approve_historical')));
});

test('targeted resolver preserves operation scope and surfaces migration/persistence failures', async () => {
  const db = { rpc: async (name, args) => {
    if (name.endsWith('_automatic_candidates')) return { data: [] };
    assert.equal(name, 'event_invoice_recovery_hydrate_historical');
    assert.deepEqual(args, { p_limit: 1, p_id: 'original-id' });
    return { error: new Error('RPC missing') };
  } };
  await assert.rejects(() => resolveHistoricalEventInvoiceRecovery({ db, operationId: 'original-id', limit: 1 }), /persistence failed/);
});

test('hydrated historical evidence does not erase ambiguous-create barriers', async () => {
  const journal = [];
  const db = { rpc: async (name, args) => {
    journal.push([name, args]);
    if (name.endsWith('_claim')) return { data: {
      id: 'same-historical-id', tenant_id: 'tenant', source: 'booking', booking_group_reference: 'group',
      snapshot: snapshot(), lease_token: 'new-fence', attempts: 3,
      invoice_write_started_at: '2026-11-01T12:01:00Z',
    } };
    return { data: true };
  } };
  const result = await processEventInvoiceRecovery({ db, providerFactory: async () => ({
    findInvoices: async () => [], findPayments: async () => [],
    createInvoice: async () => assert.fail('historical hydration is not permission to recreate'),
    createPayment: async () => assert.fail('historical hydration is not permission to resettle'),
  }) });
  assert.equal(result.status, 'needs_review');
  assert.equal(journal.at(-1)[1].p_reason, 'invoice_creation_ambiguous');
  assert.ok(!journal.some(([name]) => name.endsWith('_start_write')));
});