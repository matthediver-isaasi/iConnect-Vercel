import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BNMS_PILOT_ACCOUNTING, createXeroMembershipInvoice, applyStripePaymentToXeroInvoice,
} from './xero.js';
import { betaAccountingMapping, BNMS_BETA_REVENUE, resolveBetaAccountingContext, BNMS_BETA_BATCH } from './bnmsBetaAccounting.js';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const context = () => ({
  memberId: '33e5d54d-162e-436d-9bff-ec6676d198f9', environment: 'live', provider: 'gocardless',
  snapshot: { ...BNMS_PILOT_ACCOUNTING },
});
function fixture(change = {}) {
  const calls = [];
  let storedPayment = null, faultUsed = false;
  const mapping = change.betaMember ? betaAccountingMapping(change.betaMember) : BNMS_PILOT_ACCOUNTING;
  const bank = {
    AccountID: BNMS_PILOT_ACCOUNTING.bank_account_id, Status: 'ACTIVE', Type: 'BANK',
    CurrencyCode: 'GBP', EnablePaymentsToAccount: false, ...change.bank,
  };
  const invoice = {
    InvoiceID: 'invoice', InvoiceNumber: 'INV-1', Status: 'AUTHORISED', Total: 13,
    Contact: { ContactID: 'contact' }, AmountDue: 13, AmountPaid: 0,
    CurrencyCode: 'GBP', LineItems: [{ AccountCode: mapping.revenue_account_code }], ...change.invoice,
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
      else if (url.includes('/Accounts?')) data = { Accounts: [{ Code: mapping.revenue_account_code, Status: 'ACTIVE', Type: 'REVENUE', ...change.revenue }] };
      else if (url.includes('/Contacts?')) data = { Contacts: [{ ContactID: 'contact', Name: 'Pilot' }] };
      else if (url.includes('/Payments/')) data = { Payments: storedPayment ? [{ ...storedPayment, ...change.recoveredPayment }] : [] };
      else if (url.endsWith('/Payments')) {
        storedPayment = { PaymentID: 'payment', Amount: 13,
          Invoice: { InvoiceID: 'invoice', CurrencyCode: 'GBP', Contact: { ContactID: 'contact' } },
          Reference: JSON.parse(init.body).Payments[0].Reference, CurrencyRate: 1, BankAmount: 13, PaymentType: 'ACCRECPAY',
          Account: { AccountID: BNMS_PILOT_ACCOUNTING.bank_account_id }, Status: 'AUTHORISED', ...change.payment };
        data = { Payments: [storedPayment] };
        Object.assign(invoice, { Status: 'PAID', AmountDue: 0, AmountPaid: 13 }, change.settlement);
        invoice.Payments = [{ PaymentID: 'payment', Amount: 13 }];
        if (change.fault === 'lost-payment-response' && !faultUsed) {
          faultUsed = true;
          throw new Error('Injected lost payment response after provider commit');
        }
      }
      else if (url.endsWith('/OnlineInvoice')) data = { OnlineInvoices: [] };
      else if (url.includes('/Invoices')) {
        if (change.fault === 'failed-verification-get' && invoice.Status === 'PAID' && init.method === 'GET' && !faultUsed) {
          faultUsed = true;
          throw new Error('Injected verification GET failure after provider commit');
        }
        data = { Invoices: [invoice] };
      }
      else throw new Error(`Unexpected test request: ${url}`);
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    },
  };
  const args = {
    appTenantId: tenant, organizationName: 'Pilot', membershipYear: '2026',
    finalCost: 13, currency: 'GBP', nominalCode: mapping.revenue_account_code, markAsPaid: true,
    bankAccountSettingKey: 'xero_gocardless_bank_account_code', strictBankAccount: true,
    ddAccountingMigration: context(), idempotencyKey: 'mii-gc-PM1',
    paymentIdempotencyKey: 'mii-gc-PM1-pay', xeroInvoiceId: 'invoice', amount: 13,
    expectedContact: { name: 'Pilot' },
  };
  if (change.betaMember) args.ddAccountingMigration = { ...context(), memberId: change.betaMember, snapshot: mapping };
  return { calls, deps, args, remoteInvoice: invoice };
}

