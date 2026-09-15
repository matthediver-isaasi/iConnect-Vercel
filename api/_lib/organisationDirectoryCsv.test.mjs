import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOrganisationDirectoryCsv } from './organisationDirectoryCsv.js';

test('directory CSV projects renderer values and never serializes file descriptors', () => {
  const csv = projectOrganisationDirectoryCsv({
    organizations: [{ id: 'org-1', name: '=Formula Org' }],
    fields: [
      { key: 'org_member_count', label: 'Member count', _kind: 'core' },
      { key: 'org_members_list', label: 'Members / contacts list', _kind: 'core' },
      {
        key: 'custom:one', label: 'Membership type', field_type: 'dropdown', _kind: 'custom',
        _field: { id: 'one' }, options: [{ value: 'a', label: 'Associate' }],
      },
      {
        key: 'custom:file', label: 'Proof', field_type: 'file', _kind: 'custom',
        _field: { id: 'file' },
      },
      { key: 'object:one', label: 'Project: Status', field_type: 'text', _kind: 'object' },
    ],
    preferences: new Map([
      ['org-1:one', ['a']],
      ['org-1:file', [JSON.stringify({
        storage_path: 'tenant/private/secret.pdf', bucket: 'private-uploads', signed_url: 'nope',
      })]],
    ]),
    objectValues: new Map([['object:one', new Map([['org-1', [{ label: 'Project One', value: 'Live' }]]])]]),
    memberValues: {
      counts: new Map([['org-1', 2]]),
      names: new Map([['org-1', ['Ada Lovelace', 'Grace Hopper']]]),
    },
    includeMembersList: true,
  });
  assert.match(csv, /^\ufeffOrganisation,Member count,Members \/ contacts list,Membership type,Proof,Project: Status\r\n/);
  assert.match(csv, /'=Formula Org,2,Ada Lovelace; Grace Hopper,Associate,File,Project One: Live/);
  assert.doesNotMatch(csv, /storage_path|private-uploads|secret\.pdf|signed_url/);
});

test('directory CSV includes safe front-card logo and disambiguates duplicate labels', () => {
  const csv = projectOrganisationDirectoryCsv({
    organizations: [{
      id: 'org-1', name: 'One', logo_url: JSON.stringify({
        file_url: 'https://cdn.example.test/logo.png', storage_path: 'private/hidden',
      }),
    }],
    fields: [
      { key: 'custom:one', label: 'Detail', field_type: 'text', _kind: 'custom', _field: { id: 'one' } },
      { key: 'custom:two', label: 'Detail', field_type: 'text', _kind: 'custom', _field: { id: 'two' } },
      { key: 'custom:three', label: 'Detail (2)', field_type: 'text', _kind: 'custom', _field: { id: 'three' } },
    ],
    preferences: new Map([
      ['org-1:one', ['A']], ['org-1:two', ['B']], ['org-1:three', ['C']],
    ]),
    objectValues: new Map(),
    memberValues: { counts: new Map(), names: new Map() },
    includeLogo: true,
  });
  assert.match(csv, /^﻿Logo,Organisation,Detail,Detail \(2\),Detail \(2\) \(2\)\r\n/);
  assert.match(csv, /Logo available,One,A,B,C/);
  assert.doesNotMatch(csv, /storage_path|private\/hidden/);
});

test('only permanent credential-free public logo URLs are exported; title setting can hide title', () => {
  const csv = projectOrganisationDirectoryCsv({
    organizations: [
      { id: 'permanent', name: 'Shown nowhere', logo_url: 'https://cdn.example.test/logo.svg' },
      { id: 'signed', name: 'Hidden', logo_url: 'https://storage.example.test/logo.svg?token=private' },
      { id: 'creds', name: 'Hidden', logo_url: 'https://user:secret@example.test/logo.svg' },
    ],
    fields: [],
    preferences: new Map(),
    objectValues: new Map(),
    memberValues: { counts: new Map(), names: new Map() },
    includeLogo: true,
    includeOrganisation: false,
  });
  assert.match(csv, /^\ufeffLogo\r\nhttps:\/\/cdn\.example\.test\/logo\.svg\r\nLogo available\r\nLogo available$/);
  assert.doesNotMatch(csv, /token=private|user:secret/);
});

test('directory CSV omits contacts when no reverse-card role is configured', () => {
  const csv = projectOrganisationDirectoryCsv({
    organizations: [{ id: 'org-1', name: 'One' }],
    fields: [{ key: 'org_members_list', label: 'Members / contacts list', _kind: 'core' }],
    preferences: new Map(),
    objectValues: new Map(),
    memberValues: { counts: new Map(), names: new Map() },
    includeMembersList: false,
  });
  assert.equal(csv, '\ufeffOrganisation\r\nOne');
});