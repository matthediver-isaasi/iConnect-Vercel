import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getSavedFormFieldValue,
  getEligibleRelationshipParents,
  normalizeEligibleRelationships,
  normalizeRelationshipOptions,
  resolveFormRendererFieldValue,
  relationshipFieldConfig,
  resolveRelationshipDropdownValues,
  resolveSavedFormField,
  shouldClearRelationshipValue,
} from './formRelationshipDropdown.js';

test('relationship parents only include earlier organisation dropdowns', () => {
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
    organization_side: 'source',
    custom_object_id: 'departments',
    custom_object_name: 'Departments',
    custom_object_primary_display_field_id: 'department-name',
    relationship_definition: relationship,
    custom_object: relationship.custom_object,
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

test('renderer uses resolved parent and dependent values for loading and retention', () => {
  const source = readFileSync(
    new URL('../components/forms/FormRenderer.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /resolveRelationshipDropdownValues\(\{[\s\S]*?fields: allFields,[\s\S]*?values: allFormValues/);
  assert.match(source, /queryKey: \['public-form-relationship-options', formSlug, field\.id, relationshipParentValue\]/);
  assert.match(source, /value: relationshipCurrentValue,[\s\S]*?parentValue: relationshipParentValue/);
  assert.match(source, /else if \(relationshipValues\.needsCanonicalValue\) \{\s*onChange\(relationshipCurrentValue\)/);
});