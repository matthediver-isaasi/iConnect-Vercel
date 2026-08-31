import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeSalesInvoiceStatus, validateSalesInvoiceCommand,
} from '../../shared/salesContracts.js';
import {
  buildInvoice, buildSalesProviderIdempotencyKey, createSalesInvoice, invoiceClaimOutcome, mapSalesInvoiceLink,
  getSalesAccountingConfiguration, releaseCustomerMappingClaim, salesInvoicePermissions,
  saveSalesAccountingConfiguration, selectSalesInvoiceForProvider,
} from './salesAccounting.js';
import {
  buildQuickBooksSalesInvoicePayload, createQuickBooksSalesInvoice, quickBooksRequestId,
} from './quickbooks.js';
import {
  buildXeroSalesInvoiceLine, buildXeroSalesInvoicePayload, createXeroSalesInvoice,
} from './xero.js';
import { SalesHttpError } from './salesAccess.js';
import { salesQuoteErrorBody } from '../sales/quotes/[...path].js';
import { validateSalesAccountingConfigurationPatch } from '../../shared/salesContracts.js';
import { createSalesAccountingHandler } from '../sales/accounting/[...path].js';

test('commercial invoice command cannot override accepted quote values', () => {
  assert.deepEqual(validateSalesInvoiceCommand({}), { ok: true, errors: [] });
  assert.equal(validateSalesInvoiceCommand({ currency: 'USD' }).ok, false);
  assert.equal(validateSalesInvoiceCommand({
    providerCustomerId: '42', confirmCustomerMatch: false,
  }).ok, false);
  assert.equal(validateSalesInvoiceCommand({
    providerCustomerId: '42', confirmCustomerMatch: true,
  }).ok, true);
});

test('accounting configuration patch contract is strict', () => {
  assert.equal(validateSalesAccountingConfigurationPatch({
    mappings: [{ taxRateBps: 0, providerTaxCodeId: 'NONE' }],
  }).ok, true);
  assert.equal(validateSalesAccountingConfigurationPatch({
    provider: 'xero', mappings: [{ taxRateBps: 0, providerTaxCodeId: 'NONE' }],
  }).ok, false);
  assert.equal(validateSalesAccountingConfigurationPatch({ mappings: [] }).ok, false);
});

function configurationDb(state) {
  const rpcCalls = [];
  const db = {
    rpcCalls,
    from(table) {
      const result = () => {
        if (table === 'sales_accounting_tax_mapping') return { data: state.mappings, error: null };
        if (table === 'sales_commercial_sale') return { data: [{ quote_version_id: 'version' }], error: null };
        if (table === 'sales_quote_line') return { data: state.lines, error: null };
        return { data: null, error: null };
      };
      const query = {
        select() { return query; }, eq() { return query; }, in() { return query; },
        order() { return query; }, limit() { return query; },
        async maybeSingle() {
          if (table === 'sales_settings') return { data: { default_tax_rate_bps: state.defaultRate }, error: null };
          if (table === 'system_settings') return { data: state.itemId ? { setting_value: state.itemId } : null, error: null };
          return result();
        },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name !== 'save_sales_accounting_configuration') throw new Error(`Unexpected RPC ${name}`);
      state.mappings = args.p_mappings.map((mapping) => ({
        tax_rate_bps: mapping.taxRateBps, provider_tax_code: mapping.providerTaxCodeId,
        provider_tax_name: mapping.providerTaxCodeName,
      }));
      if (args.p_provider === 'quickbooks') state.itemId = args.p_quickbooks_sales_item_id;
      return { data: null, error: null };
    },
  };
  return db;
}

test('fresh Xero configuration discovers required zero/default/accepted rates and becomes ready', async () => {
  const state = { mappings: [], lines: [{ tax_rate_bps: 0 }, { tax_rate_bps: 2000 }],
    defaultRate: 2000, itemId: null };
  const db = configurationDb(state);
  const deps = {
    getActiveAccountingProvider: async () => 'xero',
    getAccountingProviderByName: () => ({
      listSalesTaxCodes: async () => [{ id: 'NONE', name: 'No Tax' }, { id: 'OUTPUT2', name: '20% VAT' }],
      listSalesItems: async () => [],
    }),
  };
  const fresh = await getSalesAccountingConfiguration(db, 'tenant', deps);
  assert.deepEqual(fresh.requiredTaxRates, [0, 2000]);
  assert.equal(fresh.isReady, false);
  const saved = await saveSalesAccountingConfiguration(db, 'tenant', {
    mappings: [
      { taxRateBps: 0, providerTaxCodeId: 'NONE' },
      { taxRateBps: 2000, providerTaxCodeId: 'OUTPUT2' },
    ],
  }, deps);
  assert.equal(saved.isReady, true);
  assert.deepEqual(saved.mappings.map((mapping) => mapping.providerTaxCodeName), ['No Tax', '20% VAT']);
});

