import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { financialCurrency } from '../lib/eventRegistrationFinancial.js';
import { formatRegistrationPricePaid } from '../lib/eventRegistrationPricePaid.js';
import { resolveEventPaymentPolicy } from '../../../shared/eventPaymentPolicy.js';

const source = readFileSync(new URL('./EventRegistrationReport.jsx', import.meta.url), 'utf8');
const querySource = source.slice(source.indexOf('  const paymentSettingsQuery ='), source.indexOf('  const [filterEventName'));
function evaluate(result, tenant = 'tenant-a', list = async () => []) {
  let options;
  const policy = new Function('useQuery', 'base44', 'memberInfo', 'isAccessReady', 'resolveEventPaymentPolicy',
    `${querySource}; return paymentPolicy;`)(
    value => { options = value; return result; },
    { entities: { SystemSettings: { list } } }, { tenant_id: tenant, id: 'viewer' }, true, resolveEventPaymentPolicy,
  );
  return { policy, options };
}
const rows = (voucher, fund) => [
  { setting_key: 'event_allow_voucher_payment', setting_value: voucher },
  { setting_key: 'event_allow_training_fund_payment', setting_value: fund },
];

test('all combinations use shared boolean/string policy and successful absent keys default on', () => {
  for (const voucher of [true, false, 'false']) {
    for (const fund of [true, false, ' FALSE ']) {
      assert.deepEqual(evaluate({ isSuccess: true, data: rows(voucher, fund) }).policy, {
        allowVoucherPayment: voucher === true, allowTrainingFundPayment: fund === true,
      });
    }
  }
  assert.deepEqual(evaluate({ isSuccess: true, data: [] }).policy, {
    allowVoucherPayment: true, allowTrainingFundPayment: true,
  });
});

test('pending, failed, revalidating and missing identity never enable cards', async () => {
  for (const result of [{}, { isSuccess: false, data: [] }, { isSuccess: true, isFetching: true, data: [] }]) {
    assert.equal(evaluate(result).policy, null);
  }
  assert.equal(evaluate({ isSuccess: true, data: [] }, null).policy, null);
  await assert.rejects(evaluate({}, 'tenant-a', async () => ({})).options.queryFn({}), /Unable to load/);
});

test('save invalidation refreshes policy and tenant cache keys remain isolated', async () => {
  const client = new QueryClient();
  let saved = [];
  const options = evaluate({}, 'tenant-a', async () => saved).options;
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.equal(evaluate(observer.getCurrentResult()).policy.allowVoucherPayment, true);
    saved = rows(false, true);
    await client.invalidateQueries({ queryKey: ['system-settings'] });
    assert.equal(evaluate(observer.getCurrentResult()).policy.allowVoucherPayment, false);
    unsubscribe();
    saved = rows(true, false);
    const returning = new QueryObserver(client, options);
    const stop = returning.subscribe(() => {});
    await returning.refetch();
    assert.equal(evaluate(returning.getCurrentResult()).policy.allowTrainingFundPayment, false);
    stop();
    assert.equal(client.getQueryData(evaluate({}, 'tenant-b').options.queryKey), undefined);
    assert.match(readFileSync(new URL('./EventSettings.jsx', import.meta.url), 'utf8'),
      /invalidateQueries\(\{ queryKey: \['system-settings'\] \}\)/);
  } finally { unsubscribe(); client.clear(); }
});

test('cards and table use the same resolved policy; financial values retain unavailable handling', () => {
  assert.equal((source.match(/paymentPolicy\?\.allowVoucherPayment/g) || []).length, 5);
  assert.equal((source.match(/paymentPolicy\?\.allowTrainingFundPayment/g) || []).length, 5);
  assert.match(source, /paymentPolicy\?\.allowVoucherPayment && <Card>/);
  assert.match(source, /paymentPolicy\?\.allowTrainingFundPayment && <Card>/);
  assert.match(source, /hasUnavailableVoucher \? 'Unavailable' : formatCurrency\(filteredSummary.totalVoucher\)/);
  assert.match(source, /hasUnavailableFund \? 'Unavailable' : formatCurrency\(filteredSummary.totalTrainingFund\)/);
});

// Render the actual table JSX, including its group-row callbacks, not a replica.
// Non-financial controls are stubs; row/cell/span markup is left intact.
const tableSource = source.slice(source.indexOf('<table className="w-full text-sm">'), source.indexOf('</table>') + 8);
const compiledTable = transformSync(`const table = (${tableSource});`, { loader: 'jsx', jsx: 'transform' }).code;
const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
const empty = () => null;
function renderTable(policy, attendance = false, unavailable = false) {
  const attendee = id => ({ id, attendee_first_name: id, status: 'confirmed', ticket_price: 100, price_paid: 70, price_paid_status: 'net' });
  const groupPayment = { discount: 5, totalAfterDiscount: 95, voucherAmount: unavailable ? null : 11, trainingFundAmount: unavailable ? null : 14, paymentMethod: 'card' };
  const groups = [
    { attendees: [attendee('individual')] },
    { isGroup: true, attendees: [attendee('group-first'), attendee('group-second')] },
    { isGroup: true, groupRef: 'separate-booker', booker: { first_name: 'Booker' }, attendees: [attendee('delegate-first'), attendee('delegate-second')] },
    { isGroup: true, booker: { first_name: 'Present' }, attendees: [{ ...attendee('booker-attendee'), is_booker: true }, attendee('booker-guest')] },
  ].map(group => ({ ...group, groupPayment, attendeeCount: group.attendees.length }));
  const context = {
    React, paymentPolicy: policy, showAttendanceColumn: attendance,
    paginatedGroups: groups, filteredGroups: groups, totalAttendees: 7, organizations: {},
    filteredSummary: { totalTicketPrice: 700, totalFooterDiscount: 20, totalAfterDiscount: 380, totalVoucher: 44, totalTrainingFund: 56, totalPricePaid: 490, hasUnavailableVoucher: unavailable, hasUnavailableFund: unavailable },
    Tooltip: passthrough, TooltipTrigger: passthrough, TooltipContent: empty, Badge: passthrough,
    PaymentMethodBadge: empty, ReportInvoice: empty, Layers: empty,
    renderActionIcons: empty, renderFlagBadges: empty, renderDesignationCell: empty,
    renderBuddyCell: empty, renderBadgeCell: empty, renderOptionsCell: empty, renderAttendanceCell: empty,
    formatCurrency: financialCurrency, formatRegistrationTicketPrice: a => financialCurrency(a.ticket_price),
    formatRegistrationPricePaid, isGrossSnapshotUnavailable: () => false,
    formatRegistrationCredits: () => '£0.00', formatRegistrationCreditSummary: () => '£0.00',
    formatRegistrationCreditBreakdown: empty, formatRegistrationCreditExplanation: empty,
  };
  const table = new Function(...Object.keys(context), `${compiledTable}; return table;`)(...Object.values(context));
  return new JSDOM(renderToStaticMarkup(table)).window.document.querySelector('table');
}