for (const betaMember of [null, Object.keys(BNMS_BETA_REVENUE)[0]]) {
  for (const fault of ['lost-payment-response', 'failed-verification-get', 'failed-local-persist']) {
    test(`${betaMember ? 'beta' : 'pilot'} recovers ${fault} without another payment`, async () => {
      const { calls, deps, args } = fixture({ betaMember, fault });
      args.paymentReference = 'GoCardless DD: PM1';
      let localRecord = null, persistAttempts = 0;
      const persist = async result => {
        persistAttempts++;
        if (fault === 'failed-local-persist' && persistAttempts === 1) throw new Error('Injected local persistence failure');
        localRecord = result;
      };
      if (fault === 'failed-local-persist') {
        // Simulate the accounting ledger failing to persist the successful
        // provider result: retry must use the original invoice creation key.
        await assert.rejects(createXeroMembershipInvoice(args, deps).then(persist), /persistence/);
        assert.equal(localRecord, null);
      } else {
        const first = await createXeroMembershipInvoice(args, deps);
        assert.equal(first.payment_recorded, false);
      }
      const afterFirst = calls.length;
      const retry = fault === 'failed-local-persist'
        ? await createXeroMembershipInvoice(args, deps)
        : await applyStripePaymentToXeroInvoice({ ...args, idempotencyKey: args.paymentIdempotencyKey }, deps);
      assert.equal(retry.payment_recorded, true);
      await persist(retry);
      assert.equal(localRecord.payment_recorded, true);
      assert.equal(retry.payment_id, 'payment');
      assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/Payments')).length, 1);
      assert.equal(calls.slice(afterFirst).filter(c => c.method === 'POST' && c.url.endsWith('/Payments')).length, 0);
      assert.ok(calls.slice(afterFirst).some(c => c.method === 'GET' && c.url.endsWith('/Payments/payment')));
    });
  }
}

test('scoped PAID recovery still rejects altered invoice ownership/revenue/credit and ambiguous allocations', async () => {
  for (const patch of [
    { Contact: { ContactID: 'other' } }, { LineItems: [{ AccountCode: '999' }] },
    { CurrencyCode: 'EUR' }, { AmountCredited: 1 }, { AmountPaid: 12 }, { Total: 14 },
    { Payments: [] }, { Payments: [{ PaymentID: 'payment' }, { PaymentID: 'manual' }] },
  ]) {
    const { calls, deps, args, remoteInvoice } = fixture();
    args.paymentReference = 'GoCardless DD: PM1';
    await createXeroMembershipInvoice(args, deps);
    Object.assign(remoteInvoice, patch);
    await assert.rejects(applyStripePaymentToXeroInvoice({ ...args, idempotencyKey: args.paymentIdempotencyKey }, deps), /BNMS/);
    assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/Payments')).length, 1);
  }
});

for (const recoveredPayment of [
  { Reference: 'Manual payment' }, { Amount: 12 }, { Status: 'DELETED' },
  { Account: { AccountID: 'another-bank' } },
  { Invoice: { InvoiceID: 'other', CurrencyCode: 'GBP', Contact: { ContactID: 'contact' } } },
  { Invoice: { InvoiceID: 'invoice', CurrencyCode: 'EUR', Contact: { ContactID: 'contact' } } },
  { Invoice: { InvoiceID: 'invoice', CurrencyCode: 'GBP', Contact: { ContactID: 'other' } } },
  { CurrencyRate: 2 }, { BankAmount: 12 }, { PaymentType: 'ACCPAYPAY' },
]) {
  test(`scoped PAID recovery rejects mismatched payment ${JSON.stringify(recoveredPayment)}`, async () => {
    for (const betaMember of [null, Object.keys(BNMS_BETA_REVENUE)[0]]) {
      const { calls, deps, args } = fixture({ betaMember, recoveredPayment });
      args.paymentReference = 'GoCardless DD: PM1';
      await createXeroMembershipInvoice(args, deps);
      await assert.rejects(applyStripePaymentToXeroInvoice({ ...args, idempotencyKey: args.paymentIdempotencyKey }, deps), /canonical settlement/);
      assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/Payments')).length, 1);
    }
  });
}

