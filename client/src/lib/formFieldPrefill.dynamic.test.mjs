import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEligibleFormFieldPrefillSources,
  getFormFieldPrefillSource,
  getFormFieldPrefillSourceAnswers,
  formFieldPrefillKind,
  isEligibleFormFieldPrefillTarget,
  mergeReactiveFormFieldPrefill,
  normalizeFormFieldPrefillResponse,
  normalizeFormFieldPrefillValues,
  validateFormFieldPrefillConfig,
  shouldClearFormFieldPrefillError,
  shouldClearFormFieldPrefillSelection,
} from './formFieldPrefill.js';

const fields = [
  { id: 'before', type: 'text' },
  { id: 'org', type: 'organisation_dropdown', label: 'Organisation' },
  { id: 'after', type: 'text', prefill_field: 'org:name' },
  { id: 'group', type: 'organisation_group_dropdown', label: 'Group' },
  { id: 'nested', type: 'organisation_dropdown', repeatable_field_id: 'rows' },
];

test('serialised source id resolves only an eligible top-level dropdown', () => {
  assert.deepEqual(getEligibleFormFieldPrefillSources(fields).map(field => field.id), ['org', 'group']);
  const form = { prefill_source: 'form_field', prefill_source_field_id: 'org', fields };
  assert.equal(getFormFieldPrefillSource(form)?.id, 'org');
  assert.equal(formFieldPrefillKind(getFormFieldPrefillSource(form)), 'organization');
  assert.equal(getFormFieldPrefillSource({ ...form, prefill_source_field_id: 'nested' }), null);
  assert.equal(getFormFieldPrefillSource({ ...form, prefill_source: 'member' }), null);
});

test('only fields later than the selected source are mapping targets', () => {
  const form = { prefill_source: 'form_field', prefill_source_field_id: 'org', fields };
  assert.equal(isEligibleFormFieldPrefillTarget(form, fields[0]), false);
  assert.equal(isEligibleFormFieldPrefillTarget(form, fields[1]), false);
  assert.equal(isEligibleFormFieldPrefillTarget(form, fields[2]), true);
});

test('source-answer projection tracks only earlier conditional inputs', () => {
  const form = { prefill_source: 'form_field', prefill_source_field_id: 'org', fields };
  assert.deepEqual(getFormFieldPrefillSourceAnswers(form, {
    before: 'eligible',
    org: 'org-1',
    after: 'Acme',
    unrelated: 'ignored',
  }), { before: 'eligible' });
});

test('builder validation blocks missing, reordered, and incompatible saved mappings', () => {
  assert.equal(validateFormFieldPrefillConfig({
    prefill_source: 'form_field', prefill_source_field_id: null, fields,
  }).valid, false);
  assert.equal(validateFormFieldPrefillConfig({
    prefill_source: 'form_field',
    prefill_source_field_id: 'org',
    fields: [{ id: 'target', label: 'Target', prefill_field: 'org:name' }, fields[1]],
  }).valid, false);
  assert.equal(validateFormFieldPrefillConfig({
    prefill_source: 'form_field',
    prefill_source_field_id: 'group',
    fields: [fields[3], { id: 'target', label: 'Target', prefill_field: 'org:name' }],
  }).valid, false);
  assert.equal(validateFormFieldPrefillConfig({
    prefill_source: 'form_field',
    prefill_source_field_id: 'org',
    fields: [fields[1], { id: 'target', label: 'Target', prefill_field: 'org:name' }],
  }).valid, true);
});

test('organisation-group source kind remains distinct from organisation', () => {
  const form = { prefill_source: 'form_field', prefill_source_field_id: 'group', fields };
  assert.equal(formFieldPrefillKind(getFormFieldPrefillSource(form)), 'organization_group');
});

