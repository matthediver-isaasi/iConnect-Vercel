import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRepeatableRowId,
  ensureRepeatableRowIds,
  formatRepeatableRows,
  isRepeatableRowEmpty,
  normalizeRepeatableRowField,
  repeatableRowFieldConfigUpdate,
  REPEATABLE_ROW_LAYOUT_CARDS,
  REPEATABLE_ROW_LAYOUT_SPREADSHEET,
  validateRepeatableRows,
} from './formRepeatableRows.js';

const field = {
  id: 'employment',
  type: 'repeatable_row',
  repeatable_row: {
    version: 1,
    min_rows: 1,
    max_rows: 2,
    children: [
      { id: 'org', label: 'Organisation', type: 'organisation_dropdown', required: true },
      {
        id: 'department',
        label: 'Department',
        type: 'relationship_dropdown',
        required: true,
        parent_field_id: 'org',
        relationship_definition_id: 'rel-1',
        custom_object_id: 'department-object',
        custom_object_primary_display_field_id: 'name-field',
      },
      { id: 'title', label: 'Job title', type: 'text' },
    ],
  },
};

test('normalizes the versioned schema while retaining legacy top-level properties', () => {
  assert.deepEqual(normalizeRepeatableRowField(field).children.map((child) => child.id), ['org', 'department', 'title']);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_grid',
    minimum_rows: 2,
    maximum_rows: 4,
    child_fields: [{ id: 'name', type: 'text' }],
  }).min_rows, 2);
});

test('repeatable rows default to cards and accept only the spreadsheet layout', () => {
  assert.equal(normalizeRepeatableRowField(field).layout, REPEATABLE_ROW_LAYOUT_CARDS);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_rows',
    layout: 'spreadsheet',
  }).layout, REPEATABLE_ROW_LAYOUT_SPREADSHEET);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_rows',
    display_style: 'spreadsheet',
  }).layout, REPEATABLE_ROW_LAYOUT_SPREADSHEET);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_rows',
    layout: 'forged',
  }).layout, REPEATABLE_ROW_LAYOUT_CARDS);
});

test('repeatable config updates preserve the active top-level or nested storage shape', () => {
  assert.deepEqual(repeatableRowFieldConfigUpdate({
    type: 'repeatable_rows',
    child_fields: [{ id: 'old' }],
  }, {
    layout: 'spreadsheet',
    children: [{ id: 'new' }],
  }), {
    layout: 'spreadsheet',
    child_fields: [{ id: 'new' }],
  });
  assert.deepEqual(repeatableRowFieldConfigUpdate({
    type: 'repeatable_grid',
    repeatable_row: {
      version: 1,
      layout: 'cards',
      children: [{ id: 'old' }],
    },
  }, {
    layout: 'spreadsheet',
    children: [{ id: 'new' }],
  }), {
    repeatable_row: {
      version: 1,
      layout: 'spreadsheet',
      children: [{ id: 'new' }],
    },
  });
});

test('repeatable child updates preserve every supported legacy top-level child key', () => {
  for (const childKey of ['children', 'child_fields', 'fields']) {
    const fieldWithLegacyChildren = {
      type: childKey === 'fields' ? 'repeatable_grid' : 'repeatable_rows',
      [childKey]: [{ id: 'old', type: 'text' }],
    };
    const update = repeatableRowFieldConfigUpdate(fieldWithLegacyChildren, {
      children: [{ id: 'new', type: 'text' }],
    });
    const saved = { ...fieldWithLegacyChildren, ...update };
    assert.deepEqual(normalizeRepeatableRowField(saved).children.map(child => child.id), ['new']);
    assert.deepEqual(update[childKey].map(child => child.id), ['new']);
  }
});

test('stable row IDs are retained and duplicate or absent IDs are replaced', () => {
  let next = 0;
  const rows = ensureRepeatableRowIds([
    { _row_id: 'stable', title: 'One' },
    { _row_id: 'stable', title: 'Two' },
    { title: 'Three' },
  ], () => `generated-${++next}`);
  assert.deepEqual(rows.map((row) => row._row_id), ['stable', 'generated-1', 'generated-2']);
  assert.match(createRepeatableRowId(() => 0.5, () => 1), /^row_1_/);
});

test('validates bounds, required children, duplicate IDs and tampered keys', () => {
  const valid = validateRepeatableRows(field, [
    { _row_id: 'one', org: 'org-1', department: 'department-1', title: '' },
  ]);
  assert.equal(valid.valid, true);
  const invalid = validateRepeatableRows(field, [
    { _row_id: 'same', org: 'org-1', forged: 'yes' },
    { _row_id: 'same', org: 'org-2', department: 'department-2' },
    { org: 'org-3', department: 'department-3' },
  ]);
  assert.deepEqual(new Set(invalid.errors.map((error) => error.code)),
    new Set(['max_rows', 'unknown_child', 'required_child', 'invalid_row_id']));
});

test('optional untouched rows are empty and do not trigger required-child errors', () => {
  const optional = {
    ...field,
    repeatable_row: { ...field.repeatable_row, min_rows: 0 },
  };
  assert.equal(isRepeatableRowEmpty({ _row_id: 'row-1' }, optional), true);
  assert.equal(validateRepeatableRows(optional, [{ _row_id: 'row-1' }]).valid, true);
});

