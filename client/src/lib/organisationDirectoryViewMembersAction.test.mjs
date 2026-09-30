import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { QueryClient } from '@tanstack/react-query';
import {
  parseOrganisationViewMembersRoleIds,
  hasOrganisationViewMembersRoles,
  buildOrganisationDirectoryMembersUrl,
} from './organisationDirectoryMemberContext.js';
import { parseRoleIdArray } from '../../../api/_lib/directoryConfig.js';

const readPage = name => fs.readFileSync(new URL(`../pages/${name}.jsx`, import.meta.url), 'utf8');
const standalone = readPage('OrganisationDirectory');
const dynamic = readPage('DynamicDirectoryView');
const admin = readPage('OrganisationDirectorySettings');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute the actual page query bodies so a same-key producer omitting the
// policy fails this regression, rather than testing a parallel mock projection.
function queryOptions(source, rows) {
  const body = source.match(/queryKey: \['organisation-directory-settings'\],\s*queryFn: async \(\) => \{([\s\S]*?)\n    \},/);
  assert.ok(body);
  const run = new AsyncFunction('base44', 'parseOrganisationViewMembersRoleIds', body[1]);
  return {
    queryKey: ['organisation-directory-settings'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => run({ entities: { SystemSettings: { list: async () => rows() } } }, parseOrganisationViewMembersRoleIds),
  };
}

const footer = standalone.match(/<DialogFooter\b[^>]*>(?:(?!<\/DialogFooter>)[\s\S])*button-view-members[\s\S]*?<\/DialogFooter>/)?.[0];
assert.ok(footer);
const compiled = transformSync(`return (${footer});`, { loader: 'jsx', jsxFactory: 'React.createElement' }).code;
const renderFooter = new Function(
  'React', 'DialogFooter', 'Button', 'Users', 'ExternalLink',
  'displaySettings', 'selectedOrg', 'setSelectedOrg',
  'hasOrganisationViewMembersRoles', 'buildOrganisationDirectoryMembersUrl', 'window',
  compiled,
);
function makeFooter(settings, window = { location: {} }, close = () => {}) {
  return renderFooter(React, 'footer', 'button', 'span', 'span', settings,
    { id: 'org 1' }, close, hasOrganisationViewMembersRoles, buildOrganisationDirectoryMembersUrl, window);
}

test('role parsing matches server validation and both query producers fail closed', async () => {
  for (const value of [undefined, null, '', '{bad', '{}', '"role"', 'null', '[]',
    '[null,4,false,"","  "]', '["member",null," "]', ['member'], { length: 1 }]) {
    const expected = parseRoleIdArray(value);
    assert.deepEqual(parseOrganisationViewMembersRoleIds(value), expected);
    for (const source of [standalone, dynamic]) {
      const settings = await queryOptions(source, () => [
        { setting_key: 'org_directory_view_members_role_ids', setting_value: value },
        { setting_key: 'org_directory_reverse_card_role_ids', setting_value: '["contact"]' },
      ]).queryFn();
      assert.deepEqual(settings.viewMembersRoleIds, expected);
      const html = renderToStaticMarkup(makeFooter(settings));
      assert.equal(html.includes('button-view-members'), expected.length > 0);
      assert.match(html, /Close/);
    }
  }
});

test('pending, missing and malformed cached settings hide only the action', () => {
  for (const settings of [undefined, {}, { reverseCardRoleIds: ['contact'] },
    { viewMembersRoleIds: 'role' }, { viewMembersRoleIds: [null, ' '] }]) {
    const html = renderToStaticMarkup(makeFooter(settings));
    assert.doesNotMatch(html, /button-view-members/);
    assert.match(html, /Close/);
  }
});

test('populated independent roles restore the existing destination with no contact roles', () => {
  const window = { location: {} };
  let closed = false;
  const element = makeFooter({ viewMembersRoleIds: ['member'], reverseCardRoleIds: [] },
    window, () => { closed = true; });
  assert.match(renderToStaticMarkup(element), /button-view-members/);
  const buttons = React.Children.toArray(element.props.children);
  buttons.find(button => button.props['data-testid'] === 'button-view-members').props.onClick();
  assert.equal(window.location.href, '/OrganisationDirectory/members/org%201');
  buttons.find(button => button.props.children === 'Close').props.onClick();
  assert.equal(closed, true);
});

test('dynamic-to-standalone cache navigation and save invalidation preserve role changes', async () => {
  const client = new QueryClient();
  let value = '["member"]';
  const rows = () => [{ setting_key: 'org_directory_view_members_role_ids', setting_value: value }];
  try {
    await client.fetchQuery(queryOptions(dynamic, rows));
    let standaloneFetches = 0;
    const options = queryOptions(standalone, () => { standaloneFetches++; return rows(); });
    assert.equal(hasOrganisationViewMembersRoles(await client.fetchQuery(options)), true);
    assert.equal(standaloneFetches, 0, 'navigation reuses the fresh dynamic cache');
    assert.match(admin, /invalidateQueries\(\{ queryKey: \['organisation-directory-settings'\] \}\)/);
    for (const next of ['[]', '["restored"]']) {
      value = next;
      await client.invalidateQueries({ queryKey: ['organisation-directory-settings'] });
      const settings = await client.fetchQuery(options);
      assert.equal(hasOrganisationViewMembersRoles(settings), next !== '[]');
    }
    assert.equal(standaloneFetches, 2);
    assert.match(admin, /If no roles are selected, the View Members button is hidden/);
  } finally {
    client.clear();
  }
});