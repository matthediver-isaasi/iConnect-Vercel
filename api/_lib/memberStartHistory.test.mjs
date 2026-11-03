import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMemberStartHistory } from './memberStartHistory.js';

test('history labels only explicit Start free evidence and exposes unpaid invoice queue states', async () => {
  for (const state of [null, 'pending', 'review', 'complete']) {
    const history = [
      { id: 'free', payment_method: null, total_with_vat: 0 },
      { id: 'unknown', payment_method: null, total_with_vat: 0 },
      { id: 'invoice', payment_method: 'invoice', total_with_vat: 100 },
    ];
    const db = { from(table) {
      return { select() { return this; }, eq(key, value) {
        if (key === 'tenant_id') assert.equal(value, 'tenant');
        if (key === 'member_id') assert.equal(value, 'member');
        return this;
      }, async in() {
        return { data: table === 'member_membership_start'
          ? [{ record_id: 'free', request: { paymentMode: 'free' }, quote: { paymentMode: 'free', totalWithVat: 0 } },
            { record_id: 'invoice', request: { paymentMode: 'invoice' } }]
          : state ? [{ source_id: 'invoice', state }] : [] };
      } };
    } };
    await attachMemberStartHistory(db, { tenantId: 'tenant', memberId: 'member', history, isAdmin: true });
    assert.equal(history[0].admin_no_charge, true);
    assert.equal(history[1].admin_no_charge, undefined);
    assert.equal(history[2].start_invoice_state, state === null ? 'not_queued' : state === 'pending' ? 'pending' : 'review');
  }
});
