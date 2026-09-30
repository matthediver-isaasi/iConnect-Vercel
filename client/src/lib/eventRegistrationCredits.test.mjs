import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  formatRegistrationCreditBreakdown,
  formatRegistrationCredits,
  formatRegistrationCreditsExport,
  formatRegistrationCreditSummary,
  summarizeRegistrationCredits,
  formatRegistrationCreditExplanation,
  formatCreditMoney,
} from './eventRegistrationCredits.js';

const reportSource = readFileSync(
  new URL('../pages/EventRegistrationReport.jsx', import.meta.url),
  'utf8',
);

test('unresolved explanations distinguish safe causes in visible details and CSV', () => {
  for (const [reasonCode, pattern] of Object.entries({
    no_evidence: /does not establish a zero/,
    pending: /not yet confirmed/,
    ambiguous: /Manual review/,
    lookup_failure: /provider connection/,
    storage_failure: /migration and database access/,
    provider_failed: /reversal failed/,
  })) {
    const credits = { amount: null, status: 'unavailable', reasonCode };
    assert.match(formatRegistrationCreditExplanation(credits), pattern);
    assert.match(formatRegistrationCreditsExport(credits), pattern);
  }
  assert.equal(formatCreditMoney(null, 'GBP'), null);
  assert.equal(formatCreditMoney('', 'GBP'), null);
  assert.doesNotMatch(formatRegistrationCreditExplanation({ error: 'secret-provider-detail' }), /secret-provider-detail/);
});

test('credits formatter distinguishes confirmed zero and unresolved evidence', () => {
  assert.equal(
    formatRegistrationCredits({ amount: 0, currency: null, status: 'confirmed', breakdown: [] }),
    '£0.00',
  );
  assert.equal(formatRegistrationCredits({ amount: null, status: 'pending' }), 'Pending');
  assert.equal(formatRegistrationCredits({ amount: null, status: 'failed' }), 'Failed');
  assert.equal(formatRegistrationCredits({ amount: null, status: 'mixed' }), 'Mixed / unavailable');
  assert.equal(formatRegistrationCredits({ amount: null, status: 'unavailable' }), 'Unavailable');
  assert.equal(formatRegistrationCredits(null), 'Unavailable');
  assert.equal(
    formatRegistrationCredits({ amount: 10, currency: null, status: 'confirmed', breakdown: [] }),
    'Unavailable',
  );
});

test('credits formatter uses each currency default fractional digits', () => {
  assert.equal(
    formatRegistrationCredits({ amount: 1200, currency: 'JPY', status: 'confirmed' }),
    'JP¥1,200',
  );
  assert.match(
    formatRegistrationCredits({ amount: 1.234, currency: 'KWD', status: 'confirmed' }),
    /^KWD\s1\.234$/,
  );
  assert.match(
    formatRegistrationCreditsExport({
      amount: 1.234,
      currency: 'KWD',
      status: 'confirmed',
      breakdown: [{
        type: 'refund',
        provider: 'stripe',
        amount: 1.234,
        currency: 'KWD',
        status: 'confirmed',
      }],
    }),
    /^KWD\s1\.234 — Refund \(stripe\): KWD\s1\.234$/,
  );
});

