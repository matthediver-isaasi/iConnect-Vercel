import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
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

test('only summary cards are gated; financial values retain unavailable handling', () => {
  assert.equal((source.match(/paymentPolicy\?\./g) || []).length, 2);
  assert.match(source, /paymentPolicy\?\.allowVoucherPayment && <Card>/);
  assert.match(source, /paymentPolicy\?\.allowTrainingFundPayment && <Card>/);
  assert.match(source, /hasUnavailableVoucher \? 'Unavailable' : formatCurrency\(filteredSummary.totalVoucher\)/);
  assert.match(source, /hasUnavailableFund \? 'Unavailable' : formatCurrency\(filteredSummary.totalTrainingFund\)/);
});