test('fresh QBO configuration requires a live sales item and rejects unknown selections', async () => {
  const state = { mappings: [], lines: [{ tax_rate_bps: 0 }], defaultRate: 0, itemId: null };
  const db = configurationDb(state);
  const deps = {
    getActiveAccountingProvider: async () => 'quickbooks',
    getAccountingProviderByName: () => ({
      listSalesTaxCodes: async () => [{ id: 'NON', name: 'Non-taxable' }],
      listSalesItems: async () => [{ id: 'item-1', name: 'Sales' }],
    }),
  };
  await assert.rejects(() => saveSalesAccountingConfiguration(db, 'tenant', {
    mappings: [{ taxRateBps: 0, providerTaxCodeId: 'other-tenant-code' }],
    quickbooksSalesItemId: 'item-1',
  }, deps), (error) => error.code === 'ACCOUNTING_TAX_CODE_INVALID');
  await assert.rejects(() => saveSalesAccountingConfiguration(db, 'tenant', {
    mappings: [{ taxRateBps: 0, providerTaxCodeId: 'NON' }],
    quickbooksSalesItemId: 'other-tenant-item',
  }, deps), (error) => error.code === 'ACCOUNTING_SALES_ITEM_INVALID');
  const saved = await saveSalesAccountingConfiguration(db, 'tenant', {
    mappings: [{ taxRateBps: 0, providerTaxCodeId: 'NON' }],
    quickbooksSalesItemId: 'item-1',
  }, deps);
  assert.equal(saved.isReady, true);
  assert.equal(saved.quickbooksSalesItemId, 'item-1');
});

test('conversion reports actionable missing tax and QBO item configuration', async () => {
  const version = { currency: 'GBP', net_minor: 100, tax_minor: 0, gross_minor: 100 };
  const lines = [{ description: 'Zero tax', quantity: '1', quoted_unit_price_minor: 100,
    discount_bps: 0, tax_rate_bps: 0, net_minor: 100, tax_minor: 0, gross_minor: 100 }];
  const dbFor = (taxRows, setting) => ({
    from(table) {
      const result = table === 'sales_accounting_tax_mapping'
        ? { data: taxRows, error: null } : { data: setting, error: null };
      const query = { select() { return query; }, eq() { return query; }, in() { return query; },
        async maybeSingle() { return result; },
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); } };
      return query;
    },
  });
  await assert.rejects(
    () => buildInvoice(dbFor([], null), 'tenant', { id: 'sale' }, version, lines, 'xero', 'customer'),
    (error) => error.code === 'ACCOUNTING_TAX_MAPPING_REQUIRED'
      && error.details.missingTaxRates[0] === 0,
  );
  await assert.rejects(
    () => buildInvoice(dbFor([{ tax_rate_bps: 0, provider_tax_code: 'NON' }], null),
      'tenant', { id: 'sale' }, version, lines, 'quickbooks', 'customer'),
    (error) => error.code === 'ACCOUNTING_SALES_ITEM_REQUIRED'
      && error.details.provider === 'quickbooks',
  );
});

test('configuration rejects no provider and member-only access', async () => {
  await assert.rejects(() => getSalesAccountingConfiguration({}, 'tenant', {
    getActiveAccountingProvider: async () => 'none',
  }), (error) => error.code === 'ACCOUNTING_PROVIDER_NONE');
  const handler = createSalesAccountingHandler({
    db: {},
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant', memberId: 'member', roleId: 'role',
    }),
    hasFeatureAccess: async () => true,
  });
  const response = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, setHeader() {} };
  await handler({ method: 'GET', query: { path: ['configuration'] } }, response);
  assert.equal(response.statusCode, 403);
});

test('provider statuses normalize without exposing provider vocabulary', () => {
  assert.equal(normalizeSalesInvoiceStatus('AUTHORISED'), 'authorised');
  assert.equal(normalizeSalesInvoiceStatus('Unpaid'), 'open');
  assert.equal(normalizeSalesInvoiceStatus('PAID'), 'paid');
  assert.equal(normalizeSalesInvoiceStatus('not-a-ledger-status'), 'unknown');
});