test('rejects unsupported children, invalid dependency direction and static selections', () => {
  const unsupported = {
    type: 'repeatable_row',
    children: [
      { id: 'nested', type: 'repeatable_row' },
      { id: 'choice', type: 'dropdown', options: ['A'], dependency: { source_field_id: 'later' } },
      { id: 'later', type: 'text' },
    ],
  };
  const result = validateRepeatableRows(unsupported, [{ choice: 'forged' }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'unsupported_child_type'));
  assert.ok(result.errors.some((error) => error.code === 'invalid_dependency'));
  assert.ok(result.errors.some((error) => error.code === 'invalid_selection'));
});

test('accepts a row-local Organisation Group to Organisation dependency and rejects invalid order', () => {
  const valid = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'group', type: 'organisation_group_dropdown' },
      { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
    ],
  };
  assert.equal(validateRepeatableRows(valid, [{ group: 'group-1', org: 'org-1' }]).valid, true);
  const invalid = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
      { id: 'group', type: 'organisation_group_dropdown' },
    ],
  };
  assert.ok(validateRepeatableRows(invalid, [{ group: 'group-1', org: 'org-1' }]).errors
    .some(error => error.code === 'invalid_dependency'));
});

test('supports a preceding form-scoped Organisation Group shared by every row', () => {
  const rows = {
    id: 'employment',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'org',
      type: 'organisation_dropdown',
      organisation_group_parent_field_id: 'group',
      organisation_group_parent_scope: 'form',
    }],
  };
  const rootFields = [
    { id: 'group', type: 'organisation_group_dropdown' },
    rows,
  ];
  assert.equal(validateRepeatableRows(rows, [{ org: 'org-1' }, { org: 'org-2' }], {
    rootFields,
  }).valid, true);
});

test('supports a preceding form-scoped relationship organisation parent', () => {
  const rows = {
    id: 'employment',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'department',
      type: 'relationship_dropdown',
      parent_field_id: 'organisation',
      parent_field_scope: 'form',
    }],
  };
  assert.equal(validateRepeatableRows(rows, [{ department: 'department-1' }], {
    rootFields: [
      { id: 'organisation', type: 'organisation_dropdown' },
      rows,
    ],
  }).valid, true);
});

test('supports row and form scoped custom-object relationship chaining', () => {
  const rowChain = {
    id: 'rows',
    type: 'repeatable_rows',
    child_fields: [
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'account', type: 'relationship_dropdown', parent_field_id: 'org',
        related_kind: 'custom_object', related_custom_object_id: 'account-object',
      },
      {
        id: 'contact', type: 'relationship_dropdown', parent_field_id: 'account',
        relationship_parent_kind: 'custom_object',
        relationship_parent_custom_object_id: 'account-object',
      },
    ],
  };
  assert.equal(validateRepeatableRows(rowChain, [{ account: 'account-1', contact: 'contact-1' }]).valid, true);

  const formChain = {
    id: 'rows',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'contact', type: 'relationship_dropdown', parent_field_id: 'account',
      parent_field_scope: 'form', relationship_parent_kind: 'custom_object',
      relationship_parent_custom_object_id: 'account-object',
    }],
  };
  assert.equal(validateRepeatableRows(formChain, [{ contact: 'contact-1' }], {
    rootFields: [
      { id: 'account', type: 'relationship_dropdown', related_custom_object_id: 'account-object' },
      formChain,
    ],
  }).valid, true);
});

test('rejects a relationship parent whose persisted descriptor does not match', () => {
  const rows = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'account', type: 'relationship_dropdown', parent_field_id: 'org',
        related_custom_object_id: 'account-object',
      },
      {
        id: 'contact', type: 'relationship_dropdown', parent_field_id: 'account',
        relationship_parent_kind: 'custom_object',
        relationship_parent_custom_object_id: 'forged-object',
      },
    ],
  };
  assert.ok(validateRepeatableRows(rows, [{ account: 'account-1', contact: 'contact-1' }]).errors
    .some(error => error.code === 'invalid_dependency'));
});

test('rejects missing, later, and malformed form parent scopes', () => {
  const rows = {
    id: 'employment',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'related',
      type: 'relationship_dropdown',
      parent_field_id: 'org',
      parent_field_scope: 'form',
    }, {
      id: 'org', type: 'organisation_dropdown',
    }],
  };
  assert.ok(validateRepeatableRows(rows, [{ related: 'record-1' }], {
    rootFields: [rows, { id: 'org', type: 'organisation_dropdown' }],
  }).errors.some(error => error.code === 'invalid_dependency'));
  assert.ok(validateRepeatableRows({
    ...rows,
    child_fields: [{ ...rows.child_fields[0], parent_field_scope: 'forged' }],
  }, [{ related: 'record-1' }], {
    rootFields: [{ id: 'org', type: 'organisation_dropdown' }, rows],
  }).errors.some(error => error.code === 'invalid_dependency'));
});

test('formats non-empty rows readably in child order', () => {
  assert.equal(formatRepeatableRows(field, [
    { org: 'Acme', department: 'Finance', title: 'Manager' },
    { org: 'Beta', department: 'Research' },
  ]), 'Row 1: Organisation: Acme; Department: Finance; Job title: Manager\n'
    + 'Row 2: Organisation: Beta; Department: Research');
});

test('URL children use the renderer-compatible optional-scheme URL pattern', () => {
  const urlField = {
    type: 'repeatable_rows',
    child_fields: [{ id: 'website', type: 'url', required: true }],
  };
  assert.equal(validateRepeatableRows(urlField, [{ website: 'example.com/path' }]).valid, true);
  assert.equal(validateRepeatableRows(urlField, [{ website: 'https://example.com' }]).valid, true);
  assert.equal(validateRepeatableRows(urlField, [{ website: 'ftp://example.com' }]).valid, false);
});