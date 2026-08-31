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
    minimum_price_minor: null, tax_rate_bps: 2000, name: 'Training',
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
  assert.equal(prepared.totals.taxMinor, 200);
  assert.equal(prepared.totals.grossMinor, 1200);
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
});