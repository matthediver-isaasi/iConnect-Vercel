test('saved draft line tax remains frozen despite catalogue changes or submitted rate changes', async () => {
  const product = { id: uuid, is_active: true, currency: 'GBP', standard_price_minor: 1000,
    minimum_price_minor: null, tax_rate_bps: 2000, tax_code: { provider: 'xero', id: 'OUTPUT2', rateBps: 2000 } };
  const db = { from(table) { return { select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: table === 'sales_catalogue_product' ? product : { default_terms: '' } }) }; } };
  const previous = new Map([['saved', { catalogue_kind: 'product', catalogue_id: uuid, tax_rate_bps: 0,
    catalogue_snapshot: { tax_code: { provider: 'xero', id: 'EXEMPT', rateBps: 0 } } }]]);
  const result = await prepareQuoteDraft(db, 'tenant', { actorId: 'actor' }, { currency: 'GBP',
    lines: [{ id: 'saved', kind: 'product', catalogueId: uuid, quantity: '1', taxRateBps: 2000 }] }, false, previous);
  assert.equal(result.lines[0].taxRateBps, 0);
  assert.equal(result.lines[0].catalogueSnapshot.tax_code.id, 'EXEMPT');
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SALES_QUOTE_STATUSES, calculateQuoteLine, calculateQuoteTotals, canTransitionQuote,
  normaliseQuoteInput, parseQuoteQuantity, validateQuoteDraft,
} from '../../shared/salesContracts.js';
import { createSalesQuotesHandler } from '../sales/quotes/[...path].js';
import { prepareQuoteDraft } from './salesQuote.js';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
test('billing recipient falls through an empty billing contact to the customer contact', async () => {
  const customerId = '123e4567-e89b-12d3-a456-426614174001';
  const terms = { id: uuid, name: '14 days', days: 14, isActive: true };
  const db = { from(table) {
    let id;
    const row = () => table === 'member' ? (id === customerId ? { email: 'customer@example.test', name: 'Customer' } : { name: 'No email' })
      : table === 'tenant' ? {} : { billing_presets: { paymentTerms: [terms] } };
    return { select() { return this; }, eq(key, value) { if (key === 'id') id = value; return this; },
      single: async () => ({ data: row() }), maybeSingle: async () => ({ data: row() }) };
  } };
  const result = await prepareQuoteDraft(db, uuid, { actorId: 'actor' }, { currency: 'GBP',
    scheduledBilling: true, remainderPaymentTermsId: uuid, billingContactId: uuid, customerContactId: customerId,
    lines: [{ kind: 'free_text', description: 'Service', quantity: '1', standardUnitPriceMinor: 100, quotedUnitPriceMinor: 100 }] });
  assert.deepEqual(result.billingSchedule.recipient, { email: 'customer@example.test', name: 'Customer' });
});
test('scheduled preparation uses authoritative timezone and recipient snapshots; legacy stays unscheduled', async () => {
  const terms = { id: uuid, name: '14 calendar days', days: 14, isActive: true };
  const queries = [];
  const db = { from(table) {
    queries.push(table);
    const data = table === 'tenant' ? { settings: { timezone: 'Pacific/Auckland' } }
      : table === 'member' ? { email: 'billing@example.test', first_name: 'Billing' }
      : { default_terms: '', billing_presets: { paymentTerms: [terms] } };
    return { select() { return this; }, eq() { return this; }, single: async () => ({ data }),
      maybeSingle: async () => ({ data }) };
  } };
  const draft = { currency: 'GBP', billingContactId: uuid, lines: [{ kind: 'free_text', description: 'Extra',
    quantity: '1', standardUnitPriceMinor: 100, quotedUnitPriceMinor: 100, taxRateBps: 0 }] };
  const legacy = await prepareQuoteDraft(db, uuid, { actorId: 'actor' }, draft);
  assert.equal(legacy.billingSchedule, null);
  assert.equal(queries.includes('tenant'), false);
  const result = await prepareQuoteDraft(db, uuid, { actorId: 'actor' }, {
    ...draft, scheduledBilling: true, remainderPaymentTermsId: uuid,
  });
  assert.equal(result.billingSchedule.timezone, 'Pacific/Auckland');
  assert.equal(result.billingSchedule.timezoneFallback, false);
  assert.equal(result.billingSchedule.recipient.email, 'billing@example.test');
  assert.equal(result.billingSchedule.groups[0].paymentTerms.days, 14);
  assert.equal(result.billingSchedule.remainderPaymentTerms.id, uuid);
  terms.isActive = false;
  terms.days = 30;
  const resaved = await prepareQuoteDraft(db, uuid, { actorId: 'actor' }, {
    ...draft, scheduledBilling: true, remainderPaymentTermsId: uuid,
  }, false, new Map(), undefined, result.billingSchedule);
  assert.equal(resaved.billingSchedule.remainderPaymentTerms.days, 14);
  await assert.rejects(prepareQuoteDraft(db, uuid, { actorId: 'actor' }, {
    ...draft, scheduledBilling: true, remainderPaymentTermsId: uuid,
  }), /active payment/);
  await assert.rejects(prepareQuoteDraft(db, uuid, { actorId: 'actor' },
    { ...draft, scheduledBilling: true }), /remainder/);
});
test('percentage preparation resolves tenant presets, neutralises manual terms and preserves saved identities', async () => {
  const terms = { id: uuid, name: '14 days', days: 14, isActive: true };
  const delay = { id: uuid, name: 'Acceptance', days: 0, isActive: true };
  const db = { from(table) {
    const data = table === 'tenant' ? { timezone: 'UTC' }
      : { default_terms: 'Pay within 90 days', billing_presets: { paymentTerms: [terms], issueDelays: [delay] } };
    return { select() { return this; }, eq() { return this; },
      single: async () => ({ data }), maybeSingle: async () => ({ data }) };
  } };
  const draft = { currency: 'GBP', scheduledBilling: true, billingMode: 'percentage',
    terms: 'Pay within 60 days', paymentTerms: '30 days',
    percentageInstalments: [{ id: uuid, name: 'All', percentageBps: 10000,
      paymentTerms: { id: uuid, name: 'Forged', days: 999 },
      issueDelayPreset: { id: uuid, name: 'Forged', days: 999 } }],
    lines: [{ kind: 'free_text', description: 'Discounted service', quantity: '2',
      standardUnitPriceMinor: 100, quotedUnitPriceMinor: 100, discountBps: 5000, taxRateBps: 0 }] };
  const prepared = await prepareQuoteDraft(db, uuid, { actorId: 'actor' }, draft, true);
  assert.equal(prepared.paymentTerms, null);
  assert.equal(prepared.termsSnapshot.text, 'Payment terms are specified per invoice in the billing schedule.');
  assert.equal(prepared.billingSchedule.groups[0].grossMinor, 100);
  assert.equal(prepared.billingSchedule.groups[0].timing.days, 0);
  assert.equal(prepared.billingSchedule.groups[0].paymentTerms.days, 14);
  terms.isActive = delay.isActive = false;
  const saved = await prepareQuoteDraft(db, uuid, { actorId: 'actor' },
    { ...draft, percentageInstalments: prepared.billingSchedule.percentageInstalments },
    true, new Map(), undefined, prepared.billingSchedule);
  assert.deepEqual(saved.billingSchedule, prepared.billingSchedule);
});
test('manual billing address overrides and deliberate clearing reach the persisted snapshot payload', async () => {
  const db = { from() { return { select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: { default_terms: '' }, error: null }) }; } };
  const address = { addressee: 'Accounts', line1: '10 Main Street', line2: 'Floor 2',
    city: 'Leeds', region: 'Yorkshire', postalCode: 'LS1 1AA', country: 'UK' };
  for (const savedAddress of [address, Object.fromEntries(Object.keys(address).map(key => [key, '']))]) {
    const prepared = await prepareQuoteDraft(db, 'tenant', { actorId: 'actor' },
      normaliseQuoteInput({ currency: 'GBP', address: savedAddress, lines: [
        { kind: 'free_text', description: 'Service', quantity: '1', standardUnitPriceMinor: 1000, quotedUnitPriceMinor: 1000, taxRateBps: 0 },
      ] }));
    assert.deepEqual(prepared.addressSnapshot, savedAddress);
  }
});
const draft = {
  currency: 'GBP',
  lines: [{ kind: 'product', catalogueId: uuid, quantity: '1.25' }],
};

