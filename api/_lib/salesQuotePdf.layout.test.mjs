import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesQuotePdf, lineVatPercent, formatPdfDate, quoteAddressLines } from './salesQuotePdf.js';
import { organisationAddressFromRecord, loadSalesQuotePdfContext } from './salesQuotePdfContext.js';
import { extractPdf } from './salesQuotePdf.testUtils.mjs';
import { buildBillingSchedule } from '../../shared/salesBilling.js';

const tenant = { name: 'Graduate Futures', footer_config: { legalText: 'Registered charity 1078508.' } };
const fullVersion = () => ({
  status: 'issued', version_number: 2, currency: 'GBP', issue_date: '2026-09-11', valid_until: '2026-10-11T00:00:00Z',
  organisation_snapshot: { id: 'org-1', name: 'Customer Ltd' }, customer_contact_snapshot: { name: 'Jane Buyer' },
  address_snapshot: { addressee: 'Customer Ltd', line1: '1 High Street', line2: 'Floor 2', city: 'London', postalCode: 'W1 1AA', country: 'United Kingdom' },
  terms_snapshot: { text: 'Payment terms are specified per invoice in the billing schedule.' },
  net_minor: 100000, tax_minor: 20000, gross_minor: 120000,
  sales_quote_line: [{
    description: 'Exhibition package', quantity: '2', quoted_unit_price_minor: 50000, tax_rate_bps: 2000,
    net_minor: 100000, tax_minor: 20000, gross_minor: 120000,
    catalogue_snapshot: { tax_code: { name: 'VAT on income' } },
    sales_quote_bundle_component: [
      { product_id: 'p1', quantity: 1, product_snapshot: { name: 'Stand', categoryName: 'Exhibition' } },
      { product_id: 'p2', quantity: 3, product_snapshot: { name: 'Delegate ticket', categoryName: 'Conference' } },
    ],
  }],
  billing_schedule: { mode: 'groups', timezone: 'UTC', timezoneFallback: true, groups: [
    { name: 'Deposit', bundleLineLabel: 'Line 1: Exhibition package', currency: 'GBP', grossMinor: 60000,
      timing: { kind: 'acceptance', days: 0 }, paymentTerms: { name: 'Due now', days: 0 },
      contents: [{ productId: 'p1', name: 'Exhibition — Stand', quantity: '2' }] },
    { name: 'Balance', currency: 'GBP', grossMinor: 60000, timing: { kind: 'fixed', date: '2027-01-15' },
      paymentTerms: { name: 'Net 14', days: 14 }, contents: [{ productId: 'p2', name: 'Conference — Delegate ticket', quantity: '6' }] },
  ] },
});
const textOf = async (input) => (await extractPdf(buildSalesQuotePdf(input))).map(page => page.text).join(' ').replace(/\s+/g, ' ');

test('title follows tenant terminology; dates are dd/mm/yyyy; internal wording is removed', async () => {
  const text = await textOf({ quote: { quote_number: 'GFI-0012' }, version: fullVersion(), tenant, context: { quoteSingular: 'Proposal' } });
  assert.ok(text.includes('PROPOSAL GFI-0012'));
  assert.ok(text.includes('Proposal number'));
  assert.ok(!/\bQuote\b|\bQUOTE\b/.test(text), 'no default Quote wording when renamed');
  assert.ok(text.includes('11/09/2026') && text.includes('11/10/2026'));
  for (const removed of ['VAT on income', 'Tax/VAT', 'UTC', 'fallback', 'specified per invoice', 'Exhibition — Stand', 'Conference — Delegate', 'x 3']) {
    assert.ok(!text.includes(removed), `Still shows ${removed}`);
  }
  for (const expected of ['Payment terms', 'Prepared for', 'Customer Ltd', '1 High Street', 'Floor 2', 'W1 1AA', 'United Kingdom',
    '20%', 'Stand', 'Delegate ticket', 'On acceptance', 'On 15/01/2027', 'Within 14 days of invoice', 'Registered charity 1078508.']) {
    assert.ok(text.includes(expected), `Missing ${expected}`);
  }
  const defaultText = await textOf({ quote: { quote_number: 'Q-1' }, version: fullVersion(), tenant });
  assert.ok(defaultText.includes('QUOTE Q-1'));
});

