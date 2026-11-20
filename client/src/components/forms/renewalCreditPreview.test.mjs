import test from 'node:test';
import assert from 'node:assert/strict';
import { renewalCreditPreview } from './renewalCreditPreview.js';
const data = { totalWithVat: 47, cardMonthly: { monthlyAmount: 3.92, instalmentCount: 12, planTotal: 47.04 },
  directDebit: { monthlyAmount: 3.92, instalmentCount: 12 } };
test('combined selected credit updates upfront and monthly first-payment estimates', () => {
  assert.deepEqual(renewalCreditPreview(data, [{ id: 'a', value: 20 }, { id: 'b', value: 12.79 }]),
    { credit: 32.79, upfront: 14.21, monthly_card: 1.18, direct_debit: 1.18 });
  assert.equal(renewalCreditPreview(data, []).upfront, 47);
});
test('gross plan rounding never replaces the membership cost; full and excess credit stay capped', () => {
  const quote = structuredClone(data);
  for (const value of [47, 47.01, 100]) {
    assert.deepEqual(renewalCreditPreview(quote, [{ id: 'a', value }]),
      { credit: 47, upfront: 0, monthly_card: 0, direct_debit: 0 });
  }
  assert.deepEqual(quote, data, 'preview must not mutate the payment quote');
  assert.deepEqual(renewalCreditPreview(data, []),
    { credit: 0, upfront: 47, monthly_card: 3.92, direct_debit: 3.92 });
});
test('penny sums, invalid amounts and unavailable counts do not invent negative balances or periods', () => {
  assert.equal(renewalCreditPreview(data, [{ id: 'a', value: 0.1 }, { id: 'b', value: 0.2 }]).credit, 0.3);
  assert.equal(renewalCreditPreview(data, [{ id: 'a', value: -1 }, { id: 'b', value: 'invalid' }]).credit, 0);
  for (const instalmentCount of [undefined, null, 0, -1, 1.5]) {
    const offer = { monthlyAmount: 3.92, instalmentCount };
    const preview = renewalCreditPreview({ ...data, cardMonthly: offer, directDebit: offer }, [{ id: 'a', value: 32.79 }]);
    assert.equal(preview.upfront, 14.21);
    assert.equal(preview.monthly_card, null);
    assert.equal(preview.direct_debit, null);
  }
});
test('credit caps at cost, duplicates cannot double count, missing periods are not guessed', () => {
  assert.equal(renewalCreditPreview(data, [{ id: 'a', value: 100 }]).upfront, 0);
  assert.equal(renewalCreditPreview(data, [{ id: 'a', value: 10 }, { id: 'a', value: 10 }]).credit, 10);
  assert.equal(renewalCreditPreview({ totalWithVat: 47, directDebit: { monthlyAmount: 3.92 } },
    [{ id: 'a', value: 10 }]).direct_debit, null);
});
