import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareQuoteDraft } from './salesQuote.js';
import { buildInvoice } from './salesAccounting.js';
import { scheduleInvoiceLines } from './salesInvoiceSchedule.js';
import { buildSalesQuotePdf } from './salesQuotePdf.js';
import { publicQuoteDto } from '../public/sales-quote/[...path].js';
import { buildBillingSchedule } from '../../shared/salesBilling.js';
import { bundleProductName, bundleInvoiceDescription } from '../../shared/salesBundleLabels.js';
import { bundlePreviewLines } from '../../client/src/components/sales/bundlePreview.js';

const id = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const tax = { provider: 'xero', id: 'NONE', rateBps: 0 };
const terms = { id: id(10), name: '14 days', days: 14 };
const group = { id: id(11), name: 'First group', position: 0, allocatedMinor: 1000,
  productIds: [id(2), id(3), id(4)], timing: { kind: 'acceptance', days: 0 }, paymentTerms: terms };
function fixture() {
  const rows = {
    sales_settings: [{ default_terms: '' }],
    sales_catalogue_bundle: [{ id: id(1), name: 'Package', description: 'Package', is_active: true,
      currency: 'GBP', selling_price_minor: 1000, billing_groups: [group] }],
    sales_catalogue_bundle_item: [2, 3, 4].map((n, i) => ({ product_id: id(n), quantity: i + 1 })),
    sales_catalogue_product: [2, 3, 4].map(n => ({ id: id(n), name: 'Delegate ticket', category_id: n === 4 ? null : id(n + 3) })),
    sales_catalogue_category: [{ id: id(5), name: 'Conference A' }, { id: id(6), name: 'Conference B' }],
  };
  const calls = [];
  for (const values of Object.values(rows)) for (const row of values) row.tenant_id = 'tenant';
  const db = { from(table) {
    const filters = [];
    const result = () => ({ data: (rows[table] || []).filter(row => filters.every(([key, value]) => row[key] === undefined || row[key] === value)) });
    const q = { select() { return q; }, eq(key, value) { filters.push([key, value]); calls.push([table, key, value]); return q; },
      order: async () => result(), maybeSingle: async () => ({ data: result().data[0] || null }) };
    return q;
  } };
  return { db, rows, calls };
}
const accountingDb = { from() { const q = { select: () => q, eq: () => q, in: () => q,
  maybeSingle: async () => ({ data: null }), then: resolve => resolve({ data: [] }) }; return q; } };
const persisted = line => ({ catalogue_kind: line.kind, description: line.description, quantity: line.quantity,
  quoted_unit_price_minor: line.quotedUnitPriceMinor, discount_bps: line.discountBps, tax_rate_bps: line.taxRateBps,
  net_minor: line.netMinor, tax_minor: line.taxMinor, gross_minor: line.grossMinor,
  catalogue_snapshot: { ...line.catalogueSnapshot, tax_code: tax },
  sales_quote_bundle_component: line.components.map(c => ({ quantity: c.quantity, product_snapshot: c.productSnapshot })) });

test('server category snapshots feed public DTO, PDF and ordinary/scheduled invoices without changing economics', async () => {
  const { db, rows, calls } = fixture();
  const prepared = await prepareQuoteDraft(db, 'tenant', { actorId: 'actor' }, { currency: 'GBP',
    lines: [{ kind: 'bundle', catalogueId: id(1), quantity: '2', discountBps: 1000 }] }, true);
  const line = prepared.lines[0];
  line.catalogueSnapshot.tax_code = tax;
  assert.deepEqual(line.components.map(bundleProductName), ['Conference A — Delegate ticket', 'Conference B — Delegate ticket', 'Uncategorised — Delegate ticket']);
  assert.equal(line.components[0].productSnapshot.categoryId, id(5));
  assert.equal(calls.filter(c => c[0] === 'sales_catalogue_category' && c[1] === 'tenant_id' && c[2] === 'tenant').length, 2);
  rows.sales_catalogue_category[0].name = 'Renamed';
  rows.sales_catalogue_product[0].category_id = id(6);
  const saved = persisted(line);
  const version = { currency: 'GBP', status: 'issued', version_number: 1, net_minor: 1800, tax_minor: 0, gross_minor: 1800, sales_quote_line: [saved] };
  const dto = publicQuoteDto({ quote_number: 'Q1' }, version);
  assert.deepEqual(Object.keys(dto.lines[0].bundleComponents[0]).sort(), ['categoryName', 'name', 'quantity']);
  assert.equal(bundleProductName(dto.lines[0].bundleComponents[0]), 'Conference A — Delegate ticket');
  const pdf = buildSalesQuotePdf({ quote: { quote_number: 'Q1' }, version, tenant: { name: 'Seller' } }).toString('latin1');
  assert.match(pdf, /Conference A/); assert.match(pdf, /Conference B/); assert.doesNotMatch(pdf, /Renamed/);
  const invoice = await buildInvoice(accountingDb, 'tenant', {}, version, [saved], 'xero', 'customer');
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.netMinor, 1800);
  assert.match(invoice.lines[0].description, /2 × Conference A — Delegate ticket; 4 × Conference B — Delegate ticket; 6 × Uncategorised/);
  for (const mode of ['groups', 'remainder', 'percentage']) {
    const input = structuredClone(line);
    if (mode === 'remainder') input.catalogueSnapshot.billing_groups = [];
    const schedule = buildBillingSchedule({ lines: [input], currency: 'GBP', timezone: 'UTC', newId: () => id(12),
      remainderPaymentTerms: terms, billingMode: mode === 'percentage' ? mode : 'groups',
      percentageInstalments: [{ id: id(13), name: 'All', percentageBps: 10000, paymentTerms: terms,
        issueDelayPreset: { id: id(14), name: 'Now', days: 0 } }] });
    const snapshot = structuredClone(schedule.groups[0]);
    const invoiceLines = scheduleInvoiceLines(snapshot);
    assert.equal(invoiceLines.length, 1);
    assert.match(invoiceLines[0].description, /4 × Conference B — Delegate ticket/);
    const scheduledInvoice = await buildInvoice(accountingDb, 'tenant', {}, version, invoiceLines, 'xero', 'customer');
    assert.equal(scheduledInvoice.netMinor, invoice.netMinor);
    assert.equal(scheduledInvoice.grossMinor, invoice.grossMinor);
    assert.equal(scheduledInvoice.lines[0].description, snapshot.invoiceLines[0].description);
  }
});