test('invoice DTO is normalized and provider switches retain history', () => {
  const links = [
    mapSalesInvoiceLink({ id: 'x-link', sale_id: 'sale', quote_version_id: 'version', provider: 'xero',
      provider_invoice_id: 'x-1', provider_invoice_number: 'INV-1', provider_status: 'authorised' }),
    mapSalesInvoiceLink({ id: 'q-link', sale_id: 'sale', quote_version_id: 'version', provider: 'quickbooks',
      provider_invoice_id: 'q-1', provider_invoice_number: '1001', provider_status: 'open' }),
  ];
  assert.deepEqual(selectSalesInvoiceForProvider(links, 'quickbooks'), links[1]);
  assert.equal(selectSalesInvoiceForProvider(links, 'none'), null);
  assert.deepEqual(salesInvoicePermissions({
    canManageAccounting: true, canView: true, saleId: 'sale', activeProvider: 'quickbooks', invoice: links[1],
  }), { canCreateInvoice: false, canRetryInvoice: false, canViewInvoice: true });
  assert.deepEqual(salesInvoicePermissions({
    canManageAccounting: true, canView: true, saleId: 'sale', activeProvider: 'quickbooks', invoice: null,
  }), { canCreateInvoice: true, canRetryInvoice: true, canViewInvoice: true });
  assert.equal(salesInvoicePermissions({
    canManageAccounting: true, canView: true, saleId: 'sale', activeProvider: 'none', invoice: null,
  }).canCreateInvoice, false);
});

test('quote handler preserves ambiguous customer candidates', () => {
  const error = new SalesHttpError(409, 'Provider customer match requires explicit confirmation');
  error.code = 'AMBIGUOUS_CUSTOMER_MATCH';
  error.details = { candidates: [{ id: 'xero-contact', name: 'Acme' }] };
  assert.deepEqual(salesQuoteErrorBody(error), {
    status: 409,
    body: { error: error.message, code: error.code, details: error.details },
  });
});

test('a concurrent durable claim returns a stable retryable response', () => {
  assert.throws(() => invoiceClaimOutcome({ state: 'in_progress', attemptId: 'attempt-1' }), (error) =>
    error.status === 409 && error.code === 'ACCOUNTING_INVOICE_IN_PROGRESS'
      && error.details.retryable === true && error.details.attemptId === 'attempt-1');
  assert.deepEqual(invoiceClaimOutcome({ state: 'claimed', attemptId: 'attempt-1', providerIdempotencyKey: 'same-key' }),
    { state: 'claimed', attemptId: 'attempt-1', providerIdempotencyKey: 'same-key' });
});

test('provider keys are 50 chars and do not collide on shared UUID prefixes', () => {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const first = buildSalesProviderIdempotencyKey(tenant, '1234567a-0000-4000-8000-000000000001', 'quickbooks');
  const second = buildSalesProviderIdempotencyKey(tenant, '1234567b-0000-4000-8000-000000000002', 'quickbooks');
  assert.equal(first.length, 50);
  assert.equal(second.length, 50);
  assert.notEqual(first, second);
  assert.equal(quickBooksRequestId(first), first);
  assert.throws(() => quickBooksRequestId(`${first}x`), /1-50/);
});

test('customer claims release immediately and cannot release a reclaimed owner', async () => {
  const calls = [];
  const ownedDb = { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: true, error: null };
  } };
  assert.equal(await releaseCustomerMappingClaim(ownedDb, 'tenant', {
    mappingId: 'mapping', claimToken: 'token-one',
  }), true);
  assert.deepEqual(calls[0], {
    name: 'release_sales_accounting_customer_mapping_claim',
    args: { p_tenant_id: 'tenant', p_mapping_id: 'mapping', p_claim_token: 'token-one' },
  });
  const reclaimedDb = { rpc: async () => ({ data: false, error: null }) };
  assert.equal(await releaseCustomerMappingClaim(reclaimedDb, 'tenant', {
    mappingId: 'mapping', claimToken: 'old-token',
  }), false);
  const brokenDb = { rpc: async () => ({ data: null, error: new Error('release failed') }) };
  await assert.rejects(() => releaseCustomerMappingClaim(brokenDb, 'tenant', {
    mappingId: 'mapping', claimToken: 'token',
  }), /release failed/);
});

