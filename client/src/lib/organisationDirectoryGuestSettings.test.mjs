import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  ORGANISATION_DIRECTORY_GUEST_DEFAULTS,
  normalizeOrganisationDirectoryGuestLink,
  saveOrganisationDirectoryGuestSettings,
} from './organisationDirectoryGuestSettings.js';

test('normalizes safe guest links', () => {
  assert.equal(normalizeOrganisationDirectoryGuestLink('  /membership/join?from=directory#form  '), '/membership/join?from=directory#form');
  assert.equal(normalizeOrganisationDirectoryGuestLink(' https://example.org/join '), 'https://example.org/join');
  assert.equal(normalizeOrganisationDirectoryGuestLink('http://example.org:8080/join'), 'http://example.org:8080/join');
  assert.equal(normalizeOrganisationDirectoryGuestLink(' \n\t '), '');
});

test('rejects unsafe or malformed guest links', () => {
  const invalidLinks = [
    null,
    undefined,
    42,
    'join',
    '//example.org/join',
    '\\\\example.org\\join',
    '/join\\admin',
    'javascript:alert(1)',
    'mailto:hello@example.org',
    'https://user:password@example.org/join',
    'https://example.org/\njoin',
    'https://',
    'https:///example.org',
    'https://?example.org',
    'https://example.org/%zz',
  ];

  for (const link of invalidLinks) {
    assert.equal(normalizeOrganisationDirectoryGuestLink(link), null, String(link));
  }
});

test('public settings expose only the new guest presentation key and remain tenant scoped', async () => {
  const source = await readFile(new URL('../../../api/public/system-settings.js', import.meta.url), 'utf8');
  const whitelist = source.match(/const PUBLIC_SETTINGS_WHITELIST = \[([\s\S]*?)\];/)[1];
  assert.match(whitelist, /'org_directory_guest_join_link'/);
  assert.doesNotMatch(whitelist, /org_directory_guest_join_action_id/);
  assert.doesNotMatch(whitelist, /org_directory_(?:view_members|reverse_card)_role_ids/);
  assert.match(source, /\.eq\('tenant_id', tenant.id\)/);
});

test('persists guest introduction by updating existing rows and creating missing rows', async () => {
  const updates = [];
  const creates = [];
  const entity = {
    update: async (id, patch) => updates.push({ id, patch }),
    create: async (body) => creates.push(body),
  };

  await saveOrganisationDirectoryGuestSettings({
    entity,
    existingSettings: {
      heading: { id: 'heading-row' },
      description: null,
      joinLink: { id: 'link-row' },
    },
    heading: '  Explore the Nuclear Medicine Department Directory  ',
    description: '  Find departments and their contact details.  ',
    joinLink: '  /join  ',
  });

  assert.deepEqual(updates, [
    {
      id: 'heading-row',
      patch: { setting_value: 'Explore the Nuclear Medicine Department Directory' },
    },
    { id: 'link-row', patch: { setting_value: '/join' } },
  ]);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].setting_key, 'org_directory_guest_description');
  assert.equal(creates[0].setting_value, 'Find departments and their contact details.');
});

test('persists neutral text fallbacks and an empty join link', async () => {
  const creates = [];
  const entity = {
    update: async () => assert.fail('no existing rows should be updated'),
    create: async (body) => creates.push(body),
  };

  await saveOrganisationDirectoryGuestSettings({
    entity,
    existingSettings: { heading: null, description: null, joinLink: null },
    heading: ' ',
    description: '',
    joinLink: '',
  });

  assert.deepEqual(
    creates.map(({ setting_key, setting_value }) => [setting_key, setting_value]),
    [
      ['org_directory_guest_heading', ORGANISATION_DIRECTORY_GUEST_DEFAULTS.heading],
      ['org_directory_guest_description', ORGANISATION_DIRECTORY_GUEST_DEFAULTS.description],
      ['org_directory_guest_join_link', ''],
    ]
  );
});

test('validates the join link before writing any settings', async () => {
  let writes = 0;
  const entity = {
    update: async () => { writes += 1; },
    create: async () => { writes += 1; },
  };

  await assert.rejects(
    saveOrganisationDirectoryGuestSettings({
      entity,
      existingSettings: { heading: { id: 'heading-row' }, description: null, joinLink: null },
      heading: 'Directory',
      description: 'Description',
      joinLink: 'javascript:alert(1)',
    }),
    /root-relative path or an http\(s\) URL/
  );
  assert.equal(writes, 0);
});