import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRepeatableRowId,
  ensureRepeatableRowIds,
  formatRepeatableRows,
  isRepeatableRowEmpty,
  normalizeRepeatableRowField,
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