test('quote quantity and money arithmetic never uses binary floating point', () => {
  assert.deepEqual(parseQuoteQuantity('0.1'), { units: 1n, scale: 10n, canonical: '0.1' });
  assert.deepEqual(calculateQuoteLine({
    quantity: '1.005', quotedUnitPriceMinor: 10000, taxRateBps: 2000,
  }), { quantity: '1.005', discountedUnitPriceMinor: 10000, netMinor: 10050, taxMinor: 2010, grossMinor: 12060 });
  assert.deepEqual(calculateQuoteTotals([
    { quantity: '0.1', quotedUnitPriceMinor: 5, taxRateBps: 0 },
    { quantity: '2.5', quotedUnitPriceMinor: 101, taxRateBps: 2000 },
  ]), { netMinor: 254, taxMinor: 51, grossMinor: 305 });
  assert.throws(() => parseQuoteQuantity(1.5), /decimal string/);
  assert.throws(() => parseQuoteQuantity('1.0000001'), /at most 6/);
});

test('quote contract rejects client totals and unsafe or malformed inputs', () => {
  assert.equal(validateQuoteDraft(draft).ok, true);
  assert.equal(validateQuoteDraft({ ...draft, totalMinor: 10 }).ok, false);
  assert.equal(validateQuoteDraft({ ...draft, lines: [{ ...draft.lines[0], quantity: 1.25 }] }).ok, false);
  assert.equal(validateQuoteDraft({ ...draft, lines: [{ ...draft.lines[0], quotedUnitPriceMinor: 1.2 }] }).ok, false);
  assert.equal(validateQuoteDraft({ ...draft, expectedVersion: 1 }).ok, false);
  assert.equal(validateQuoteDraft({ ...draft, expectedVersion: 1 }, { existing: true }).ok, true);
});

