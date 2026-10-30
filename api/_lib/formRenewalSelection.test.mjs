import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFormRenewalSelection } from './formRenewalSelection.js';

function fixture() {
  const payment = { id: 'payment', type: 'membership_payment', membership_config_id: 'base',
    field_mappings: { class: 'answer' } };
  const form = { id: 'form', tenant_id: 'tenant', is_active: true, require_authentication: true,
    fields: [payment, { id: 'answer', options: ['Associate', 'Overseas associate'] }] };
  const config = { id: 'base', tenant_id: 'tenant', structure_scope_type: 'member', structure_field_id: 'class' };
  const db = { from(table) {
    let rows = table === 'form' ? [form] : [config];
    return { select() { return this; }, eq(k, v) { rows = rows.filter(row => row[k] === v); return this; },
      async maybeSingle() { return { data: rows[0] || null }; } };
  } };
  const input = { tenantId: 'tenant', formId: 'form', paymentFieldId: 'payment',
    fieldOverrides: { class: 'Overseas associate', price: 0 } };
  return { db, input, form, payment, config };
}
const allowed = async () => ({ allowed: true });
test('saved mapping permits either authored class and discards unrelated overrides', async () => {
  const f = fixture();
  for (const value of ['Associate', 'Overseas associate']) {
    f.input.fieldOverrides.class = value;
    assert.deepEqual(await resolveFormRenewalSelection(f.db, f.input, allowed),
      { fieldId: 'class', value, formId: 'form', paymentFieldId: 'payment' });
  }
});
test('unknown, absent, array and object class answers fail closed', async () => {
  for (const value of ['Full', '', undefined, ['Associate'], { value: 'Associate' }]) {
    const f = fixture(); f.input.fieldOverrides.class = value;
    await assert.rejects(resolveFormRenewalSelection(f.db, f.input, allowed), /valid membership class/);
  }
});
test('tenant, field, active, authentication and access checks are authoritative', async () => {
  for (const mutate of [
    f => { f.input.tenantId = 'other'; }, f => { f.input.paymentFieldId = 'other'; },
    f => { f.form.is_active = false; }, f => { f.form.require_authentication = false; },
    f => { f.form.deactivate_at = '2020-01-01'; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(resolveFormRenewalSelection(f.db, f.input, allowed), /unavailable/);
  }
  const f = fixture();
  await assert.rejects(resolveFormRenewalSelection(f.db, f.input, async () => ({ allowed: false })), /access/);
});
test('unmapped and legacy callers retain the original renewal path', async () => {
  const f = fixture();
  assert.equal(await resolveFormRenewalSelection(f.db, { tenantId: 'tenant' }, allowed), null);
  f.payment.field_mappings = {};
  assert.equal(await resolveFormRenewalSelection(f.db, f.input, allowed), null);
});
