import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesQuotePdf } from './salesQuotePdf.js';
import { extractPdf } from './salesQuotePdf.testUtils.mjs';

test('percentage PDF lays out whole-proposal instalments as a Payment terms table without timezone text', async () => {
  const result = buildSalesQuotePdf({
    tenant: { name: 'Test tenant' }, quote: { quote_number: 'TEST-1' },
    version: { currency: 'GBP', lines: [], net_minor: 40000, tax_minor: 0, gross_minor: 40000,
      terms_snapshot: { text: 'Payment terms are specified per invoice in the billing schedule.' },
      billing_schedule: { mode: 'percentage', timezone: 'UTC', timezoneFallback: true, groups: [
        { name: 'Deposit', percentageBps: 2500, currency: 'GBP', grossMinor: 10000,
          timing: { kind: 'acceptance', days: 0 }, paymentTerms: { name: 'Due now', days: 0 }, contents: [] },
        { name: 'Balance', percentageBps: 7500, currency: 'GBP', grossMinor: 30000,
          timing: { kind: 'acceptance', days: 30 }, paymentTerms: { name: 'Net 14', days: 14 }, contents: [] },
      ] },
    },
  });
  const text = (await extractPdf(result)).map(page => page.text).join(' ');
  for (const expected of ['Payment terms', 'Instalment', 'Invoiced', 'Payment due', 'Amount',
    'Deposit', '25%', 'Balance', '75%', 'On acceptance', '30 days after acceptance',
    'On receipt of invoice', 'Within 14 days of invoice', '£100.00', '£300.00']) {
    assert.ok(text.includes(expected), `Missing ${expected}`);
  }
  for (const removed of ['UTC', 'fallback', 'Whole-proposal percentage schedule', 'specified per invoice', 'Terms ']) {
    assert.ok(!text.includes(removed), `Still shows ${removed}`);
  }
});
