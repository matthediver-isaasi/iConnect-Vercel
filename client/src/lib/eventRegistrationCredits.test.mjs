import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { projectCredits } from '../../../api/reports/_credits.js';
import { summarizeRegistrationRevenue } from '../../../shared/eventRegistrationRevenue.mjs';
import {
  formatRegistrationCredits, formatRegistrationCreditsExport,
  formatRegistrationCreditExplanation, summarizeRegistrationCredits, formatRegistrationCreditSummary,
} from './eventRegistrationCredits.js';

const report = readFileSync(new URL('../pages/EventRegistrationReport.jsx', import.meta.url), 'utf8');
const evidence = { operation_key: 'one', provider_id: 'cn_1', provider: 'xero', leg: 'credit_note', amount_minor: 6000, currency: 'GBP', status: 'confirmed' };
const group = credits => ({ credits, groupPayment: { totalAfterDiscount: 100 } });

test('local zero uses plain money and explains the iConnect boundary in CSV', () => {
  const credits = projectCredits([]);
  assert.equal(formatRegistrationCredits(credits), '£0.00');
  assert.equal(formatRegistrationCreditExplanation(credits), 'No credits recorded in iConnect.');
  assert.match(formatRegistrationCreditsExport(credits), /^£0\.00 — No credits recorded in iConnect/);
  assert.doesNotMatch(formatRegistrationCreditsExport(credits), /verified|checked|coverage/i);
});

test('rows, filtered footer, revenue and CSV share local credit amounts', () => {
  const positive = projectCredits([evidence]);
  const groups = [group(positive), ...Array.from({ length: 63 }, () => group(projectCredits([])))];
  assert.equal(formatRegistrationCredits(positive), '£60.00');
  assert.match(formatRegistrationCreditsExport(positive), /^£60\.00 — Credit note \(xero\) #cn_1: £60\.00$/);
  assert.equal(formatRegistrationCreditSummary(summarizeRegistrationCredits(groups)), 'Recorded credits: £60.00');
  assert.equal(summarizeRegistrationRevenue(groups).totalRevenue, 6340);
  assert.equal(formatRegistrationCreditSummary(summarizeRegistrationCredits(groups.slice(1))), 'Recorded credits: £0.00');
  assert.equal(summarizeRegistrationRevenue(groups.slice(1)).totalRevenue, 6300);
});

test('pending and failed attempts remain separate from applied amounts', () => {
  for (const status of ['pending', 'failed']) {
    const credits = projectCredits([evidence, { ...evidence, provider_id: 'cn_2', operation_key: 'two', status }]);
    assert.equal(formatRegistrationCredits(credits), '£60.00');
    assert.match(formatRegistrationCreditsExport(credits), /not counted as an applied credit/);
    assert.equal(summarizeRegistrationRevenue([group(credits)]).totalRevenue, 40);
  }
});

test('legacy missing amounts and storage errors remain explicit across outputs', () => {
  for (const [credits, label] of [
    [projectCredits([], { historicalUnknown: true }), 'Amount not recorded'],
    [{ amount: null, status: 'unavailable', reasonCode: 'storage_failure' }, 'Storage unavailable'],
    [projectCredits([evidence], { partialScope: true }), 'Needs review — allocation or overlap unknown'],
  ]) {
    assert.equal(formatRegistrationCredits(credits), label);
    assert.ok(formatRegistrationCreditsExport(credits).startsWith(label));
    assert.ok(formatRegistrationCreditSummary(summarizeRegistrationCredits([group(credits)])).includes(label));
    assert.equal(summarizeRegistrationRevenue([group(credits)]).totalRevenue, null);
  }
});

test('unavailable instrument with a known amount stays unresolved in row, footer, revenue and CSV', () => {
  const unresolved = { ...evidence, status: 'unavailable' };
  for (const rows of [[unresolved], [{ ...evidence, provider_id: 'cn_confirmed', operation_key: 'other' }, unresolved]]) {
    const credits = projectCredits(rows);
    assert.equal(formatRegistrationCredits(credits), 'Recorded credit status unresolved');
    assert.match(formatRegistrationCreditsExport(credits), /outcome is unresolved/);
    assert.doesNotMatch(formatRegistrationCreditsExport(credits), /No credits recorded|£0\.00/);
    const summary = summarizeRegistrationCredits([group(credits)]);
    assert.deepEqual(summary.unknownByStatus, { 'Recorded credit status unresolved': 1 });
    assert.equal(summarizeRegistrationRevenue([group(credits)]).totalRevenue, null);
  }
});

test('currency precision and incompatible revenue are preserved', () => {
  for (const [currency, amount_minor, pattern] of [['JPY', 1200, /JP¥1,200/], ['KWD', 1234, /KWD\s1\.234/]]) {
    const credits = projectCredits([{ ...evidence, currency, amount_minor }]);
    assert.match(formatRegistrationCredits(credits), pattern);
    assert.match(formatRegistrationCreditSummary(summarizeRegistrationCredits([group(credits)])), pattern);
    assert.equal(summarizeRegistrationRevenue([group(credits)]).totalRevenue, null);
  }
});

test('report exports Credits once per group and totals the whole filtered set', () => {
  assert.match(report, /key: 'std:credits'[\s\S]*?isFirstInGroup \? formatRegistrationCreditsExport\(group\.credits\) : ''/);
  assert.match(report, /const creditsSummary = summarizeRegistrationCredits\(filteredGroups\)/);
  assert.match(report, /renderGroupSpannedCells \? renderGroupCreditsCell\(attendee\.id\) : null/);
  assert.doesNotMatch(report, /BookingCreditRefresh|reconcile-booking-credits|canRefreshCredits/);
});
