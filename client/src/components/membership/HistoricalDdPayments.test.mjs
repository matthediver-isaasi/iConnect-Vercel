import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatHistoricalDdAmount,
  formatHistoricalDdDate,
  formatHistoricalDdStatus,
  historicalInvoiceFilename,
  historicalDdInvoiceUrl,
  HistoricalDdPaymentsTable,
  isHistoricalDdInvoiceAvailable,
} from './HistoricalDdPayments.jsx';

test('historical amount and nominal/charge dates are formatted separately', () => {
  assert.equal(formatHistoricalDdAmount(1304, 'GBP'), '£13.04');
  assert.equal(formatHistoricalDdDate('2026-01-01', { monthOnly: true }), 'January 2026');
  assert.match(formatHistoricalDdDate('2026-01-06'), /6 Jan 2026/);
});

test('alpha mandate, first-payment and held statuses reuse member-facing labels', () => {
  assert.equal(formatHistoricalDdStatus('active'), 'Active mandate');
  assert.equal(formatHistoricalDdStatus('first_payment_pending'), 'Awaiting first payment');
  assert.equal(formatHistoricalDdStatus('held'), 'Held');
});

test('read-only renderer only uses authenticated GET requests for invoices', () => {
  const source = readFileSync(new URL('./HistoricalDdPayments.jsx', import.meta.url), 'utf8');
  assert.match(source, /historical-dd-invoice/);
  assert.match(source, /credentials:\s*"include"/);
  assert.match(source, /source:\s*payment\.source\s*\|\|\s*"pilot_historical_ledger"/);
  assert.doesNotMatch(source, /xero_invoice_url/);
  assert.match(source, /read-only and never trigger a collection, retry, refund or accounting action/);
  assert.doesNotMatch(source, /method:\s*["']POST/);
});

test('invoice requests include the historical source and never a provider payment id', () => {
  assert.equal(
    historicalDdInvoiceUrl({
      id: 'history-row-id',
      source: 'beta_provider_history',
      provider_payment_id: 'provider-id-must-not-be-used',
    }),
    '/api/membership/historical-dd-invoice?recordId=history-row-id&source=beta_provider_history',
  );
  assert.equal(
    historicalDdInvoiceUrl({
      id: 'alpha-history-uuid',
      source: 'alpha_provider_history',
      provider_payment_id: 'must-not-appear',
    }),
    '/api/membership/historical-dd-invoice?recordId=alpha-history-uuid&source=alpha_provider_history',
  );
  assert.equal(
    historicalDdInvoiceUrl({ id: 'pilot-row-id' }, true),
    '/api/membership/historical-dd-invoice?recordId=pilot-row-id&source=pilot_historical_ledger&inline=true',
  );
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

test('projects invoice availability compatibly across current and historical API shapes', () => {
  const base = {
    period: '2026-01-01',
    charge_date: '2026-01-06',
    amount_minor: 1304,
    currency: 'GBP',
    provider_status: 'paid_out',
  };
  const cases = [
    {
      payment: {
        ...base,
        id: 'old-shape',
        xero_invoice_id: '3e69cfdf-4d7c-4d70-9630-aa68f8c8fced',
        xero_invoice_number: 'INV-OLD',
      },
      available: true,
    },
    {
      payment: {
        ...base,
        id: 'explicit-false',
        xero_invoice_id: 'persisted-id',
        xero_invoice_number: 'INV-FALSE',
        invoice_available: false,
      },
      available: false,
    },
    {
      payment: {
        ...base,
        id: 'malformed-flag',
        xero_invoice_id: 'persisted-id',
        invoice_available: 'false',
      },
      available: false,
    },
    {
      payment: {
        ...base,
        id: 'permission-denied',
        xero_invoice_id: 'persisted-id',
        xero_invoice_number: 'INV-DENIED',
        invoice_unavailable_reason: 'permission_denied',
      },
      available: false,
    },
    {
      payment: {
        ...base,
        id: 'number-only',
        xero_invoice_number: 'INV-NUMBER',
        xero_invoice_url: 'https://go.xero.com/invoice/number-only',
      },
      available: false,
    },
  ];

  for (const { payment, available } of cases) {
    assert.equal(isHistoricalDdInvoiceAvailable(payment), available);
  }

  const html = renderToStaticMarkup(React.createElement(HistoricalDdPaymentsTable, {
    request: async () => { throw new Error('not called during render'); },
    payments: cases.map(({ payment }) => payment),
  }));
  assert.match(html, /button-view-historical-dd-invoice-old-shape/);
  assert.match(html, /button-download-historical-dd-invoice-old-shape/);
  assert.doesNotMatch(html, /button-view-historical-dd-invoice-explicit-false/);
  assert.doesNotMatch(html, /button-download-historical-dd-invoice-explicit-false/);
  assert.doesNotMatch(html, /button-view-historical-dd-invoice-permission-denied/);
  assert.doesNotMatch(html, /button-download-historical-dd-invoice-permission-denied/);
  assert.doesNotMatch(html, /button-view-historical-dd-invoice-number-only/);
  assert.doesNotMatch(html, /button-download-historical-dd-invoice-number-only/);
  assert.match(html, /historical-dd-invoice-denied-permission-denied/);
});

test('beta provider history is clearly unreconciled and exposes no invoice actions or activation claim', () => {
  const html = renderToStaticMarkup(React.createElement(HistoricalDdPaymentsTable, {
    request: async () => { throw new Error('not called during render'); },
    payments: [{
      id: 'beta-provider',
      period: null,
      charge_date: '2026-09-09',
      amount_minor: 1425,
      currency: 'GBP',
      provider_status: 'paid_out',
      provider_only: true,
      provenance: 'provider_evidence_only',
      accounting_reconciled: false,
      invoice_available: false,
      invoice_unavailable_reason: 'accounting_unreconciled',
    }],
  }));
  assert.match(html, /Provider history only/);
  assert.match(html, /Provider evidence · unreconciled/);
  assert.match(html, /No accounting invoice — provider evidence only/);
  assert.match(html, /have no invoice or download/);
  assert.match(html, /do not[\s\S]*activate payment/);
  assert.doesNotMatch(html, /button-view-historical-dd-invoice-beta-provider/);
  assert.doesNotMatch(html, /button-download-historical-dd-invoice-beta-provider/);
  assert.doesNotMatch(html, /Nominal period: Unknown/);
});

test('reconciled beta history exposes protected invoice actions and keeps its historical row id', () => {
  const html = renderToStaticMarkup(React.createElement(HistoricalDdPaymentsTable, {
    request: async () => { throw new Error('not called during render'); },
    payments: [{
      id: 'beta-linked',
      source: 'beta_provider_history',
      charge_date: '2026-09-09',
      amount_minor: 1425,
      currency: 'GBP',
      provider_status: 'paid_out',
      provider_only: false,
      provenance: 'provider_and_accounting_evidence',
      accounting_reconciled: true,
      xero_invoice_number: 'BETA-10',
      invoice_available: true,
    }],
  }));
  assert.match(html, /Reconciled provider history/);
  assert.match(html, /Provider \+ accounting evidence · reconciled/);
  assert.match(html, /button-view-historical-dd-invoice-beta-linked/);
  assert.match(html, /button-download-historical-dd-invoice-beta-linked/);
  assert.doesNotMatch(html, /Provider evidence · unreconciled/);
});

test('reconciled alpha history reuses protected provider-history invoice presentation', () => {
  const html = renderToStaticMarkup(React.createElement(HistoricalDdPaymentsTable, {
    request: async () => { throw new Error('not called during render'); },
    payments: [{
      id: 'alpha-linked',
      source: 'alpha_provider_history',
      charge_date: '2026-01-01',
      amount_minor: 1600,
      currency: 'GBP',
      provider_status: 'first_payment_pending',
      provider_only: false,
      provenance: 'provider_and_accounting_evidence',
      accounting_reconciled: true,
      xero_invoice_number: 'ALPHA-10',
      invoice_available: true,
    }],
  }));
  assert.match(html, /Awaiting first payment/);
  assert.match(html, /Reconciled provider history/);
  assert.match(html, /button-view-historical-dd-invoice-alpha-linked/);
});

test('both existing member surfaces include historical DD records', () => {
  const admin = readFileSync(new URL('../MemberMembershipTab.jsx', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../../pages/History.jsx', import.meta.url), 'utf8');
  assert.match(admin, /<HistoricalDdPayments[\s\S]*request=\{adminFetch\}/);
  assert.match(admin, /activeTenantId=\{activeTenantId\}/);
  assert.match(portal, /<HistoricalDdPayments[\s\S]*memberId=\{memberInfo\?\.id\}/);
});