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

function explicitFixture() {
  const f = fixture();
  f.form.fields[1].type = 'radio';
  f.payment.membership_config_id = null;
  f.payment.field_mappings = {};
  f.payment.membership_schedule_mapping = { source_field_id: 'answer',
    entries: [{ value: 'Associate', config_id: 'base' }, { value: 'Overseas associate', config_id: 'base' }] };
  f.input.scheduleAnswer = 'Overseas associate';
  f.config.structure_match_value = 'Different schedule class label';
  return f;
}
test('explicit value-to-schedule mapping selects exact saved ID independently of answer naming', async () => {
  const f = explicitFixture();
  assert.deepEqual(await resolveFormRenewalSelection(f.db, f.input, allowed), {
    configId: 'base', fieldId: 'class', value: 'Different schedule class label',
    sourceValue: 'Overseas associate', formId: 'form', paymentFieldId: 'payment',
  });
});
test('explicit mapping never falls back for unmapped, missing, duplicate or invalid schedules', async () => {
  for (const mutate of [
    f => { f.input.scheduleAnswer = 'Other'; },
    f => { f.input.scheduleAnswer = undefined; },
    f => { f.payment.membership_schedule_mapping.entries = []; },
    f => { f.payment.membership_schedule_mapping.entries.push({ value: 'Overseas associate', config_id: 'base' }); },
    f => { f.config.id = 'missing'; },
    f => { f.config.tenant_id = 'other'; },
    f => { f.config.is_active = false; },
    f => { f.config.structure_scope_type = 'organization'; },
    f => { f.form.fields[1].type = 'checkbox'; },
    f => { f.payment.membership_schedule_mapping.source_field_id = 'missing'; },
  ]) {
    const f = explicitFixture(); mutate(f);
    await assert.rejects(resolveFormRenewalSelection(f.db, f.input, allowed), /valid answer|unique membership schedule|unavailable/);
  }
});
test('explicit mapping still enforces authentication and saved form access', async () => {
  const f = explicitFixture();
  await assert.rejects(resolveFormRenewalSelection(f.db, f.input, async () => ({ allowed: false })), /access/);
  f.form.require_authentication = false;
  await assert.rejects(resolveFormRenewalSelection(f.db, f.input, allowed), /unavailable/);
});
