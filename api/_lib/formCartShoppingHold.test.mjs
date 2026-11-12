import test from 'node:test';
import assert from 'node:assert/strict';
import { readShoppingHold, shoppingHoldsReady, updateShoppingHold, withOwnStock } from './formCartShoppingHold.js';
const token = '12345678-1234-4234-8234-123456789012';
const item = { kind: 'product', id: token, remaining: 0, available: false };
const answer = { version: 1, lines: [{ kind: 'product', id: token, quantity: 1 }] };
const form = { id: 'form', tenant_id: 'tenant' };
const field = { id: 'cart' };
test('reservation mutations scope authority and normalize browser input', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: name === 'form_cart_shopping_hold_version' ? 1 : { id: token, state: 'shopping', answer } };
  } };
  await updateShoppingHold(db, form, field, { action: 'reserve', reservation_id: token, version: 0,
    answer: { ...answer, price: 1, lines: [{ ...answer.lines[0], price: 1 }] } }, [item]);
  assert.deepEqual(calls[1].args, { p_tenant_id: 'tenant', p_form_id: 'form', p_id: token,
    p_answer: answer, p_expected_version: 0 });
  await assert.rejects(updateShoppingHold(db, form, field, { action: 'reserve', reservation_id: token,
    version: 0, answer }, []), /no longer offered/);
  await assert.rejects(readShoppingHold(db, form, 'guess'), /identified/);
});
test('own reservation offsets stock only while held', () => {
  assert.deepEqual(withOwnStock([item], { state: 'shopping', answer })[0], { ...item, remaining: 1, available: true });
  assert.equal(withOwnStock([{ ...item, remaining: null }], { state: 'shopping', answer })[0].remaining, null);
  for (const state of ['released', 'consumed']) assert.deepEqual(withOwnStock([item], { state, answer }), [item]);
});
test('missing migration remains compatible but other lookup errors fail closed', async () => {
  assert.equal(await shoppingHoldsReady({ rpc: async () => ({ error: { code: 'PGRST202' } }) }), false);
  await assert.rejects(shoppingHoldsReady({ rpc: async () => ({ error: new Error('offline') }) }), /offline/);
});
test('expired checkout clears only after verified cancellation, not processing or successful payment', async () => {
  for (const outcome of ['released', 'processing', 'paid', 'invoice']) {
    let state = 'held', cancelled = 0;
    const db = {
      rpc: async name => ({ data: name === 'form_cart_shopping_hold_version' ? 1
        : { id: token, state, answer, expiresAt: new Date(Date.now() - 5000).toISOString() } }),
      from(table) {
        return { select() { return this; }, eq() { return this; }, async single() {
          return { data: table === 'form_cart_hold' ? { submission_id: 's' }
            : { payment_provider: outcome === 'invoice' ? 'invoice' : 'stripe', payment_status: outcome === 'paid' ? 'paid' : 'pending' } };
        } };
      },
    };
    const result = await updateShoppingHold(db, form, field, { action: 'reservation_status', reservation_id: token }, [],
      { cancelPayment: async () => { cancelled++; if (outcome !== 'released') throw new Error('processing'); state = 'released'; } });
    assert.equal(result.state, outcome === 'released' ? 'released' : 'held');
    assert.equal(cancelled, ['paid', 'invoice'].includes(outcome) ? 0 : 1);
  }
});
