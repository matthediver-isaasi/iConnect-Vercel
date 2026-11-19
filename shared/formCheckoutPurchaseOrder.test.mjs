import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCheckoutPurchaseOrder, invoicePurchaseOrderReference, CHECKOUT_PURCHASE_ORDER_KEY } from './formCheckoutPurchaseOrder.js';
import { cartAccountingSettings } from './formCartAccounting.js';
test('automatic checkout PO is optional, normalized and used without an admin mapping',()=>{
  for(const value of [undefined,null,'','   ']) assert.equal(invoicePurchaseOrderReference(value),'TBC');
  assert.equal(normalizeCheckoutPurchaseOrder(' PO-42 '),'PO-42');
  assert.equal(cartAccountingSettings({fields:[{type:'sales_cart'}]},{[CHECKOUT_PURCHASE_ORDER_KEY]:' PO-42 '}).reference,'PO-42');
});
test('legacy mapped PO remains supported but contradictory answers block acceptance',()=>{
  assert.equal(invoicePurchaseOrderReference('', ' PO-42 '),'PO-42');
  assert.equal(invoicePurchaseOrderReference(' PO-42 ', 'PO-42'),'PO-42');
  assert.throws(()=>invoicePurchaseOrderReference('PO-A','PO-B'),/differs/);
});
test('invalid checkout PO types, multiline and overlong values are rejected',()=>{
  for(const value of [{},[],42,true]) assert.throws(()=>normalizeCheckoutPurchaseOrder(value),/must be text/);
  for(const value of ['PO\n42','PO\r42','PO\u000042']) assert.throws(()=>normalizeCheckoutPurchaseOrder(value),/single line/);
  assert.throws(()=>normalizeCheckoutPurchaseOrder('x'.repeat(256)),/255/);
  assert.equal(normalizeCheckoutPurchaseOrder('x'.repeat(255)).length,255);
});
