import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createXeroMembershipInvoice,
  findFormStripeXeroInvoice,
  settleFormStripeXeroInvoice,
} from './xero.js';
import {
  createQuickBooksMembershipInvoice,
  findFormStripeQuickBooksInvoice,
  findOrCreateQuickBooksCustomer,
  quickBooksSettlementRequestId,
  settleFormStripeQuickBooksInvoice,
} from './quickbooks.js';
import { getAccountingProviderByName } from './accountingProvider.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function settings(values) {
  return {
    from() {
      let key;
      return {
        select() { return this; },
        eq(column, value) {
          if (column === 'setting_key') key = value;
          return this;
        },
        async maybeSingle() {
          return { data: values[key] ? { setting_value: values[key] } : null, error: null };
        },
      };
    },
  };
}

const baseArgs = {
  appTenantId: 'tenant-1',
  invoiceId: 'invoice-1',
  stripePaymentIntentId: 'pi_3UE6Sn0Ku8P2LW360u2QlH5B',
  amount: 61,
  currency: 'GBP',
  paidAt: '2026-01-02T12:00:00Z',
  operationKey: 'form-stripe-invoice:ff2df806-b321-4254-b651-3af11fccf1db:11d8a645-1a04-48c9-8e00-025f0195db3d:16dcc70d-71af-4c38-b5fc-56ac2a102d77:pi_3UE6Sn0Ku8P2LW360u2QlH5B',
};

test('facade exposes pinned provider settlement operation', () => {
  assert.equal(typeof getAccountingProviderByName('xero').settleFormStripeInvoice, 'function');
  assert.equal(typeof getAccountingProviderByName('quickbooks').settleFormStripeInvoice, 'function');
  assert.equal(typeof getAccountingProviderByName('xero').findFormStripeInvoice, 'function');
  assert.equal(typeof getAccountingProviderByName('quickbooks').findFormStripeInvoice, 'function');
});

