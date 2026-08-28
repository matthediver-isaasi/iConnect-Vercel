import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateFormLogicCondition,
  getFormLogicConditionOptions,
  isOnlyFormNotListedConditionOption,
} from './formLogicConditions.js';
import { FORM_NOT_LISTED_VALUE } from '../../../shared/formNotListedChoice.js';
import {
  FORM_NO_RELATIONSHIP_VALUE,
  DEFAULT_FORM_NO_RELATIONSHIP_LABEL,
  stripFormNoRelationshipValues,
} from '../../../shared/formNoRelationshipChoice.js';

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

test('organisation group dropdown exposes IDs with human-readable names', () => {
  assert.deepEqual(getFormLogicConditionOptions({
    field: { id: 'group', type: 'organisation_group_dropdown' },
    organizationGroups: [{ id: 'group-1', name: 'Northern Group' }],
  }), [{ value: 'group-1', label: 'Northern Group' }]);
});

test('FormBuilder registers organisation groups without replacing organisation dropdowns', () => {
  const source = readFileSync(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');
  assert.match(source, /\{ value: 'organisation_dropdown', label: 'Organisation Dropdown' \}/);
  assert.match(source, /\{ value: 'organisation_group_dropdown', label: 'Organisation Group Dropdown' \}/);
  assert.match(source, /organizationGroups=\{organizationGroups\}/);
  assert.match(
    source,
    /getConditionalFieldOptions\(\s*source,\s*categories,\s*communicationCategories,\s*customFields,\s*organizationGroups,\s*\)/,
  );
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
  assert.equal(isOnlyFormNotListedConditionOption(after), false);
});

test('relationship fields expose a separately labelled confirmed-empty condition', () => {
  const options = getFormLogicConditionOptions({
    field: {
      type: 'relationship_dropdown',
      no_relationship_found_label: 'No branch found',
    },
  });
  assert.deepEqual(options, [
    { value: FORM_NO_RELATIONSHIP_VALUE, label: 'No branch found' },
  ]);
  assert.equal(getFormLogicConditionOptions({
    field: { type: 'relationship_dropdown' },
  })[0].label, DEFAULT_FORM_NO_RELATIONSHIP_LABEL);
});

test('no-relationship rules match only a confirmed empty lookup, never a stored field value', () => {
  assert.equal(evaluateFormLogicCondition(
    '',
    'equals',
    FORM_NO_RELATIONSHIP_VALUE,
    { relationshipEmpty: true },
  ), true);
  assert.equal(evaluateFormLogicCondition(
    FORM_NO_RELATIONSHIP_VALUE,
    'equals',
    FORM_NO_RELATIONSHIP_VALUE,
    { relationshipEmpty: false },
  ), false);
  assert.equal(evaluateFormLogicCondition(
    'record-1',
    'not_equals',
    FORM_NO_RELATIONSHIP_VALUE,
    { relationshipEmpty: false },
  ), false);
  assert.equal(evaluateFormLogicCondition(
    '',
    'is_empty',
    FORM_NO_RELATIONSHIP_VALUE,
    { relationshipEmpty: false },
  ), false);
  assert.equal(evaluateFormLogicCondition(
    '',
    'not_equals',
    FORM_NO_RELATIONSHIP_VALUE,
    { relationshipEmpty: true },
  ), false);
  assert.equal(evaluateFormLogicCondition('', 'is_empty', '', { relationshipEmpty: true }), true);
});

test('the runtime sentinel is stripped only from relationship draft values', () => {
  assert.deepEqual(stripFormNoRelationshipValues({
    relationship: FORM_NO_RELATIONSHIP_VALUE,
    legacyRelationship: FORM_NO_RELATIONSHIP_VALUE,
    arrayRelationship: [FORM_NO_RELATIONSHIP_VALUE],
    objectRelationship: { value: FORM_NO_RELATIONSHIP_VALUE },
    text: FORM_NO_RELATIONSHIP_VALUE,
  }, [
    { id: 'relationship', name: 'legacyRelationship', type: 'relationship_dropdown' },
    { id: 'arrayRelationship', type: 'relationship_dropdown' },
    { id: 'objectRelationship', type: 'relationship_dropdown' },
    { id: 'text', type: 'text' },
  ]), {
    text: FORM_NO_RELATIONSHIP_VALUE,
  });
});

test('draft endpoint sanitizes synthetic relationship values before writes and reads', () => {
  const source = readFileSync(new URL('../../../api/public/form-draft.js', import.meta.url), 'utf8');
  assert.match(source, /\.select\('id, tenant_id, access_policy, deactivate_at, fields'\)/);
  assert.match(source, /const safeDraftData = stripFormNoRelationshipValues\(draft_data, form\.fields\)/);
  assert.match(source, /draft_data: safeDraftData/g);
  assert.match(source, /draft_data: stripFormNoRelationshipValues\(draft\.draft_data, form\.fields\)/);
});

test('normal and embedded public forms use the shared ordinary-rule evaluator', () => {
  for (const path of ['../pages/FormView.jsx', '../pages/EmbedForm.jsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /import \{ evaluateFormLogicCondition \} from ["']@\/lib\/formLogicConditions["']/);
    assert.match(source, /evaluateFormLogicCondition\(triggerValue, operator, value, \{ relationshipEmpty \}\)/);
    assert.match(source, /onRelationshipEmptyStateChange=\{handleRelationshipEmptyStateChange\}/);
  }
});