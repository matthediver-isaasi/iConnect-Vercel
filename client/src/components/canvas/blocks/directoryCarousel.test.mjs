import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BLOCK_DEFAULTS,
  BLOCK_TYPES,
  createBlock,
} from '../../../lib/canvasDesign.js';

const source = fs.readFileSync(
  new URL('./dynamicBlocks.jsx', import.meta.url),
  'utf8',
);

test('directory carousel defaults persist randomiseOrder as false', () => {
  assert.equal(
    BLOCK_DEFAULTS[BLOCK_TYPES.DIRECTORY_CAROUSEL].content.randomiseOrder,
    false,
  );
  const created = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL);
  assert.equal(created.content.randomiseOrder, false);
  const persisted = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, {
    content: { randomiseOrder: true },
  });
  assert.equal(persisted.content.randomiseOrder, true);
});

test('directory carousel query is bounded and only sends seed for random order', () => {
  const start = source.indexOf('export function buildDirectoryCarouselQuery(');
  const end = source.indexOf('\n}\n\n// Directory carousel indicator helper.', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const buildQuery = new Function(
    `${source.slice(start, end + 2).replace('export function', 'function')}; return buildDirectoryCarouselQuery;`,
  )();

  const normal = buildQuery({ directorySlug: 'orgs', tenant: 'association', page: 1, limit: 3 });
  assert.equal(normal.get('mode'), 'carousel');
  assert.equal(normal.get('slug'), 'orgs');
  assert.equal(normal.get('tenant'), 'association');
  assert.equal(normal.get('page'), '1');
  assert.equal(normal.get('limit'), '3');
  assert.equal(normal.has('seed'), false);

  const random = buildQuery({
    directorySlug: 'orgs',
    page: 2,
    limit: 999,
    randomiseOrder: true,
    seed: 'visit-seed',
  });
  assert.equal(random.get('page'), '2');
  assert.equal(random.get('limit'), '50');
  assert.equal(random.get('seed'), 'visit-seed');
});

test('directory carousel windows large page indicators with accessible jumps', () => {
  const start = source.indexOf('export function buildDirectoryCarouselIndicatorItems(');
  const end = source.indexOf('\n}\n\n// Directory data is tenant-controlled', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const buildItems = new Function(
    `${source.slice(start, end + 2).replace('export function', 'function')}; return buildDirectoryCarouselIndicatorItems;`,
  )();

  const first = buildItems(400, 1);
  assert.equal(first.length, 7);
  assert.deepEqual(first.map((item) => [item.type, item.page]), [
    ['page', 1], ['page', 2], ['page', 3], ['page', 4], ['page', 5],
    ['ellipsis', 399], ['page', 400],
  ]);
  assert.equal(first.filter((item) => item.type === 'page' && item.page === 1).length, 1);

  const middle = buildItems(33334, 16667);
  assert.equal(middle.length, 7);
  assert.deepEqual(middle.map((item) => [item.type, item.page]), [
    ['page', 1], ['ellipsis', 16665], ['page', 16666], ['page', 16667],
    ['page', 16668], ['ellipsis', 16669], ['page', 33334],
  ]);

  const last = buildItems(33334, 33334);
  assert.equal(last.length, 7);
  assert.deepEqual(last.map((item) => [item.type, item.page]), [
    ['page', 1], ['ellipsis', 2], ['page', 33330], ['page', 33331],
    ['page', 33332], ['page', 33333], ['page', 33334],
  ]);
});

test('directory carousel keeps visit seed and ordinal offset stable across navigation/resizing', () => {
  const renderStart = source.indexOf('function DirectoryCarouselRender(');
  const renderEnd = source.indexOf('\nfunction DirectoryCarouselInspector(', renderStart);
  assert.notEqual(renderStart, -1);
  const renderer = source.slice(renderStart, renderEnd);

  // A mounted visit owns one ref seed. Directory/order changes reset to page
  // one, while a responsive page-size change translates the ordinal offset.
  assert.match(renderer, /const visitSeedRef = useRef\(null\)/);
  assert.match(renderer, /createDirectoryCarouselVisitSeed\(\)/);
  assert.match(renderer, /setCurrentPage\(1\);\s*setSelected\(null\);\s*return;\s*\}/);
  assert.match(renderer, /Math\.floor\(\(\(page - 1\) \* previousPerView\) \/ perView\) \+ 1/);
  assert.match(renderer, /page:\s*requestPage,\s*limit:\s*perView,\s*randomiseOrder,\s*seed:\s*visitSeed/);
  assert.match(renderer, /setCurrentPage\(\(page\) => \(page <= 1 \? pageCount : page - 1\)\)/);
  assert.match(renderer, /setCurrentPage\(\(page\) => \(page >= pageCount \? 1 : page \+ 1\)\)/);
  assert.match(renderer, /data !== undefined && !isFetching && requestPage > pageCount/);
});

test('directory carousel rejects unsafe website protocols', () => {
  const start = source.indexOf('export function resolveDirectoryCarouselWebsiteUrl(');
  const end = source.indexOf('\n}\n\nfunction useDirectoryCarouselRecords', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const resolveUrl = new Function(
    `${source.slice(start, end + 2).replace('export function', 'function')}; return resolveDirectoryCarouselWebsiteUrl;`,
  )();
  assert.equal(resolveUrl('javascript:alert(1)'), null);
  assert.equal(resolveUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(resolveUrl('//example.com/org'), null);
  assert.equal(resolveUrl('https://example.com/org'), 'https://example.com/org');
});

test('directory carousel inspector uses active organisation directories', () => {
  const inspectorStart = source.indexOf('function DirectoryCarouselInspector(');
  const inspectorEnd = source.indexOf('\n// ============================================================================\n// SHOWCASE CARD SETTINGS', inspectorStart);
  const inspector = source.slice(inspectorStart, inspectorEnd);
  assert.match(inspector, /entityType="organization"/);
  assert.match(inspector, /activeOnly/);
  assert.match(inspector, /toggle-directory-carousel-randomise-order/);
});