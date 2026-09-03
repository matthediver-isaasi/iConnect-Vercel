import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import PortalNavLink from '../components/navigation/PortalNavLink.jsx';
import {
  getPortalMenuFallbackFeatureId,
  getPortalMenuLinkType,
  isPortalMenuDestinationActive,
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
});

test('gallery directory is registered and classified as a hybrid route', () => {
  const pageRegistry = readFileSync(path.join(here, '../pages/index.jsx'), 'utf8');
  const layout = readFileSync(path.join(here, '../pages/Layout.jsx'), 'utf8');
  assert.match(pageRegistry, /GalleryDirectory:\s*GalleryDirectory/);
  assert.match(pageRegistry, /<Route path="\/galleries" element=\{<GalleryDirectory \/>}/);
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