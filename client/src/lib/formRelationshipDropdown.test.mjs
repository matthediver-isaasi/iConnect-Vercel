import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FORM_NOT_LISTED_VALUE } from '../../../shared/formNotListedChoice.js';
import {
  isConfirmedEmptyRelationshipResult,
  getSavedFormFieldValue,
  getEligibleRelationshipParents,
  isRelationshipCompatibleWithParent,
  normalizeEligibleRelationships,
  normalizeRelationshipOptions,
  resolveFormRendererFieldValue,
  relationshipFieldConfig,
  resolveRelationshipDropdownValues,
  resolveRelationshipParentTransition,
  resolveSavedFormField,
  shouldClearRelationshipValue,
} from './formRelationshipDropdown.js';

test('relationship parents include compatible earlier record selectors', () => {
  const fields = [
    { id: 'name', type: 'text' },
    { id: 'org-1', type: 'organisation_dropdown' },
    { id: 'relationship', type: 'relationship_dropdown' },
    { id: 'org-2', type: 'organisation_dropdown' },
  ];
  assert.deepEqual(getEligibleRelationshipParents(fields, 'relationship').map((field) => field.id), ['org-1']);
});

test('eligible relationship discovery excludes inactive, hidden, and unrelated definitions', () => {
  const eligible = {
    id: 'eligible',
    status: 'active',
    source_kind: 'organization',
    target_kind: 'custom_object',
    show_on_source: true,
  };
  const result = normalizeEligibleRelationships([
    eligible,
    { ...eligible, id: 'draft', status: 'draft' },
    { ...eligible, id: 'hidden', show_on_source: false },
    { ...eligible, id: 'custom-custom', source_kind: 'custom_object' },
  ]);
  assert.deepEqual(result, [eligible]);
});

test('relationship config retains definition and object metadata', () => {
  const relationship = {
    id: 'definition-1',
    relationship_key: 'organisation_departments',
    side: 'source',
    custom_object: { id: 'departments', name: 'Departments', primary_display_field_id: 'department-name' },
  };
  assert.deepEqual(relationshipFieldConfig(relationship), {
    relationship_definition_id: 'definition-1',
    relationship_key: 'organisation_departments',
    relationship_parent_side: 'source',
    relationship_parent_kind: undefined,
    relationship_parent_custom_object_id: undefined,
    related_kind: 'custom_object',
    related_custom_object_id: 'departments',
    related_primary_display_field_id: 'department-name',
    organization_side: 'source',
    custom_object_id: 'departments',
    custom_object_name: 'Departments',
    custom_object_primary_display_field_id: 'department-name',
    relationship_definition: relationship,
    custom_object: relationship.custom_object,
  });
});

test('relationship definitions are filtered to the selected parent descriptor', () => {
  const relationship = {
    id: 'department-to-team',
    source_kind: 'custom_object',
    source_custom_object_id: 'departments',
    target_kind: 'custom_object',
    target_custom_object_id: 'teams',
  };
  assert.equal(isRelationshipCompatibleWithParent(relationship, {
    type: 'relationship_dropdown',
    related_kind: 'custom_object',
    related_custom_object_id: 'departments',
  }), true);
  assert.equal(isRelationshipCompatibleWithParent(relationship, {
    type: 'relationship_dropdown',
    related_kind: 'custom_object',
    related_custom_object_id: 'projects',
  }), false);
});

test('normalized side-specific discovery supports non-custom related records', () => {
  const normalized = {
    id: 'org-to-group',
    relationship_parent_side: 'source',
    relationship_parent_kind: 'organization',
    related_kind: 'organization_group',
    parent_object: { id: 'organisation' },
    related_object: { id: 'group-1', name: 'Regional group' },
  };
  assert.deepEqual(normalizeEligibleRelationships([normalized]), [normalized]);
  assert.equal(isRelationshipCompatibleWithParent(normalized, {
    type: 'organisation_dropdown',
  }), true);
  assert.deepEqual(relationshipFieldConfig(normalized), {
    relationship_definition_id: 'org-to-group',
    relationship_key: null,
    relationship_parent_side: 'source',
    relationship_parent_kind: 'organization',
    relationship_parent_custom_object_id: null,
    related_kind: 'organization_group',
    related_custom_object_id: null,
    related_primary_display_field_id: null,
    organization_side: 'source',
    custom_object_id: null,
    custom_object_name: 'Regional group',
    custom_object_primary_display_field_id: null,
    relationship_definition: normalized,
    custom_object: normalized.related_object,
  });
});

