import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateCatalogueBundle, validateCatalogueProduct,
} from '../../shared/salesContracts.js';
import {
  delegateCapacityFromTicket, listCatalogue, listCatalogueEventOptions, resolveEventTicketReference,
} from './salesCatalogue.js';
import { createSalesCatalogueHandler } from '../sales/catalogue/[...path].js';

const product = {
  code: 'EVENT_1', name: 'Delegate place', currency: 'GBP',
  standardPriceMinor: 12500, minimumPriceMinor: 10000, costMinor: 4000,
  taxTreatment: 'standard', taxRateBps: 2000,
};
const bundle = {
  code: 'PACK_1', name: 'Package', currency: 'GBP', sellingPriceMinor: 19000,
  minimumPriceMinor: 15000, presentationMode: 'bundle',
  items: [{ productId: '123e4567-e89b-12d3-a456-426614174000', quantity: 2 }],
};

test('catalogue validates currencies, integer minor units, dates and composition', () => {
  assert.equal(validateCatalogueProduct({ ...product, shortDescription: 'A concise description' }).ok, true);
  assert.equal(validateCatalogueProduct({ ...product, shortDescription: 'x'.repeat(501) }).ok, false);
  assert.equal(validateCatalogueProduct({ ...product, currency: 'gbp' }).ok, false);
  assert.equal(validateCatalogueProduct({ ...product, standardPriceMinor: 12.5 }).ok, false);
  assert.equal(validateCatalogueProduct({
    ...product, availableFrom: '2027-02-02T00:00:00Z', availableTo: '2027-01-01T00:00:00Z',
  }).ok, false);
  assert.equal(validateCatalogueBundle(bundle).ok, true);
  assert.equal(validateCatalogueBundle({ ...bundle, items: [...bundle.items, bundle.items[0]] }).ok, false);
});

test('bundle price is independent of component product prices', () => {
  assert.equal(validateCatalogueBundle({ ...bundle, sellingPriceMinor: 1, minimumPriceMinor: null }).ok, true);
  assert.equal(validateCatalogueBundle({ ...bundle, sellingPriceMinor: 1, minimumPriceMinor: 2 }).ok, false);
});

test('catalogue lists active records by default and includes history only on request', async () => {
  const filters = [];
  const db = {
    from() {
      const query = {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        order() { return this; },
        then(resolve) { resolve({ data: [], error: null }); },
      };
      return query;
    },
  };
  await listCatalogue(db, 'tenant-a', 'categories');
  assert.deepEqual(filters, [['tenant_id', 'tenant-a'], ['is_active', true]]);
  filters.length = 0;
  await listCatalogue(db, 'tenant-a', 'categories', { includeInactive: true });
  assert.deepEqual(filters, [['tenant_id', 'tenant-a']]);
});

test('delegate capacity is derived directly from existing ticket group_size', () => {
  assert.equal(delegateCapacityFromTicket({ is_group_ticket: false, group_size: 20 }), 1);
  assert.equal(delegateCapacityFromTicket({ is_group_ticket: true, group_size: 8 }), 8);
  assert.equal(delegateCapacityFromTicket({ is_group_ticket: true, group_size: null }), 1);
});

function resolvedQuery(data, calls, table) {
  return {
    select() { return this; },
    eq(column, value) { calls.push([table, column, value]); return this; },
    then(resolve) { resolve({ data, error: null }); },
  };
}

test('event options are tenant scoped and retain ticket group delegate capacity', async () => {
  const calls = [];
  const db = {
    from(table) {
      if (table === 'event') return resolvedQuery([{
        id: 'simple-a', title: 'Simple conference',
        pricing_config: { ticket_classes: [{ id: 'simple-group', name: 'Table of six', is_group_ticket: true, group_size: 6 }] },
      }], calls, table);
      if (table === 'complex_event') return resolvedQuery([{ id: 'complex-a', title: 'Complex conference' }], calls, table);
      if (table === 'complex_event_ticket_class') return resolvedQuery([{
        id: 'complex-group', name: 'Team ticket', complex_event_id: 'complex-a', is_group_ticket: true, group_size: 4,
      }], calls, table);
      throw new Error(`unexpected ${table}`);
    },
  };
  const options = await listCatalogueEventOptions(db, 'tenant-a');
  assert.deepEqual(calls.filter((call) => call[1] === 'tenant_id'), [
    ['event', 'tenant_id', 'tenant-a'],
    ['complex_event', 'tenant_id', 'tenant-a'],
    ['complex_event_ticket_class', 'tenant_id', 'tenant-a'],
  ]);
  assert.deepEqual(options.map((event) => [event.kind, event.eventId, event.ticketOptions[0].delegateCapacity]), [
    ['simple', 'simple-a', 6], ['complex', 'complex-a', 4],
  ]);
  assert.equal((await listCatalogueEventOptions(db, 'tenant-a', 'team')).length, 1);
});

test('catalogue route parses event-options and q/search query aliases', async () => {
  const calls = [];
  const db = {
    from(table) {
      const data = table === 'event' ? [] : [];
      return resolvedQuery(data, calls, table);
    },
  };
  const handler = createSalesCatalogueHandler({
    db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a' }),
  });
  const res = { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
  await handler({ method: 'GET', query: { path: ['event-options'], search: 'team' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { items: [] });
  assert.equal(calls.filter(([table, column, value]) => table === 'event' && column === 'tenant_id' && value === 'tenant-a').length, 1);
});

function queryResult(data) {
  const query = {
    select() { return this; }, eq() { return this; },
    maybeSingle() { return Promise.resolve({ data, error: null }); },
  };
  return query;
}

test('event and ticket reference tenant mismatches are rejected', async () => {
  const missingDb = { from: () => queryResult(null) };
  await assert.rejects(
    resolveEventTicketReference(missingDb, 'tenant-a', {
      kind: 'simple', eventId: '123e4567-e89b-12d3-a456-426614174000', ticketTypeId: 'ticket-a',
    }),
    (error) => error.status === 400 && /tenant/.test(error.message),
  );
  const eventOnlyDb = {
    from(table) {
      if (table === 'event') return queryResult({
        id: 'event-a', tenant_id: 'tenant-a',
        pricing_config: { ticket_classes: [{ id: 'different-ticket' }] },
      });
      throw new Error('unexpected table');
    },
  };
  await assert.rejects(
    resolveEventTicketReference(eventOnlyDb, 'tenant-a', {
      kind: 'simple', eventId: '123e4567-e89b-12d3-a456-426614174000', ticketTypeId: 'ticket-a',
    }),
    (error) => error.status === 400 && /Ticket type/.test(error.message),
  );
});

test('persistence keeps inactive history and bundle composition instead of cascading product archives', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20260908_sales_catalogue.sql', import.meta.url), 'utf8');
  assert.match(sql, /is_active boolean NOT NULL DEFAULT true/);
  assert.match(sql, /archived_at timestamptz/);
  assert.match(sql, /sales_catalogue_bundle_item_product_fk[\s\S]*ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /sales_catalogue_bundle_item_product_fk[\s\S]{0,200}ON DELETE CASCADE/);
  assert.match(sql, /FUNCTION public\.replace_sales_catalogue_bundle_items/);
  assert.match(sql, /DELETE FROM public\.sales_catalogue_bundle_item[\s\S]*INSERT INTO public\.sales_catalogue_bundle_item/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.replace_sales_catalogue_bundle_items\(uuid,uuid,jsonb\) FROM PUBLIC, anon, authenticated/);
});