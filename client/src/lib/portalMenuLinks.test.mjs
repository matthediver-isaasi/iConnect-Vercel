import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import PortalNavLink from '../components/navigation/PortalNavLink.jsx';
import { createPageUrl } from '../utils/index.ts';
import {
  getCustomObjectIdFromPortalListUrl,
  getCustomObjectIdFromPortalPath,
  getCustomObjectIdFromPortalRoleAccessId,
  getCustomObjectPortalListUrl,
  getCustomObjectPortalRoleAccessId,
  getPortalMenuFallbackFeatureId,
  getPortalMenuLinkType,
  isPortalMenuDestinationActive,
  loadViewableCustomObjectPortalDestinations,
  resolvePortalMenuDestination,
  validateExternalPortalUrl,
  validatePortalMenuDestination,
} from './portalMenuLinks.js';

const createInternalUrl = (url) => `/${String(url).replace(/^\/+/, '')}`;
const here = path.dirname(fileURLToPath(import.meta.url));

test('legacy portal menu records remain internal current-tab links', () => {
  const legacy = { title: 'Events', url: 'Events' };
  assert.equal(getPortalMenuLinkType(legacy), 'internal');
  assert.deepEqual(resolvePortalMenuDestination(legacy, createInternalUrl), {
    url: '/Events',
    isExternal: false,
    isValid: true,
    error: '',
    openInNewTab: false,
    target: undefined,
    rel: undefined,
  });
  assert.equal(isPortalMenuDestinationActive(
    resolvePortalMenuDestination(legacy, createInternalUrl),
    '/Events',
  ), true);
});

test('Custom Object destinations have stable object-aware URLs and access identifiers', () => {
  const objectId = '11111111-1111-4111-8111-111111111111';
  assert.equal(
    getCustomObjectPortalListUrl(objectId),
    `CustomObjectsAdmin/${objectId}/records`,
  );
  assert.equal(
    getCustomObjectIdFromPortalListUrl(`/CustomObjectsAdmin/${objectId}/records/`),
    objectId,
  );
  assert.equal(
    getCustomObjectIdFromPortalListUrl(`/CustomObjectsAdmin/${objectId}/records/record-1`),
    null,
  );
  const featureId = getCustomObjectPortalRoleAccessId(objectId);
  assert.equal(featureId, `custom-object:${objectId}:view-records`);
  assert.equal(getCustomObjectIdFromPortalRoleAccessId(featureId), objectId);
  assert.equal(getCustomObjectIdFromPortalRoleAccessId('page_Events'), null);
});

test('Custom Object portal paths resolve list, create, detail, and edit routes only', () => {
  const objectId = 'object / with spaces';
  const listUrl = getCustomObjectPortalListUrl(objectId);
  assert.equal(getCustomObjectIdFromPortalPath(listUrl), objectId);
  assert.equal(getCustomObjectIdFromPortalPath(`/${listUrl}/new`), objectId);
  assert.equal(getCustomObjectIdFromPortalPath(`/${listUrl}/record-1`), objectId);
  assert.equal(getCustomObjectIdFromPortalPath(`/${listUrl}/record-1/edit`), objectId);
  assert.equal(getCustomObjectIdFromPortalPath('/CustomObjectsAdmin/object-1'), null);
  assert.equal(getCustomObjectIdFromPortalPath('/CustomObjectsAdmin'), null);
});

test('internal list destinations stay active on object record sub-routes', () => {
  const destination = resolvePortalMenuDestination({
    url: 'CustomObjectsAdmin/object-1/records',
  }, createInternalUrl);
  assert.equal(
    isPortalMenuDestinationActive(destination, '/CustomObjectsAdmin/object-1/records'),
    true,
  );
  assert.equal(
    isPortalMenuDestinationActive(destination, '/CustomObjectsAdmin/object-1/records/record-2/edit'),
    true,
  );
  assert.equal(
    isPortalMenuDestinationActive(destination, '/CustomObjectsAdmin/object-10/records'),
    false,
  );
});