test('relationship value clears on parent change, clear, or invalid loaded options', () => {
  const base = { value: 'department-1', parentValue: 'org-1', options: [{ id: 'department-1' }] };
  assert.equal(shouldClearRelationshipValue({ ...base, previousParentValue: 'org-1', optionsLoaded: true }), false);
  assert.equal(shouldClearRelationshipValue({ ...base, previousParentValue: 'org-2' }), true);
  assert.equal(shouldClearRelationshipValue({ ...base, parentValue: '' }), true);
  assert.equal(shouldClearRelationshipValue({ ...base, options: [], optionsLoaded: false }), false);
  assert.equal(shouldClearRelationshipValue({ ...base, options: [], optionsLoaded: true }), true);
});

test('relationship auto-selects its enabled not-listed choice only from a not-listed parent', () => {
  const enabled = {
    id: 'department',
    type: 'relationship_dropdown',
    not_listed_choice: { enabled: true, label: 'Department is not listed' },
  };
  assert.equal(resolveRelationshipParentTransition({
    field: enabled,
    value: '',
    parentValue: FORM_NOT_LISTED_VALUE,
  }), FORM_NOT_LISTED_VALUE);
  assert.equal(resolveRelationshipParentTransition({
    field: enabled,
    value: FORM_NOT_LISTED_VALUE,
    parentValue: FORM_NOT_LISTED_VALUE,
  }), null);
  assert.equal(resolveRelationshipParentTransition({
    field: enabled,
    value: '',
    parentValue: 'org-1',
    options: [],
    optionsLoaded: false,
  }), null);
});

test('relationship stays empty for a not-listed parent when its own choice is disabled', () => {
  const disabled = {
    id: 'department',
    type: 'relationship_dropdown',
    not_listed_choice: { enabled: false, label: 'Department is not listed' },
  };
  assert.equal(resolveRelationshipParentTransition({
    field: disabled,
    value: '',
    parentValue: FORM_NOT_LISTED_VALUE,
  }), null);
  assert.equal(resolveRelationshipParentTransition({
    field: disabled,
    value: 'department-1',
    parentValue: FORM_NOT_LISTED_VALUE,
  }), '');
});

test('relationship clears an auto-selected choice when its parent becomes resolvable', () => {
  const field = {
    id: 'department',
    type: 'relationship_dropdown',
    not_listed_choice: { enabled: true, label: 'Department is not listed' },
  };
  assert.equal(resolveRelationshipParentTransition({
    field,
    value: FORM_NOT_LISTED_VALUE,
    parentValue: 'org-1',
    previousParentValue: FORM_NOT_LISTED_VALUE,
    options: [],
    optionsLoaded: false,
  }), '');
});

test('legacy name-key values resolve through saved fields and request dependent options', () => {
  const parent = { id: 'organisation-field', name: 'organisation', type: 'organisation_dropdown' };
  const dependent = {
    id: 'department-field',
    name: 'department',
    type: 'relationship_dropdown',
    parent_field_id: 'organisation-field',
  };
  const values = {
    organisation: 'organisation-record',
    department: 'department-record',
  };

  assert.equal(resolveSavedFormField([parent, dependent], dependent.parent_field_id), parent);
  assert.equal(getSavedFormFieldValue(values, parent), 'organisation-record');
  assert.deepEqual(resolveRelationshipDropdownValues({
    field: dependent,
    fields: [parent, dependent],
    values,
  }), {
    parentField: parent,
    parentValue: 'organisation-record',
    currentValue: 'department-record',
    needsCanonicalValue: true,
  });
});

test('repeatable relationship fields default to row scope and can read an explicit form parent', () => {
  const rootParent = { id: 'root-org', type: 'organisation_dropdown' };
  const rowParent = { id: 'row-org', type: 'organisation_dropdown' };
  const field = {
    id: 'row-relationship',
    type: 'relationship_dropdown',
    parent_field_id: 'root-org',
    repeatable_container_field_id: 'rows',
    parent_field_scope: 'form',
  };
  const resolved = resolveRelationshipDropdownValues({
    field,
    fields: [rowParent, field],
    values: { 'row-org': 'row-value' },
    rootFields: [rootParent],
    rootValues: { 'root-org': 'form-value' },
  });
  assert.equal(resolved.parentValue, 'form-value');
});