test('free-text lines, discounts, and builder aliases normalize to the canonical contract', () => {
  const input = normaliseQuoteInput({
    organization_id: uuid, customer_contact_id: uuid, billing_contact_id: uuid,
    issue_date: '2026-09-09', purchase_order_reference: 'PO-1', payment_terms: '30 days',
    line_items: [{ line_type: 'free_text', quantity: 1.5, standard_unit_price_minor: 1001,
      quoted_unit_price_minor: 1001, discount_bps: 333, tax_rate_bps: 2000, description: 'Consulting' }],
    currency: 'GBP',
  });
  assert.equal(validateQuoteDraft(input).ok, true);
  assert.deepEqual(calculateQuoteLine({ ...input.lines[0] }), {
    quantity: '1.5', discountedUnitPriceMinor: 968, netMinor: 1452, taxMinor: 290, grossMinor: 1742,
  });
  assert.equal(input.customerContactId, uuid);
  assert.equal(input.lines[0].kind, 'free_text');
  assert.equal(input.lines[0].catalogueId, null);
  const usCamel = normaliseQuoteInput({ ...draft, organizationId: uuid });
  assert.equal(validateQuoteDraft(usCamel).ok, true);
  assert.equal(usCamel.organisationId, uuid);
  assert.equal('organizationId' in usCamel, false);
});

