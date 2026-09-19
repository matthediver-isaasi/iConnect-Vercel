import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BNMS_PILOT_ACCOUNTING, createXeroMembershipInvoice, applyStripePaymentToXeroInvoice,
} from './xero.js';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const context = () => ({
  memberId: '33e5d54d-162e-436d-9bff-ec6676d198f9', environment: 'live', provider: 'gocardless',
  snapshot: { ...BNMS_PILOT_ACCOUNTING },
});
function fixture(change = {}) {
  const calls = [];
  const bank = {
    AccountID: BNMS_PILOT_ACCOUNTING.bank_account_id, Status: 'ACTIVE', Type: 'BANK',
    CurrencyCode: 'GBP', EnablePaymentsToAccount: false, ...change.bank,
  };
  const invoice = {
    InvoiceID: 'invoice', InvoiceNumber: 'INV-1', Status: 'AUTHORISED', Total: 13,
    Contact: { ContactID: 'contact' }, AmountDue: 13, AmountPaid: 0,
    CurrencyCode: 'GBP', LineItems: [{ AccountCode: '200' }], ...change.invoice,
  };
  const chain = {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: null, error: null }; },
  };
  const deps = {
    supabase: { from: () => chain },
    getValidXeroAccessToken: async () => ({ accessToken: 'test-only', tenantId: change.tenantId || BNMS_PILOT_ACCOUNTING.xero_tenant_id }),
    findOrCreateXeroContact: async () => { calls.push({ method: 'CONTACT' }); return 'contact'; },
    fetch: async (url, init = {}) => {
      calls.push({ url, ...init });
      let data;
      if (url.endsWith('/Organisation')) data = { Organisations: [{
        OrganisationID: BNMS_PILOT_ACCOUNTING.xero_tenant_id, BaseCurrency: 'GBP', ...change.org,
      }] };
      else if (url.includes('/Accounts/')) data = { Accounts: [bank] };
      else if (url.includes('/Accounts?')) data = { Accounts: [{ Code: '200', Status: 'ACTIVE', ...change.revenue }] };
      else if (url.includes('/Contacts?')) data = { Contacts: [{ ContactID: 'contact', Name: 'Pilot' }] };
      else if (url.endsWith('/Payments')) {
        data = { Payments: [{ PaymentID: 'payment', Amount: 13, Invoice: { InvoiceID: 'invoice' },
          Account: { AccountID: BNMS_PILOT_ACCOUNTING.bank_account_id }, Status: 'AUTHORISED', ...change.payment }] };
        Object.assign(invoice, { Status: 'PAID', AmountDue: 0, AmountPaid: 13 }, change.settlement);
      }
      else if (url.endsWith('/OnlineInvoice')) data = { OnlineInvoices: [] };
      else if (url.includes('/Invoices')) data = { Invoices: [invoice] };
      else throw new Error(`Unexpected test request: ${url}`);
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    },
  };
  const args = {
    appTenantId: tenant, organizationName: 'Pilot', membershipYear: '2026',
    finalCost: 13, currency: 'GBP', nominalCode: '200', markAsPaid: true,
    bankAccountSettingKey: 'xero_gocardless_bank_account_code', strictBankAccount: true,
    ddAccountingMigration: context(), idempotencyKey: 'mii-gc-PM1',
    paymentIdempotencyKey: 'mii-gc-PM1-pay', xeroInvoiceId: 'invoice', amount: 13,
    expectedContact: { name: 'Pilot' },
  };
  return { calls, deps, args };
}

for (const [label, change, mutate] of [
  ['app tenant', {}, a => { a.appTenantId = 'other'; }],
  ['member', {}, a => { a.ddAccountingMigration.memberId = 'other'; }],
  ['environment', {}, a => { a.ddAccountingMigration.environment = 'sandbox'; }],
  ['provider', {}, a => { a.ddAccountingMigration.provider = 'stripe'; }],
  ['arbitrary mapping', {}, a => { a.ddAccountingMigration.snapshot.bank_account_id = 'other'; }],
  ['connected organisation', { tenantId: 'other' }],
  ['live organisation', { org: { OrganisationID: 'other' } }],
  ['organisation currency', { org: { BaseCurrency: 'EUR' } }],
  ['bank identity', { bank: { AccountID: 'other' } }],
  ['bank currency', { bank: { CurrencyCode: 'EUR' } }],
  ['bank archived', { bank: { Status: 'ARCHIVED' } }],
  ['bank type (even enabled)', { bank: { Type: 'CURRENT', EnablePaymentsToAccount: true } }],
  ['revenue archived', { revenue: { Status: 'ARCHIVED' } }],
]) {
  for (const [path, post] of [['create', createXeroMembershipInvoice], ['retry', applyStripePaymentToXeroInvoice]]) {
    test(`${path}: invalid ${label} fails before contact, invoice or payment writes`, async () => {
      const { args, deps, calls } = fixture(change);
      mutate?.(args);
      await assert.rejects(post(args, deps), /BNMS/);
      assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
    });
  }
}

