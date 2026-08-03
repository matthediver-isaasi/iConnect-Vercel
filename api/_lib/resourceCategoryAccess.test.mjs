// Task #3306: role-based resource category access — pure helper tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getExcludedRoleIds,
  isCategoryRestricted,
  isCategoryVisibleToViewer,
  filterCategoriesForViewer,
  computeHiddenSubcategories,
  isResourceHiddenByCategories,
  filterResourcesByCategoryAccess,
} from './resourceCategoryAccess.js';

const cats = [
  { id: 'c1', subcategories: ['A', 'B'], excluded_role_ids: [] },
  { id: 'c2', subcategories: ['B', 'C'], excluded_role_ids: ['r1'] },
  { id: 'c3', subcategories: ['D'], excluded_role_ids: ['r2'] },
];

test('empty/NULL/malformed exclusions read as unrestricted', () => {
  assert.deepEqual(getExcludedRoleIds({}), []);
  assert.deepEqual(getExcludedRoleIds({ excluded_role_ids: null }), []);
  assert.deepEqual(getExcludedRoleIds({ excluded_role_ids: 'junk' }), []);
  assert.deepEqual(getExcludedRoleIds({ excluded_role_ids: ['r1', '', 42] }), ['r1']);
  assert.equal(isCategoryRestricted({ excluded_role_ids: [] }), false);
  assert.equal(isCategoryRestricted({ excluded_role_ids: ['r1'] }), true);
});

test('no restrictions anywhere = zero behaviour change for every viewer', () => {
  const plain = [{ id: 'x', subcategories: ['A'], excluded_role_ids: [] }, { id: 'y', subcategories: [] }];
  for (const viewer of [{ isGuest: true }, { roleId: 'r9' }, { roleId: null }, { isPrivileged: true }]) {
    assert.equal(filterCategoriesForViewer(plain, viewer).length, 2);
    assert.equal(computeHiddenSubcategories(plain, viewer).size, 0);
  }
});

test('excluded role loses the category; other roles keep it', () => {
  assert.equal(isCategoryVisibleToViewer(cats[1], { roleId: 'r1' }), false);
  assert.equal(isCategoryVisibleToViewer(cats[1], { roleId: 'r2' }), true);
  assert.deepEqual(filterCategoriesForViewer(cats, { roleId: 'r1' }).map((c) => c.id), ['c1', 'c3']);
});

test('guests and roleless members fail closed on any restricted category', () => {
  assert.equal(isCategoryVisibleToViewer(cats[1], { isGuest: true }), false);
  assert.equal(isCategoryVisibleToViewer(cats[1], { roleId: null }), false);
  assert.deepEqual(filterCategoriesForViewer(cats, { isGuest: true }).map((c) => c.id), ['c1']);
});

test('privileged viewers see everything', () => {
  assert.deepEqual(filterCategoriesForViewer(cats, { isPrivileged: true }).map((c) => c.id), ['c1', 'c2', 'c3']);
});

test('a subcategory shared with a visible category is never hidden', () => {
  const hidden = computeHiddenSubcategories(cats, { roleId: 'r1' });
  assert.deepEqual([...hidden].sort(), ['C']); // B rescued by c1
});

test('guest hidden set unions all restricted categories', () => {
  const hidden = computeHiddenSubcategories(cats, { isGuest: true });
  assert.deepEqual([...hidden].sort(), ['C', 'D']);
});

test('resource hidden only when ALL of its subcategories are hidden', () => {
  const hidden = new Set(['C', 'D']);
  assert.equal(isResourceHiddenByCategories({ subcategories: ['C'] }, hidden), true);
  assert.equal(isResourceHiddenByCategories({ subcategories: ['C', 'D'] }, hidden), true);
  assert.equal(isResourceHiddenByCategories({ subcategories: ['C', 'A'] }, hidden), false);
  // no subcategories or legacy/unmapped names stay visible
  assert.equal(isResourceHiddenByCategories({ subcategories: [] }, hidden), false);
  assert.equal(isResourceHiddenByCategories({ subcategories: null }, hidden), false);
  assert.equal(isResourceHiddenByCategories({ subcategories: ['Legacy'] }, hidden), false);
  // empty hidden set is a no-op
  assert.equal(isResourceHiddenByCategories({ subcategories: ['C'] }, new Set()), false);
});

test('filterResourcesByCategoryAccess keeps identity when nothing hidden', () => {
  const res = [{ id: 1, subcategories: ['C'] }];
  assert.equal(filterResourcesByCategoryAccess(res, new Set()), res);
  assert.deepEqual(
    filterResourcesByCategoryAccess(
      [{ id: 1, subcategories: [] }, { id: 2, subcategories: ['C'] }, { id: 3, subcategories: ['C', 'A'] }],
      new Set(['C'])
    ).map((r) => r.id),
    [1, 3]
  );
});
