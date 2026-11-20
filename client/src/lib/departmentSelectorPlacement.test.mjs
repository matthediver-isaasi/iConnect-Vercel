import { test } from 'node:test';
import assert from 'node:assert/strict';
import { departmentSelectorAnchor, showDepartmentSelector } from './departmentSelectorPlacement.js';
const form = { pages: [{ id: 'intro' }, { id: 'later' }], fields: [
  { id: 'instructions', page_id: 'intro' },
  { id: 'name', page_id: 'intro', department_selector_before: true },
] };
test('configured selector appears only before its first-page field', () => {
  assert.equal(departmentSelectorAnchor(form), 'name');
  assert.equal(showDepartmentSelector({ form }), false);
  assert.equal(showDepartmentSelector({ form, fieldId: 'instructions' }), false);
  assert.equal(showDepartmentSelector({ form, fieldId: 'name' }), true);
  assert.equal(showDepartmentSelector({ form, fieldId: 'name', firstPage: false }), false);
});
test('legacy, hidden, moved and removed anchors fall back to the beginning only', () => {
  for (const candidate of [{}, { ...form, fields: [] }, {
    ...form, fields: [{ id: 'name', page_id: 'later', department_selector_before: true }],
  }]) {
    assert.equal(showDepartmentSelector({ form: candidate }), true);
    assert.equal(showDepartmentSelector({ form: candidate, firstPage: false }), false);
  }
  assert.equal(showDepartmentSelector({ form, hiddenIds: new Set(['name']) }), true);
});
test('card-swipe ignores field anchors and unpaged forms support them', () => {
  assert.equal(departmentSelectorAnchor({ ...form, layout_type: 'card_swipe' }), null);
  assert.equal(departmentSelectorAnchor({ fields: [{ id: 'name', department_selector_before: true }] }), 'name');
});
