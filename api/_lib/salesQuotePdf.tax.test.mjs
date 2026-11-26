import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesQuotePdf } from './salesQuotePdf.js';
import { extractPdf } from './salesQuotePdf.testUtils.mjs';

test('proposal PDF shows stored net, VAT and gross per line with a VAT % column and right-aligned totals', async () => {
  const bytes = buildSalesQuotePdf({
    quote: { quote_number: 'TEST' }, tenant: { name: 'Test tenant' },
    version: {
      status: 'draft', version_number: 1, currency: 'GBP',
      net_minor: 23000, tax_minor: 3600, gross_minor: 26600,
      sales_quote_line: [
        { description: 'Discounted taxable item', quantity: '2', net_minor: 18000,
          tax_minor: 3600, gross_minor: 21600,
          // Deliberately different rate: PDF must not recalculate frozen totals.
          tax_rate_bps: 500, catalogue_snapshot: { tax_code: { name: 'Standard VAT' } } },
        { description: 'Exempt item', quantity: '1', net_minor: 5000,
          tax_minor: 0, gross_minor: 5000, tax_rate_bps: 0,
          catalogue_snapshot: { tax_code: { name: 'Exempt Income' } } },
      ],
    },
  });
  const [page] = await extractPdf(bytes);
  for (const expected of ['Description', 'Qty', 'Unit price', 'VAT %', 'Net', 'VAT', 'Gross',
    '£180.00', '£36.00', '£216.00', '£0.00', '5%', '0%', 'Subtotal', '£230.00', 'Total GBP', '£266.00']) {
    assert.ok(page.items.some(item => item.str === expected), `Missing ${expected}`);
  }
  for (const internal of ['Standard VAT', 'Exempt Income', 'Tax/VAT']) assert.ok(!page.text.includes(internal), `Shows ${internal}`);
  const x = label => page.items.find(item => item.str === label).transform[4];
  assert.ok(x('Qty') < x('Unit price') && x('Unit price') < x('VAT %') && x('VAT %') < x('Net') && x('Net') < x('VAT') && x('VAT') < x('Gross'));
  const money = page.items.filter(item => /^£/.test(item.str));
  assert.ok(money.every(item => item.transform[4] + item.width < page.width - 20), 'amounts remain inside page');
  // Right aligned: gross column values share a right edge with the Gross header.
  const grossEdge = x('Gross') + page.items.find(item => item.str === 'Gross').width;
  for (const value of ['£216.00', '£50.00']) {
    assert.ok(page.items.filter(i => i.str === value)
      .some(item => Math.abs(item.transform[4] + item.width - grossEdge) < 0.5), `${value} right aligned`);
  }
  const total = page.items.find(item => item.str === '£266.00');
  assert.ok(Math.abs(total.transform[4] + total.width - grossEdge) < 0.5, 'total right aligned');
});
