import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildMemberResourceCategoryPrefillValues,
  buildPrefillValues,
} from './formFieldPrefill.js';

const selections = [
  { resource_category_id: 'category-a', subcategory_name: 'Alpha' },
  { resource_category_id: 'category-a', subcategory_name: 'Beta' },
  { resource_category_id: 'category-b', subcategory_name: 'Gamma' },
  { resource_category_id: 'category-a', subcategory_name: 'Alpha' },
  { resource_category_id: 'category-a', subcategory_name: null },
];

test('member resource categories prefill compatible dropdown and multiselect shapes', () => {
  const form = {
    prefill_source: 'member',
    fields: [
      { id: 'dropdown', type: 'category_dropdown', category_id: 'category-b' },
      { id: 'limited', type: 'category_multiselect', allowed_category_ids: ['category-a'] },
      { id: 'all', type: 'category_multiselect', allowed_category_ids: [] },
      {
        id: 'legacy',
        type: 'resource_categories',
        allowed_category_ids: ['category-a'],
        prefill_field: 'member_custom:legacy-category-value',
      },
    ],
  };

  assert.deepEqual(buildMemberResourceCategoryPrefillValues({
    form,
    memberResourceCategorySelections: selections,
  }), {
    dropdown: 'Gamma',
    limited: ['Alpha', 'Beta'],
    all: ['Alpha', 'Beta', 'Gamma'],
    legacy: ['Alpha', 'Beta'],
  });

  assert.deepEqual(buildPrefillValues({
    form,
    memberEntity: { id: 'member-a' },
    primaryEntity: { id: 'member-a' },
    memberResourceCategorySelections: selections,
  }), {
    dropdown: 'Gamma',
    limited: ['Alpha', 'Beta'],
    all: ['Alpha', 'Beta', 'Gamma'],
    legacy: ['Alpha', 'Beta'],
  });
});

test('anonymous/non-member prefill has no resource-category defaults', () => {
  const fields = [
    { id: 'dropdown', type: 'category_dropdown', category_id: 'category-a' },
    { id: 'multi', type: 'category_multiselect', allowed_category_ids: ['category-a'] },
  ];

  assert.deepEqual(buildMemberResourceCategoryPrefillValues({
    form: { prefill_source: 'member', fields },
  }), {});
  assert.deepEqual(buildMemberResourceCategoryPrefillValues({
    form: { prefill_source: 'organization', fields },
    memberResourceCategorySelections: selections,
  }), {});
});

test('all public form surfaces pass saved member categories into shared prefill mapping', async () => {
  const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const surfaceFiles = [
    path.join(clientRoot, 'pages/FormView.jsx'),
    path.join(clientRoot, 'pages/EmbedForm.jsx'),
    path.join(clientRoot, 'components/iedit/elements/IEditFormElement.jsx'),
  ];

  for (const file of surfaceFiles) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /memberResourceCategorySelections:/, `${path.basename(file)} must pass category selections to prefill`);
    assert.match(source, /MemberResourceCategory\.list|resourceCategorySelections/, `${path.basename(file)} must load category selections`);
  }
});

test('saved category selections take precedence over legacy prefill_field values', () => {
  const form = {
    prefill_source: 'member',
    fields: [
      {
        id: 'dropdown',
        type: 'category_dropdown',
        category_id: 'category-b',
        prefill_field: 'member_custom:legacy-dropdown',
      },
      {
        id: 'multi',
        type: 'category_multiselect',
        allowed_category_ids: ['category-a'],
        prefill_field: 'member_custom:legacy-multi',
      },
    ],
  };

  assert.deepEqual(buildPrefillValues({
    form,
    memberEntity: { id: 'member-a' },
    primaryEntity: { id: 'member-a' },
    memberCustomValues: [
      { field_id: 'legacy-dropdown', value: 'Wrong dropdown' },
      { field_id: 'legacy-multi', value: '["Wrong multi"]' },
    ],
    memberResourceCategorySelections: selections,
  }), {
    dropdown: 'Gamma',
    multi: ['Alpha', 'Beta'],
  });
});