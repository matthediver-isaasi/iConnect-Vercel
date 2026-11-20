import test from 'node:test';
import assert from 'node:assert/strict';
import { departmentBuilderFields, saveDepartmentBuilderFields, DEPARTMENT_SELECTOR_ID as selector } from './departmentSelectorBuilder.js';
import { departmentSelectorAnchor, showDepartmentSelector } from './departmentSelectorPlacement.js';

const form = {
  current_set_enabled: true, layout_type: 'standard', pages: [{ id: 'first' }, { id: 'second' }],
  fields: [{ id: 'intro', page_id: 'first' }, { id: 'name', page_id: 'first' }, { id: 'later', page_id: 'second' }],
};
test('adds exactly one virtual block only to current-set forms, without changing answers', () => {
  assert.deepEqual(departmentBuilderFields({ ...form, current_set_enabled: false }), form.fields);
  assert.deepEqual(departmentBuilderFields(form).map(f => f.id), [selector, 'intro', 'name', 'later']);
  assert.equal(form.fields.length, 3);
});
test('legacy saved position survives opening and save/reload', () => {
  const legacy = { ...form, fields: form.fields.map(f => ({ ...f, department_selector_before: f.id === 'name' })) };
  const fields = departmentBuilderFields(legacy);
  assert.deepEqual(fields.map(f => f.id), ['intro', selector, 'name', 'later']);
  const saved = saveDepartmentBuilderFields(fields);
  assert.equal(saved.some(f => f.id === selector), false);
  assert.deepEqual(departmentBuilderFields({ ...form, fields: saved }).map(f => f.id), fields.map(f => f.id));
});
test('dragging after all first-page fields persists and renders only there', () => {
  const [block, intro, name, later] = departmentBuilderFields(form);
  const saved = { ...form, fields: saveDepartmentBuilderFields([intro, name, block, later]) };
  assert.equal(departmentSelectorAnchor(saved), 'name:after');
  assert.equal(showDepartmentSelector({ form: saved }), false);
  assert.equal(showDepartmentSelector({ form: saved, fieldId: 'name:after' }), true);
  assert.equal(showDepartmentSelector({ form: saved, fieldId: 'name:after', firstPage: false }), false);
  assert.deepEqual(departmentBuilderFields(saved).map(f => f.id), ['intro', 'name', selector, 'later']);
});
test('empty and card-swipe forms retain their required initial selector', () => {
  assert.equal(departmentBuilderFields({ ...form, fields: [] })[0].id, selector);
  const card = { ...form, layout_type: 'card_swipe' };
  assert.equal(departmentBuilderFields(card)[0].fixed, true);
  assert.equal(departmentSelectorAnchor(card), null);
});
test('hidden and deleted after-anchors fall back to beginning', () => {
  const saved = { ...form, fields: [{ id: 'intro', page_id: 'first', department_selector_after: true }] };
  assert.equal(departmentSelectorAnchor(saved, new Set(['intro'])), null);
  assert.equal(departmentSelectorAnchor({ ...saved, fields: [] }), null);
});