test('catalogue-backed quote lines use the persisted catalogue tax rate', async () => {
  const product = {
    id: uuid, is_active: true, currency: 'GBP', standard_price_minor: 1000,
    minimum_price_minor: null, tax_rate_bps: 2000, name: 'Training', create_task_on_acceptance: true,
  };
  const db = {
    from(table) {
      const row = table === 'sales_catalogue_product' ? product : table === 'sales_settings'
        ? { default_terms: '' } : null;
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: row, error: null }),
      };
    },
  };
  const prepared = await prepareQuoteDraft(db, 'tenant-server', { actorId: 'actor', actorType: 'tenant_user' }, {
    currency: 'GBP',
    lines: [{ kind: 'product', catalogueId: uuid, quantity: '1', taxRateBps: 0 }],
  });

  assert.equal(prepared.lines[0].taxRateBps, 2000);
  assert.equal(prepared.lines[0].catalogueSnapshot.create_task_on_acceptance, true);
  assert.equal(prepared.totals.taxMinor, 200);
  assert.equal(prepared.totals.grossMinor, 1200);
});

test('multi-line discounted products and bundles preserve the database price override invariant', async () => {
  const item = { id: uuid, is_active: true, currency: 'GBP', standard_price_minor: 1000,
    selling_price_minor: 1000, minimum_price_minor: 800, tax_rate_bps: 2000, name: 'Training' };
  const db = { from(table) { return {
    select() { return this; }, eq() { return this; },
    order: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: table === 'sales_settings' ? { default_terms: '' } : item, error: null }),
  }; } };
  const input = { currency: 'GBP', lines: [
    { kind: 'product', catalogueId: uuid, quantity: '1', quotedUnitPriceMinor: 1000 },
    { kind: 'product', catalogueId: uuid, quantity: '2', quotedUnitPriceMinor: 1000, discountBps: 1000 },
    { kind: 'bundle', catalogueId: uuid, quantity: '1', quotedUnitPriceMinor: 1000, discountBps: 1000 },
    { kind: 'product', catalogueId: uuid, quantity: '1', quotedUnitPriceMinor: 900 },
  ] };
  const prepared = await prepareQuoteDraft(db, 'tenant', { actorId: 'actor' }, input, true);
  assert.deepEqual(prepared.lines.map(l => l.priceOverridden), [false, false, false, true]);
  for (const line of prepared.lines) {
    assert.equal(line.priceOverridden, line.standardUnitPriceMinor !== line.quotedUnitPriceMinor);
  }
  assert.equal(prepared.lines[1].netMinor, 1800);
  assert.equal(prepared.lines[2].netMinor, 900);
  for (const kind of ['product', 'bundle']) {
    const discounted = { ...input, lines: [{ ...input.lines[1], kind }] };
    await assert.rejects(prepareQuoteDraft(db, 'tenant', { actorId: 'actor' }, discounted, false), /override capability required/);
    await assert.rejects(prepareQuoteDraft(db, 'tenant', { actorId: 'actor' }, {
      ...discounted, lines: [{ ...discounted.lines[0], discountBps: 3000 }],
    }, true), /below its minimum price/);
  }
});

test('versioned lifecycle uses declined/superseded/converted vocabulary', () => {
  assert.deepEqual(SALES_QUOTE_STATUSES, [
    'draft', 'issued', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'converted',
  ]);
  assert.equal(canTransitionQuote('issued', 'sent'), true);
  assert.equal(canTransitionQuote('sent', 'declined'), true);
  assert.equal(canTransitionQuote('accepted', 'converted'), true);
  assert.equal(canTransitionQuote('converted', 'draft'), false);
});

test('quote migration enforces tenant FKs, immutability, RPC security and atomic numbering', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20260909_sales_quotes.sql', import.meta.url), 'utf8');
  assert.match(sql, /FOREIGN KEY \(tenant_id,quote_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id,quote_version_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id,product_id\)/);
  assert.match(sql, /append-only/);
  assert.match(sql, /SECURITY DEFINER/g);
  assert.match(sql, /auth\.role\(\)<>'service_role'/);
  assert.match(sql, /ON CONFLICT\(tenant_id,kind\) DO UPDATE/);
  assert.match(sql, /price_overridden = \(standard_unit_price_minor <> quoted_unit_price_minor\)/);
  assert.match(sql, /catalogue_kind varchar\(20\) NOT NULL, catalogue_id uuid,/);
  assert.match(sql, /tenant_id=OLD\.tenant_id AND id=OLD\.quote_version_id/);
  assert.match(sql, /tenant_id=NEW\.tenant_id AND id=NEW\.quote_version_id/);
  assert.match(sql, /l\.tenant_id=OLD\.tenant_id AND l\.id=OLD\.quote_line_id/);
  assert.match(sql, /l\.tenant_id=NEW\.tenant_id AND l\.id=NEW\.quote_line_id/);
  assert.match(sql, /REVOKE ALL ON FUNCTION/);
  assert.doesNotMatch(sql, /TO authenticated[\s\S]*GRANT EXECUTE/);
});

