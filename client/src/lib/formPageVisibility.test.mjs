import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeHiddenFieldIds } from '../../../api/_lib/formFieldVisibility.js';
import { resolveFormPageVisibility } from './formPageVisibility.js';

const embedFormSource = readFileSync(
  new URL('../pages/EmbedForm.jsx', import.meta.url),
  'utf8',
);

function evaluateRule(rule, values) {
  return (rule.conditions || []).every((condition) => {
    const actual = values[condition.field_id];
    if (condition.operator !== 'equals') return false;
    return String(actual) === String(condition.value);
  });
}

const pages = [
  { id: 'page-country' },
  { id: 'page-journal' },
  { id: 'page-other', starts_hidden: true },
];

const fields = [
  { id: 'country', type: 'country' },
  { id: 'journal', type: 'boolean' },
  { id: 'journal-delivery', page_id: 'page-journal', required: true },
  { id: 'other-answer', page_id: 'page-other', required: true },
  // A hidden set_value target without a page must remain available to the
  // existing submission pipeline; page filtering is intentionally narrower.
  { id: 'derived-answer', starts_hidden: true },
];

const rules = [
  {
    id: 'rule15',
    conditions: [
      { field_id: 'country', operator: 'equals', value: 'United Kingdom' },
      { field_id: 'journal', operator: 'equals', value: 'No' },
    ],
    actions: [
      {
        action_type: 'set_value',
        target_field_id: 'derived-answer',
        set_value: 'No',
      },
      {
        action_type: 'visibility',
        field_states: { 'page-journal': { visible: false } },
      },
    ],
  },
  {
    id: 'show-journal',
    conditions: [
      { field_id: 'country', operator: 'equals', value: 'United Kingdom' },
      { field_id: 'journal', operator: 'equals', value: 'Yes' },
    ],
    actions: [
      {
        action_type: 'visibility',
        field_states: { 'page-journal': { visible: true } },
      },
    ],
  },
];

test('mixed set_value + pagehide targets classify page ids and preserve hidden set_value fields', () => {
  const hidden = resolveFormPageVisibility({
    fields,
    pages,
    visibilityRules: rules,
    formValues: { country: 'United Kingdom', journal: 'No' },
    evaluateRuleConditions: evaluateRule,
  });

  assert.ok(hidden.hiddenPageIds.has('page-journal'));
  assert.ok(hidden.hiddenFieldIds.has('journal-delivery'));
  assert.ok(hidden.hiddenPageIds.has('page-other'));
  assert.ok(hidden.hiddenFieldIds.has('other-answer'));
  assert.ok(hidden.hiddenFieldIds.has('derived-answer'));
  assert.deepEqual(
    [...hidden.hiddenFieldIds].sort(),
    [...computeHiddenFieldIds(
      { fields, pages, visibility_rules: rules },
      { country: 'United Kingdom', journal: 'No' },
    )].sort(),
  );
});

test('show restores a hidden page while hide wins when both visibility rules match', () => {
  const shown = resolveFormPageVisibility({
    fields,
    pages,
    visibilityRules: rules,
    formValues: { country: 'United Kingdom', journal: 'Yes' },
    evaluateRuleConditions: evaluateRule,
  });
  assert.ok(!shown.hiddenPageIds.has('page-journal'));
  assert.ok(!shown.hiddenFieldIds.has('journal-delivery'));
  assert.deepEqual(
    [...shown.hiddenFieldIds].sort(),
    [...computeHiddenFieldIds(
      { fields, pages, visibility_rules: rules },
      { country: 'United Kingdom', journal: 'Yes' },
    )].sort(),
  );

  const hideAndShow = resolveFormPageVisibility({
    fields,
    pages,
    visibilityRules: [
      ...rules,
      {
        id: 'hide-wins',
        conditions: [{ field_id: 'journal', operator: 'equals', value: 'Yes' }],
        actions: [{
          action_type: 'visibility',
          field_states: { 'page-journal': { visible: false } },
        }],
      },
    ],
    formValues: { country: 'United Kingdom', journal: 'Yes' },
    evaluateRuleConditions: evaluateRule,
  });
  assert.ok(hideAndShow.hiddenPageIds.has('page-journal'));
  assert.ok(hideAndShow.hiddenFieldIds.has('journal-delivery'));
});

test('embedded quote and submission paths retain raw form answers', () => {
  assert.match(embedFormSource, /useMembershipFeeQuote\(\{\s*form,\s*formValues,\s*prefillOrganizationId/s);
  assert.match(embedFormSource, /!displayOnlyFieldIds\.has\(key\)/);
  assert.doesNotMatch(embedFormSource, /quoteFormValues/);
  assert.doesNotMatch(embedFormSource, /hiddenPageFieldIds/);
});