test('migration enforces one immutable-source link per sale and provider', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20260912_sales_accounting_invoice.sql', import.meta.url), 'utf8');
  assert.match(sql, /UNIQUE\(tenant_id,sale_id,provider\)/);
  assert.match(sql, /FOREIGN KEY\(tenant_id,quote_version_id\) REFERENCES public\.sales_quote_version/);
  assert.match(sql, /provider_idempotency_key text NOT NULL/);
  assert.match(sql, /Organisation does not belong to accounting mapping tenant/);
  assert.match(sql, /confirmed_at IS NOT NULL/);
  assert.match(sql, /claim_sales_accounting_invoice_attempt/);
  assert.match(sql, /state','in_progress/);
  assert.match(sql, /Invoice link quote version must equal sale quote version/);
  assert.match(sql, /Accounting invoice linkage source fields are immutable/);
  assert.match(sql, /claim_token=p_claim_token/);
  assert.match(sql, /release_sales_accounting_customer_mapping_claim/);
  assert.match(sql, /'si_'\|\|substr\(encode\(extensions\.digest/);
  assert.match(sql, /save_sales_accounting_configuration/);
  assert.match(sql, /DELETE FROM public\.sales_accounting_tax_mapping WHERE tenant_id=p_tenant_id AND provider=p_provider/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.save_sales_accounting_configuration/);
});

test('invoice-link unique conflicts are never treated as a successful different-sale link', async () => {
  const source = await readFile(new URL('./salesAccounting.js', import.meta.url), 'utf8');
  assert.match(source, /Provider invoice is already linked to another commercial sale/);
  assert.match(source, /ACCOUNTING_INVOICE_LINK_CONFLICT/);
  // The fallback is deliberately scoped to the same sale/provider, rather
  // than selecting by provider invoice id and accidentally repointing history.
  assert.match(source, /existingLink\(db, tenantId, sale\.id, provider\.name\)/);
});

test('QBO payload preserves accepted discounted net without double discount', () => {
  const payload = buildQuickBooksSalesInvoicePayload({
    customerId: 'customer', currency: 'GBP', purchaseOrderReference: 'PO-1',
    lines: [{ description: 'Fractional discounted sale', itemId: 'item', quantity: '2.5',
      netMinor: 251, unitPriceMinor: 125, discountBps: 100, taxCode: 'VAT' }],
  });
  const line = payload.Line[0];
  assert.equal(line.Amount, 2.51);
  assert.equal(line.SalesItemLineDetail.Qty, 2.5);
  assert.equal(line.SalesItemLineDetail.UnitPrice * line.SalesItemLineDetail.Qty, 2.51);
  assert.equal('DiscountRate' in line.SalesItemLineDetail, false);
  assert.equal(payload.PONumber, 'PO-1');
});

const qboAcceptedInvoice = () => ({
  customerId: 'customer', currency: 'GBP', netMinor: 253, taxMinor: 51, grossMinor: 304,
  purchaseOrderReference: 'PO-1', customerReference: 'REF-1',
  idempotencyKey: 'si_12345678901234567890123456789012345678901234567',
  lines: [{ description: 'Fractional accepted line', itemId: 'item', quantity: '2.5',
    netMinor: 253, taxMinor: 51, grossMinor: 304, unitPriceMinor: 101,
    discountBps: 1, taxCode: 'VAT' }],
});
const jsonResponse = (body) => ({
  ok: true, status: 200, headers: { get: () => 'application/json' },
  async json() { return body; }, async text() { return JSON.stringify(body); },
});
const withMockedFetch = async (readbackInvoice, operation, postInvoice = { Id: 'qbo-1' }) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? jsonResponse({ Invoice: postInvoice })
      : jsonResponse({ Invoice: readbackInvoice });
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = original;
  }
};
const qboDependencies = {
  getValidQuickBooksAccessToken: async () => ({
    accessToken: 'access', realmId: 'realm', environment: 'sandbox',
  }),
};
const exactQboReadback = () => ({
  Id: 'qbo-1', DocNumber: '1001', Balance: 3.04, TotalAmt: 3.04, InvoiceLink: 'https://invoice',
  TxnTaxDetail: { TotalTax: 0.51 },
  Line: [{ Id: '1', DetailType: 'SalesItemLineDetail', Amount: 2.53 }],
  MetaData: { CreateTime: '2026-01-01T00:00:00Z' },
});

