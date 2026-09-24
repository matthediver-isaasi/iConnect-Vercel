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

test('Price Paid is introduced as a default-selected export column next to Ticket Price', () => {
  const ticketPriceIndex = source.indexOf("{ key: 'std:ticketPrice'");
  const pricePaidIndex = source.indexOf("{ key: 'std:pricePaid'");
  const groupDiscountIndex = source.indexOf("{ key: 'std:groupDiscount'");
  assert.ok(ticketPriceIndex >= 0);
  assert.ok(ticketPriceIndex < pricePaidIndex && pricePaidIndex < groupDiscountIndex);

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

test('report explains net and pending Price Paid semantics', () => {
  assert.match(source, /net ticket price after discounts and credits/);
  assert.match(source, /not a payment-provider settlement or refund ledger/);
  assert.match(source, /Pending\/unpaid amounts have not been received/);
});