test('Xero settlement annotates independently and records full Stripe reference', async () => {
  let paid = false;
  let history = [];
  let paymentBody;
  let paymentIdempotencyKey;
  let annotationIdempotencyKey;
  const fetch = async (url, init = {}) => {
    if (url.includes('/History') && init.method === 'PUT') {
      annotationIdempotencyKey = init.headers['Idempotency-Key'];
      history.push(JSON.parse(init.body).HistoryRecords[0]);
      return json({ HistoryRecords: history });
    }
    if (url.includes('/History')) return json({ HistoryRecords: history });
    if (url.includes('/Accounts?')) {
      return json({ Accounts: [{ AccountID: 'bank-1', Code: 'STRIPE', Type: 'BANK', Status: 'ACTIVE' }] });
    }
    if (url.endsWith('/Payments')) {
      paymentIdempotencyKey = init.headers['Idempotency-Key'];
      paymentBody = JSON.parse(init.body);
      paid = true;
      return json({ Payments: [{ PaymentID: 'payment-1' }] });
    }
    if (url.includes('/Invoices/')) {
      return json({ Invoices: [{
        InvoiceID: 'invoice-1', InvoiceNumber: 'INV-1', Status: paid ? 'PAID' : 'AUTHORISED',
        Total: 61, AmountDue: paid ? 0 : 61, CurrencyCode: 'GBP',
        Payments: paid ? [{ PaymentID: 'payment-1', Amount: 61, Reference: baseArgs.stripePaymentIntentId }] : [],
      }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await settleFormStripeXeroInvoice(baseArgs, {
    fetch,
    supabase: settings({ xero_stripe_bank_account_code: 'STRIPE' }),
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
  });
  assert.deepEqual(result, {
    payment_recorded: true,
    annotation_recorded: true,
    settlement_state: 'done',
    error: null,
    invoice_id: 'invoice-1',
    invoice_number: 'INV-1',
    balance: 0,
    account: 'STRIPE',
    provider_context: { xero_tenant_id: 'org' },
  });
  assert.match(history[0].Details, /pi_3UE6Sn0Ku8P2LW360u2QlH5B/);
  assert.match(paymentBody.Payments[0].Reference, /pi_3UE6Sn0Ku8P2LW360u2QlH5B/);
  assert.ok(paymentIdempotencyKey.length <= 128);
  assert.ok(annotationIdempotencyKey.length <= 128);
  assert.notEqual(paymentIdempotencyKey, annotationIdempotencyKey);
});

test('Xero refuses a partial/manual invoice without attempting payment', async () => {
  let writes = 0;
  const fetch = async (url, init = {}) => {
    if (init.method === 'PUT') writes += 1;
    if (url.includes('/History')) return json({ HistoryRecords: [] });
    return json({ Invoices: [{
      InvoiceID: 'invoice-1', InvoiceNumber: 'INV-1', Status: 'AUTHORISED',
      Total: 61, AmountDue: 20, CurrencyCode: 'GBP', Payments: [],
    }] });
  };
  const result = await settleFormStripeXeroInvoice({ ...baseArgs, dryRun: true }, {
    fetch,
    supabase: settings({}),
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
  });
  assert.equal(result.settlement_state, 'blocked');
  assert.equal(result.payment_recorded, false);
  assert.match(result.error, /partial or manual/);
  assert.equal(writes, 0);
});

test('QuickBooks settlement preserves existing private note and PO fields', async () => {
  let paid = false;
  let privateNote = 'Existing staff note';
  let annotationBody;
  let paymentBody;
  let annotationWrites = 0;
  let paymentWrites = 0;
  const invoice = () => ({
    Id: 'invoice-1', DocNumber: 'Q-1', SyncToken: '2', TotalAmt: 61,
    Balance: paid ? 0 : 61, CurrencyRef: { value: 'GBP' },
    CustomerRef: { value: 'customer-1' }, PrivateNote: privateNote,
    PONumber: 'PO-REAL', CustomerMemo: { value: 'PO-REAL' },
  });
  const fetch = async (url, init = {}) => {
    if (url.includes('/query?')) {
      return json({ QueryResponse: { Payment: paid ? [{
        Id: 'payment-1', PrivateNote: `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}`,
        Line: [{ Amount: 61, LinkedTxn: [{ TxnId: 'invoice-1', TxnType: 'Invoice' }] }],
      }] : [] } });
    }
    if (url.includes('/account/')) {
      return json({ Account: { Id: 'bank-1', Active: true, AccountType: 'Bank' } });
    }
    if (url.includes('/invoice?') && init.method === 'POST') {
      annotationWrites += 1;
      annotationBody = JSON.parse(init.body);
      privateNote = annotationBody.PrivateNote;
      return json({ Invoice: invoice() });
    }
    if (url.includes('/payment?') && init.method === 'POST') {
      paymentWrites += 1;
      paymentBody = JSON.parse(init.body);
      paid = true;
      return json({ Payment: { Id: 'payment-1' } });
    }
    if (url.includes('/invoice/')) return json({ Invoice: invoice() });
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await settleFormStripeQuickBooksInvoice(baseArgs, {
    fetch,
    supabase: settings({ quickbooks_stripe_bank_account_id: 'bank-1' }),
    getValidQuickBooksAccessToken: async () => ({
      accessToken: 'token', realmId: 'realm', environment: 'sandbox',
    }),
  });
  assert.equal(result.settlement_state, 'done');
  assert.equal(annotationBody.PONumber, undefined);
  assert.match(annotationBody.PrivateNote, /^Existing staff note\nStripe PaymentIntent: pi_/);
  assert.equal(paymentBody.PaymentRefNum.length, 21);
  assert.match(paymentBody.PrivateNote, /pi_3UE6Sn0Ku8P2LW360u2QlH5B/);
  const replay = await settleFormStripeQuickBooksInvoice(baseArgs, {
    fetch,
    supabase: settings({ quickbooks_stripe_bank_account_id: 'bank-1' }),
    getValidQuickBooksAccessToken: async () => ({
      accessToken: 'token', realmId: 'realm', environment: 'sandbox',
    }),
  });
  assert.equal(replay.settlement_state, 'done');
  assert.equal(annotationWrites, 1);
  assert.equal(paymentWrites, 1);
});

test('QuickBooks operation request ids are stable, safe, and distinct', () => {
  const long = 'submission:'.repeat(20);
  const payment = quickBooksSettlementRequestId(long, 'pay');
  assert.equal(payment, quickBooksSettlementRequestId(long, 'pay'));
  assert.notEqual(payment, quickBooksSettlementRequestId(long, 'note'));
  assert.match(payment, /^[A-Za-z0-9_-]{1,50}$/);
});

test('client-secret-shaped and prefix-only PaymentIntent values are never accepted as identity', async () => {
  await assert.rejects(
    settleFormStripeXeroInvoice({
      ...baseArgs,
      stripePaymentIntentId: `${baseArgs.stripePaymentIntentId}_secret_do_not_store`,
    }),
    /full PaymentIntent identifier/,
  );

  const fetch = async (url) => {
    if (url.includes('/History')) {
      return json({ HistoryRecords: [{ Details: `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}MORE` }] });
    }
    return json({ Invoices: [{
      InvoiceID: 'invoice-1', InvoiceNumber: 'INV-1', Status: 'PAID',
      Total: 61, AmountDue: 0, CurrencyCode: 'GBP',
      Payments: [{ Amount: 61, Reference: `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}MORE` }],
    }] });
  };
  const result = await settleFormStripeXeroInvoice({ ...baseArgs, dryRun: true }, {
    fetch,
    supabase: settings({}),
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
  });
  assert.equal(result.payment_recorded, false);
  assert.equal(result.annotation_recorded, false);
  assert.equal(result.settlement_state, 'blocked');
});

test('missing Xero account remains blocked while annotation succeeds independently', async () => {
  let history = [];
  const fetch = async (url, init = {}) => {
    if (url.includes('/History') && init.method === 'PUT') {
      history = JSON.parse(init.body).HistoryRecords;
      return json({ HistoryRecords: history });
    }
    if (url.includes('/History')) return json({ HistoryRecords: history });
    return json({ Invoices: [{
      InvoiceID: 'invoice-1', InvoiceNumber: 'INV-1', Status: 'AUTHORISED',
      Total: 61, AmountDue: 61, CurrencyCode: 'GBP', Payments: [],
    }] });
  };
  const result = await settleFormStripeXeroInvoice(baseArgs, {
    fetch,
    supabase: settings({}),
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
  });
  assert.equal(result.annotation_recorded, true);
  assert.equal(result.payment_recorded, false);
  assert.equal(result.settlement_state, 'blocked');
  assert.match(result.error, /not configured/);
});

test('rejected Xero payment remains retryable and annotation replay is a no-op', async () => {
  let history = [];
  let annotationWrites = 0;
  let paymentWrites = 0;
  const fetch = async (url, init = {}) => {
    if (url.includes('/History') && init.method === 'PUT') {
      annotationWrites += 1;
      history = JSON.parse(init.body).HistoryRecords;
      return json({ HistoryRecords: history });
    }
    if (url.includes('/History')) return json({ HistoryRecords: history });
    if (url.includes('/Accounts?')) {
      return json({ Accounts: [{ AccountID: 'bank-1', Code: 'STRIPE', Type: 'BANK', Status: 'ACTIVE' }] });
    }
    if (url.endsWith('/Payments')) {
      paymentWrites += 1;
      return json({ ErrorNumber: 10 }, 500);
    }
    return json({ Invoices: [{
      InvoiceID: 'invoice-1', InvoiceNumber: 'INV-1', Status: 'AUTHORISED',
      Total: 61, AmountDue: 61, CurrencyCode: 'GBP', Payments: [],
    }] });
  };
  const deps = {
    fetch,
    supabase: settings({ xero_stripe_bank_account_code: 'STRIPE' }),
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
  };
  const first = await settleFormStripeXeroInvoice(baseArgs, deps);
  const second = await settleFormStripeXeroInvoice(baseArgs, deps);
  assert.equal(first.settlement_state, 'retry');
  assert.equal(first.annotation_recorded, true);
  assert.match(first.error, /payment-create/);
  assert.equal(second.annotation_recorded, true);
  assert.equal(annotationWrites, 1);
  assert.equal(paymentWrites, 2);
});

test('ambiguous QuickBooks payment success is resolved by authoritative reread', async () => {
  let paid = false;
  let privateNote = `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}`;
  const fetch = async (url, init = {}) => {
    if (url.includes('/query?')) {
      return json({ QueryResponse: { Payment: paid ? [{
        Id: 'pay-1', PrivateNote: privateNote,
        Line: [{ Amount: 61, LinkedTxn: [{ TxnId: 'invoice-1', TxnType: 'Invoice' }] }],
      }] : [] } });
    }
    if (url.includes('/account/')) return json({ Account: { Id: 'bank-1', Active: true, AccountType: 'Bank' } });
    if (url.includes('/payment?') && init.method === 'POST') {
      paid = true;
      throw new Error('socket closed after write');
    }
    return json({ Invoice: {
      Id: 'invoice-1', DocNumber: 'Q-1', SyncToken: '1', TotalAmt: 61,
      Balance: paid ? 0 : 61, CurrencyRef: { value: 'GBP' },
      CustomerRef: { value: 'customer-1' }, PrivateNote: privateNote,
    } });
  };
  const result = await settleFormStripeQuickBooksInvoice(baseArgs, {
    fetch,
    supabase: settings({ quickbooks_stripe_bank_account_id: 'bank-1' }),
    getValidQuickBooksAccessToken: async () => ({ accessToken: 'token', realmId: 'realm', environment: 'sandbox' }),
  });
  assert.equal(result.payment_recorded, true);
  assert.equal(result.settlement_state, 'done');
  assert.equal(result.error, null);
});

test('QuickBooks rejects invalid account and missing invoice balance', async () => {
  const invoice = (balance = 61) => ({
    Id: 'invoice-1', DocNumber: 'Q-1', SyncToken: '1', TotalAmt: 61, Balance: balance,
    CurrencyRef: { value: 'GBP' }, CustomerRef: { value: 'customer-1' },
    PrivateNote: `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}`,
  });
  const fetch = async (url) => {
    if (url.includes('/query?')) return json({ QueryResponse: {} });
    if (url.includes('/account/')) return json({ Account: { Id: 'bad', Active: false, AccountType: 'Expense' } });
    return json({ Invoice: invoice() });
  };
  const deps = {
    fetch,
    supabase: settings({ quickbooks_stripe_bank_account_id: 'bad' }),
    getValidQuickBooksAccessToken: async () => ({ accessToken: 'token', realmId: 'realm', environment: 'sandbox' }),
  };
  const invalid = await settleFormStripeQuickBooksInvoice(baseArgs, deps);
  assert.equal(invalid.settlement_state, 'blocked');
  assert.match(invalid.error, /not active or deposit-capable/);

  await assert.rejects(settleFormStripeQuickBooksInvoice(baseArgs, {
    ...deps,
    fetch: async (url) => {
      if (url.includes('/invoice/')) return json({ Invoice: invoice(null) });
      return fetch(url);
    },
  }), /returned no balance/);
});

test('QuickBooks note capacity fails explicitly without overwriting, but payment remains independent', async () => {
  let paid = false;
  let annotationWrites = 0;
  const tooLong = 'x'.repeat(3990);
  const fetch = async (url, init = {}) => {
    if (url.includes('/query?')) {
      return json({ QueryResponse: { Payment: paid ? [{
        Id: 'pay-1', PrivateNote: `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}`,
        Line: [{ Amount: 61, LinkedTxn: [{ TxnId: 'invoice-1', TxnType: 'Invoice' }] }],
      }] : [] } });
    }
    if (url.includes('/account/')) return json({ Account: { Id: 'bank-1', Active: true, AccountType: 'Bank' } });
    if (url.includes('/invoice?') && init.method === 'POST') {
      annotationWrites += 1;
      throw new Error('annotation should not be written');
    }
    if (url.includes('/payment?')) {
      paid = true;
      return json({ Payment: { Id: 'pay-1' } });
    }
    return json({ Invoice: {
      Id: 'invoice-1', DocNumber: 'Q-1', SyncToken: '1', TotalAmt: 61,
      Balance: paid ? 0 : 61, CurrencyRef: { value: 'GBP' },
      CustomerRef: { value: 'customer-1' }, PrivateNote: tooLong,
    } });
  };
  const result = await settleFormStripeQuickBooksInvoice(baseArgs, {
    fetch,
    supabase: settings({ quickbooks_stripe_bank_account_id: 'bank-1' }),
    getValidQuickBooksAccessToken: async () => ({ accessToken: 'token', realmId: 'realm', environment: 'sandbox' }),
  });
  assert.equal(result.payment_recorded, true);
  assert.equal(result.annotation_recorded, false);
  assert.equal(result.settlement_state, 'retry');
  assert.match(result.error, /cannot fit/);
  assert.equal(annotationWrites, 0);
});

test('QuickBooks payment inspection paginates beyond 1000 records', async () => {
  const starts = [];
  const matching = {
    Id: 'pay-match', PrivateNote: `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}`,
    Line: [{ Amount: 61, LinkedTxn: [{ TxnId: 'invoice-1', TxnType: 'Invoice' }] }],
  };
  const fetch = async (url) => {
    if (url.includes('/query?')) {
      const query = decodeURIComponent(new URL(url).searchParams.get('query'));
      starts.push(Number(/STARTPOSITION (\d+)/.exec(query)[1]));
      return json({ QueryResponse: { Payment: starts.length === 1
        ? Array.from({ length: 1000 }, (_, index) => ({ Id: `old-${index}`, PrivateNote: 'unrelated' }))
        : [matching] } });
    }
    if (url.includes('/invoice/')) {
      return json({ Invoice: {
        Id: 'invoice-1', DocNumber: 'Q-1', SyncToken: '1', TotalAmt: 61, Balance: 0,
        CurrencyRef: { value: 'GBP' }, CustomerRef: { value: 'customer-1' },
        PrivateNote: `Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}`,
      } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await settleFormStripeQuickBooksInvoice({ ...baseArgs, dryRun: true }, {
    fetch,
    supabase: settings({}),
    getValidQuickBooksAccessToken: async () => ({ accessToken: 'token', realmId: 'realm', environment: 'sandbox' }),
  });
  assert.equal(result.settlement_state, 'done');
  assert.deepEqual(starts, [1, 1001]);
});

test('settlement rejects a changed remote provider context before invoice access', async () => {
  let fetched = false;
  await assert.rejects(settleFormStripeXeroInvoice({
    ...baseArgs,
    expectedProviderContext: { xero_tenant_id: 'original-org' },
  }, {
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
    supabase: settings({}),
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'replacement-org' }),
  }), /does not match/);
  assert.equal(fetched, false);

  await assert.rejects(settleFormStripeQuickBooksInvoice({
    ...baseArgs,
    expectedProviderContext: { quickbooks_realm_id: 'original-realm' },
  }, {
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
    supabase: settings({}),
    getValidQuickBooksAccessToken: async () => ({
      accessToken: 'token', realmId: 'replacement-realm', environment: 'sandbox',
    }),
  }), /does not match/);
  assert.equal(fetched, false);
});

test('annotationOnly never reads an account or posts payment, including manually paid invoices', async () => {
  let history = [];
  let accountOrPaymentCalls = 0;
  const fetch = async (url, init = {}) => {
    assert.ok(init.signal instanceof AbortSignal);
    if (url.includes('/History') && init.method === 'PUT') {
      history = JSON.parse(init.body).HistoryRecords;
      return json({ HistoryRecords: history });
    }
    if (url.includes('/History')) return json({ HistoryRecords: history });
    if (url.includes('/Accounts') || url.endsWith('/Payments')) {
      accountOrPaymentCalls += 1;
      throw new Error('annotationOnly must not reach settlement calls');
    }
    return json({ Invoices: [{
      InvoiceID: 'invoice-1', InvoiceNumber: 'INV-1', Status: 'PAID',
      Total: 61, AmountDue: 0, CurrencyCode: 'GBP', Payments: [],
    }] });
  };
  const result = await settleFormStripeXeroInvoice({
    ...baseArgs, annotationOnly: true,
  }, {
    fetch,
    supabase: settings({ xero_stripe_bank_account_code: 'STRIPE' }),
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
  });
  assert.equal(result.annotation_recorded, true);
  assert.equal(result.payment_recorded, false);
  assert.equal(result.settlement_state, 'blocked');
  assert.equal(accountOrPaymentCalls, 0);
  assert.deepEqual(result.provider_context, { xero_tenant_id: 'org' });
});

test('Xero discovery returns only a unique exact deferred membership trace', async () => {
  const fetch = async (url, init = {}) => {
    assert.ok(init.signal instanceof AbortSignal);
    const page = Number(new URL(url).searchParams.get('page'));
    assert.equal(page, 1);
    return json({ Invoices: [{
      InvoiceID: 'found-xero', InvoiceNumber: 'INV-42', Total: 61, AmountDue: 61,
      CurrencyCode: 'GBP',
      LineItems: [{ Description: `Membership\nForm membership Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}` }],
    }, {
      InvoiceID: 'prefix-only', InvoiceNumber: 'INV-43', Total: 61, AmountDue: 61,
      CurrencyCode: 'GBP',
      LineItems: [{ Description: `Form membership Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}MORE` }],
    }] });
  };
  const found = await findFormStripeXeroInvoice({
    appTenantId: baseArgs.appTenantId,
    stripePaymentIntentId: baseArgs.stripePaymentIntentId,
    createdAfter: '2026-01-01T00:00:00Z',
    expectedProviderContext: { xero_tenant_id: 'org' },
  }, {
    fetch,
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
  });
  assert.equal(found.invoice_id, 'found-xero');
  assert.deepEqual(found.provider_context, { xero_tenant_id: 'org' });
});

test('QuickBooks discovery paginates and fails closed on duplicate exact traces', async () => {
  let page = 0;
  const marked = (id) => ({
    Id: id, DocNumber: id, TotalAmt: 61, Balance: 61, CurrencyRef: { value: 'GBP' },
    PrivateNote: `Form membership Stripe PaymentIntent: ${baseArgs.stripePaymentIntentId}`,
    MetaData: { CreateTime: '2026-01-02T12:00:00Z' },
  });
  const fetch = async (url, init = {}) => {
    assert.ok(init.signal instanceof AbortSignal);
    page += 1;
    return json({ QueryResponse: { Invoice: page === 1
      ? [...Array.from({ length: 999 }, (_, index) => ({
        Id: `old-${index}`, PrivateNote: 'other', MetaData: { CreateTime: '2026-01-02T12:00:00Z' },
      })), marked('duplicate-a')]
      : [marked('duplicate-b')] } });
  };
  await assert.rejects(findFormStripeQuickBooksInvoice({
    appTenantId: baseArgs.appTenantId,
    stripePaymentIntentId: baseArgs.stripePaymentIntentId,
    createdAfter: '2026-01-01T00:00:00Z',
    expectedProviderContext: { quickbooks_realm_id: 'realm' },
  }, {
    fetch,
    getValidQuickBooksAccessToken: async () => ({
      accessToken: 'token', realmId: 'realm', environment: 'sandbox',
    }),
  }), /Multiple QuickBooks membership invoices/);
  assert.equal(page, 2);
});

test('membership creation rejects provider-context mismatch before contact or invoice writes', async () => {
  let xeroContacts = 0;
  await assert.rejects(createXeroMembershipInvoice({
    appTenantId: 'tenant-1',
    organizationName: 'Organisation',
    expectedProviderContext: { xero_tenant_id: 'original-org' },
  }, {
    supabase: {},
    getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'replacement-org' }),
    findOrCreateXeroContact: async () => { xeroContacts += 1; return 'contact'; },
  }), /does not match/);
  assert.equal(xeroContacts, 0);

  let qboCustomers = 0;
  await assert.rejects(createQuickBooksMembershipInvoice({
    appTenantId: 'tenant-1',
    organizationName: 'Organisation',
    expectedProviderContext: {
      quickbooks_realm_id: 'original-realm',
      environment: 'sandbox',
    },
  }, {
    getValidQuickBooksAccessToken: async () => ({
      accessToken: 'token', realmId: 'replacement-realm', environment: 'sandbox',
    }),
    findOrCreateQuickBooksCustomer: async () => { qboCustomers += 1; return 'customer'; },
  }), /does not match/);
  assert.equal(qboCustomers, 0);
});

test('QBO customer resolution validates its pinned connection before any request', async () => {
  await assert.rejects(findOrCreateQuickBooksCustomer('tenant-1', {
    name: 'Organisation',
  }, {
    accessToken: 'token',
    realmId: 'replacement-realm',
    environment: 'sandbox',
    expectedProviderContext: {
      quickbooks_realm_id: 'original-realm',
      environment: 'sandbox',
    },
  }), /does not match/);
});

test('provider HTTP errors retain exact status for finalizer ambiguity classification', async () => {
  for (const status of [400, 408, 409, 429]) {
    await assert.rejects(findFormStripeXeroInvoice({
      appTenantId: 'tenant-1',
      stripePaymentIntentId: baseArgs.stripePaymentIntentId,
      createdAfter: '2026-01-01T00:00:00Z',
    }, {
      getValidXeroAccessToken: async () => ({ accessToken: 'token', tenantId: 'org' }),
      fetch: async () => json({ Type: 'ProviderError' }, status),
    }), (error) => error.status === status && error.statusCode === status);

    await assert.rejects(findFormStripeQuickBooksInvoice({
      appTenantId: 'tenant-1',
      stripePaymentIntentId: baseArgs.stripePaymentIntentId,
      createdAfter: '2026-01-01T00:00:00Z',
    }, {
      getValidQuickBooksAccessToken: async () => ({
        accessToken: 'token', realmId: 'realm', environment: 'sandbox',
      }),
      fetch: async () => json({ Fault: { Error: [{ Message: 'ProviderError' }] } }, status),
    }), (error) => error.status === status && error.statusCode === status);
  }
});