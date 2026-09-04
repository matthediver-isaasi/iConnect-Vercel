import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFormFieldValueChange } from './formFieldValueChange.js';
import {
  resolveRelationshipParentTransition,
  shouldClearFilteredOrganisationValue,
} from './formRelationshipDropdown.js';

const fields = [
  { id: 'trigger', type: 'radio' },
  { id: 'prefilled', type: 'text' },
  { id: 'choice', type: 'select' },
  { id: 'cascade', type: 'text' },
];

const change = (values, fieldId, value) => applyFormFieldValueChange({
  fields,
  currentValues: values,
  fieldId,
  value,
});

test('prefilled text and choice answers survive a show-hide-show trigger cycle', () => {
  let values = {
    trigger: 'show',
    prefilled: 'Prefilled name',
    choice: 'prefilled-choice',
  };
  values = change(values, 'trigger', 'hide');
  assert.equal(values.prefilled, 'Prefilled name');
  assert.equal(values.choice, 'prefilled-choice');
  values = change(values, 'trigger', 'show');
  assert.equal(values.prefilled, 'Prefilled name');
  assert.equal(values.choice, 'prefilled-choice');
});

test('all persisted prefill mapping shapes use the same retention semantics', () => {
  for (const prefillField of [
    'booking:reference',
    'member:first_name',
    'org:name',
    'member_custom:field-1',
    'org_custom:field-2',
    'custom:field-3',
    'legacy_property',
  ]) {
    const values = change({
      trigger: 'show',
      prefilled: `value from ${prefillField}`,
    }, 'trigger', 'hide');
    assert.equal(values.prefilled, `value from ${prefillField}`, prefillField);
  }
});

test('user-entered dependants and cascading trigger answers are not blanket-cleared', () => {
  const values = change({
    trigger: 'show',
    prefilled: 'user edited',
    choice: 'user choice',
    cascade: 'downstream answer',
  }, 'trigger', 'hide');
  assert.deepEqual(values, {
    trigger: 'hide',
    prefilled: 'user edited',
    choice: 'user choice',
    cascade: 'downstream answer',
  });
});

test('genuinely invalid relationship answers still clear through option validation', () => {
  assert.equal(resolveRelationshipParentTransition({
    field: { type: 'relationship_dropdown' },
    value: 'old-department',
    parentValue: 'new-org',
    previousParentValue: 'old-org',
    options: [],
  }), '');
  assert.equal(shouldClearFilteredOrganisationValue({
    field: {
      type: 'organisation_dropdown',
      organisation_group_parent_field_id: 'group',
    },
    value: 'old-org',
    organisations: [{ id: 'new-org' }],
    optionsLoaded: true,
  }), true);
});