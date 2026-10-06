import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeRegistrationRevenue, registrationRevenueExplanation } from './eventRegistrationRevenue.mjs';
import { normalizeGroupPayment } from '../api/reports/_pricePaid.js';
import { projectCredits } from '../api/reports/_credits.js';

function group(source = 'standard', amount = 25) {
  const rows = [{
    _report_booking_source: source, ticket_price: source === 'complex' ? 100 : 110,
    total_cost: 110, discount_code_amount: 10, discount_amount: 10,
    voucher_amount: 20, training_fund_amount: 15, account_balance_amount: 30,
  }];
  return {
    attendees: [{ id: 'one' }, { id: 'two' }],
    groupPayment: { ...normalizeGroupPayment(rows), totalCost: 1 },
    credits: { status: 'confirmed', amount, currency: 'GBP' },
  };
}

test('source-aware value less partial/full/zero credits, unaffected by settlement or attendees', () => {
  for (const source of ['standard', 'complex']) {
    for (const [credit, expected] of [[25, 75], [100, 0], [0, 100], [110, 0]]) {
      const input = group(source, credit);
      const before = structuredClone(input);
      assert.equal(summarizeRegistrationRevenue([input]).totalRevenue, expected);
      assert.deepEqual(input, before);
    }
  }
});

test('linked legs count once and independent operations sum using the existing projection', () => {
  const row = { operation_key: 'a', leg: 'refund', amount_minor: 2500, currency: 'GBP', status: 'confirmed' };
  const input = group();
  input.credits = projectCredits([row, { ...row, leg: 'credit_note' }]);
  assert.equal(summarizeRegistrationRevenue([input]).totalRevenue, 75);
  input.credits = projectCredits([row, { ...row, operation_key: 'b', amount_minor: 500 }]);
  assert.equal(summarizeRegistrationRevenue([input]).totalRevenue, 70);
});

test('unresolved evidence, missing values and currencies never become a complete total', () => {
  const invalid = [
    ...['pending', 'failed', 'mixed', 'unavailable'].map(status => ({ status, amount: 25, currency: 'GBP' })),
    projectCredits([], { historicalUnknown: true }),
    projectCredits([{ operation_key: 'a', leg: 'refund', amount_minor: 100, currency: 'GBP', status: 'confirmed' },
      { operation_key: 'b', leg: 'credit_note', amount_minor: 100, currency: 'GBP', status: 'confirmed' }]),
    ...[null, '', NaN, Infinity, -1, true].map(amount => ({ status: 'confirmed', amount, currency: 'GBP' })),
    ...['USD', null, 'JPY', 'KWD'].map(currency => ({ status: 'confirmed', amount: 25, currency })),
    { status: 'confirmed', amount: 0, currency: 'USD' },
  ];
  for (const credits of invalid) {
    const summary = summarizeRegistrationRevenue([{ ...group(), credits }, group()]);
    assert.equal(summary.totalRevenue, null);
    assert.equal(summary.hasUnavailableRevenue, true);
    assert.equal(summary.revenueUnavailableGroups, 1);
    assert.ok(registrationRevenueExplanation(summary));
  }
  for (const base of [null, undefined, '', 'bad', Infinity, -1]) {
    const input = group();
    input.groupPayment.totalAfterDiscount = base;
    assert.equal(summarizeRegistrationRevenue([input]).totalRevenue, null);
  }
  const input = group('standard', 0);
  input.credits.currency = null;
  assert.equal(summarizeRegistrationRevenue([input]).totalRevenue, 100);
});

test('whole-filter pennies are stable across pages and filtered attendee subsets', () => {
  const groups = Array.from({ length: 30 }, () => group());
  assert.equal(summarizeRegistrationRevenue(groups).totalRevenue, 2250);
  assert.equal(summarizeRegistrationRevenue(groups.slice(0, 2)).totalRevenue, 150);
  assert.equal(summarizeRegistrationRevenue([{ ...groups[0], attendees: [{ id: 'two' }] }]).totalRevenue, 75);
  const fractional = Array.from({ length: 100 }, () => ({
    groupPayment: { totalAfterDiscount: 0.3 },
    credits: { status: 'confirmed', amount: 0.1, currency: 'GBP' },
  }));
  assert.equal(summarizeRegistrationRevenue(fractional).totalRevenue, 20);
  assert.equal(summarizeRegistrationRevenue([]).totalRevenue, 0);
});

test('actual client summary and API summary share the contract after attachment, without touching Stripe', () => {
  const client = readFileSync(new URL('../client/src/pages/EventRegistrationReport.jsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/reports/event-registration-report.js', import.meta.url), 'utf8');
  const block = client.slice(client.indexOf('  const filteredSummary = useMemo('), client.indexOf('  const totalPages ='));
  const groups = [group(), group('complex')];
  const result = new Function('useMemo', 'filteredGroups', 'totalAttendees',
    'summarizeRegistrationRevenue', 'summarizeRegistrationCredits', 'financialAmount', 'isGrossSnapshotUnavailable',
    `${block}; return filteredSummary;`)(
    fn => fn(), groups, 4, summarizeRegistrationRevenue, () => ({}),
    value => value == null ? null : Number(value), () => false,
  );
  assert.equal(result.totalRevenue, 150);
  assert.equal(result.totalStripePayments, 0);
  const summaryStart = api.indexOf('      summary = {');
  const summaryEnd = api.indexOf('\n      };', summaryStart) + '\n      };'.length;
  const bindings = {
    summarizeRegistrationRevenue, bookingGroups: groups,
    totalVoucher: 0, totalTrainingFund: 0, totalDiscount: 0,
    totalAccountPayments: 0, totalStripePayments: 99,
    hasUnavailableTicketTotal: false, hasUnavailableDiscount: false,
    hasUnavailableAfterDiscount: false, hasUnavailablePricePaid: false,
    countByMethod: {}, countByStatus: {}, allBookings: [],
    groupMap: new Map(), commercialAllocations: [],
  };
  const server = new Function(...Object.keys(bindings),
    `let summary; ${api.slice(summaryStart, summaryEnd)}; return summary;`)(...Object.values(bindings));
  assert.equal(server.totalRevenue, result.totalRevenue);
  assert.equal(server.totalStripePayments, 99);
  groups[0].credits.status = 'pending';
  const unavailableServer = new Function(...Object.keys(bindings),
    `let summary; ${api.slice(summaryStart, summaryEnd)}; return summary;`)(...Object.values(bindings));
  assert.equal(unavailableServer.totalRevenue, null);
  assert.equal(unavailableServer.revenueUnavailableGroups, 1);
  assert.match(api, /await attachReportCredits[\s\S]*?summary = \{\s*\.\.\.summarizeRegistrationRevenue\(bookingGroups\)/);
  assert.ok(client.indexOf('summarizeRegistrationRevenue(filteredGroups)') < client.indexOf('const paginatedGroups'));
  assert.match(client, /else totalStripePayments \+= cost - codeDiscount/);
});
