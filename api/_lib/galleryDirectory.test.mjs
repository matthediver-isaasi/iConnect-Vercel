import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildGalleryDirectoryPage, parseGalleryDirectoryPagination } from './galleryDirectory.js';

const gallery = (id, isPublic = true) => ({
  id,
  title: `Gallery ${id}`,
  description: `Description ${id}`,
  slug: `gallery-${id}`,
  is_public: isPublic,
  cover_photo_id: `cover-${id}`,
});

test('directory pagination is bounded and defaults to twelve', () => {
  assert.deepEqual(parseGalleryDirectoryPagination({}), { page: 1, pageSize: 12 });
  assert.deepEqual(parseGalleryDirectoryPagination({ page: '-2', limit: '1000' }), { page: 1, pageSize: 48 });
  assert.deepEqual(parseGalleryDirectoryPagination({ page: '3', limit: '6' }), { page: 3, pageSize: 6 });
});

test('paginates only authorised galleries and reports the exact authorised total', () => {
  const galleries = [
    gallery('1'),
    gallery('2', false),
    gallery('3', false),
    gallery('4'),
    gallery('5', false),
  ];
  const access = [
    { allowed: true },
    { allowed: false },
    { allowed: true },
    { allowed: true },
    { allowed: true },
  ];
  const result = buildGalleryDirectoryPage({
    galleries,
    access,
    isAuthenticated: true,
    page: 2,
    pageSize: 2,
    covers: [
      { id: 'cover-1', gallery_id: '1', file_url: 'one.jpg' },
      { id: 'cover-4', gallery_id: '4', file_url: 'four.jpg' },
      { id: 'cover-5', gallery_id: '5', file_url: 'five.jpg' },
    ],
  });
  assert.equal(result.total, 4);
  assert.deepEqual(result.galleries.map((row) => row.id), ['4', '5']);
  assert.deepEqual(result.galleries.map((row) => row.cover_photo?.id), ['cover-4', 'cover-5']);
});

test('anonymous directory pages never expose non-public galleries even when policy access is unrestricted', () => {
  const result = buildGalleryDirectoryPage({
    galleries: [gallery('public'), gallery('private', false)],
    access: [{ allowed: true }, { allowed: true }],
    isAuthenticated: false,
    page: 1,
    pageSize: 12,
    covers: [],
  });
  assert.equal(result.total, 1);
  assert.deepEqual(result.galleries.map((row) => row.id), ['public']);
});

test('directory endpoint batches policy evaluation and fetches covers after page selection', () => {
  const source = readFileSync(new URL('../public/gallery-directory.js', import.meta.url), 'utf8');
  assert.match(source, /evaluateGalleryAccessPolicies/);
  assert.doesNotMatch(source, /for \(const gallery[\s\S]*gallery_photo/);
  const pageSelection = source.indexOf('const pageRows = visible.slice');
  const coverFetch = source.indexOf("from('gallery_photo')");
  assert.ok(pageSelection >= 0 && coverFetch > pageSelection);
  assert.match(source, /\.in\('gallery_id', pageRows\.map/);
  assert.match(source, /gallery\.is_public \|\| \(context\.isAuthenticated && access\[index\]\?\.allowed\)/);
});

test('directory client resets search pagination without retaining another search result as placeholder', () => {
  const pageSource = readFileSync(new URL('../../client/src/pages/GalleryDirectory.jsx', import.meta.url), 'utf8');
  const clientSource = readFileSync(new URL('../../client/src/api/publicClient.js', import.meta.url), 'utf8');
  assert.match(pageSource, /setPage\(1\);\s*setSearch\(event\.target\.value\)/);
  assert.match(
    pageSource,
    /previousQuery\?\.queryKey\?\.\[1\] === normalizedSearch \? previousData : undefined/,
  );
  assert.match(pageSource, /Page \{page\} of \{totalPages\}/);
  assert.match(clientSource, /page: String\(page\), limit: String\(limit\)/);
});