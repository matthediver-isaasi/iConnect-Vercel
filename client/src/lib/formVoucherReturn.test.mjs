import test from 'node:test';
import assert from 'node:assert/strict';
import { formVoucherReturnPath, formVoucherConfirmationPath, saveFormVoucherReturn, readFormVoucherReturn } from './formVoucherReturn.js';

test('3DS confirmation returns to the owning voucher endpoint, not the form confirmer', () => {
  assert.equal(formVoucherConfirmationPath('a'.repeat(64)), `/membership-fees/${'a'.repeat(64)}`);
  assert.throws(() => formVoucherConfirmationPath('../FormView?slug=renew'));
});

test('return navigation is scoped to its checkout and preserves form query values', () => {
  const rows = new Map();
  const store = { setItem: (k, v) => rows.set(k, v), getItem: k => rows.get(k) };
  const token = 'a'.repeat(64);
  const path = '/FormView?slug=membership-renewal&answer=a%2Fb#payment';
  assert.equal(saveFormVoucherReturn(store, token, path), true);
  assert.equal(readFormVoucherReturn(store, token), path);
  assert.equal(readFormVoucherReturn(store, 'b'.repeat(64)), null);
});

test('return navigation cannot become an external redirect or imply payment success', () => {
  for (const path of ['https://evil.test/FormView?slug=f', '//evil.test/FormView?slug=f',
    '/FormView', '/FormView?slug=', '/FormView/../login?slug=f', '/login?slug=f',
    '/FormView?slug=f\\evil', '/FormView?slug=f\n']) assert.equal(formVoucherReturnPath(path), null);
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readFormVoucherReturn(unavailable, 'a'.repeat(64)), null);
  assert.equal(saveFormVoucherReturn(unavailable, 'a'.repeat(64), '/FormView?slug=f'), false);
});
