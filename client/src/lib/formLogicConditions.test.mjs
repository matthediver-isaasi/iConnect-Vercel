import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateFormLogicCondition,
  getFormLogicConditionOptions,
  isOnlyFormNotListedConditionOption,
} from './formLogicConditions.js';
import { FORM_NOT_LISTED_VALUE } from '../../../shared/formNotListedChoice.js';

const enabledNotListed = {
  not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
};

test('ordinary form logic exposes the configured label but stores the stable sentinel', () => {
  const options = getFormLogicConditionOptions({
    field: { id: 'org', type: 'organisation_dropdown', ...enabledNotListed },
    organizations: [{ id: 'org-1', name: 'Example Hospital' }],
  });
  assert.deepEqual(options, [
    { value: FORM_NOT_LISTED_VALUE, label: 'My organisation is not listed' },
    { value: 'org-1', label: 'Example Hospital' },
  ]);
});

test('all supported dynamic source fields expose the stable not-listed condition value', () => {
  for (const type of [
    'organisation_dropdown',
    'relationship_dropdown',
    'category_dropdown',
    'category_multiselect',
    'country',
    'countries',
  ]) {
    const options = getFormLogicConditionOptions({
      field: { id: type, type, ...enabledNotListed },
    });
    assert.equal(options[0]?.value, FORM_NOT_LISTED_VALUE, type);
    assert.equal(options[0]?.label, 'My organisation is not listed', type);
  }
});

test('disabled and unsupported fields do not expose a synthetic condition value', () => {
  assert.deepEqual(getFormLogicConditionOptions({
    field: {
      type: 'organisation_dropdown',
      not_listed_choice: { enabled: false, label: 'Not listed' },
    },
  }), []);
  assert.deepEqual(getFormLogicConditionOptions({
    field: {
      type: 'text',
      not_listed_choice: { enabled: true, label: 'Not listed' },
    },
  }), []);
});

test('not-listed conditions match scalar and multi-select answers', () => {
  assert.equal(evaluateFormLogicCondition(
    FORM_NOT_LISTED_VALUE,
    'equals',
    FORM_NOT_LISTED_VALUE,
  ), true);
  assert.equal(evaluateFormLogicCondition(
    [FORM_NOT_LISTED_VALUE],
    'contains',
    FORM_NOT_LISTED_VALUE,
  ), true);
  assert.equal(evaluateFormLogicCondition(
    [FORM_NOT_LISTED_VALUE],
    'not_equals',
    FORM_NOT_LISTED_VALUE,
  ), false);
});

test('renaming the label cannot break a saved sentinel rule', () => {
  const before = getFormLogicConditionOptions({
    field: { type: 'relationship_dropdown', ...enabledNotListed },
  });
  const after = getFormLogicConditionOptions({
    field: {
      type: 'relationship_dropdown',
      not_listed_choice: { enabled: true, label: 'No matching department' },
    },
  });
  assert.equal(before[0].value, FORM_NOT_LISTED_VALUE);
  assert.equal(after[0].value, FORM_NOT_LISTED_VALUE);
  assert.equal(evaluateFormLogicCondition(after[0].value, 'equals', before[0].value), true);
  assert.equal(isOnlyFormNotListedConditionOption(after), true);
});

test('normal and embedded public forms use the shared ordinary-rule evaluator', () => {
  for (const path of ['../pages/FormView.jsx', '../pages/EmbedForm.jsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /import \{ evaluateFormLogicCondition \} from ["']@\/lib\/formLogicConditions["']/);
    assert.match(source, /evaluateFormLogicCondition\(triggerValue, operator, value\)/);
  }
});