test('source replacement refreshes previous autofills but preserves user edits', () => {
  const first = mergeReactiveFormFieldPrefill({
    currentValues: { org: 'one', unrelated: 'keep' },
    resolvedValues: { name: 'One Ltd', phone: '111' },
  });
  assert.deepEqual(first.values, {
    org: 'one', unrelated: 'keep', name: 'One Ltd', phone: '111',
  });
  const second = mergeReactiveFormFieldPrefill({
    currentValues: { ...first.values, phone: 'user changed' },
    resolvedValues: { name: 'Two Ltd', phone: '222' },
    trackedValues: first.trackedValues,
  });
  assert.equal(second.values.name, 'Two Ltd');
  assert.equal(second.values.phone, 'user changed');
  assert.equal(second.values.unrelated, 'keep');
});

test('source replacement preserves an intentionally cleared auto-filled answer', () => {
  const first = mergeReactiveFormFieldPrefill({
    currentValues: { org: 'one' },
    resolvedValues: { name: 'One Ltd' },
  });
  const second = mergeReactiveFormFieldPrefill({
    currentValues: { ...first.values, org: 'two', name: '' },
    resolvedValues: { name: 'Two Ltd' },
    trackedValues: first.trackedValues,
  });
  assert.equal(second.values.name, '');
  assert.deepEqual(second.trackedValues, {});
});

test('clearing removes only values still owned by reactive prefill', () => {
  const cleared = mergeReactiveFormFieldPrefill({
    currentValues: { org: '', name: 'One Ltd', phone: 'user changed', unrelated: 'keep' },
    trackedValues: { name: 'One Ltd', phone: '111' },
    clear: true,
  });
  assert.equal('name' in cleared.values, false);
  assert.equal(cleared.values.phone, 'user changed');
  assert.equal(cleared.values.unrelated, 'keep');
  assert.deepEqual(cleared.trackedValues, {});
});

test('not-listed source selection is a clear transition', () => {
  assert.equal(shouldClearFormFieldPrefillSelection('__form_not_listed__'), true);
  const cleared = mergeReactiveFormFieldPrefill({
    currentValues: {
      org: '__form_not_listed__',
      name: 'One Ltd',
      respondentNote: 'Keep me',
    },
    trackedValues: { name: 'One Ltd' },
    clear: true,
  });
  assert.deepEqual(cleared.values, {
    org: '__form_not_listed__',
    respondentNote: 'Keep me',
  });
});

test('definitive resolver rejection clears while transient failures retain', () => {
  assert.equal(shouldClearFormFieldPrefillError({
    status: 400,
    errorData: { code: 'PREFILL_RECORD_INELIGIBLE' },
  }), true);
  assert.equal(shouldClearFormFieldPrefillError({
    status: 404,
    errorData: { code: 'PREFILL_RECORD_NOT_FOUND' },
  }), true);
  assert.equal(shouldClearFormFieldPrefillError({ status: 500 }), false);
  assert.equal(shouldClearFormFieldPrefillError(new Error('Network Error')), false);
});

test('resolver response normalization accepts supported payload envelopes', () => {
  assert.deepEqual(normalizeFormFieldPrefillResponse({ values: { a: 1 } }), { a: 1 });
  assert.deepEqual(normalizeFormFieldPrefillResponse({ prefill_values: { b: 2 } }), { b: 2 });
  assert.deepEqual(normalizeFormFieldPrefillResponse(null), {});
});

test('resolved values normalize list and boolean target types', () => {
  const form = {
    fields: [
      { id: 'tags', type: 'list' },
      { id: 'active', type: 'boolean' },
    ],
  };
  assert.deepEqual(normalizeFormFieldPrefillValues(form, {
    values: { tags: '["One","Two"]', active: 'yes' },
  }), { tags: ['One', 'Two'], active: true });
});

test('wrapped custom-field targets use server-resolved underlying types', () => {
  const form = {
    fields: [
      { id: 'choices', type: 'custom_field', custom_field_id: 'cf-choices' },
      { id: 'enabled', type: 'custom_field', custom_field_id: 'cf-enabled' },
    ],
  };
  assert.deepEqual(normalizeFormFieldPrefillValues(form, {
    values: { choices: '["A","B"]', enabled: 'true' },
    fieldTypes: { choices: 'checkbox', enabled: 'boolean' },
  }), { choices: ['A', 'B'], enabled: true });
});