function assertTable(policy, attendance = false, unavailable = false) {
  const table = renderTable(policy, attendance, unavailable);
  const headers = [...table.querySelectorAll('thead th')].map(cell => cell.textContent);
  const voucher = !!policy?.allowVoucherPayment;
  const fund = !!policy?.allowTrainingFundPayment;
  assert.equal(headers.includes('Voucher'), voucher);
  assert.equal(headers.includes('Fund'), fund);
  assert.equal(headers.length, 21 + Number(voucher) + Number(fund) + Number(attendance));
  // Expand rowSpan/colSpan into a logical grid to check every delegate row,
  // including the extra non-attending booker row, against the header positions.
  for (const section of ['tbody', 'tfoot']) {
    const grid = [];
    [...table.querySelectorAll(`${section} tr`)].forEach((row, r) => {
      grid[r] ||= [];
      let column = 0;
      for (const cell of row.cells) {
        while (grid[r][column]) column++;
        for (let y = r; y < r + cell.rowSpan; y++) {
          grid[y] ||= [];
          for (let x = column; x < column + cell.colSpan; x++) {
            assert.equal(grid[y][x], undefined, 'spans must not overlap');
            grid[y][x] = cell;
          }
        }
        column += cell.colSpan;
      }
      assert.equal(grid[r].length, headers.length, `${section} row ${r} aligns`);
      assert.ok(Array.from({ length: headers.length }, (_, i) => grid[r][i]).every(Boolean));
      for (const [label, value, total] of [['Voucher', '£11.00', '£44.00'], ['Fund', '£14.00', '£56.00']]) {
        if (headers.includes(label)) {
          assert.equal(grid[r][headers.indexOf(label)].textContent.trim(), unavailable ? 'Unavailable' : section === 'tfoot' ? total : value);
        }
      }
      const paid = grid[r][headers.indexOf('Price Paid')].textContent.trim();
      assert.equal(paid, section === 'tfoot' ? '£490.00' : row.dataset.testid?.startsWith('row-booker-header-') ? '' : '£70.00');
    });
  }
}

test('all policy and attendance combinations align headers, individual/group/delegate rows and footer', () => {
  for (const voucher of [false, true]) for (const fund of [false, true]) {
    for (const attendance of [false, true]) for (const unavailable of [false, true]) {
      assertTable(evaluate({ isSuccess: true, data: rows(voucher, fund) }).policy, attendance, unavailable);
    }
  }
});

test('table hides during loading, failure and revalidation, and defaults on only after successful missing keys', () => {
  for (const result of [{}, { isSuccess: false, data: [] }, { isSuccess: true, isFetching: true, data: [] }, { isSuccess: true, data: [] }]) {
    assertTable(evaluate(result).policy);
  }
});

test('saved-settings invalidation hides stale columns, applies changes, and stays hidden on refetch failure', async () => {
  const client = new QueryClient();
  let response = async () => [];
  const observer = new QueryObserver(client, evaluate({}, 'tenant-a', () => response()).options);
  const stop = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assertTable(evaluate(observer.getCurrentResult()).policy);
    for (const [voucher, fund] of [[false, true], [true, false], [false, false], [true, true]]) {
      let resolve;
      response = () => new Promise(done => { resolve = done; });
      const refresh = client.invalidateQueries({ queryKey: ['system-settings'] });
      assert.equal(evaluate(observer.getCurrentResult()).policy, null);
      assertTable(evaluate(observer.getCurrentResult()).policy);
      resolve(rows(voucher, fund));
      await refresh;
      const policy = evaluate(observer.getCurrentResult()).policy;
      assert.deepEqual(policy, { allowVoucherPayment: voucher, allowTrainingFundPayment: fund });
      assertTable(policy);
    }
    response = async () => { throw new Error('Settings unavailable'); };
    await observer.refetch();
    assert.equal(evaluate(observer.getCurrentResult()).policy, null);
    assertTable(evaluate(observer.getCurrentResult()).policy);
  } finally { stop(); client.clear(); }
});

test('policy only affects presentation, never calculations, filters or export definitions', () => {
  const beforeTable = source.slice(source.indexOf('  const [filterEventName'), source.indexOf('            {paymentPolicy?.allowVoucherPayment && <Card>'));
  assert.doesNotMatch(beforeTable, /paymentPolicy/);
  assert.match(beforeTable, /key: 'std:voucher', label: 'Voucher Amount'/);
  assert.match(beforeTable, /key: 'std:trainingFund', label: 'Training Fund'/);
});