test('QBO production create verifies exact read-back, including idempotent replay', async () => {
  await withMockedFetch(exactQboReadback(), async (calls) => {
    const result = await createQuickBooksSalesInvoice('tenant', qboAcceptedInvoice(), qboDependencies);
    assert.equal(result.id, 'qbo-1');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /requestid=si_12345678901234567890123456789012345678901234567/);
    assert.match(calls[1].url, /invoice\/qbo-1\?include=invoiceLink/);
  }, { Id: 'qbo-1', DocNumber: 'replayed-post-response' });
});

test('QBO rejects sub-cent effective UnitPrice before provider fetch', async () => {
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  try {
    const invoice = qboAcceptedInvoice();
    invoice.netMinor = 1; invoice.taxMinor = 0; invoice.grossMinor = 1;
    invoice.lines = [{ ...invoice.lines[0], quantity: '100', netMinor: 1, taxMinor: 0, grossMinor: 1 }];
    await assert.rejects(() => createQuickBooksSalesInvoice('tenant', invoice, qboDependencies),
      (error) => error.code === 'ACCOUNTING_UNREPRESENTABLE');
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = original;
  }
});

for (const [name, mutate, field] of [
  ['line net mismatch', (invoice) => { invoice.Line[0].Amount = 2.52; }, 'lineNet'],
  ['tax rounding mismatch', (invoice) => { invoice.TxnTaxDetail.TotalTax = 0.50; }, 'tax'],
  ['gross mismatch', (invoice) => { invoice.TotalAmt = 3.03; }, 'gross'],
]) {
  test(`QBO fails closed on provider ${name}`, async () => {
    const readback = exactQboReadback(); mutate(readback);
    await withMockedFetch(readback, async () => {
      await assert.rejects(
        () => createQuickBooksSalesInvoice('tenant', qboAcceptedInvoice(), qboDependencies),
        (error) => error.code === 'ACCOUNTING_TOTAL_MISMATCH' && error.details.field === field,
      );
    });
  });
}

test('QBO verifies explicit zero tax as zero', async () => {
  const accepted = qboAcceptedInvoice();
  accepted.taxMinor = 0; accepted.grossMinor = 253; accepted.lines[0].taxMinor = 0; accepted.lines[0].grossMinor = 253;
  const readback = exactQboReadback();
  readback.TxnTaxDetail.TotalTax = 0; readback.TotalAmt = 2.53; readback.Balance = 2.53;
  await withMockedFetch(readback, async () => {
    const result = await createQuickBooksSalesInvoice('tenant', accepted, qboDependencies);
    assert.equal(result.id, 'qbo-1');
  });
});

test('Xero payload round-trips accepted fractional-quantity net, tax, and gross', () => {
  const accepted = {
    description: 'Discounted fractional quantity', quantity: '2.5',
    // The immutable quote calculation rounds this fractional-quantity line to
    // 253 minor net. Representing that total requires a 101.2-minor effective
    // Xero unit and must not reapply the original quote discount.
    unitPriceMinor: 101, discountBps: 1, netMinor: 253, taxMinor: 51,
    grossMinor: 304, accountCode: '200', taxCode: 'OUTPUT2',
  };
  const line = buildXeroSalesInvoiceLine(accepted);
  assert.equal(line.Quantity, 2.5);
  assert.equal(line.UnitAmount, 1.012);
  assert.equal(line.TaxAmount, 0.51);
  assert.equal(Math.round(line.Quantity * line.UnitAmount * 100), accepted.netMinor);
  assert.equal(Math.round((line.Quantity * line.UnitAmount + line.TaxAmount) * 100), accepted.grossMinor);
  assert.equal('DiscountRate' in line, false);
  const payload = buildXeroSalesInvoicePayload({
    customerId: 'contact', currency: 'GBP', lines: [accepted],
  });
  assert.deepEqual(payload.Invoices[0].LineItems[0], line);
  assert.equal(payload.Invoices[0].LineAmountTypes, 'Exclusive');
});