test('category resolution fails closed for foreign/missing categories', async () => {
  const { db, rows } = fixture();
  rows.sales_catalogue_category[0].tenant_id = 'foreign';
  await assert.rejects(prepareQuoteDraft(db, 'tenant', {}, { currency: 'GBP',
    lines: [{ kind: 'bundle', catalogueId: id(1), quantity: '1' }] }), /category was not found in this tenant/);
});

test('fractional bundle quantities, multiple groups and instalments preserve discounted net and VAT for both providers', async () => {
  for (const provider of ['xero', 'quickbooks']) {
    const code = { provider, id: 'VAT', rateBps: 2000 };
    const line = { kind: 'bundle', description: 'Package', quantity: '2.5', standardUnitPriceMinor: 1000,
      quotedUnitPriceMinor: 1000, discountBps: 1000, taxRateBps: 2000, netMinor: 2250, taxMinor: 450, grossMinor: 2700,
      catalogueSnapshot: { tax_code: code, billing_groups: [
        { ...group, allocatedMinor: 500, productIds: [id(2)] },
        { ...group, id: id(20), name: 'Second', position: 1, allocatedMinor: 500, productIds: [id(3)] }] },
      components: [{ productId: id(2), quantity: 2, productSnapshot: { name: 'Ticket', categoryName: 'A' } },
        { productId: id(3), quantity: 4, productSnapshot: { name: 'Ticket', categoryName: 'B' } }] };
    const db = { from(table) { const q = { select: () => q, eq: () => q, in: () => q,
      maybeSingle: async () => ({ data: table === 'system_settings' ? { setting_value: '200' } : null }),
      then: resolve => resolve({ data: [] }) }; return q; } };
    const saved = persisted(line);
    saved.catalogue_snapshot.tax_code = code;
    const version = { currency: 'GBP', net_minor: 2250, tax_minor: 450, gross_minor: 2700 };
    const ordinary = await buildInvoice(db, 'tenant', {}, version, [saved], provider, 'customer');
    assert.match(ordinary.lines[0].description, /5 × A — Ticket; 10 × B — Ticket/);
    assert.equal(ordinary.lines[0].quantity, '2.5');
    for (const mode of ['groups', 'percentage']) {
      const schedule = buildBillingSchedule({ lines: [line], currency: 'GBP', timezone: 'UTC', newId: () => id(21),
        billingMode: mode, percentageInstalments: [22, 23].map(n => ({ id: id(n), name: `Part ${n}`,
          percentageBps: 5000, paymentTerms: terms, issueDelayPreset: { id: id(24), name: 'Now', days: 0 } })) });
      let total = 0;
      for (const [index, part] of schedule.groups.entries()) {
        const lines = scheduleInvoiceLines(structuredClone(part));
        const invoice = await buildInvoice(db, 'tenant', {}, { currency: 'GBP', net_minor: part.netMinor,
          tax_minor: part.taxMinor, gross_minor: part.grossMinor }, lines, provider, 'customer');
        assert.equal(invoice.lines.length, 1);
        assert.match(invoice.lines[0].description, mode === 'groups' && index === 1 ? /10 × B — Ticket/ : /5 × A — Ticket/);
        total += invoice.grossMinor;
      }
      assert.equal(total, ordinary.grossMinor);
    }
  }
});

test('legacy and unsaved previews never substitute live category labels for saved evidence', () => {
  const legacy = { quantity: '2', description: 'Original', components: [{ quantity: 3, productSnapshot: { name: 'Original product' } }] };
  assert.equal(bundleInvoiceDescription(legacy), 'Original');
  assert.equal(bundleProductName(legacy.components[0]), 'Original product');
  const lines = [{ type: 'bundle', bundleId: 'b', catalogue_id: 'b', components: legacy.components }];
  const products = [{ id: 'p', name: 'Same', categoryId: 'a' }];
  const bundles = [{ id: 'b', items: [{ productId: 'p', quantity: 2 }] }];
  assert.equal(bundlePreviewLines(lines, products, bundles, [{ id: 'a', name: 'New' }])[0], lines[0]);
  const preview = bundlePreviewLines([{ type: 'bundle', bundleId: 'b' }], products, bundles, [{ id: 'a', name: '<Conference>' }]);
  assert.equal(bundleProductName(preview[0].bundleComponents[0]), '<Conference> — Same');
});
