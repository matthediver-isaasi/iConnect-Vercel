import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEventCommercial, buildOrganisationCommercial, buildSalesDashboard, buildSalesReport,
  paginateSalesReport, parseSalesReportQuery, readSalesReportSource, salesReportCsv,
} from './salesReports.js';
import { createSalesReportsHandler } from '../sales/reports/index.js';

const fixture = {
  stages: [
    { id: 'open', name: 'Open', probability: 25, is_won: false, is_lost: false },
    { id: 'lost', name: 'Lost', probability: 0, is_won: false, is_lost: true },
  ],
  lossReasons: [{ id: 'price', name: 'Price' }],
  organisations: [{ id: 'org-a', name: 'Alpha' }, { id: 'org-b', name: 'Beta' }],
  opportunities: [
    { id: 'o-open', organization_id: 'org-a', stage_id: 'open', owner_id: 'u1', name: 'Pipeline',
      value_minor: 10001, currency: 'GBP', expected_close_date: '2026-02-01', created_at: '2026-01-01T00:00:00Z' },
    { id: 'o-lost', organization_id: 'org-a', stage_id: 'lost', loss_reason_id: 'price', owner_id: 'u1',
      name: 'Lost', value_minor: 500, currency: 'GBP', lost_at: '2026-02-03T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    { id: 'o-sale', organization_id: 'org-b', stage_id: 'open', owner_id: 'u2', name: 'Sale',
      value_minor: 2000, currency: 'USD', expected_close_date: '2025-01-01', created_at: '2026-01-01T00:00:00Z' },
  ],
  quotes: [
    { id: 'q1', quote_number: 'Q1', opportunity_id: 'o-sale', current_version: 1 },
    { id: 'q2', quote_number: 'Q2', opportunity_id: 'o-open', current_version: 1 },
  ],
  versions: [
    { id: 'v1', quote_id: 'q1', version_number: 1, status: 'converted', currency: 'USD',
      net_minor: 1000, tax_minor: 200, gross_minor: 1200, issued_at: '2026-02-01T00:00:00Z',
      event_snapshot: { id: 'event-1', title: 'Conference' } },
    { id: 'v2', quote_id: 'q2', version_number: 1, status: 'issued', currency: 'GBP',
      net_minor: 500, tax_minor: 100, gross_minor: 600, issued_at: '2026-02-02T00:00:00Z' },
  ],
  lines: [
    { id: 'l1', quote_version_id: 'v1', product_id: 'product-1',
      catalogue_snapshot: { category_id: 'category-1', event_id: 'event-1' } },
  ],
  sales: [{ id: 'sale-1', quote_id: 'q1', quote_version_id: 'v1', opportunity_id: 'o-sale',
    created_at: '2026-02-10T00:00:00Z' }],
  invoices: [{ sale_id: 'sale-1', provider: 'xero', provider_status: 'paid', provider_invoice_number: 'INV-1' }],
  allocations: [{ allocation_id: 'a1', sale_id: 'sale-1', event_reference_kind: 'simple',
    event_id: 'event-1', ticket_type_id: 'ticket', allocated: 10, named: 3, reserved: 2,
    released: 1, cancelled: 0, remaining: 9 }],
  events: [{ id: 'event-1', title: 'Conference',
    pricing_config: { ticket_classes: [
      { id: 'ticket', name: 'General', available_count: 20 },
      { id: 'untouched', name: 'Untouched', available_count: 5 },
    ] } }],
  complexEvents: [], complexTickets: [],
  bookings: [{ id: 'b1', event_id: 'event-1', ticket_class_id: 'ticket', status: 'confirmed' }],
  complexBookings: [],
  activities: [{ id: 'activity-1', opportunity_id: 'o-open', action: 'updated',
    summary: 'Pipeline updated', created_at: '2026-02-01T00:00:00Z' }],
  tasks: [{ id: 'task-1', opportunity_id: 'o-open', title: 'Follow up',
    due_at: '2020-01-01T00:00:00Z', completed_at: null }],
};

const filters = (input = {}) => parseSalesReportQuery({ mode: 'report', report: 'sales', ...input });

test('weighted pipeline uses stage probability and keeps currencies separate', () => {
  const result = buildSalesReport(fixture, filters({ report: 'pipeline' }));
  assert.equal(result.details.find((row) => row.id === 'o-open').weightedValueMinor, 2500);
  assert.deepEqual(result.summary.quotes.map((row) => row.currency), ['GBP', 'USD']);
  assert.deepEqual(result.summary.sales.map((row) => row.currency), ['USD']);
});

test('pagination and CSV use the same stable filtered report rows', () => {
  const parsed = filters({ report: 'quotes', currency: 'GBP', pageSize: '1' });
  const result = buildSalesReport(fixture, parsed);
  const page = paginateSalesReport(result.details, parsed);
  assert.equal(page.total, 1);
  assert.equal(page.items[0].quoteId, 'q2');
  assert.match(salesReportCsv(result.details), /Q2/);
  assert.doesNotMatch(salesReportCsv(result.details), /Q1/);
});

test('conversion, losses, deal size, and sales cycle have explicit denominators', () => {
  const result = buildSalesReport(fixture, filters());
  assert.deepEqual(result.summary.conversion, {
    wonCount: 1, lostCount: 1, denominator: 2, conversionRateBps: 5000,
  });
  assert.deepEqual(result.summary.losses, [{ id: 'price', name: 'Price', count: 1 }]);
  assert.equal(result.summary.dealSize[0].averageGrossMinor, 1200);
  assert.equal(result.summary.salesCycle.averageDays, 40);
});

