import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeMembershipPreparation, prepareMembershipSourceRequest } from './accountingSourcePreparation.js';
import { prepareQueuedSalesRequest } from './salesAccounting.js';

for (const provider of ['xero', 'quickbooks']) {
  test(`${provider}: frozen membership preparation uses original settings, date and binding`, async () => {
    const args = { appTenantId: 'tenant', organizationName: 'Original name', currency: 'GBP',
      finalCost: 10, membershipYear: '2026', privateToken: 'must-not-persist' };
    const db = { from: () => ({
      select() { return this; }, eq() { return this; },
      async in() { return { data: [{ setting_key: 'xero_invoice_status', setting_value: 'AUTHORISED' }], error: null }; },
    }) };
    const invoice = await freezeMembershipPreparation({ db, args, totalMinor: 1000 });
    assert.equal(invoice.args.privateToken, undefined);
    args.organizationName = 'Changed';
    const row = { tenant_id: 'tenant', provider, company_id: 'company', source_type: 'member_membership_history',
      source_id: 'history', snapshot: { version: 1, preparation: true, invoice, environment: 'sandbox',
        payment: null, linkage: { recordId: 'history', ownerId: 'member' } } };
    const original = structuredClone(row);
    const result = await prepareMembershipSourceRequest({ row, transport: {} }, {
      prepare: async (frozen, dependencies) => {
        assert.equal(frozen.organizationName, 'Original name');
        assert.equal(frozen.markAsPaid, false);
        assert.equal(dependencies.prepareOnly, true);
        const setting = await dependencies.supabase.from('system_settings').select('setting_value')
          .eq('tenant_id', 'tenant').eq('setting_key', 'xero_invoice_status').maybeSingle();
        assert.equal(setting.data.setting_value, 'AUTHORISED');
        return { companyId: 'company', environment: 'sandbox', contactId: 'contact',
          payload: provider === 'xero'
            ? { Type: 'ACCREC', Status: 'AUTHORISED', LineItems: [{ UnitAmount: '10.00' }] }
            : { CustomerRef: { value: 'contact' }, GlobalTaxCalculation: 'TaxExcluded', Line: [] } };
      },
    });
    assert.deepEqual(row, original);
    assert.equal(result.preparation, undefined);
    assert.equal(result.invoice.envelope.payload.DueDate, invoice.dueDate);
    assert.equal(result.invoice.envelope.payload[provider === 'xero' ? 'Date' : 'TxnDate'], invoice.invoiceDate);
    assert.equal(result.invoice.envelope.expected.totalMinor, 1000);
    assert.equal(result.payment, null);
    await assert.rejects(prepareMembershipSourceRequest({ row, transport: {} }, {
      prepare: async () => { throw Object.assign(new Error('throttle'), { status: 429, retryAfter: '3600' }); },
    }), error => error.status === 429 && error.retryAfter === '3600');
    await assert.rejects(prepareMembershipSourceRequest({ row, transport: {} }, {
      prepare: async () => ({ companyId: 'different' }),
    }), /BINDING_CHANGED/);
  });

  test(`${provider}: sales worker resolves customer against frozen economics without catalogue reads`, async () => {
    const row = { tenant_id: 'tenant', provider, snapshot: {
      version: 1, preparation: true, environment: 'sandbox', payment: null,
      linkage: { actorId: 'actor' },
      invoice: { customer: { organisationId: 'org', name: 'Original' }, command: {},
        payload: { currency: 'GBP', netMinor: 1000, taxMinor: 200, grossMinor: 1200,
          idempotencyKey: 'original-claim', lines: [{ description: 'Accepted', quantity: '1', unitPriceMinor: 1000,
            netMinor: 1000, taxMinor: 200, grossMinor: 1200, discountBps: 0,
            taxRateBps: 2000, taxCode: 'TAX', itemId: 'item', accountCode: '200' }] } },
    } };
    const db = { from() { throw new Error('Live settings read forbidden'); },
      async rpc(name) {
        assert.equal(name, 'claim_sales_accounting_customer_mapping');
        return { data: { state: 'mapped', customerId: 'customer' } };
      } };
    const result = await prepareQueuedSalesRequest({ row, db, transport: {} }, { provider: { name: provider } });
    assert.equal(result.invoice.envelope.operationKey, 'original-claim');
    assert.equal(result.invoice.envelope.expected.totalMinor, 1200);
    assert.equal(result.invoice.envelope.expected.contactId, 'customer');
    assert.equal(row.snapshot.preparation, true);
  });
}