test('CSV detail distinguishes refunds from credit notes while sharing the visible amount formatter', () => {
  const credits = {
    amount: 25,
    currency: 'GBP',
    status: 'confirmed',
    breakdown: [
      { type: 'refund', provider: 'stripe', providerId: 're_1', amount: 25, currency: 'GBP', status: 'confirmed' },
      { type: 'credit_note', provider: 'xero', providerId: 'cn_1', amount: 25, currency: 'GBP', status: 'confirmed' },
    ],
  };
  assert.equal(formatRegistrationCredits(credits), '£25.00');
  assert.match(formatRegistrationCreditBreakdown(credits), /Refund \(stripe\) #re_1: £25\.00/);
  assert.match(formatRegistrationCreditBreakdown(credits), /Credit note \(xero\) #cn_1: £25\.00/);
  assert.match(formatRegistrationCreditsExport(credits), /^£25\.00 — Refund/);
});

test('whole-filter credit summary counts each group once and preserves currencies and unknown statuses', () => {
  const groups = [
    { isComplexEvent: false, attendees: [{ id: 'a' }, { id: 'b' }], credits: { amount: 10, currency: 'GBP', status: 'confirmed' } },
    { isComplexEvent: true, attendees: [{ id: 'c' }], credits: { amount: 5, currency: 'USD', status: 'confirmed' } },
    { attendees: [{ id: 'd' }], credits: { amount: null, currency: 'GBP', status: 'pending' } },
    { attendees: [{ id: 'e' }], credits: { amount: null, currency: null, status: 'unavailable' } },
  ];
  const summary = summarizeRegistrationCredits(groups);
  assert.deepEqual(summary.totalsByCurrency, { GBP: 10, USD: 5 });
  assert.deepEqual(summary.unknownByStatus, { pending: 1, unavailable: 1 });
  const label = formatRegistrationCreditSummary(summary);
  assert.match(label, /£10\.00/);
  assert.match(label, /US\$5\.00/);
  assert.match(label, /Pending: 1/);
  assert.match(label, /Unavailable: 1/);
});

test('whole-filter summary preserves JPY and KWD precision and flags missing nonzero currency', () => {
  const summary = summarizeRegistrationCredits([
    { credits: { amount: 1200, currency: 'JPY', status: 'confirmed' } },
    { credits: { amount: 1.234, currency: 'KWD', status: 'confirmed' } },
    { credits: { amount: 9, currency: null, status: 'confirmed' } },
    { credits: { amount: 0, currency: null, status: 'confirmed' } },
  ]);
  assert.deepEqual(summary.totalsByCurrency, { JPY: 1200, KWD: 1.234 });
  assert.deepEqual(summary.unknownByStatus, { unavailable: 1 });
  const label = formatRegistrationCreditSummary(summary);
  assert.match(label, /JP¥1,200/);
  assert.match(label, /KWD\s1\.234/);
  assert.match(label, /Unavailable: 1/);
});

test('report renders and exports group credits as a singleton after Price Paid', () => {
  const priceColumn = reportSource.indexOf("{ key: 'std:pricePaid'");
  const creditsColumn = reportSource.indexOf("{ key: 'std:credits'");
  const nextColumn = reportSource.indexOf("{ key: 'std:discountCode'");
  assert.ok(priceColumn >= 0 && priceColumn < creditsColumn && creditsColumn < nextColumn);
  assert.match(
    reportSource,
    /key: 'std:credits'[\s\S]*?isFirstInGroup \? formatRegistrationCreditsExport\(group\.credits\) : ''/,
  );
  assert.match(
    reportSource,
    /text-price-paid-\$\{attendee\.id\}[\s\S]*?text-credits-\$\{attendee\.id\}/,
  );
  assert.match(reportSource, /renderGroupCreditsCell\(headerKey\)/);
  assert.match(reportSource, /renderGroupSpannedCells \? renderGroupCreditsCell\(attendee\.id\) : null/);
});

test('credit footer uses all filtered groups, not the current page', () => {
  assert.match(
    reportSource,
    /const creditsSummary = summarizeRegistrationCredits\(filteredGroups\)/,
  );
  const summaryIndex = reportSource.indexOf('const creditsSummary = summarizeRegistrationCredits(filteredGroups)');
  const paginationIndex = reportSource.indexOf('const paginatedGroups = filteredGroups.slice');
  assert.ok(summaryIndex >= 0 && summaryIndex < paginationIndex);
  assert.match(reportSource, /text-total-credits/);
});

test('new Credits CSV choice is defaulted without reselecting known deselections', () => {
  const introductionSource = reportSource.slice(
    reportSource.indexOf('  // Default new columns to selected'),
    reportSource.indexOf('  const toggleColumn ='),
  );
  const state = { selected: new Set(['std:event']) };
  const knownColumnKeysRef = { current: new Set(['std:event', 'std:pricePaid']) };
  const allColumnKeys = ['std:event', 'std:pricePaid', 'std:credits'];
  let scheduledUpdater;
  const setSelectedColumnKeys = (updater) => { scheduledUpdater = updater; };
  const useEffect = (callback) => callback();
  new Function(
    'allColumnKeys',
    'knownColumnKeysRef',
    'setSelectedColumnKeys',
    'useEffect',
    introductionSource,
  )(allColumnKeys, knownColumnKeysRef, setSelectedColumnKeys, useEffect);
  state.selected = scheduledUpdater(state.selected);
  assert.deepEqual([...state.selected], ['std:event', 'std:credits']);
});