import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  activeDisplayNameCopyIssues,
  displayNameCopyConfigurationError,
  recordSelectionOptionScope,
  resolveDisplayNameCopyValue,
} from './formConditionalCopyMode.js';

const fields = [
  { id: 'group', type: 'organisation_group_dropdown' },
  { id: 'relationship', type: 'relationship_dropdown' },
  { id: 'multi', type: 'relationship_dropdown', selection_mode: 'multiple' },
  { id: 'name', type: 'text' },
  { id: 'notes', type: 'textarea' },
  { id: 'number', type: 'number' },
];
const action = {
  id: 'copy-group-name',
  action_type: 'set_value',
  set_value_source: 'field',
  set_value_field_id: 'group',
  target_field_id: 'name',
  copy_mode: 'display_name',
};
const groupScope = (values) => recordSelectionOptionScope(fields[0], fields, values);

test('display-name copy retains UUID answers and resolves only an authorised option label', () => {
  const result = resolveDisplayNameCopyValue({
    action,
    fields,
    values: { group: 'group-uuid' },
    optionStates: {
      group: { status: 'resolved', scope: groupScope({ group: 'group-uuid' }), options: [{ id: 'group-uuid', label: 'Northern Region' }] },
    },
  });
  assert.deepEqual(result, { state: 'resolved', value: 'Northern Region' });
});

test('display-name copy clears instead of copying IDs during empty, pending, and unavailable states', () => {
  assert.deepEqual(resolveDisplayNameCopyValue({
    action, fields, values: { group: '' }, optionStates: {},
  }), { state: 'empty', value: '' });
  assert.deepEqual(resolveDisplayNameCopyValue({
    action, fields, values: { group: 'group-uuid' }, optionStates: {},
  }), { state: 'pending', value: '' });
  assert.deepEqual(resolveDisplayNameCopyValue({
    action, fields, values: { group: 'group-uuid' },
    optionStates: { group: { status: 'resolved', scope: groupScope({ group: 'group-uuid' }), options: [] } },
  }), { state: 'unavailable', value: '' });
});

test('scope changes invalidate old options and stale derived targets block submit until resynchronised', () => {
  const scopedFields = [
    { id: 'parent', type: 'text' },
    {
      id: 'org', type: 'organisation_dropdown',
      conditional_filters: {
        version: 1,
        rules: [{
          id: 'filter-a', source_field_id: 'parent', operator: 'equals', value: 'A',
          is_fallback: false, allowed_values: ['org-a'], org_filter: null,
        }],
      },
    },
    { id: 'name', type: 'text' },
  ];
  const scopedAction = { ...action, set_value_field_id: 'org' };
  const oldValues = { parent: 'A', org: 'org-a', name: 'Alpha' };
  const newValues = { parent: 'B', org: 'org-a', name: 'Alpha' };
  assert.deepEqual(resolveDisplayNameCopyValue({
    action: scopedAction, fields: scopedFields, values: newValues,
    optionStates: {
      org: {
        status: 'resolved',
        scope: recordSelectionOptionScope(scopedFields[1], scopedFields, oldValues),
        options: [{ id: 'org-a', label: 'Alpha' }],
      },
    },
  }), { state: 'pending', value: '' });
  const issues = activeDisplayNameCopyIssues({
    rules: [{ actions: [action] }],
    fields,
    values: { group: 'group-uuid', name: 'Old name' },
    optionStates: {
      group: {
        status: 'resolved',
        scope: groupScope({ group: 'group-uuid', name: 'Old name' }),
        options: [{ id: 'group-uuid', label: 'Northern Region' }],
      },
    },
    evaluateRule: () => true,
  });
  assert.equal(issues.length, 1);
});

