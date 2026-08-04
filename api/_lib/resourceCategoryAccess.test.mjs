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
  getSubcategoryExclusionMap,
  getSubcategoryExcludedRoleIds,
  hasSubcategoryRestrictions,
  isSubcategoryVisibleInCategory,
  filterCategorySubcategoriesForViewer,
  stripCategoryAccessFields,
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

// ---- Task #3320: subcategory-level role exclusions ----

const subCats = [
  {
    id: 's1',
    subcategories: ['A', 'B'],
    excluded_role_ids: [],
    subcategory_excluded_role_ids: { B: ['r1'] },
  },
  {
    id: 's2',
    subcategories: ['B', 'C'],
    excluded_role_ids: ['r1'],
    subcategory_excluded_role_ids: {},
  },
];

test('malformed/empty subcategory exclusion maps read as unrestricted', () => {
  assert.deepEqual(getSubcategoryExclusionMap({}), {});
  assert.deepEqual(getSubcategoryExclusionMap({ subcategory_excluded_role_ids: null }), {});
  assert.deepEqual(getSubcategoryExclusionMap({ subcategory_excluded_role_ids: ['junk'] }), {});
  assert.deepEqual(getSubcategoryExcludedRoleIds({ subcategory_excluded_role_ids: { A: ['r1', '', 42] } }, 'A'), ['r1']);
  assert.equal(hasSubcategoryRestrictions({ subcategory_excluded_role_ids: {} }), false);
  assert.equal(hasSubcategoryRestrictions({ subcategory_excluded_role_ids: { A: [] } }), false);
  assert.equal(hasSubcategoryRestrictions({ subcategory_excluded_role_ids: { A: ['r1'] } }), true);
});

test('subcategory visibility: excluded role loses only that subcategory', () => {
  assert.equal(isSubcategoryVisibleInCategory(subCats[0], 'A', { roleId: 'r1' }), true);
  assert.equal(isSubcategoryVisibleInCategory(subCats[0], 'B', { roleId: 'r1' }), false);
  assert.equal(isSubcategoryVisibleInCategory(subCats[0], 'B', { roleId: 'r2' }), true);
  // Category hidden => every subcategory hidden regardless of the map.
  assert.equal(isSubcategoryVisibleInCategory(subCats[1], 'C', { roleId: 'r1' }), false);
  // Privileged bypass.
  assert.equal(isSubcategoryVisibleInCategory(subCats[0], 'B', { isPrivileged: true }), true);
  // Guests / roleless members fail closed on restricted subcategories.
  assert.equal(isSubcategoryVisibleInCategory(subCats[0], 'B', { isGuest: true }), false);
  assert.equal(isSubcategoryVisibleInCategory(subCats[0], 'B', { roleId: null }), false);
});

test('computeHiddenSubcategories includes role-excluded subs of visible categories', () => {
  // r1: category s2 hidden (B, C), sub B of s1 excluded => B hidden everywhere, C hidden, A visible.
  assert.deepEqual([...computeHiddenSubcategories(subCats, { roleId: 'r1' })].sort(), ['B', 'C']);
  // r2 sees everything.
  assert.equal(computeHiddenSubcategories(subCats, { roleId: 'r2' }).size, 0);
});

test('duplicate subcategory names: any visible occurrence rescues the name', () => {
  const cats = [
    { id: 'x', subcategories: ['B'], subcategory_excluded_role_ids: { B: ['r1'] } },
    { id: 'y', subcategories: ['B'], subcategory_excluded_role_ids: {} },
  ];
  assert.equal(computeHiddenSubcategories(cats, { roleId: 'r1' }).size, 0);
});

test('filterCategorySubcategoriesForViewer trims only hidden occurrences', () => {
  assert.deepEqual(filterCategorySubcategoriesForViewer(subCats[0], { roleId: 'r1' }).subcategories, ['A']);
  assert.deepEqual(filterCategorySubcategoriesForViewer(subCats[0], { roleId: 'r2' }).subcategories, ['A', 'B']);
  assert.deepEqual(filterCategorySubcategoriesForViewer(subCats[0], { isGuest: true }).subcategories, ['A']);
  assert.deepEqual(filterCategorySubcategoriesForViewer(subCats[0], { isPrivileged: true }).subcategories, ['A', 'B']);
});

test('stripCategoryAccessFields removes both access-control fields', () => {
  const stripped = stripCategoryAccessFields(subCats[0]);
  assert.equal('excluded_role_ids' in stripped, false);
  assert.equal('subcategory_excluded_role_ids' in stripped, false);
  assert.equal(stripped.id, 's1');
});

test('no subcategory restrictions anywhere = zero behaviour change', () => {
  for (const viewer of [{ isGuest: true }, { roleId: 'r9' }, { roleId: null }, { isPrivileged: true }]) {
    assert.equal(computeHiddenSubcategories([{ id: 'p', subcategories: ['A'], subcategory_excluded_role_ids: {} }], viewer).size, 0);
  }
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
