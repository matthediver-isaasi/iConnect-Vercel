import test from 'node:test';
import assert from 'node:assert/strict';
import { cartAccountingSettings, cartAccountingConfigurationError } from './formCartAccounting.js';

const cart = { id: 'cart', type: 'sales_cart', nominal_code: ' 201 ', project_code: ' Exhibition ',
  purchase_order_field_id: 'po' };
const fields = [cart, { id: 'po', type: 'text', label: 'Purchase order' }];
test('saved admin settings and selected answer alone control cart accounting', () => {
  assert.deepEqual(cartAccountingSettings({ fields }, {
    po: ' PO-42 ', cart: { nominal_code: '999', project_code: 'Forged', reference: 'Forged' },
  }), { nominalCode: '201', projectCode: 'Exhibition', reference: 'PO-42' });
});
test('blank, whitespace, missing or unmapped purchase orders become exactly TBC', () => {
  for (const po of ['', '   ', null, undefined]) {
    assert.equal(cartAccountingSettings({ fields }, { po }).reference, 'TBC');
  }
  assert.equal(cartAccountingSettings({ fields: [{ ...cart, purchase_order_field_id: '' }] }, { po: 'ignore' }).reference, 'TBC');
  assert.deepEqual(cartAccountingSettings({ fields: [{ id: 'cart', type: 'sales_cart' }] }, {}),
    { nominalCode: null, projectCode: null, reference: 'TBC' });
  assert.equal(cartAccountingSettings({ fields: [] }, {}), null);
});
test('invalid mappings and structured or overlong answers fail rather than corrupt reference', () => {
  assert.match(cartAccountingConfigurationError(cart, [cart]), /existing Text/);
  assert.match(cartAccountingConfigurationError(cart, [cart, { id: 'po', type: 'payment' }]), /existing Text/);
  assert.match(cartAccountingConfigurationError(cart, [cart, { id: 'po', type: 'text', parent_field_id: 'repeat' }]), /existing Text/);
  assert.match(cartAccountingConfigurationError({ ...cart, nominal_code: {} }, fields), /accounting codes/);
  assert.throws(() => cartAccountingSettings({ fields }, { po: { text: 'bad' } }), /must be text/);
  assert.throws(() => cartAccountingSettings({ fields }, { po: 'A'.repeat(256) }), /255/);
});