test('runtime lifecycle semantics resynchronise pending, selection changes, clears, and reactivation', () => {
  const rules = [{ actions: [action] }];
  const active = (values, optionStates) => activeDisplayNameCopyIssues({
    rules, fields, values, optionStates, evaluateRule: () => true,
  });
  const resolved = (values, options) => ({
    group: { status: 'resolved', scope: groupScope(values), options },
  });
  // pending -> resolved A
  assert.equal(active(
    { group: 'a', name: '' },
    { group: { status: 'pending', scope: groupScope({ group: 'a', name: '' }), options: [] } },
  ).length, 1);
  assert.equal(active(
    { group: 'a', name: 'Alpha' },
    resolved({ group: 'a', name: 'Alpha' }, [{ id: 'a', label: 'Alpha' }]),
  ).length, 0);
  // A -> B must not retain A's label through the passive effect window.
  assert.equal(active(
    { group: 'b', name: 'Alpha' },
    resolved({ group: 'b', name: 'Alpha' }, [{ id: 'b', label: 'Beta' }]),
  ).length, 1);
  assert.equal(active(
    { group: 'b', name: 'Beta' },
    resolved({ group: 'b', name: 'Beta' }, [{ id: 'b', label: 'Beta' }]),
  ).length, 0);
  // A clear expects an empty target; deactivation permits existing restored data.
  assert.equal(active(
    { group: '', name: 'Beta' },
    resolved({ group: '', name: 'Beta' }, []),
  ).length, 1);
  assert.equal(active(
    { group: '', name: '' },
    resolved({ group: '', name: '' }, []),
  ).length, 0);
  assert.equal(activeDisplayNameCopyIssues({
    rules, fields, values: { group: '', name: 'Restored by deactivation' },
    optionStates: {}, evaluateRule: () => false,
  }).length, 0);
});

test('display-name mode is limited to top-level single selections and text-compatible targets', () => {
  assert.match(displayNameCopyConfigurationError({
    ...action, set_value_field_id: 'multi',
  }, fields), /single-select/);
  assert.match(displayNameCopyConfigurationError({
    ...action, target_field_id: 'number',
  }, fields), /text or textarea/);
  assert.match(displayNameCopyConfigurationError({
    ...action, set_value_field_id: 'distinct',
  }, [...fields, { id: 'distinct', type: 'organisation_dropdown', option_source: { type: 'custom_object' } }]), /single-select/);
  assert.equal(displayNameCopyConfigurationError({
    ...action, set_value_field_id: 'not-listed',
  }, [...fields, { id: 'not-listed', type: 'organisation_dropdown', not_listed_choice: { enabled: true } }]), null);
});

test('Not-listed-enabled sources still resolve normal records but reject the Other sentinel', () => {
  const notListedFields = [
    { id: 'org', type: 'organisation_dropdown', not_listed_choice: { enabled: true } },
    { id: 'name', type: 'text' },
  ];
  const notListedAction = { ...action, set_value_field_id: 'org' };
  const values = { org: 'org-a' };
  assert.deepEqual(resolveDisplayNameCopyValue({
    action: notListedAction, fields: notListedFields, values,
    optionStates: {
      org: {
        status: 'resolved',
        scope: recordSelectionOptionScope(notListedFields[0], notListedFields, values),
        options: [{ id: 'org-a', label: 'Actual organisation' }],
      },
    },
  }), { state: 'resolved', value: 'Actual organisation' });
  assert.deepEqual(resolveDisplayNameCopyValue({
    action: notListedAction, fields: notListedFields,
    values: { org: '__form_not_listed__' }, optionStates: {},
  }), { state: 'unavailable', value: '' });
});

test('only active unresolved display-name actions block submission', () => {
  const rules = [{
    conditions: [{ field_id: 'relationship', operator: 'equals', value: 'yes' }],
    actions: [action],
  }];
  const unresolved = activeDisplayNameCopyIssues({
    rules, fields,
    values: { relationship: 'yes', group: 'group-uuid' },
    optionStates: { group: { status: 'pending', options: [] } },
    evaluateRule: () => true,
  });
  assert.equal(unresolved.length, 1);
  assert.equal(activeDisplayNameCopyIssues({
    rules, fields,
    values: { relationship: 'no', group: 'group-uuid' },
    optionStates: { group: { status: 'pending', options: [] } },
    evaluateRule: () => false,
  }).length, 0);
});

test('standalone and embedded runtimes use the same authorised display-name resolver', async () => {
  const [standalone, embedded] = await Promise.all([
    readFile(new URL('../pages/FormView.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../pages/EmbedForm.jsx', import.meta.url), 'utf8'),
  ]);
  for (const source of [standalone, embedded]) {
    assert.match(source, /resolveDisplayNameCopyValue/);
    assert.match(source, /activeDisplayNameCopyIssues/);
    assert.match(source, /onRecordSelectionOptionsChange=\{handleRecordSelectionOptionsChange\}/);
    assert.match(source, /recordSelectionOptionStates/);
  }
});