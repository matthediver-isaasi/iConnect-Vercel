import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveDirectoryCarouselOrganisationNameDisplay } from './directoryCarouselSource.mjs';
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
  assert.equal(created.content.organisationNameDisplay, 'inherit');
  assert.deepEqual(created.content.perView, { desktop: 3, tablet: 2, mobile: 1 });
  const persisted = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, {
    content: { randomiseOrder: true },
  });
  assert.equal(persisted.content.randomiseOrder, true);
  const legacy = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, { content: { perView: 4, directorySlug: 'legacy' } });
  assert.equal(legacy.content.perView, 4);
  assert.equal(legacy.content.organisationNameDisplay, 'inherit');
  for (const mode of ['inherit', 'show', 'hide']) {
    assert.equal(createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, {
      content: { organisationNameDisplay: mode },
    }).content.organisationNameDisplay, mode);
  }
  const authored = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, { content: { perView: { desktop: 5, tablet: 3, mobile: 2 } } });
  assert.deepEqual(authored.content.perView, { desktop: 5, tablet: 3, mobile: 2 });
});

test('directory carousel query is bounded and only sends seed for random order', () => {
  const start = source.indexOf('export function buildDirectoryCarouselQuery(');
  const end = source.indexOf('\n}\n\n// Directory carousel indicator helper.', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const buildQuery = new Function(
    'resolveDirectoryCarouselOrganisationNameDisplay',
    `${source.slice(start, end + 2).replace('export function', 'function')}; return buildDirectoryCarouselQuery;`,
  )(resolveDirectoryCarouselOrganisationNameDisplay);

  const normal = buildQuery({ directorySlug: 'orgs', tenant: 'association', page: 1, limit: 3 });
  assert.equal(normal.get('mode'), 'carousel');
  assert.equal(normal.get('slug'), 'orgs');
  assert.equal(normal.get('tenant'), 'association');
  assert.equal(normal.get('page'), '1');
  assert.equal(normal.get('limit'), '3');
  assert.equal(normal.has('seed'), false);
  assert.equal(normal.get('organization_name_display'), 'inherit');
  for (const mode of ['inherit', 'show', 'hide']) {
    assert.equal(buildQuery({ organisationNameDisplay: mode }).get('organization_name_display'), mode);
  }
  assert.equal(buildQuery({ organisationNameDisplay: 'invalid' }).get('organization_name_display'), 'inherit');

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

test('directory carousel inspector uses complete searchable source discovery and shared geometry', () => {
  const inspectorStart = source.indexOf('function DirectoryCarouselInspector(');
  const inspectorEnd = source.indexOf('\n// ============================================================================\n// SHOWCASE CARD SETTINGS', inspectorStart);
  const inspector = source.slice(inspectorStart, inspectorEnd);
  assert.match(inspector, /DirectoryCarouselSourceField/);
  assert.match(inspector, /setBlockBp/);
  assert.match(inspector, /setBlockContentFullBleed/);
  assert.match(inspector, /toggle-directory-carousel-randomise-order/);
});

test('directory carousel supports explicit source queries without stale legacy parameters', () => {
  const start = source.indexOf('export function buildDirectoryCarouselQuery(');
  const end = source.indexOf('\n}\n\n// Directory carousel indicator helper.', start);
  const buildQuery = new Function('resolveDirectoryCarouselOrganisationNameDisplay', `${source.slice(start, end + 2).replace('export function', 'function')}; return buildDirectoryCarouselQuery;`)(resolveDirectoryCarouselOrganisationNameDisplay);
  for (const kind of ['primary-member', 'primary-organization']) {
    const query = buildQuery({ source: kind, directorySlug: 'old', directoryId: 'old' });
    assert.equal(query.get('source'), kind);
    assert.equal(query.has('directory_id'), false);
    assert.equal(query.has('slug'), false);
  }
  const dynamic = buildQuery({ source: 'dynamic', directoryId: 'immutable-id', directorySlug: 'old-slug' });
  assert.equal(dynamic.get('directory_id'), 'immutable-id');
  assert.equal(dynamic.has('slug'), false);
});

test('directory carousel query isolates viewer and disables unauthorized retry loops', () => {
  const hook = source.slice(source.indexOf('function useDirectoryCarouselRecords('), source.indexOf('function DirectoryPickerField('));
  assert.match(hook, /viewerIdentity \|\| ''/);
  assert.match(hook, /directoryId \|\| directorySlug/);
  assert.match(hook, /retry: false/);
  assert.match(hook, /refetchOnWindowFocus: false/);
  assert.match(hook, /visitIdentity \|\| ''/);
  assert.match(hook, /resolveDirectoryCarouselOrganisationNameDisplay\(organisationNameDisplay\)/);
  assert.match(hook, /placeholderData: \(\) => undefined/);
});