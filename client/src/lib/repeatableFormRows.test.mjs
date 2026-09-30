import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRepeatableRowId,
  ensureRepeatableRowIds,
  normalizeRepeatableRowField,
  reconcilePendingRepeatableRows,
  validateRepeatableRows,
} from '../../../shared/formRepeatableRows.js';

const field = {
  type: 'repeatable_rows',
  min_rows: 0,
  max_rows: 3,
  initial_row_required: false,
  child_fields: [
    { id: 'org', type: 'organisation_dropdown', label: 'Organisation', required: true },
    { id: 'department', type: 'relationship_dropdown', label: 'Department', parent_field_id: 'org', required: true },
  ],
};

test('normalizes repeatable configuration for UI and server validation', () => {
  const config = normalizeRepeatableRowField({
    ...field,
    child_fields: [...field.child_fields, { id: 'upload', type: 'file' }],
  });
  assert.deepEqual(config.children.map(child => child.id), ['org', 'department', 'upload']);
  assert.equal(config.max_rows, 3);
});

test('preserves stable row IDs and canonical child keys', () => {
  const row = { _row_id: 'stable-row', org: '', department: '' };
  row.org = 'org-1';
  const normalized = ensureRepeatableRowIds([row]);
  assert.equal(normalized[0]._row_id, 'stable-row');
  assert.equal(normalized[0].org, 'org-1');
  assert.match(createRepeatableRowId(() => 0.5, () => 1), /^row_/);
});

test('normalizes absent, null, empty, and non-array answers to empty rows', () => {
  assert.deepEqual(ensureRepeatableRowIds(undefined), []);
  assert.deepEqual(ensureRepeatableRowIds(null), []);
  assert.deepEqual(ensureRepeatableRowIds([]), []);
  assert.deepEqual(ensureRepeatableRowIds('not-an-array'), []);
});

test('keeps queued sibling changes through stale controlled-value renders', () => {
  const original = [{ _row_id: 'row-1', org: '', department: '' }];
  const parentQueued = [{
    ...original[0],
    org: '__form_not_listed__',
    __not_listed_choice_text: { org: 'Independent organisation' },
  }];
  const staleRender = reconcilePendingRepeatableRows(original, parentQueued);
  assert.deepEqual(staleRender.currentRows, parentQueued);
  assert.deepEqual(staleRender.pendingRows, parentQueued);

  const dependentQueued = staleRender.currentRows.map(row => ({
    ...row,
    department: '__form_not_listed__',
  }));
  const intermediateRender = reconcilePendingRepeatableRows(parentQueued, dependentQueued);
  assert.deepEqual(intermediateRender.currentRows, dependentQueued);

  const acknowledgedRender = reconcilePendingRepeatableRows(dependentQueued, dependentQueued);
  assert.deepEqual(acknowledgedRender.currentRows, dependentQueued);
  assert.equal(acknowledgedRender.pendingRows, null);
});

test('ignores untouched optional rows but validates active rows independently', () => {
  const empty = { _row_id: 'empty', org: '', department: '' };
  assert.equal(validateRepeatableRows(field, [empty]).valid, true);
  const active = { ...empty, org: 'org-1' };
  const result = validateRepeatableRows(field, [active]);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /Department is required/);
});

test('enforces row limits and child renderer validity', () => {
  const rows = [
    { _row_id: 'one', org: 'a', department: 'x' },
    { _row_id: 'two', org: 'b', department: 'y' },
    { _row_id: 'three', org: 'c', department: 'z' },
    { _row_id: 'four', org: 'd', department: 'z' },
  ];
  assert.match(validateRepeatableRows(field, rows).errors[0].message, /No more than 3/);
  const invalid = validateRepeatableRows(field, rows.slice(0, 1), {
    validateChild: ({ child }) => child.id !== 'department',
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0].message, /Department is invalid/);
});

test('marks repeatable values invalid when a unique column repeats', () => {
  const uniqueField = {
    ...field,
    child_fields: field.child_fields.map(child => (
      child.id === 'org' ? { ...child, unique_across_rows: true } : child
    )),
  };
  const result = validateRepeatableRows(uniqueField, [
    { _row_id: 'one', org: 'org-1', department: 'unit-1' },
    { _row_id: 'two', org: 'org-1', department: 'unit-2' },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'duplicate_child_value');
});

test('allows a caller-authorized synthetic selection outside persisted static options', () => {
  const staticField = {
    type: 'repeatable_rows',
    min_rows: 1,
    child_fields: [{
      id: 'category',
      type: 'category_dropdown',
      required: true,
      options: ['one', 'two'],
    }],
  };
  const result = validateRepeatableRows(staticField, [{ category: '__form_not_listed__' }], {
    isAllowedSpecialSelection: ({ value }) => value === '__form_not_listed__',
  });
  assert.equal(result.valid, true);
});