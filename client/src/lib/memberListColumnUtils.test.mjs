import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendMissingColumns,
  formatMemberDepartments,
  normalizeMemberDepartments,
  uniqueMemberRows,
} from './memberListColumnUtils.mjs';

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

test('formats every department in deterministic name order without using a singular fallback', () => {
  const member = {
    department: { id: 'legacy', name: 'Legacy primary' },
    departments: [
      { id: 'z', name: 'Radiopharmacy' },
      { id: 'a', name: 'Clinical Imaging' },
      { id: 'z', name: 'Radiopharmacy' },
      { id: 'b', name: 'clinical imaging' },
    ],
  };

  assert.deepEqual(normalizeMemberDepartments(member), [
    { id: 'a', name: 'Clinical Imaging' },
    { id: 'b', name: 'clinical imaging' },
    { id: 'z', name: 'Radiopharmacy' },
  ]);
  assert.equal(formatMemberDepartments(member), 'Clinical Imaging, clinical imaging, Radiopharmacy');
  assert.equal(formatMemberDepartments({ department: member.department }), '');
});

test('keeps one member row and unions department collections from duplicate join rows', () => {
  const rows = uniqueMemberRows([
    { id: 'member-1', first_name: 'Ada', departments: [{ id: '2', name: 'Therapy' }] },
    { id: 'member-1', first_name: 'Ada', departments: [{ id: '1', name: 'Imaging' }] },
    { id: 'member-2', first_name: 'Grace', departments: [] },
  ]);

  assert.deepEqual(rows.map((row) => row.id), ['member-1', 'member-2']);
  assert.equal(formatMemberDepartments(rows[0]), 'Imaging, Therapy');
});