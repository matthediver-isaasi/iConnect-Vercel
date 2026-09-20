import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TENANT, matches, checkTaxonomy, verify } from './restrict-bnms-meeting-resources.mjs';

const resource = (subcategories, extra = {}) => ({ tenant_id: TENANT, subcategories, is_public: true, ...extra });
test('exact collection AND (Posters OR Presentation); never presentation column, title or Events', () => {
  for (const type of ['Posters', 'Presentation']) {
    assert(matches(resource(['Spring Meeting 2026', type], { resource_type: 'download' })));
    assert(!matches(resource(['Events', type])));
    assert(!matches(resource(['Spring Meeting 2026', type], { tenant_id: 'other' })));
  }
  assert(!matches(resource(['Spring Meeting 2026'], { resource_type: 'Presentation' })));
  assert(!matches(resource(['Posters'], { title: 'Spring Meeting 2026' })));
  assert(!matches(resource(null)));
});
test('taxonomy fails closed for missing or ambiguous meanings', () => {
  const categories = [{ name: 'Collection', subcategories: ['Spring Meeting 2026', 'Events'] },
    { name: 'Resource Type', subcategories: ['Posters', 'Presentation'] }];
  checkTaxonomy(categories);
  assert.throws(() => checkTaxonomy(categories.slice(0, 1)));
  assert.throws(() => checkTaxonomy([...categories, { name: 'Other', subcategories: ['Posters'] }]));
});
test('verification preserves every unrelated field and nonmatch, handles null and replay', () => {
  const before = [resource(['Spring Meeting 2026', 'Posters'], { is_public: null, allowed_role_ids: ['role'], target_url: 'unchanged' }),
    resource(['Events', 'Presentation']), resource(['Spring Meeting 2026', 'Presentation'], { is_public: false })];
  const after = before.map(row => matches(row) ? { ...row, is_public: false } : row);
  verify(before, after);
  verify(after, after);
  assert.throws(() => verify(before, before));
  assert.throws(() => verify(before, after.map(row => ({ ...row, allowed_role_ids: [] }))));
});