import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceReferenceFromRow, invoiceReferenceColumns, resolveFeeTokenInvoiceReference } from './feeTokenInvoiceReference.js';

test('invoice references preserve legacy Xero and reject ambiguous providers', () => {
  assert.equal(invoiceReferenceFromRow({ xero_invoice_id: 'x' }).provider, 'xero');
  assert.throws(() => invoiceReferenceFromRow({ accounting_invoice_id: '1' }), /provider/);
  assert.throws(() => invoiceReferenceFromRow({ accounting_provider: 'quickbooks', accounting_invoice_id: '1', xero_invoice_id: '1' }), /Conflicting/);
  assert.equal(invoiceReferenceColumns({ provider: 'quickbooks', invoiceId: '1' }).xero_invoice_id, undefined);
});

test('legacy misleading fields require exact owned history, not active provider', async () => {
  const filters = {};
  let history = { accounting_provider: 'quickbooks', accounting_invoice_id: '1' };
  const client = { from(table) {
    assert.equal(table, 'member_membership_history');
    const q = { select() { return q; }, eq(k,v) { filters[k] = v; return q; },
      maybeSingle: async () => ({ data: history }) };
    return q;
  } };
  const token = { tenant_id: 'tenant', member_id: 'member', membership_year: '2026', history_record_id: 'history', xero_invoice_id: '1' };
  assert.equal((await resolveFeeTokenInvoiceReference(client, token)).provider, 'quickbooks');
  assert.deepEqual(filters, { id: 'history', tenant_id: 'tenant', member_id: 'member', membership_year: '2026' });
  await assert.rejects(resolveFeeTokenInvoiceReference(client, { ...token, xero_invoice_id: '2' }), /differs/);
  history = null;
  await assert.rejects(resolveFeeTokenInvoiceReference(client, token), /verify/);
});