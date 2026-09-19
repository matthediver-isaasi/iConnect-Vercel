import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatHistoricalDdAmount,
  formatHistoricalDdDate,
  historicalInvoiceFilename,
  HistoricalDdPaymentsTable,
} from './HistoricalDdPayments.jsx';

test('historical amount and nominal/charge dates are formatted separately', () => {
  assert.equal(formatHistoricalDdAmount(1304, 'GBP'), '£13.04');
  assert.equal(formatHistoricalDdDate('2026-01-01', { monthOnly: true }), 'January 2026');
  assert.match(formatHistoricalDdDate('2026-01-06'), /6 Jan 2026/);
});

test('read-only renderer only uses authenticated GET requests for invoices', () => {
  const source = readFileSync(new URL('./HistoricalDdPayments.jsx', import.meta.url), 'utf8');
  assert.match(source, /historical-dd-invoice/);
  assert.match(source, /credentials:\s*"include"/);
  assert.doesNotMatch(source, /xero_invoice_url/);
  assert.match(source, /read-only and never trigger a collection, retry, refund or accounting action/);
  assert.doesNotMatch(source, /method:\s*["']POST/);
});

test('safe invoice filenames prefer Content-Disposition and fall back to persisted display values', () => {
  const payment = { id: 'one', xero_invoice_number: 'INV/100' };
  assert.equal(
    historicalInvoiceFilename("attachment; filename*=UTF-8''January%20invoice.pdf", payment),
    'January invoice.pdf',
  );
  assert.equal(historicalInvoiceFilename(null, payment), 'historical-dd-invoice-INV-100.pdf');
  assert.equal(
    historicalInvoiceFilename('attachment; filename="../../unsafe"', payment),
    '..-..-unsafe.pdf',
  );
});

test('renders nominal period, actual charge, amount, status and protected invoice controls', () => {
  const html = renderToStaticMarkup(React.createElement(HistoricalDdPaymentsTable, {
    request: async () => { throw new Error('not called during render'); },
    payments: [{
      id: 'one',
      period: '2026-01-01',
      charge_date: '2026-01-06',
      amount_minor: 1304,
      currency: 'GBP',
      provider_status: 'paid_out',
      xero_invoice_number: 'INV-100',
      invoice_available: true,
    }],
  }));
  assert.match(html, /January 2026/);
  assert.match(html, /6 Jan 2026/);
  assert.match(html, /£13\.04/);
  assert.match(html, /Paid out/);
  assert.match(html, /INV-100/);
  assert.match(html, /View invoice INV-100/);
  assert.match(html, /Download invoice INV-100/);
  assert.doesNotMatch(html, /go\.xero\.com/);
});

test('both existing member surfaces include historical DD records', () => {
  const admin = readFileSync(new URL('../MemberMembershipTab.jsx', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../../pages/History.jsx', import.meta.url), 'utf8');
  assert.match(admin, /<HistoricalDdPayments[\s\S]*request=\{adminFetch\}/);
  assert.match(admin, /activeTenantId=\{activeTenantId\}/);
  assert.match(portal, /<HistoricalDdPayments[\s\S]*memberId=\{memberInfo\?\.id\}/);
});