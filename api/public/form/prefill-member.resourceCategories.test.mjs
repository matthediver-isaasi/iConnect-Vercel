import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./prefill-member.js', import.meta.url), 'utf8');

test('public member prefill returns saved resource-category selections', () => {
  assert.match(
    source,
    /\.from\('member_resource_category'\)[\s\S]*?\.select\('resource_category_id, subcategory_name'\)[\s\S]*?\.eq\('member_id', member_id\)/,
  );
  assert.match(source, /resourceCategorySelections: categorySelectionsError \? \[\] : \(resourceCategorySelections \|\| \[\]\)/);
});

test('resource-category lookup failure does not suppress core member prefill', () => {
  const lookupStart = source.indexOf("const { data: resourceCategorySelections");
  const allowedFieldsStart = source.indexOf("const { data: allowedFields");
  const categoryBlock = source.slice(lookupStart, allowedFieldsStart);
  assert.doesNotMatch(categoryBlock, /return res\.status\(500\)/);
});

test('public member category lookup occurs only after tenant-scoped member resolution', () => {
  const memberLookup = source.indexOf(".from('member')");
  const categoryLookup = source.indexOf(".from('member_resource_category')");
  assert.ok(memberLookup >= 0);
  assert.ok(categoryLookup > memberLookup);
  assert.match(
    source.slice(memberLookup, categoryLookup),
    /\.eq\('tenant_id', tenantId\)/,
  );
});