test('Custom Object destination catalogue keeps only active viewable objects and paginates', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url, 'https://portal.test').searchParams.get('page'));
    const rows = page === 1
      ? [{
          id: 'object-1',
          status: 'active',
          plural_label: 'Projects',
          capabilities: { view: true },
        }, {
          id: 'object-2',
          status: 'active',
          plural_label: 'Private',
          capabilities: { view: false },
        }]
      : [{
          id: 'object-3',
          status: 'active',
          singular_label: 'Supplier',
          capabilities: { view: true },
        }];
    return {
      ok: true,
      json: async () => ({ data: rows, total: 3 }),
    };
  };

  assert.deepEqual(await loadViewableCustomObjectPortalDestinations(fetchImpl), [{
    objectId: 'object-1',
    value: 'CustomObjectsAdmin/object-1/records',
    label: 'Custom Object: Projects',
    featureId: 'custom-object:object-1:view-records',
  }, {
    objectId: 'object-3',
    value: 'CustomObjectsAdmin/object-3/records',
    label: 'Custom Object: Supplier',
    featureId: 'custom-object:object-3:view-records',
  }]);
  assert.equal(calls.length, 2);
});

test('external URLs accept complete HTTP(S) addresses', () => {
  assert.equal(validateExternalPortalUrl('https://www.example.com/path?q=1').isValid, true);
  assert.equal(validateExternalPortalUrl('http://example.com').isValid, true);
});

test('external URLs reject missing, relative, malformed, and unsafe destinations', () => {
  for (const value of ['', '/events', 'example.com', 'https://', 'mailto:test@example.com', 'javascript:alert(1)']) {
    const result = validateExternalPortalUrl(value);
    assert.equal(result.isValid, false, `${value || '(empty)'} should be rejected`);
    assert.ok(result.error);
  }
});

test('same-tab external links preserve the absolute URL without target attributes', () => {
  const destination = resolvePortalMenuDestination({
    link_type: 'external',
    url: 'https://www.example.com/resources',
    open_in_new_tab: false,
  }, createInternalUrl);

  assert.equal(destination.url, 'https://www.example.com/resources');
  assert.equal(destination.isExternal, true);
  assert.equal(destination.target, undefined);
  assert.equal(destination.rel, undefined);
  assert.equal(isPortalMenuDestinationActive(destination, 'https://www.example.com/resources'), false);
});

test('new-tab external links receive safe browser attributes', () => {
  const destination = resolvePortalMenuDestination({
    link_type: 'external',
    url: 'https://www.example.com',
    open_in_new_tab: true,
  }, createInternalUrl);

  assert.equal(destination.target, '_blank');
  assert.equal(destination.rel, 'noopener noreferrer');
});

