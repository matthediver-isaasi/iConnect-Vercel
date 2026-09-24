import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { formatRegistrationPricePaid } from '../lib/eventRegistrationPricePaid.js';

const source = readFileSync(new URL('./EventRegistrationReport.jsx', import.meta.url), 'utf8');

test('price paid formatter distinguishes net, pending, and unavailable values', () => {
  assert.equal(formatRegistrationPricePaid({ price_paid_status: 'net', price_paid: 12 }), '£12.00');
  assert.equal(formatRegistrationPricePaid({ price_paid_status: 'net', price_paid: 12.345 }), '£12.35');
  assert.equal(
    formatRegistrationPricePaid({ price_paid_status: 'pending', price_paid: 19.5 }),
    'Pending/unpaid — £19.50',
  );
  assert.equal(
    formatRegistrationPricePaid({ price_paid_status: 'pending', price_paid: null }),
    'Pending/unpaid',
  );
  assert.equal(
    formatRegistrationPricePaid({ price_paid_status: 'unavailable', price_paid: null }),
    'Unavailable',
  );
  assert.equal(formatRegistrationPricePaid({}), 'Unavailable');
});

test('financial export columns use stable keys in accounting order', () => {
  const ticketPriceIndex = source.indexOf("{ key: 'std:ticketPrice'");
  const groupDiscountIndex = source.indexOf("{ key: 'std:groupDiscount'");
  const groupTotalIndex = source.indexOf("{ key: 'std:groupTotal'");
  const voucherIndex = source.indexOf("{ key: 'std:voucher'");
  const trainingFundIndex = source.indexOf("{ key: 'std:trainingFund'");
  const pricePaidIndex = source.indexOf("{ key: 'std:pricePaid'");
  assert.ok(ticketPriceIndex >= 0);
  assert.ok(
    ticketPriceIndex < groupDiscountIndex
      && groupDiscountIndex < groupTotalIndex
      && groupTotalIndex < voucherIndex
      && voucherIndex < trainingFundIndex
      && trainingFundIndex < pricePaidIndex,
  );
  assert.match(source, /key: 'std:groupTotal', label: 'Total after Discount'/);
  assert.match(source, /gp\.totalAfterDiscount/);
  assert.match(
    source,
    /key: 'std:groupTotal'[\s\S]*?gp\.totalAfterDiscount/,
    'the CSV total must use the canonical intermediate total',
  );
  assert.match(
    source,
    /totalRevenue \+= \(gp\.totalCost \|\| 0\) - \(gp\.codeDiscount \|\| 0\)/,
    'the separate revenue summary keeps its existing meaning',
  );

  // Exercise the page's actual introduction effect. Existing deselections
  // remain untouched while the newly introduced Price Paid key is selected.
  const introductionSource = source.slice(
    source.indexOf('  // Default new columns to selected'),
    source.indexOf('  const toggleColumn ='),
  );
  const state = { selected: new Set(['std:event']) };
  const knownColumnKeysRef = { current: new Set(['std:event', 'std:ticketPrice']) };
  const allColumnKeys = ['std:event', 'std:ticketPrice', 'std:pricePaid'];
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
  // Mirror React concurrent scheduling: the ref has advanced before the
  // functional state updater runs.
  state.selected = scheduledUpdater(state.selected);
  assert.deepEqual([...state.selected], ['std:event', 'std:pricePaid']);

  // Exercise the actual picker toggle handler in both directions.
  const toggleSource = source.slice(
    source.indexOf('  const toggleColumn ='),
    source.indexOf('  const filteredSummary ='),
  );
  const applySelectedUpdate = (updater) => { state.selected = updater(state.selected); };
  new Function('setSelectedColumnKeys', `${toggleSource}; toggleColumn('std:pricePaid');`)(
    applySelectedUpdate,
  );
  assert.equal(state.selected.has('std:pricePaid'), false);
  new Function('setSelectedColumnKeys', `${toggleSource}; toggleColumn('std:pricePaid');`)(
    applySelectedUpdate,
  );
  assert.equal(state.selected.has('std:pricePaid'), true);
});

test('table and filtered CSV export share the same Price Paid formatter', () => {
  const formatterCalls = source.match(/formatRegistrationPricePaid\(a(?:ttendee)?\)/g) || [];
  assert.equal(formatterCalls.length, 3, 'one export getter and two table row layouts must use the formatter');
  assert.match(
    source,
    /for \(const group of filteredGroups\)[\s\S]*?rows\.push\(orderedColumns\.map\(c =>/,
    'CSV rows must continue to come from the filtered report groups',
  );
  assert.match(source, /data-testid=\{`text-price-paid-\$\{attendee\.id\}`\}/);
});

test('table financial columns and whole-filter footer use canonical totals in order', () => {
  const headerStart = source.indexOf('<th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Ticket Price</th>');
  const headerEnd = source.indexOf('<th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Method</th>', headerStart);
  const financialHeaders = source.slice(headerStart, headerEnd);
  for (const label of ['Ticket Price', 'Discount', 'Total after Discount', 'Voucher', 'Fund', 'Price Paid']) {
    assert.ok(financialHeaders.indexOf(label) >= 0, `missing ${label}`);
  }
  assert.ok(financialHeaders.indexOf('Discount') < financialHeaders.indexOf('Total after Discount'));
  assert.ok(financialHeaders.indexOf('Fund') < financialHeaders.indexOf('Price Paid'));
  assert.match(source, /for \(const group of filteredGroups\)[\s\S]*?totalAfterDiscount \+= Number\(gp\.totalAfterDiscount \|\| 0\)/);
  assert.match(source, /totalDiscount \+= gp\.discount \|\| 0/);
  assert.match(source, /totalFooterDiscount \+= Math\.abs\(Number\(gp\.discount\)\)/);
  assert.match(source, /formatCurrency\(filteredSummary\.totalAfterDiscount\)/);
  assert.match(source, /formatCurrency\(filteredSummary\.totalPricePaid\)/);
});

test('unavailable historical gross snapshots are never rendered or exported as zero', () => {
  assert.match(source, /ticket_price_status === 'unavailable_gross_snapshot'/);
  assert.match(
    source,
    /isGrossSnapshotUnavailable\(a\) \|\| a\.ticket_price == null[\s\S]*?'Unavailable'/,
  );
  assert.match(
    source,
    /isGrossSnapshotUnavailable\(gp\) \|\| gp\.discount == null\) return 'Unavailable'/,
  );
  assert.match(source, /hasUnavailableTicketTotal[\s\S]*?text-muted-foreground">Unavailable/);
  assert.match(source, /hasUnavailableDiscount[\s\S]*?text-muted-foreground">Unavailable/);
  assert.match(source, /Historical Invoice \/ PO registrations with offer-adjusted prices/);
});

test('report explains net and pending Price Paid semantics', () => {
  assert.match(source, /net ticket price after discounts and credits/);
  assert.match(source, /not a payment-provider settlement or refund ledger/);
  assert.match(source, /Pending\/unpaid amounts have not been received/);
});