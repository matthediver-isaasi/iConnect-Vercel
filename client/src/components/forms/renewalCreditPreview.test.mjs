import test from 'node:test';
import assert from 'node:assert/strict';
import { renewalCreditPreview } from './renewalCreditPreview.js';
const data = { totalWithVat: 47, cardMonthly: { monthlyAmount: 3.92, instalmentCount: 12 },
  directDebit: { monthlyAmount: 3.92, instalmentCount: 12 } };
test('combined selected credit updates upfront and monthly first-payment estimates', () => {
  assert.deepEqual(renewalCreditPreview(data, [{ id: 'a', value: 20 }, { id: 'b', value: 12.79 }]),
    { credit: 32.79, upfront: 14.21, monthly_card: 1.18, direct_debit: 1.18 });
  assert.equal(renewalCreditPreview(data, []).upfront, 47);
});
test('credit caps at cost, duplicates cannot double count, missing periods are not guessed', () => {
  assert.equal(renewalCreditPreview(data, [{ id: 'a', value: 100 }]).upfront, 0);
  assert.equal(renewalCreditPreview(data, [{ id: 'a', value: 10 }, { id: 'a', value: 10 }]).credit, 10);
  assert.equal(renewalCreditPreview({ totalWithVat: 47, directDebit: { monthlyAmount: 3.92 } },
    [{ id: 'a', value: 10 }]).direct_debit, null);
});
