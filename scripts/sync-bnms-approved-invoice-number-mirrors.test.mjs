import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOnlyNumberChanged, PINS } from './sync-bnms-approved-invoice-number-mirrors.mjs';

test('exact approved local/provider IDs and replacements are pinned', () => {
  assert.deepEqual(PINS.map(t => [t.id, t.bookingId, t.recoveryId, t.assigned]), [
    ['97a5a6a1-aec9-42ed-ba44-71d9e7139cf1', '01e349e2-9ae5-49e6-9ec8-95a47a1b3b9f',
      'b23264a0-7859-4912-86a6-19dc96c4aab6', 'INV-8956'],
    ['114acb56-e37e-4d9b-ade0-9f98255002f3', 'b09afeb8-0955-4c3d-9636-35aa543a9f5a',
      '8126f3a8-fd0d-4b6d-95ee-adda6af98ad9', 'INV-8958'],
  ]);
});
test('number-only comparison rejects survey, snapshot, identity, payment, status and other drift', () => {
  for (const key of ['xero_invoice_number', 'invoice_number']) {
    const before = { [key]: 'old', id: 'same', status: 'complete', total: 166.67,
      survey_invitation_revision: '8', snapshot: { amount: 166.67 }, payment_id: 'original-payment',
      purchaser_context: { email: 'offline@example.test' } };
    const after = { ...before, [key]: 'INV-8956' };
    assert.doesNotThrow(() => assertOnlyNumberChanged(before, after, key, 'INV-8956'));
    for (const change of [{ id: 'new' }, { status: 'pending' }, { total: 200 },
      { survey_invitation_revision: '9' }, { snapshot: {} }, { payment_id: 'new' },
      { purchaser_context: {} }, { future_field: true }, { [key]: 'INV-8958' }]) {
      assert.throws(() => assertOnlyNumberChanged(before, { ...after, ...change }, key, 'INV-8956'));
    }
  }
});