test('bundle components are their own rows with quantities in the Qty column', async () => {
  const [page] = await extractPdf(buildSalesQuotePdf({ quote: { quote_number: 'Q-2' }, version: fullVersion(), tenant }));
  const qty = page.items.find(item => item.str === 'Qty');
  const qtyEdge = qty.transform[4] + qty.width;
  for (const [name, quantity] of [['Stand', '2'], ['Delegate ticket', '6']]) {
    const row = page.items.find(item => item.str === name && item.transform[5] > 400);
    assert.ok(row, `Row for ${name}`);
    assert.ok(page.items.some(item => item.str === quantity && Math.abs(item.transform[5] - row.transform[5]) < 0.5
      && Math.abs(item.transform[4] + item.width - qtyEdge) < 0.5), `${name} quantity ${quantity} in Qty column`);
  }
});

test('genuine terms text still renders under Payment terms when there is no schedule', async () => {
  const version = { ...fullVersion(), billing_schedule: null, terms_snapshot: { text: 'Payment due within 30 days.' } };
  const text = await textOf({ quote: { quote_number: 'Q-3' }, version, tenant });
  assert.ok(text.includes('Payment terms') && text.includes('Payment due within 30 days.'));
  assert.ok(!/\bTerms\b/.test(text), 'no bare Terms heading');
});

test('legacy snapshots without address, tax rate, categories, naming or schedule details render cleanly', async () => {
  const version = {
    status: 'accepted', version_number: 1, currency: 'GBP', issued_at: '2026-01-05T10:00:00Z',
    organisation_snapshot: { name: 'Legacy Org' }, net_minor: 1000, tax_minor: 200, gross_minor: 1200, payment_terms: 'Net 30',
    sales_quote_line: [{ description: 'Old line', quantity: 1, net_minor: 1000, tax_minor: 200, gross_minor: 1200,
      sales_quote_bundle_component: [{ quantity: 2, product_snapshot: { name: 'Old item' } }] }],
    billing_schedule: { timezone: 'UTC', groups: [{ name: 'Remainder', grossMinor: 0, timing: { kind: 'acceptance', days: 0 },
      paymentTerms: { name: 'Immediate' }, contents: [{ name: 'Old line', quantity: '1' }] }] },
  };
  const text = await textOf({ quote: { quote_number: 'OLD-1' }, version, tenant: { name: 'Legacy' },
    context: { organisationAddress: { line1: '9 Org Road', city: 'Leeds', postalCode: 'LS1 1AA' } } });
  for (const expected of ['QUOTE OLD-1', '05/01/2026', 'Legacy Org', '9 Org Road', 'Leeds', 'LS1 1AA', '20%', 'Old item', 'No charge', 'Net 30']) {
    assert.ok(text.includes(expected), `Missing ${expected}`);
  }
  const contactOnly = await textOf({ quote: {}, version: { version_number: 1, currency: 'GBP', customer_contact_snapshot: { name: 'Solo Buyer' } }, tenant: {} });
  assert.ok(contactOnly.includes('Solo Buyer'));
});

test('long quotes paginate with repeated table headers inside the bottom margin', async () => {
  const version = fullVersion();
  version.billing_schedule = null;
  version.sales_quote_line = Array.from({ length: 60 }, (_, i) => ({ description: `Line item number ${i} with a description that wraps across the column`,
    quantity: 1, quoted_unit_price_minor: 100, tax_rate_bps: 2000, net_minor: 100, tax_minor: 20, gross_minor: 120 }));
  const pages = await extractPdf(buildSalesQuotePdf({ quote: { quote_number: 'LONG' }, version: { ...version, status: 'draft' }, tenant }));
  assert.ok(pages.length > 2);
  for (const page of pages) {
    assert.ok(page.items.some(item => item.str === 'Description') || page === pages.at(-1));
    assert.ok(page.items.every(item => item.transform[5] > 20), 'nothing below the bottom margin');
  }
  assert.ok(pages[0].text.includes('DRAFT'));
  const all = pages.map(page => page.text).join(' ');
  for (let i = 0; i < 60; i++) assert.ok(all.includes(`Line item number ${i} `), `row ${i}`);
});

