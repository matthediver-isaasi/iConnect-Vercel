import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatHistoricalDdAmount,
  formatHistoricalDdDate,
  HistoricalDdPaymentsTable,
} from './HistoricalDdPayments.jsx';

test('historical amount and nominal/charge dates are formatted separately', () => {
  assert.equal(formatHistoricalDdAmount(1304, 'GBP'), '£13.04');
  assert.equal(formatHistoricalDdDate('2026-01-01', { monthOnly: true }), 'January 2026');
  assert.match(formatHistoricalDdDate('2026-01-06'), /6 Jan 2026/);
});

test('read-only renderer has no mutation controls and uses safe external links', () => {
  const source = readFileSync(new URL('./HistoricalDdPayments.jsx', import.meta.url), 'utf8');
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /read-only and never trigger a collection, retry, refund or accounting action/);
  assert.doesNotMatch(source, /method:\s*["']POST/);
});

test('renders nominal period, actual charge, amount, status and Xero invoice', () => {
  const html = renderToStaticMarkup(React.createElement(HistoricalDdPaymentsTable, {
    payments: [{
      id: 'one',
      period: '2026-01-01',
      charge_date: '2026-01-06',
      amount_minor: 1304,
      currency: 'GBP',
      provider_status: 'paid_out',
      xero_invoice_number: 'INV-100',
      xero_invoice_url: 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=valid',
    }],
  }));
  assert.match(html, /January 2026/);
  assert.match(html, /6 Jan 2026/);
  assert.match(html, /£13\.04/);
  assert.match(html, /Paid out/);
  assert.match(html, /INV-100/);
  assert.match(html, /target="_blank"/);
  assert.doesNotMatch(html, /button/i);
});

test('both existing member surfaces include historical DD records', () => {
  const admin = readFileSync(new URL('../MemberMembershipTab.jsx', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../../pages/History.jsx', import.meta.url), 'utf8');
  assert.match(admin, /<HistoricalDdPayments[\s\S]*request=\{adminFetch\}/);
  assert.match(admin, /activeTenantId=\{activeTenantId\}/);
  assert.match(portal, /<HistoricalDdPayments[\s\S]*memberId=\{memberInfo\?\.id\}/);
});