import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildSalesQuotePdf } from './salesQuotePdf.js';

test('proposal PDF shows stored net, VAT and gross for mixed-tax lines and totals', async () => {
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
          tax_minor: 0, gross_minor: 5000,
          catalogue_snapshot: { tax_code: { name: 'Exempt Income' } } },
      ],
    },
  });
  const pdf = await getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  try {
    const page = await pdf.getPage(1);
    const { items } = await page.getTextContent();
    const text = items.map(item => item.str).join(' ');
    for (const expected of ['Net', 'Tax/VAT', 'Gross', '£180.00', '£36.00', '£216.00',
      '£0.00', 'Standard VAT', 'Exempt Income', 'Net: £230.00', 'Tax/VAT: £36.00', 'Gross total: £266.00']) {
      assert.ok(text.includes(expected), `Missing ${expected}`);
    }
    const headers = ['Net', 'Tax/VAT', 'Gross'].map(label => items.find(item => item.str === label));
    assert.ok(headers[0].transform[4] < headers[1].transform[4]);
    assert.ok(headers[1].transform[4] < headers[2].transform[4]);
    assert.ok(items.filter(item => /^£/.test(item.str)).every(item =>
      item.transform[4] + item.width < page.view[2] - 20), 'amounts remain inside page');
  } finally {
    await pdf.destroy();
  }
});