for (const memberId of Object.keys(BNMS_BETA_REVENUE)) {
  test(`approved beta identity ${memberId}: create and retry settle to the same scoped code-less bank`, async () => {
    for (const post of [createXeroMembershipInvoice, applyStripePaymentToXeroInvoice]) {
      const { args, deps, calls } = fixture({ betaMember: memberId });
      const outcome = await post(args, deps);
      assert.equal(outcome.payment_recorded, true);
      const payment = calls.find(c => c.url?.endsWith('/Payments') && c.method === 'POST');
      assert.equal(JSON.parse(payment.body).Payments[0].Account.AccountID, betaAccountingMapping(memberId).bank_account_id);
      const invoice = calls.find(c => c.url?.endsWith('/Invoices') && c.method === 'POST');
      if (invoice) assert.equal(JSON.parse(invoice.body).Invoices[0].LineItems[0].AccountCode, BNMS_BETA_REVENUE[memberId]);
    }
  });
}

test('beta accounting rejects other cohorts/tenant/bank/batch/rail and mismatched revenue before writes', async () => {
  const memberId = Object.keys(BNMS_BETA_REVENUE)[0];
  for (const mutate of [
    a => { a.appTenantId = 'other'; },
    a => { a.ddAccountingMigration.memberId = 'alpha-or-unknown'; },
    a => { a.ddAccountingMigration.memberId = context().memberId; },
    a => { a.ddAccountingMigration.environment = 'sandbox'; },
    a => { a.ddAccountingMigration.provider = 'stripe'; },
    a => { a.ddAccountingMigration.snapshot.bank_account_id = 'other'; },
    a => { a.ddAccountingMigration.snapshot.batch_hash = 'other'; },
    a => { a.ddAccountingMigration.snapshot.revenue_account_code = '200'; },
    a => { a.nominalCode = '200'; },
  ]) {
    const { args, deps, calls } = fixture({ betaMember: memberId });
    mutate(args);
    await assert.rejects(createXeroMembershipInvoice(args, deps));
    assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
  }
});

test('held beta cannot resolve accounting; exact immutable release mapping and owner links are mandatory', async () => {
  const memberId = Object.keys(BNMS_BETA_REVENUE)[0], mapping = betaAccountingMapping(memberId);
  const agreement = { id: 'agreement', tenant_id: tenant, member_id: memberId, environment: 'live', provider: 'gocardless',
    gocardless_mandate_id: 'mandate', gocardless_customer_id: 'customer' };
  const adoption = { id: 'adoption', batch_id: 'batch', plan_id: 'plan', mandate_id: 'mandate', customer_id: 'customer' };
  const evidence = { adoptionId: 'adoption', agreementId: 'agreement', memberId, planId: 'plan',
    accounting: { mapping, bankAccountId: mapping.bank_account_id, xeroTenantId: mapping.xero_tenant_id, revenueCode: mapping.revenue_account_code } };
  const records = { bnms_dd_beta_adoption: adoption, bnms_dd_beta_batch: { evidence_sha256: BNMS_BETA_BATCH }, bnms_dd_beta_release: null };
  const db = { from(table) { return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: records[table], error: null }; } }; } };
  await assert.rejects(resolveBetaAccountingContext(agreement, db), /immutable adoption and release/);
  records.bnms_dd_beta_release = { evidence };
  assert.deepEqual((await resolveBetaAccountingContext(agreement, db)).snapshot, mapping);
  evidence.planId = 'other';
  await assert.rejects(resolveBetaAccountingContext(agreement, db), /ownership/);
  assert.equal(await resolveBetaAccountingContext({ ...agreement, tenant_id: 'other' }, db), null);
});

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