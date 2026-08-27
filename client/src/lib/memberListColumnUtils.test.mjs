import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendMissingColumns } from './memberListColumnUtils.mjs';

test('appends newly introduced default columns without changing saved preferences', () => {
  const saved = [
    { id: 'name', visible: true },
    { id: 'email', visible: false },
    { id: 'custom_field', visible: true },
  ];
  const defaults = [
    { id: 'name', visible: true },
    { id: 'email', visible: true },
    { id: 'department', visible: false },
  ];

  assert.deepEqual(appendMissingColumns(saved, defaults), [
    ...saved,
    { id: 'department', visible: false },
  ]);
});

test('returns the existing preference array when no default columns are missing', () => {
  const saved = [{ id: 'name', visible: false }];
  const result = appendMissingColumns(saved, [{ id: 'name', visible: true }]);

  assert.equal(result, saved);
  assert.deepEqual(result, [{ id: 'name', visible: false }]);
});