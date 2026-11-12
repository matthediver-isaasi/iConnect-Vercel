import test from 'node:test';
import assert from 'node:assert/strict';
import { cartViewTarget, openCartView } from './formCartNavigation.js';

const fields = [{ id: 'cart', type: 'sales_cart', page_id: 'one' },
  { id: 'name', type: 'text', page_id: 'two' },
  { id: 'review', type: 'sales_cart_view', page_id: 'three' }];
test('targets review without altering answers; supports standard, swipe, unassigned and legacy pages', () => {
  const pages = ['one', 'two', 'three'].map(id => ({ id }));
  assert.deepEqual(cartViewTarget({ fields, pages }), { page: 2, step: 2, swipe: false });
  assert.deepEqual(cartViewTarget({ fields, pages, layout: 'card_swipe' }), { page: 2, step: 2, swipe: true });
  assert.equal(cartViewTarget({ fields, pages: pages.slice(0, 2) }), null);
  assert.equal(cartViewTarget({ fields, pages: [], allPages: pages }), null);
  assert.equal(cartViewTarget({ fields: fields.slice(0, 2), pages }), null);
  assert.equal(cartViewTarget({ fields: [{ type: 'sales_cart_view' }], pages }).page, 0);
  assert.equal(cartViewTarget({ fields, pages: [{ fields: fields.slice(0, 2) }, { fields: fields.slice(2) }] }).page, 1);
});
test('navigation changes only position then focuses and scrolls within this form', () => {
  const calls = [];
  const previousRAF = globalThis.requestAnimationFrame, previousWindow = globalThis.window;
  globalThis.requestAnimationFrame = callback => callback();
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    const root = { isConnected: true, querySelector: selector => {
      assert.equal(selector, '[data-form-cart-view]');
      return { focus: () => calls.push('focus'), scrollIntoView: options => calls.push(options.behavior) };
    } };
    const navigation = { setPage: page => calls.push(page), setStep: step => calls.push(`step-${step}`) };
    openCartView(navigation, { page: 2 }, root);
    assert.deepEqual(calls, [2, 'focus', 'auto']);
    calls.length = 0;
    openCartView(navigation, { swipe: true, step: 2 }, root);
    assert.deepEqual(calls, ['step-2', 'focus', 'auto']);
  } finally { globalThis.requestAnimationFrame = previousRAF; globalThis.window = previousWindow; }
});