test('valid legacy dependent value is retained after options load', () => {
  const field = {
    id: 'department-field',
    name: 'department',
    type: 'relationship_dropdown',
    parent_field_id: 'organisation-field',
  };
  const resolved = resolveRelationshipDropdownValues({
    field,
    fields: [
      { id: 'organisation-field', name: 'organisation', type: 'organisation_dropdown' },
      field,
    ],
    values: {
      organisation: 'organisation-record',
      department: 'department-record',
    },
  });

  assert.equal(shouldClearRelationshipValue({
    value: resolved.currentValue,
    parentValue: resolved.parentValue,
    options: [{ id: 'department-record' }],
    optionsLoaded: true,
  }), false);
});

test('canonical field IDs win over legacy names, including explicit clears', () => {
  const parent = { id: 'organisation-field', name: 'organisation' };
  const dependent = { id: 'department-field', name: 'department', parent_field_id: parent.id };
  const resolved = resolveRelationshipDropdownValues({
    field: dependent,
    fields: [parent, dependent],
    values: {
      [parent.id]: '',
      organisation: 'stale-organisation',
      [dependent.id]: 'canonical-department',
      department: 'stale-department',
    },
  });

  assert.equal(resolved.parentValue, '');
  assert.equal(resolved.currentValue, 'canonical-department');
  assert.equal(resolved.needsCanonicalValue, false);
  assert.equal(shouldClearRelationshipValue({
    value: resolved.currentValue,
    parentValue: resolved.parentValue,
    options: [{ id: 'canonical-department' }],
    optionsLoaded: true,
  }), true);
});

test('legacy organisation parents render and normalize through their canonical field ID', () => {
  const fields = [
    { id: 'org-id', name: 'organisation', type: 'organisation_dropdown' },
    {
      id: 'department-id',
      name: 'department',
      type: 'relationship_dropdown',
      parent_field_id: 'org-id',
    },
  ];

  assert.deepEqual(resolveFormRendererFieldValue({
    field: fields[0],
    fields,
    values: { organisation: 'org-123' },
    value: undefined,
  }), {
    value: 'org-123',
    needsCanonicalValue: true,
  });

  assert.deepEqual(resolveFormRendererFieldValue({
    field: fields[0],
    fields,
    values: { 'org-id': '', organisation: 'org-123' },
    value: undefined,
  }), {
    value: '',
    needsCanonicalValue: false,
  });
});

test('relationship option normalization removes duplicate record keys', () => {
  assert.deepEqual(normalizeRelationshipOptions([
    { id: 'department-record', label: 'Department' },
    { value: 'department-record', name: 'Duplicate' },
  ]), [{ id: 'department-record', label: 'Department' }]);
});

test('empty relationship state requires a successful zero-result lookup', () => {
  const base = {
    fieldType: 'relationship_dropdown',
    parentValue: 'org-1',
    options: [],
    optionsLoaded: true,
    optionsError: false,
  };
  assert.equal(isConfirmedEmptyRelationshipResult(base), true);
  assert.equal(isConfirmedEmptyRelationshipResult({ ...base, parentValue: '' }), false);
  assert.equal(isConfirmedEmptyRelationshipResult({ ...base, optionsLoaded: false }), false);
  assert.equal(isConfirmedEmptyRelationshipResult({ ...base, optionsError: true }), false);
  assert.equal(isConfirmedEmptyRelationshipResult({ ...base, options: [{ id: 'record-1' }] }), false);
  assert.equal(isConfirmedEmptyRelationshipResult({
    ...base,
    parentValue: FORM_NOT_LISTED_VALUE,
  }), false);
});

test('renderer scopes repeatable relationship option queries by container', () => {
  const source = readFileSync(
    new URL('../components/forms/FormRenderer.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /resolveRelationshipDropdownValues\(\{[\s\S]*?fields: allFields,[\s\S]*?values: allFormValues/);
  assert.match(source, /queryKey: \['public-form-relationship-options', formSlug, field\.id, relationshipParentValue, field\.repeatable_container_field_id\]/);
  assert.match(source, /listFormRelationshipOptions\([\s\S]*?field\.repeatable_container_field_id/);
  assert.match(source, /value: relationshipCurrentValue,[\s\S]*?parentValue: relationshipParentValue/);
  assert.match(source, /else if \(relationshipValues\.needsCanonicalValue\) \{\s*onChange\(relationshipCurrentValue\)/);
  assert.match(source, /rootAllFields = null, rootAllFormValues = null/);
  assert.match(source, /organisation_group_parent_scope !== 'form'/);
});

test('relationship option client serializes the optional repeatable container scope', () => {
  const source = readFileSync(new URL('../api/publicClient.js', import.meta.url), 'utf8');
  const method = source.match(/async listFormRelationshipOptions[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(method, /containerFieldId = null/);
  assert.match(method, /params\.set\('containerFieldId', containerFieldId\)/);
});