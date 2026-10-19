import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesQuotePdf } from './salesQuotePdf.js';

test('percentage PDF identifies whole-proposal instalments and their independent timing and terms', () => {
  const result = buildSalesQuotePdf({
    tenant: { name: 'Test tenant' }, quote: { quote_number: 'TEST-1' },
    version: { currency: 'GBP', lines: [], net_minor: 40000, tax_minor: 0, gross_minor: 40000,
      terms_snapshot: { text: 'Payment terms are specified per invoice in the billing schedule.' },
      billing_schedule: { mode: 'percentage', timezone: 'UTC', groups: [
        { name: 'Deposit', percentageBps: 2500, currency: 'GBP', grossMinor: 10000,
          timing: { kind: 'acceptance', days: 0 }, paymentTerms: { name: 'Due now', days: 0 }, contents: [] },
        { name: 'Balance', percentageBps: 7500, currency: 'GBP', grossMinor: 30000,
          timing: { kind: 'acceptance', days: 30 }, paymentTerms: { name: 'Net 14', days: 14 }, contents: [] },
      ] },
    },
  });
  const text = Buffer.from(result).toString('latin1');
  assert.match(text, /Whole-proposal percentage schedule/);
  assert.match(text, /Deposit.*25%/);
  assert.match(text, /Balance.*75%/);
  assert.match(text, /Issue on acceptance/);
  assert.match(text, /30 calendar days after acceptance/);
  assert.match(text, /Payment due 14 calendar days after invoice issue/);
});
