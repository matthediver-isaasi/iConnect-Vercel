import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectOrganisationDirectoryCsv, countOrganisationDirectoryCsvRows,
  organisationDirectoryCsvSourceExpands, formatOrganisationDirectoryCsvValue,
} from './organisationDirectoryCsv.js';

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
  assert.match(csv, /^\ufeffOrganisation,Number of members,Membership type,Proof,Project: Status\r\n/);
  assert.match(csv, /'=Formula Org,2,Associate,File,Live/);
  assert.doesNotMatch(csv, /Ada|Grace|contacts list/);
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
  assert.match(csv, /^﻿Logo,Organisation,Detail,Detail \(2\),Detail \(2\) \(2\),Number of members\r\n/);
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
  assert.match(csv, /^\ufeffLogo,Number of members\r\nhttps:\/\/cdn\.example\.test\/logo\.svg,0\r\nLogo available,0\r\nLogo available,0$/);
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
  assert.equal(csv, '\ufeffOrganisation,Number of members\r\nOne,0');
});

test('expansion interprets every cardinality from the organisation endpoint', () => {
  for (const direction of ['source', 'target']) {
    for (const cardinality of ['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']) {
      assert.equal(organisationDirectoryCsvSourceExpands({
        _kind: 'object', _source: { direction, cardinality },
      }), cardinality === 'many_to_many'
        || (direction === 'source' && cardinality === 'one_to_many')
        || (direction === 'target' && cardinality === 'many_to_one'));
    }
  }
  assert.equal(organisationDirectoryCsvSourceExpands({ _kind: 'custom', multi_select: true }), false);
});

test('additive rows align by record identity, dedupe edges, repeat single sources and omit identities', () => {
  const field = (key, relationship_id, cardinality = 'one_to_many') => ({
    key, label: key, _kind: 'object',
    _source: { relationship_id, direction: 'source', object_id: relationship_id, cardinality },
  });
  const entry = (recordId, value, label = 'Identical record label') => ({ recordId, value, label });
  const input = {
    organizations: [{ id: 'org', name: 'One' }, { id: 'empty', name: 'Empty' }],
    fields: [field('Dept', 'a'), field('Code', 'a'), field('Office', 'b'),
      field('Single', 'c', 'one_to_one'), { key: 'org_members_list', _kind: 'core' }],
    preferences: new Map(),
    objectValues: new Map([
      ['Dept', new Map([['org', [entry('d2', 'Same'), entry('d1', 'Same'), entry('d1', 'Same')]]])],
      ['Code', new Map([['org', [entry('d1', ''), entry('d2', 'Code two')]]])],
      ['Office', new Map([['org', [entry('o3', 'Third'), entry('o1', 'First'), entry('o2', 'Second')]]])],
      ['Single', new Map([['org', [entry('s1', 'Shared')]]])],
    ]),
    memberValues: {
      counts: new Map([['org', 9], ['empty', 4]]),
      recordCounts: new Map([['org:a:d1', 2], ['org:a:d2', 0]]),
      names: new Map([['org', ['SECRET NAME']]]),
    },
    includeMembersList: true,
  };
  const csv = projectOrganisationDirectoryCsv(input);
  assert.deepEqual(csv.split('\r\n'), [
    '\ufeffOrganisation,Dept,Code,Office,Single,Number of members',
    'One,Same,,,Shared,2',
    'One,Same,Code two,,Shared,0',
    'One,,,First,Shared,',
    'One,,,Second,Shared,',
    'One,,,Third,Shared,',
    'Empty,,,,,4',
  ]);
  assert.doesNotMatch(csv, /SECRET|d1|d2|o1|org/);
  assert.equal(countOrganisationDirectoryCsvRows(input), 6);
  assert.throws(() => projectOrganisationDirectoryCsv({ ...input, maxRows: 5 }), /row limit/);
});

test('one related entry and all-blank record fields still retain their row', () => {
  const input = {
    organizations: [{ id: 'org', name: 'One' }],
    fields: [{ key: 'blank', label: 'Blank', _kind: 'object',
      _source: { relationship_id: 'r', direction: 'target', object_id: 'obj', cardinality: 'many_to_one' } }],
    preferences: new Map(),
    objectValues: new Map([['blank', new Map([['org', [{ recordId: 'record', value: '', label: 'Nonempty label' }]]])]]),
    memberValues: { counts: new Map([['org', 8]]), recordCounts: new Map([['org:obj:record', 0]]) },
  };
  assert.equal(projectOrganisationDirectoryCsv(input), '\ufeffOrganisation,Blank,Number of members\r\nOne,,0');
});

test('department fields export formatted values only for multi- and single-valued sources', () => {
  for (const cardinality of ['one_to_many', 'one_to_one']) {
    const specs = [
      ['Name', 'text', 'Radiology based Nuclear Medicine', 'Radiology based Nuclear Medicine'],
      ['Address line 1', 'text', 'Pield Heath Road', 'Pield Heath Road'],
      ['Notes', 'text', 'Hours: 09:00', 'Hours: 09:00'],
      ['Blank', 'text', '', ''],
      ['Option', 'dropdown', 'a', 'Associate'],
      ['Active', 'boolean', true, 'Yes'],
      ['Inactive', 'boolean', false, 'No'],
      ['Country', 'country', 'GB', 'United Kingdom'],
      ['Attachment', 'file', '{"storage_path":"private/secret.pdf"}', 'File'],
    ];
    const fields = specs.map(([name, field_type]) => ({
      key: name, label: `Organisation department: ${name} (Departments)`,
      field_type, options: [{ value: 'a', label: 'Associate' }], _kind: 'object',
      _source: { relationship_id: 'r', direction: 'source', object_id: 'dept', cardinality },
    }));
    const csv = projectOrganisationDirectoryCsv({
      organizations: [{ id: 'org', name: 'Synthetic Hospital' }],
      fields, preferences: new Map(),
      objectValues: new Map(fields.map((field, index) => [field.key, new Map([['org', [{
        recordId: 'dept-1', label: 'Radiology based Nuclear Medicine',
        value: formatOrganisationDirectoryCsvValue(specs[index][2], field),
      }]]])])),
      memberValues: { counts: new Map([['org', 2]]), recordCounts: new Map([['org:dept:dept-1', 2]]) },
    });
    assert.equal(csv, '\ufeffOrganisation,' + fields.map(f => f.label).join(',')
      + ',Number of members\r\nSynthetic Hospital,' + specs.map(s => s[3]).join(',') + ',2');
    assert.doesNotMatch(csv, /private|secret\.pdf/);
  }
});

test('value-only object cells retain CSV formula protection, quotes and newline flattening', () => {
  const cases = [
    ['=1+1', "'=1+1"], ['+1', "'+1"], ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"], ['\tformula', "'\tformula"],
    ['Unit: "A", floor 2\r\nNext line\nLast', '"Unit: ""A"", floor 2 Next line Last"'],
  ];
  for (const [value, escaped] of cases) {
    const csv = projectOrganisationDirectoryCsv({
      organizations: [{ id: 'org', name: 'One' }],
      fields: [{ key: 'object', label: 'Detail', _kind: 'object' }],
      preferences: new Map(),
      objectValues: new Map([['object', new Map([['org', [{ label: 'Record name', value }]]])]]),
      memberValues: { counts: new Map() },
    });
    assert.equal(csv, `\ufeffOrganisation,Detail,Number of members\r\nOne,${escaped},0`);
  }
});