test('organisation and event summaries use sales and allocation facts', () => {
  const result = buildSalesReport(fixture, filters());
  assert.equal(result.organisations.find((row) => row.id === 'org-b').values[0].grossMinor, 1200);
  const event = result.events.find((row) => row.id === 'event-1');
  assert.equal(event.saleCount, 1);
  assert.equal(event.allocations[0].available, 4);
});

test('view and frontend report key aliases normalize to supported reports', () => {
  assert.equal(parseSalesReportQuery({ view: 'dashboard' }).mode, 'dashboard');
  for (const report of ['owners', 'products', 'bundles', 'categories']) {
    assert.equal(parseSalesReportQuery({ view: 'report', report }).report, report);
  }
  assert.equal(parseSalesReportQuery({ view: 'report', report: 'loss_reasons' }).report, 'losses');
  assert.equal(parseSalesReportQuery({ view: 'report', report: 'deal_size' }).report, 'deal-size');
  assert.equal(parseSalesReportQuery({ view: 'report', report: 'sales_cycle' }).report, 'sales-cycle');
});

test('dashboard, organisation, and event builders expose frontend contract sections', () => {
  const result = buildSalesReport(fixture, filters());
  const dashboard = buildSalesDashboard(fixture, result);
  assert.equal(dashboard.byCurrency.find((row) => row.currency === 'USD').wonValue, 1200);
  assert.equal(dashboard.recentWins.length, 1);
  assert.equal(dashboard.recentActivity.length, 1);
  assert.equal(dashboard.overdueTasks.length, 1);
  assert.ok(Array.isArray(dashboard.outstandingQuotes));

  const organisation = buildOrganisationCommercial(fixture, result, 'org-b');
  assert.equal(organisation.opportunities.length, 1);
  assert.equal(organisation.sales.length, 1);
  assert.equal(organisation.invoices.length, 1);
  assert.equal(organisation.allocations.length, 1);

  const event = buildEventCommercial(fixture, result, 'event-1');
  assert.deepEqual(event.summary, {
    allocated: 10, named: 3, reserved: 2, unused: 4, confirmedBookings: 1,
    trueAvailability: 20, true_available: 20,
  });
  assert.equal(event.capacity[0].trueAvailability, 15);
  assert.equal(event.capacity.find((row) => row.id === 'untouched').trueAvailability, 5);
});

test('event report handler exposes reconciled allocation and true availability', async () => {
  const handler = createSalesReportsHandler({
    loadSalesReportData: async () => fixture,
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'user-a',
    }),
  });
  const result = response();
  await handler({ method: 'GET', query: { view: 'report', report: 'events' } }, result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.rows[0].allocated, 10);
  assert.equal(result.body.rows[0].named, 3);
  assert.equal(result.body.rows[0].unused, 4);
  assert.equal(result.body.rows[0].trueAvailability, 20);
});

function response() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

test('handler rejects unauthenticated reads and scopes its injected loader to tenant', async () => {
  const denied = createSalesReportsHandler({
    loadSalesReportData: async () => fixture,
    getTenantContext: async () => ({ isAuthenticated: false }),
  });
  const deniedResponse = response();
  await denied({ method: 'GET', query: {} }, deniedResponse);
  assert.equal(deniedResponse.statusCode, 401);

  let seenTenant;
  const handler = createSalesReportsHandler({
    loadSalesReportData: async (_db, tenantId) => { seenTenant = tenantId; return fixture; },
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'user-a',
    }),
  });
  const allowedResponse = response();
  await handler({ method: 'GET', query: { mode: 'report', report: 'sales' } }, allowedResponse);
  assert.equal(allowedResponse.statusCode, 200);
  assert.equal(seenTenant, 'tenant-a');
  assert.equal(allowedResponse.body.metadata.money.unit, 'minor');
  assert.equal(allowedResponse.body.rows.length, 1);
  assert.equal(allowedResponse.body.items.length, 1);
  assert.equal(allowedResponse.body.pagination.total, 1);
  assert.ok(allowedResponse.body.columns.length > 0);
  assert.ok(allowedResponse.body.facets.currencies.length > 0);
});

function pagedDb(total) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        async range(from, to) {
          const count = Math.max(0, Math.min(to, total - 1) - from + 1);
          return { data: Array.from({ length: count }, (_, index) => ({ id: from + index })) };
        },
      };
    },
  };
}

test('bounded source reads return exact limits and reject any overflow', async () => {
  const exact = await readSalesReportSource(pagedDb(50000), 'opportunity', 'tenant-a');
  assert.equal(exact.length, 50000);
  await assert.rejects(
    readSalesReportSource(pagedDb(50001), 'opportunity', 'tenant-a'),
    /exceeds the maximum scan/,
  );
  await assert.rejects(
    readSalesReportSource(pagedDb(60000), 'opportunity', 'tenant-a'),
    /exceeds the maximum scan/,
  );
});

test('conversion endpoint real loader includes confirmed commercial sales', async () => {
  const tableData = {
    opportunity: fixture.opportunities,
    opportunity_stage: fixture.stages,
    opportunity_loss_reason: fixture.lossReasons,
    organization: fixture.organisations,
    sales_quote: fixture.quotes,
    sales_quote_version: fixture.versions,
    sales_quote_line: fixture.lines,
    sales_commercial_sale: fixture.sales,
    sales_accounting_invoice_link: fixture.invoices,
    sales_commercial_allocation_totals: fixture.allocations,
  };
  const db = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        async range(from, to) {
          return { data: (tableData[table] || []).slice(from, to + 1) };
        },
      };
    },
  };
  const handler = createSalesReportsHandler({
    db,
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'user-a',
    }),
  });
  const result = response();
  await handler({ method: 'GET', query: { view: 'report', report: 'conversion' } }, result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.rows[0].wonCount, 1);
  assert.equal(result.body.rows[0].conversionRateBps, 5000);
});