const xeroAcceptedInvoice = () => ({
  customerId: 'contact', currency: 'GBP', netMinor: 253, taxMinor: 51, grossMinor: 304,
  purchaseOrderReference: 'PO-1', customerReference: 'REF-1',
  idempotencyKey: 'si_12345678901234567890123456789012345678901234567',
  lines: [{ description: 'Fractional accepted line', quantity: '2.5',
    netMinor: 253, taxMinor: 51, grossMinor: 304, unitPriceMinor: 101,
    discountBps: 1, accountCode: '200', taxCode: 'OUTPUT2' }],
});
const exactXeroReadback = () => ({
  InvoiceID: 'xero-1', InvoiceNumber: 'INV-1', Status: 'AUTHORISED',
  SubTotal: 2.53, TotalTax: 0.51, Total: 3.04,
  LineItems: [{ LineItemID: 'line-1', LineAmount: 2.53 }],
  DateString: '2026-01-01T00:00:00Z',
});
const xeroDependencies = {
  getValidXeroAccessToken: async () => ({ accessToken: 'access', tenantId: 'xero-tenant' }),
};
const withMockedXeroFetch = async (readback, operation, postInvoice = { InvoiceID: 'xero-1' }) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse({ Invoices: [postInvoice] });
    if (calls.length === 2) return jsonResponse({ Invoices: [readback] });
    return jsonResponse({ OnlineInvoices: [{ OnlineInvoiceUrl: 'https://xero.example/invoice' }] });
  };
  try { return await operation(calls); } finally { globalThis.fetch = original; }
};

test('Xero production create verifies exact read-back after idempotent replay', async () => {
  await withMockedXeroFetch(exactXeroReadback(), async (calls) => {
    const result = await createXeroSalesInvoice('tenant', xeroAcceptedInvoice(), xeroDependencies);
    assert.equal(result.id, 'xero-1');
    assert.equal(result.number, 'INV-1');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].init.headers['Idempotency-Key'],
      'si_12345678901234567890123456789012345678901234567');
    assert.match(calls[1].url, /Invoices\/xero-1\?unitdp=4/);
  }, { InvoiceID: 'xero-1', InvoiceNumber: 'replayed-response-is-not-trusted' });
});

for (const [name, mutate, field] of [
  ['line/net mismatch', (invoice) => { invoice.LineItems[0].LineAmount = 2.52; }, 'lineNet'],
  ['subtotal mismatch', (invoice) => { invoice.SubTotal = 2.52; }, 'subtotal'],
  ['tax mismatch', (invoice) => { invoice.TotalTax = 0.50; }, 'tax'],
  ['gross mismatch', (invoice) => { invoice.Total = 3.03; }, 'gross'],
]) {
  test(`Xero fails closed on provider ${name}`, async () => {
    const readback = exactXeroReadback(); mutate(readback);
    await withMockedXeroFetch(readback, async (calls) => {
      await assert.rejects(
        () => createXeroSalesInvoice('tenant', xeroAcceptedInvoice(), xeroDependencies),
        (error) => error.code === 'ACCOUNTING_TOTAL_MISMATCH' && error.details.field === field,
      );
      // Verification fails before the optional OnlineInvoice request and
      // before createSalesInvoice can persist a linkage.
      assert.equal(calls.length, 2);
    });
  });
}

test('Xero verifies explicit zero tax as zero', async () => {
  const accepted = xeroAcceptedInvoice();
  accepted.taxMinor = 0; accepted.grossMinor = 253;
  accepted.lines[0].taxMinor = 0; accepted.lines[0].grossMinor = 253;
  const readback = exactXeroReadback();
  readback.TotalTax = 0; readback.Total = 2.53;
  await withMockedXeroFetch(readback, async () => {
    const result = await createXeroSalesInvoice('tenant', accepted, xeroDependencies);
    assert.equal(result.id, 'xero-1');
  });
});