test('external destinations render as native anchors with safe new-tab attributes', () => {
  const destination = resolvePortalMenuDestination({
    link_type: 'external',
    url: 'https://www.example.com/resources',
    open_in_new_tab: true,
  });
  const html = renderToStaticMarkup(React.createElement(
    PortalNavLink,
    { destination, className: 'nav-link' },
    'Resources',
  ));

  assert.match(html, /^<a /);
  assert.match(html, /href="https:\/\/www\.example\.com\/resources"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('same-tab external anchors omit target and rel', () => {
  const destination = resolvePortalMenuDestination({
    link_type: 'external',
    url: 'https://www.example.com/resources',
    open_in_new_tab: false,
  });
  const html = renderToStaticMarkup(React.createElement(PortalNavLink, { destination }, 'Resources'));

  assert.match(html, /^<a /);
  assert.doesNotMatch(html, /target=/);
  assert.doesNotMatch(html, /rel=/);
});

test('top-level and child external menu records use identical link resolution', () => {
  const topLevel = {
    id: 'top',
    parent_id: '',
    link_type: 'external',
    url: 'https://top.example.com/landing',
  };
  const child = {
    id: 'child',
    parent_id: 'top',
    link_type: 'external',
    url: 'https://child.example.com/landing',
  };

  assert.equal(resolvePortalMenuDestination(topLevel, createInternalUrl).url, topLevel.url);
  assert.equal(resolvePortalMenuDestination(child, createInternalUrl).url, child.url);
  assert.equal(resolvePortalMenuDestination(topLevel, createInternalUrl).isExternal, true);
  assert.equal(resolvePortalMenuDestination(child, createInternalUrl).isExternal, true);
});

test('structural parents cannot be converted to external destinations', () => {
  const result = validatePortalMenuDestination({
    link_type: 'external',
    url: 'https://www.example.com',
  }, { hasChildren: true });

  assert.equal(result.isValid, false);
  assert.match(result.error, /sub-items must remain internal parent menus/i);
  assert.equal(validatePortalMenuDestination({
    link_type: 'external',
    url: 'https://www.example.com',
  }, { hasChildren: false }).isValid, true);
});

test('external permission fallback is stable and title-based', () => {
  const common = {
    section: 'admin',
    title: 'Partner Resources',
    link_type: 'external',
  };
  assert.equal(
    getPortalMenuFallbackFeatureId({ ...common, url: 'https://one.example.com' }),
    'page_admin_PartnerResources',
  );
  assert.equal(
    getPortalMenuFallbackFeatureId({ ...common, url: 'https://two.example.com' }),
    'page_admin_PartnerResources',
  );
});

test('gallery directory is available as a built-in portal destination', () => {
  const source = readFileSync(path.join(here, '../pages/PortalMenuManagement.jsx'), 'utf8');
  assert.match(
    source,
    /\{\s*value:\s*"GalleryDirectory",\s*label:\s*"Gallery Directory"\s*\}/,
  );
  assert.equal(createPageUrl('GalleryDirectory'), '/GalleryDirectory');
});

test('gallery directory is registered and classified as a hybrid route', () => {
  const pageRegistry = readFileSync(path.join(here, '../pages/index.jsx'), 'utf8');
  const layout = readFileSync(path.join(here, '../pages/Layout.jsx'), 'utf8');
  assert.match(pageRegistry, /GalleryDirectory:\s*GalleryDirectory/);
  assert.match(pageRegistry, /<Route path="\/galleries" element=\{<GalleryDirectory \/>}/);
  assert.match(pageRegistry, /<Route path="\/GalleryDirectory" element=\{<GalleryDirectory \/>}/);
  assert.ok(
    pageRegistry.indexOf('<Route path="/GalleryDirectory" element={<GalleryDirectory />} />')
      < pageRegistry.indexOf('<Route path="/:slug" element={<DynamicPage />} />'),
    'the saved portal destination must be registered before the dynamic page fallback',
  );
  assert.match(layout, /hybridPages = \[[^\]]*"GalleryDirectory"/);
  assert.match(layout, /'GalleryDirectory': 'content\.gallery\.directory'/);
});

test('every portal sidebar leaf renderer uses the shared destination-aware link', () => {
  const layoutSource = readFileSync(path.join(here, '../pages/Layout.jsx'), 'utf8');
  const topLevelUses = layoutSource.match(/<PortalNavLink\s+[^>]*destination=\{item\}/g) || [];
  const childUses = layoutSource.match(/<PortalNavLink\s+[^>]*destination=\{subItem\}/g) || [];

  assert.equal(topLevelUses.length, 4, 'desktop/mobile user/admin top-level leaves must use PortalNavLink');
  assert.equal(childUses.length, 4, 'expanded/collapsed/mobile user/admin children must use PortalNavLink');
  assert.doesNotMatch(layoutSource, /<Link[\s\S]{0,160}to=\{(?:item|subItem)\.url\}/);
});