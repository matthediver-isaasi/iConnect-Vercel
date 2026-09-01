import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildMemberResourceCategoryDiff,
  collectMemberResourceCategoryMappingIntents,
  isMemberResourceCategoryMapping,
} from './process-application.js';

test('resource-category target contract is explicit and member-only', () => {
  const valid = {
    target_type: 'resource_category',
    target_entity: 'member',
    target_field: 'category-a',
    source_field_id: 'field-a',
  };
  assert.equal(isMemberResourceCategoryMapping(valid), true);
  assert.equal(isMemberResourceCategoryMapping({ ...valid, target_type: 'core' }), false);
  assert.equal(isMemberResourceCategoryMapping({ ...valid, target_entity: 'organization' }), false);
  assert.equal(isMemberResourceCategoryMapping({ ...valid, target_field: '' }), false);
  assert.equal(isMemberResourceCategoryMapping({ ...valid, source_field_id: '' }), false);
});

test('mapping intents support dropdown scalars, multiselect arrays, clears, and absent values', () => {
  const pipeline = {
    mappings: [
      { target_type: 'resource_category', target_entity: 'member', target_field: 'category-a', source_field_id: 'dropdown' },
      { target_type: 'resource_category', target_entity: 'member', target_field: 'category-b', source_field_id: 'multi' },
      { target_type: 'resource_category', target_entity: 'member', target_field: 'category-c', source_field_id: 'clear' },
      { target_type: 'resource_category', target_entity: 'member', target_field: 'category-d', source_field_id: 'absent' },
      { target_type: 'custom', target_entity: 'member', target_field: 'category-e', source_field_id: 'ignored' },
    ],
  };
  const intents = collectMemberResourceCategoryMappingIntents(
    pipeline,
    {
      dropdown: 'One',
      multi: ['Two', 'Three', 'Two'],
      clear: [],
      ignored: 'Nope',
    },
    [
      { id: 'dropdown', type: 'category_dropdown', category_id: 'category-a' },
      { id: 'multi', type: 'category_multiselect', allowed_category_ids: ['category-b'] },
      { id: 'clear', type: 'category_multiselect', allowed_category_ids: ['category-c'] },
      { id: 'absent', type: 'category_dropdown', category_id: 'category-d' },
      { id: 'ignored', type: 'category_dropdown', category_id: 'category-e' },
    ],
  );
  assert.deepEqual([...intents.get('category-a')], ['One']);
  assert.deepEqual([...intents.get('category-b')], ['Two', 'Three']);
  assert.deepEqual([...intents.get('category-c')], []);
  assert.equal(intents.has('category-d'), false);
  assert.equal(intents.has('category-e'), false);
});

test('source category configuration cannot be remapped to a mismatched destination', () => {
  const mapping = {
    target_type: 'resource_category',
    target_entity: 'member',
    target_field: 'category-a',
    source_field_id: 'field-a',
  };
  const dropdownMismatch = collectMemberResourceCategoryMappingIntents(
    { mappings: [mapping] },
    { 'field-a': 'Shared name' },
    [{ id: 'field-a', type: 'category_dropdown', category_id: 'category-b' }],
  );
  const multiMismatch = collectMemberResourceCategoryMappingIntents(
    { mappings: [mapping] },
    { 'field-a': ['Shared name'] },
    [{ id: 'field-a', type: 'category_multiselect', allowed_category_ids: ['category-b'] }],
  );
  assert.equal(dropdownMismatch.size, 0);
  assert.equal(multiMismatch.size, 0);
});

test('destination diff only changes rows supplied for that category', () => {
  const categoryARows = [
    { id: 'a-1', resource_category_id: 'category-a', subcategory_name: 'Old' },
    { id: 'a-2', resource_category_id: 'category-a', subcategory_name: 'Keep' },
  ];
  assert.deepEqual(
    buildMemberResourceCategoryDiff(categoryARows, ['Keep', 'New']),
    { removeIds: ['a-1'], toInsert: ['New'] },
  );
});

test('persistence validates active categories in the authoritative tenant and scopes legacy fallback', async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'process-application.js'),
    'utf8',
  );
  const mappedBlock = source.slice(
    source.indexOf('const persistMappedMemberResourceCategories'),
    source.indexOf('// Helper function to process pipeline entry mappings'),
  );
  assert.match(mappedBlock, /from\('resource_category'\)[\s\S]*?\.eq\('tenant_id', effectiveEntityTenantId\)[\s\S]*?\.eq\('is_active', true\)/);
  assert.match(mappedBlock, /\.eq\('resource_category_id', categoryId\)/);
  assert.match(mappedBlock, /submittedValues\.size > 0 && selectedValues\.length === 0/);

  const legacyBlock = source.slice(
    source.indexOf('// Backwards compatibility: old forms had no explicit mapping'),
    source.indexOf('// Auto-approve membership fees'),
  );
  assert.match(legacyBlock, /\.eq\('tenant_id', effectiveEntityTenantId\)[\s\S]*?\.eq\('is_active', true\)/);
  assert.match(legacyBlock, /!explicitlyMappedCategoryIds\.has\(id\)/);
});

test('mapped persistence is applied to primary and additional member pipelines', async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'process-application.js'),
    'utf8',
  );
  assert.match(source, /const topLevelCategoryMappings = \(field_mappings \|\| \[\]\)[\s\S]*?\.filter\(isMemberResourceCategoryMapping\)/);
  assert.match(source, /mappings: \[\.\.\.primaryPipelineCategoryMappings, \.\.\.topLevelCategoryMappings\]/);
  assert.match(source, /persistMappedMemberResourceCategories\(createdMemberId, effectivePrimaryCategoryPipeline\)/);
  assert.match(source, /persistMappedMemberResourceCategories\(existingMemberId, memberConfig\)/);
  assert.match(source, /memberPipelines\.filter\(m => !m\.isPrimary && !m\.is_primary\)/);
});