test('a large real remainder schedule paginates every instalment item without clipping', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ kind: 'product', description: `Remainder item ${i}`, quantity: '1',
    netMinor: 100, taxMinor: 20, grossMinor: 120, taxRateBps: 2000, catalogueSnapshot: {}, components: [] }));
  let n = 0;
  const schedule = buildBillingSchedule({ lines, currency: 'GBP', timezone: 'UTC', timezoneFallback: true,
    remainderPaymentTerms: { name: 'Net 30', days: 30 }, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  assert.equal(schedule.groups.length, 1);
  const version = { ...fullVersion(), status: 'issued', billing_schedule: schedule,
    sales_quote_line: lines.map(l => ({ description: l.description, quantity: l.quantity, tax_rate_bps: 2000, net_minor: 100, tax_minor: 20, gross_minor: 120 })) };
  const pages = await extractPdf(buildSalesQuotePdf({ quote: { quote_number: 'BIG' }, version, tenant }));
  const termsPages = pages.filter(page => page.text.includes('Instalment'));
  assert.ok(termsPages.length >= 2, 'payment terms continue across pages');
  for (const page of termsPages.slice(1)) assert.ok(page.text.includes('(continued)'), 'continuation rows identify the instalment');
  for (const page of pages) {
    assert.ok(page.items.every(item => item.transform[5] > 20 && item.transform[5] < page.height), 'text within page bounds');
  }
  const contents = pages.flatMap(page => page.items.filter(item => /^1 × Remainder item \d+$/.test(item.str)).map(item => item.str));
  assert.equal(new Set(contents).size, 100, 'every remainder item is visible in Payment terms');
  // Contents above the footer zone (footer text sits at 10mm from the bottom).
  for (const page of pages) for (const item of page.items.filter(i => /Remainder item/.test(i.str))) assert.ok(item.transform[5] > 20 / 25.4 * 72);
});

test('a single line taller than a page flows instead of being clipped', async () => {
  const version = { ...fullVersion(), billing_schedule: null, sales_quote_line: [{ description: Array.from({ length: 120 }, (_, i) => `Clause ${i}.`).join('\n'),
    quantity: 1, net_minor: 100, tax_minor: 20, gross_minor: 120, tax_rate_bps: 2000 }] };
  const pages = await extractPdf(buildSalesQuotePdf({ quote: { quote_number: 'TALL' }, version, tenant }));
  const all = pages.flatMap(page => page.items.map(item => item.str));
  for (let i = 0; i < 120; i++) assert.ok(all.includes(`Clause ${i}.`), `clause ${i}`);
  for (const page of pages) assert.ok(page.items.filter(item => /^Clause/.test(item.str)).every(item => item.transform[5] > 20 / 25.4 * 72));
});

test('helpers degrade for legacy data', async () => {
  assert.equal(lineVatPercent({ net_minor: 1000, tax_minor: 200 }), '20%');
  assert.equal(lineVatPercent({ net_minor: 0, tax_minor: 0 }), '');
  assert.equal(lineVatPercent({ tax_rate_bps: 0, net_minor: 1000, tax_minor: 0 }), '0%');
  assert.equal(lineVatPercent({ tax_rate_bps: 1750 }), '17.5%');
  assert.equal(formatPdfDate('2026-02-03'), '03/02/2026');
  assert.equal(formatPdfDate(null), '');
  assert.deepEqual(quoteAddressLines({ address_snapshot: { line1: '', city: null } }, null), []);
  assert.deepEqual(organisationAddressFromRecord({ invoicing_address: 'Old\nAddress' }), { line1: 'Old\nAddress' });
  assert.deepEqual(organisationAddressFromRecord({ address: '1 St', postcode: 'AB1', city: 'Town' }),
    { line1: '1 St', line2: undefined, city: 'Town', region: undefined, postalCode: 'AB1', country: undefined });
  const calls = [];
  const query = (table, data) => ({ select() { return this; }, eq(column, value) { calls.push([table, column, value]); return this; }, maybeSingle: async () => ({ data }) });
  const db = { from: table => query(table, table === 'sales_settings' ? { quote_singular_name: 'Proposal' }
    : { invoicing_address_line1: '5 Road', invoicing_city: 'York', invoicing_postal_code: 'YO1' }) };
  const context = await loadSalesQuotePdfContext(db, 'tenant', { organisation_snapshot: { id: 'org-1', name: 'Org' } });
  assert.equal(context.quoteSingular, 'Proposal');
  assert.equal(context.organisationAddress.line1, '5 Road');
  assert.ok(calls.some(([table, column, value]) => table === 'organization' && column === 'tenant_id' && value === 'tenant'));
  const withSnapshot = await loadSalesQuotePdfContext(db, 'tenant', fullVersion());
  assert.equal(withSnapshot.organisationAddress, undefined, 'stored address snapshot wins');
});
