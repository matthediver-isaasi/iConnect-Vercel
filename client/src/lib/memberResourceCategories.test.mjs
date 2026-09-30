import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeMemberCategorySelections } from './memberResourceCategories.js';

test('normalizes flat and subcategory endpoint rows into the save shape', () => {
  assert.deepEqual(
    normalizeMemberCategorySelections([
      { resource_category_id: 'flat-category', subcategory_name: '' },
      { resource_category_id: 'sub-category', subcategory_name: '  Updates  ' },
    ]),
    [
      { category_id: 'flat-category', subcategory_name: null },
      { category_id: 'sub-category', subcategory_name: 'Updates' },
    ],
  );
});

test('uses the persisted resource category field and removes duplicate rows', () => {
  assert.deepEqual(
    normalizeMemberCategorySelections([
      { category_id: 'wrong-category', resource_category_id: 'right-category', subcategory_name: null },
      { resource_category_id: 'right-category', subcategory_name: 'Topic' },
      { resource_category_id: 'right-category', subcategory_name: 'Topic' },
    ]),
    [
      { category_id: 'right-category', subcategory_name: null },
      { category_id: 'right-category', subcategory_name: 'Topic' },
    ],
  );
});

test('empty or malformed endpoint results normalize to no selections', () => {
  assert.deepEqual(normalizeMemberCategorySelections([]), []);
  assert.deepEqual(normalizeMemberCategorySelections(null), []);
  assert.deepEqual(normalizeMemberCategorySelections([
    { category_id: 'legacy-only' },
    { resource_category_id: '', subcategory_name: 'Ignored' },
  ]), []);
});

test('both member detail surfaces share the endpoint normalization and save contract', async () => {
  for (const file of [
    'client/src/pages/MemberDetail.jsx',
    'client/src/components/MemberDetailView.jsx',
  ]) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /normalizeMemberCategorySelections/, `${file} must normalize endpoint rows`);
    assert.match(source, /method: ['"]POST['"]/, `${file} must use the supported save method`);
    assert.match(source, /selections: selectedSubcategories/, `${file} must preserve the save payload`);
  }
});