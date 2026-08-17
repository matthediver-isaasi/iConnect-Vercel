// Task #3638: reserved page-slug guard for Canvas Builder / iEdit pages.
// Run: npx tsx --test client/src/lib/reservedPageSlug.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isReservedPageSlug,
  isReservedMemberSlug,
  reservedPageSlugMessage,
  BUILTIN_MEMBER_ALIASES,
  RESERVED_MEMBER_SLUGS,
} from '../../../shared/memberAliases.js';

test('built-in member aliases are reserved for PAGE slugs', () => {
  for (const alias of BUILTIN_MEMBER_ALIASES) {
    assert.equal(isReservedPageSlug(alias), true, alias);
  }
});

test('member-slug helper still exempts the built-in aliases (semantics unchanged)', () => {
  for (const alias of BUILTIN_MEMBER_ALIASES) {
    assert.equal(isReservedMemberSlug(alias), false, alias);
  }
  assert.equal(isReservedMemberSlug('events'), true);
});

test('every reserved route root is a reserved page slug', () => {
  for (const slug of RESERVED_MEMBER_SLUGS) {
    if (!slug) continue; // '' is handled by required-field validation, not the reserved check
    if (slug === 'login') continue; // see next test
    assert.equal(isReservedPageSlug(slug), true, slug);
  }
});

test('login is exempt: the system login canvas page legitimately owns that slug', () => {
  assert.equal(isReservedPageSlug('login'), false);
  assert.equal(isReservedMemberSlug('login'), true);
});

test('case-insensitive', () => {
  assert.equal(isReservedPageSlug('People'), true);
  assert.equal(isReservedPageSlug('EVENTS'), true);
});

test('ordinary slugs are allowed', () => {
  for (const slug of ['about-us', 'annual-conference-2026', 'our-people', 'people-directory']) {
    assert.equal(isReservedPageSlug(slug), false, slug);
  }
});

test('falsy slugs are not reserved (required-field validation owns those)', () => {
  assert.equal(isReservedPageSlug(''), false);
  assert.equal(isReservedPageSlug(null), false);
  assert.equal(isReservedPageSlug(undefined), false);
});

test('message names the conflicting route', () => {
  assert.match(reservedPageSlugMessage('People'), /"\/people" is a built-in app route/);
});

// Route-table regression guard: every static top-level route root registered
// in the app router must be reserved for page slugs (React Router matches
// case-insensitively, so any explicit <Route path="/X"> shadows a page saved
// at /x). Fails when a new static route is added without reserving its root.
test('every static router root is a reserved page slug (login excepted)', () => {
  const src = fs.readFileSync(new URL('../pages/index.jsx', import.meta.url), 'utf8');
  const roots = new Set();
  for (const m of src.matchAll(/<Route path="\/([^"]*)"/g)) {
    const root = m[1].split('/')[0];
    if (!root || root.includes(':') || root.includes('*')) continue;
    roots.add(root.toLowerCase());
  }
  assert.ok(roots.size > 100, `expected many route roots, parsed ${roots.size}`);
  const missing = [...roots].filter((r) => r !== 'login' && !isReservedPageSlug(r));
  assert.deepEqual(missing, [], `route roots not reserved for page slugs: ${missing.join(', ')}`);
});

// Source-contract: the server entity API enforces the same rule on create and
// update, and exempts microsite-scoped pages, so stale client bundles or raw
// API callers cannot mint an unreachable page.
import fs from 'node:fs';
const readApi = (rel) => fs.readFileSync(new URL(`../../../api/${rel}`, import.meta.url), 'utf8');

test('server create path enforces reserved + duplicate slugs (microsite exempt)', () => {
  const src = readApi('entities/[entity]/index.js');
  assert.match(src, /isReservedPageSlug/);
  assert.match(src, /reservedPageSlugMessage/);
  assert.match(src, /microsite_id && isReservedPageSlug/);
  assert.match(src, /Another page already uses this slug/);
});

test('server update path enforces reserved + duplicate slugs (microsite exempt)', () => {
  const src = readApi('entities/[entity]/[id].js');
  assert.match(src, /isReservedPageSlug/);
  assert.match(src, /targetMicrositeId && isReservedPageSlug/);
  assert.match(src, /Another page already uses this slug/);
});

test('doc-import slug minting dodges reserved roots', () => {
  const src = readApi('admin/canvas-from-doc.js');
  assert.match(src, /isReservedPageSlug\(slug\)/);
});