function response() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('quote route derives tenant and actor and passes concurrency token to issue RPC', async () => {
  const calls = [];
  const db = {
    rpc(name, args) {
      calls.push([name, args]);
      return Promise.resolve({ data: { id: uuid, status: 'issued' }, error: null });
    },
  };
  const handler = createSalesQuotesHandler({
    db,
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-server', tenantUserId: 'actor-server',
    }),
  });
  const res = response();
  await handler({
    method: 'POST', query: { path: [uuid, 'issue'] },
    body: { expectedVersion: 7, tenantId: 'attacker', actorId: 'attacker' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0][0], 'issue_sales_quote');
  assert.equal(calls[0][1].p_tenant_id, 'tenant-server');
  assert.equal(calls[0][1].p_actor_id, 'actor-server');
  assert.equal(calls[0][1].p_expected_version, 7);
});

test('quote route accepts workspace query-parameter actions through the catch-all handler', async () => {
  const calls = [];
  const db = {
    rpc(name, args) {
      calls.push([name, args]);
      return Promise.resolve({ data: { id: uuid, status: 'issued' }, error: null });
    },
  };
  const handler = createSalesQuotesHandler({
    db,
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-server', tenantUserId: 'actor-server',
    }),
  });
  const res = response();
  await handler({
    method: 'POST', query: { path: uuid, action: 'issue' },
    body: { expectedVersion: 8 },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0][0], 'issue_sales_quote');
  assert.equal(calls[0][1].p_expected_version, 8);
});

test('quote detail route accepts the scalar catch-all shape emitted by the development adapter', async () => {
  const quote = { id: uuid, current_version: 1, quote_number: 'Q-1' };
  const version = { id: 'version-id', version_number: 1, status: 'draft' };
  const db = {
    from(table) {
      if (table === 'sales_quote') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: quote, error: null }),
        };
      }
      if (table === 'sales_quote_version') {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({ data: [version], error: null }),
        };
      }
      if (table === 'sales_commercial_sale') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      if (table === 'tenant') {
        return { select() { return this; }, eq() { return this; },
          maybeSingle: async () => ({ data: { name: 'Example', footer_config: { legalText: 'Registered company 123' } }, error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  const handler = createSalesQuotesHandler({
    db,
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-server', tenantUserId: 'actor-server',
    }),
    getActiveAccountingProvider: async () => 'xero',
  });
  const res = response();

  await handler({ method: 'GET', query: { path: uuid } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, uuid);
  assert.equal(res.body.currentVersion.id, 'version-id');
  const direct = response();
  await handler({ method: 'GET', url: `/api/sales/quotes/${uuid}`, query: {} }, direct);
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.body.id, uuid, 'URL-only requests must resolve a quote, never the list endpoint');
  const spoof = response();
  await handler({ method: 'GET', url: `/api/sales/quotes/${uuid}`, query: { path: 'wrong-id' } }, spoof);
  assert.equal(spoof.body.id, uuid);
  const draftPdf = response();
  draftPdf.setHeader = () => {};
  draftPdf.send = value => { draftPdf.pdf = value; return draftPdf; };
  await handler({ method: 'GET', url: `/api/sales/quotes/${uuid}?action=pdf`, query: { action: 'pdf' } }, draftPdf);
  assert.ok(Buffer.isBuffer(draftPdf.pdf), 'saved drafts can be previewed without issuing or sending');
  assert.match(draftPdf.pdf.toString('latin1'), /DRAFT/);
});