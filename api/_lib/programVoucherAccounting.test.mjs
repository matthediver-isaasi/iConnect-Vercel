import test from 'node:test';
import assert from 'node:assert/strict';
import { programAccountingPlan, programInvoiceTax, continueProgramVoucherAccounting } from './programVoucherAccounting.js';

const snapshot = {
  programName: 'Training', grossMinor: 12000, discountMinor: 1000,
  voucherMinor: 3000, trainingFundMinor: 2000, remainingMinor: 6000,
  paymentMethod: 'account', currency: 'GBP',
  allocations: [{ id: 'allocation-1', amountMinor: 3000, ownerType: 'member', displayName: 'Saved personal credit' }],
};
test('gross invoice excludes genuine discount only, not funding; account cash remains unpaid', () => {
  const plan = programAccountingPlan(snapshot);
  assert.equal(plan.invoiceMinor, 11000);
  assert.equal(plan.payments.length, 2);
  assert.match(plan.description, /Saved personal credit \(Personal\)/);
  assert.match(plan.description, /Remaining cash liability GBP 60.00/);
  assert.ok(plan.payments.every(p => p.kind !== 'cash'));
});
test('card cash is distinct from owner-specific voucher funding', () => {
  const plan = programAccountingPlan({ ...snapshot, paymentMethod: 'card', paymentIntentId: 'pi_verified' });
  assert.deepEqual(plan.payments.map(p => p.amountMinor), [3000, 2000, 6000]);
  assert.equal(plan.payments[2].reference, 'Stripe: pi_verified');
});
test('extracts configured inclusive VAT without raising the cash liability; missing rate fails closed', () => {
  assert.deepEqual(programInvoiceTax(12000, '20', 'OUTPUT2'),
    { rate: 20, taxCode: 'OUTPUT2', grossMinor: 12000, netMinor: 10000, taxMinor: 2000 });
  assert.equal(programInvoiceTax(12000, '0', 'NONE').taxMinor, 0);
  assert.throws(() => programInvoiceTax(12000, '', 'NONE'), /explicit/);
});
test('rejects missing snapshot and unbalanced or relabelled owner allocations', () => {
  assert.throws(() => programAccountingPlan(null), /snapshot/);
  assert.throws(() => programAccountingPlan({ ...snapshot, remainingMinor: 0 }), /balance/);
  assert.throws(() => programAccountingPlan({ ...snapshot, allocations: [{ ...snapshot.allocations[0], ownerType: 'other' }] }), /balance/);
});
test('durable retry persists invoice and steps, never reposts confirmed funding', async () => {
  const row = { accounting_snapshot: snapshot, accounting_steps: [], accounting_status: 'pending' };
  const calls = [];
  let fail = true;
  const provider = {
    name: 'xero', resolveOrCreateContact: async () => ({ contactId: 'contact' }),
    createSalesInvoice: async (_, args) => { calls.push(['invoice', args]); return { id: 'invoice' }; },
    applyStripePaymentToInvoice: async args => {
      calls.push(['payment', args]);
      if (args.bankAccountSettingKey.includes('training') && fail) throw new Error('temporary failure');
      return { payment_recorded: true };
    },
  };
  const db = {
    rpc: async () => ({ data: [{ ...row }] }),
    from: table => {
      let values;
      const query = {
        update(v) { values = v; return this; }, eq() { return this; }, select() { return this; },
        async single() { Object.assign(row, values); return { data: { purchase_key: 'key' } }; },
        async maybeSingle() { return { data: { setting_value: '0' } }; },
      };
      assert.ok(['program_credit_purchase', 'system_settings'].includes(table));
      return query;
    },
  };
  const deps = { facade: { getAccountingProvider: async () => provider, getAccountingProviderByName: () => provider } };
  assert.equal((await continueProgramVoucherAccounting(db, 'tenant', 'key', deps)).status, 'pending');
  assert.deepEqual(row.accounting_steps, ['allocation-1']);
  fail = false;
  assert.equal((await continueProgramVoucherAccounting(db, 'tenant', 'key', deps)).status, 'complete');
  assert.equal(calls.filter(([kind]) => kind === 'invoice').length, 1);
  const payments = calls.filter(([kind]) => kind === 'payment').map(([, args]) => args);
  assert.ok(payments.every(p => p.strictBankAccount && !p.stripePaymentIntentId));
  assert.equal(payments.filter(p => p.bankAccountSettingKey.includes('voucher')).length, 1);
});