test('code-less ACTIVE GBP BANK with EnablePaymentsToAccount=false creates and pays using exact ID and keys', async () => {
  const { args, deps, calls } = fixture();
  const result = await createXeroMembershipInvoice(args, deps);
  assert.equal(result.payment_recorded, true);
  const invoice = calls.find(c => c.method === 'POST' && c.url.endsWith('/Invoices'));
  assert.equal(invoice.headers['Idempotency-Key'], 'mii-gc-PM1');
  assert.equal(JSON.parse(invoice.body).Invoices[0].LineItems[0].AccountCode, '200');
  assert.equal(JSON.parse(invoice.body).Invoices[0].CurrencyCode, 'GBP');
  const payment = calls.find(c => c.url?.endsWith('/Payments'));
  assert.equal(JSON.parse(payment.body).Payments[0].Account.AccountID, BNMS_PILOT_ACCOUNTING.bank_account_id);
  assert.equal(payment.headers['Idempotency-Key'], 'mii-gc-PM1-pay');
});

for (const [label, invoice] of [
  ['wrong total', { Total: 20 }],
  ['wrong contact', { Contact: { ContactID: 'other' } }],
  ['edited due', { AmountDue: 12 }],
  ['already paid', { Status: 'PAID', AmountDue: 0, AmountPaid: 13 }],
  ['part paid', { AmountDue: 10, AmountPaid: 3 }],
]) {
  for (const [path, post] of [['create', createXeroMembershipInvoice], ['retry', applyStripePaymentToXeroInvoice]]) {
    test(`${path}: ${label} blocks payment and authorisation`, async () => {
      const { args, deps, calls } = fixture({ invoice });
      await assert.rejects(post(args, deps), /BNMS/);
      assert.equal(calls.filter(c => c.url?.endsWith('/Payments')).length, 0);
      assert.equal(calls.filter(c => c.method === 'POST' && c.url?.endsWith('/Invoices/invoice')).length, 0);
    });
  }
}

for (const [label, change] of [
  ['partial payment', { payment: { Amount: 12 } }],
  ['wrong invoice', { payment: { Invoice: { InvoiceID: 'other' } } }],
  ['missing amount', { payment: { Amount: undefined } }],
  ['not fully settled', { settlement: { AmountDue: 1, AmountPaid: 12, Status: 'AUTHORISED' } }],
]) {
  for (const [path, post] of [['create', createXeroMembershipInvoice], ['retry', applyStripePaymentToXeroInvoice]]) {
    test(`${path}: ${label} cannot report posted and retry cannot duplicate`, async () => {
      const { args, deps, calls } = fixture(change);
      const result = await post(args, deps);
      assert.equal(result.payment_recorded, false);
      await assert.rejects(post(args, deps), /BNMS/);
      assert.equal(calls.filter(c => c.url?.endsWith('/Payments')).length, 1);
    });
  }
}

test('linked invoice retry validates live mapping and only pays with unchanged payment key', async () => {
  const { args, deps, calls } = fixture();
  args.idempotencyKey = 'mii-gc-PM1-pay';
  const result = await applyStripePaymentToXeroInvoice(args, deps);
  assert.equal(result.payment_recorded, true);
  const writes = calls.filter(c => c.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.endsWith('/Payments'));
  assert.equal(writes[0].headers['Idempotency-Key'], 'mii-gc-PM1-pay');
  assert.equal(JSON.parse(writes[0].body).Payments[0].Account.AccountID, BNMS_PILOT_ACCOUNTING.bank_account_id);
});

test('retry refuses wrong existing invoice currency before authorisation', async () => {
  const { args, deps, calls } = fixture({ invoice: { Status: 'DRAFT', CurrencyCode: 'USD' } });
  await assert.rejects(applyStripePaymentToXeroInvoice(args, deps), /currency or revenue/);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
});