test('persisted accepted line assembly carries exact amounts into mocked Xero create', async () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const saleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const organisationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const line = {
    id: 'line', tenant_id: tenantId, quote_version_id: versionId, display_order: 0,
    description: 'Persisted fractional discounted line', quantity: '2.500000',
    quoted_unit_price_minor: 101, discount_bps: 1, tax_rate_bps: 2000,
    net_minor: 253, tax_minor: 51, gross_minor: 304,
  };
  const version = {
    id: versionId, status: 'converted', currency: 'GBP', tax_treatment: 'standard',
    organisation_snapshot: { id: organisationId, name: 'Accepted Customer' },
    net_minor: 253, tax_minor: 51, gross_minor: 304,
    purchase_order_reference: 'PO-ACCEPTED', customer_reference: 'REF-ACCEPTED',
  };
  const resolve = (table, mode) => {
    if (mode === 'insert' && table === 'sales_accounting_invoice_link') {
      return { data: { id: 'link', tenant_id: tenantId, sale_id: saleId,
        quote_version_id: versionId, provider: 'xero', provider_invoice_id: 'xero-invoice',
        provider_invoice_number: 'INV-1', provider_status: 'authorised' }, error: null };
    }
    if (mode === 'update') return { data: null, error: null };
    if (table === 'sales_quote_line') return { data: [line], error: null };
    if (table === 'sales_accounting_tax_mapping') {
      return { data: [{ tax_rate_bps: 2000, provider_tax_code: 'OUTPUT2' }], error: null };
    }
    return { data: null, error: null };
  };
  const db = {
    from(table) {
      let mode = 'select';
      const query = {
        select() { return query; }, eq() { return query; }, in() { return query; },
        order() { return query; }, limit() { return query; },
        insert() { mode = 'insert'; return query; },
        update() { mode = 'update'; return query; },
        async maybeSingle() {
          if (table === 'sales_accounting_invoice_link') return { data: null, error: null };
          if (table === 'sales_commercial_sale') {
            return { data: { id: saleId, quote_version_id: versionId }, error: null };
          }
          if (table === 'sales_quote_version') return { data: version, error: null };
          if (table === 'system_settings') return { data: { setting_value: '200' }, error: null };
          return resolve(table, mode);
        },
        async single() { return resolve(table, mode); },
        then(onFulfilled, onRejected) {
          return Promise.resolve(resolve(table, mode)).then(onFulfilled, onRejected);
        },
      };
      return query;
    },
    async rpc(name) {
      if (name === 'claim_sales_accounting_invoice_attempt') {
        return { data: { state: 'claimed', attemptId: 'attempt',
          providerIdempotencyKey: 'si_12345678901234567890123456789012345678901234567' }, error: null };
      }
      if (name === 'claim_sales_accounting_customer_mapping') {
        return { data: { state: 'mapped', customerId: 'xero-contact' }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  let received;
  const provider = {
    name: 'xero',
    async createSalesInvoice(_tenantId, payload) {
      received = payload;
      // Exercise the actual adapter representation before simulating Xero.
      const xeroPayload = buildXeroSalesInvoicePayload(payload);
      assert.equal(xeroPayload.Invoices[0].LineItems[0].TaxAmount, 0.51);
      return { id: 'xero-invoice', number: 'INV-1', status: 'AUTHORISED' };
    },
  };
  const result = await createSalesInvoice(db, tenantId, { actorId: 'actor' }, saleId, {}, {
    getAccountingProvider: async () => provider,
  });
  assert.deepEqual({
    documentNetMinor: received.netMinor,
    documentTaxMinor: received.taxMinor,
    documentGrossMinor: received.grossMinor,
    quantity: received.lines[0].quantity,
    netMinor: received.lines[0].netMinor,
    taxMinor: received.lines[0].taxMinor,
    grossMinor: received.lines[0].grossMinor,
  }, {
    documentNetMinor: 253, documentTaxMinor: 51, documentGrossMinor: 304,
    quantity: '2.500000', netMinor: 253, taxMinor: 51, grossMinor: 304,
  });
  assert.equal(result.invoice.invoiceId, 'xero-invoice');
});

test('Xero fails closed when four-decimal unit representation would drift', () => {
  assert.throws(() => buildXeroSalesInvoiceLine({
    description: 'Unrepresentable', quantity: '100000', netMinor: 1,
    taxMinor: 0, grossMinor: 1, accountCode: '200', taxCode: 'NONE',
  }), (error) => error.code === 'ACCOUNTING_UNREPRESENTABLE');
  assert.throws(() => buildXeroSalesInvoiceLine({
    description: 'Unsupported quantity precision', quantity: '1.00001', netMinor: 100,
    taxMinor: 20, grossMinor: 120, accountCode: '200', taxCode: 'OUTPUT2',
  }), (error) => error.code === 'ACCOUNTING_UNREPRESENTABLE');
});

test('both provider creates use provider-supported idempotency and fields', async () => {
  const xero = await readFile(new URL('./xero.js', import.meta.url), 'utf8');
  assert.match(xero, /'Idempotency-Key': String\(invoice\.idempotencyKey\)/);
  assert.match(xero, /CurrencyCode: invoice\.currency/);
  assert.match(xero, /LineAmountTypes: 'Exclusive'/);
  assert.match(xero, /Invoices\?unitdp=4/);
});