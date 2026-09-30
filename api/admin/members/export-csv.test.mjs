import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildCustomFieldHeaders,
  formatCustomFieldValueForCsv,
  formatMemberCoreValueForCsv,
  loadMemberPreferenceValuesForCsv,
  MEMBER_CSV_CORE_FIELDS,
} from './export-csv.js';
import { escapeCsvCell } from '../../_lib/csvCell.js';

const source = fs.readFileSync(new URL('./export-csv.js', import.meta.url), 'utf8');

test('member CSV formats boolean and checkbox custom fields like member details', () => {
  for (const fieldType of ['boolean', 'checkbox']) {
    const field = { field_type: fieldType };
    assert.equal(formatCustomFieldValueForCsv(true, field), 'Yes');
    assert.equal(formatCustomFieldValueForCsv('true', field), 'Yes');
    assert.equal(formatCustomFieldValueForCsv(false, field), 'No');
    assert.equal(formatCustomFieldValueForCsv('false', field), 'No');
    assert.equal(formatCustomFieldValueForCsv(undefined, field), '');
    assert.equal(formatCustomFieldValueForCsv(null, field), '');
  }
});

test('member CSV preserves existing non-option custom-field formatting', () => {
  assert.equal(formatCustomFieldValueForCsv(undefined, { field_type: 'text' }), '');
  assert.equal(formatCustomFieldValueForCsv('hello', { field_type: 'text' }), 'hello');
  assert.equal(formatCustomFieldValueForCsv('["A","B"]', { field_type: 'text' }), '["A","B"]');
  assert.equal(
    formatCustomFieldValueForCsv({ url: 'https://example.test/a,b', name: 'Résumé “final”.pdf' }, { field_type: 'file' }),
    '{"name":"Résumé “final”.pdf","url":"https://example.test/a,b"}',
  );
});

test('member CSV exports only stored option values across supported single-select shapes', () => {
  for (const fieldType of ['picklist', 'dropdown', 'list']) {
    const field = {
      field_type: fieldType,
      options: [
        { value: 'retired-dd', label: 'Retired Membership DD' },
        { value: 'same', label: 'same' },
      ],
    };
    assert.equal(formatCustomFieldValueForCsv('retired-dd', field), 'retired-dd');
    assert.equal(formatCustomFieldValueForCsv({ label: 'Retired Membership DD', value: 'retired-dd' }, field), 'retired-dd');
    assert.equal(formatCustomFieldValueForCsv('{"label":"Retired Membership DD","value":"retired-dd"}', field), 'retired-dd');
    assert.equal(formatCustomFieldValueForCsv({ label: 'same', value: 'same' }, field), 'same');
    assert.equal(formatCustomFieldValueForCsv(7, field), '7');
    assert.equal(formatCustomFieldValueForCsv({ value: 7 }, field), '7');
    assert.equal(formatCustomFieldValueForCsv('unknown-option', field), 'unknown-option');
    assert.equal(formatCustomFieldValueForCsv('', field), '');
    assert.equal(formatCustomFieldValueForCsv(null, field), '');
  }
});

test('member CSV exports multi-select option values as a stable human-usable list', () => {
  const field = { field_type: 'list' };
  assert.equal(
    formatCustomFieldValueForCsv([
      { label: 'Alpha label', value: 'alpha' },
      'beta',
      { label: 'Unknown label', value: 'unknown' },
    ], field),
    'alpha; beta; unknown',
  );
  assert.equal(
    formatCustomFieldValueForCsv('[{"label":"Alpha label","value":"alpha"},{"value":2},"unknown"]', field),
    'alpha; 2; unknown',
  );
});

test('member CSV custom headers are deterministic, nonblank, and unique', () => {
  assert.deepEqual(buildCustomFieldHeaders([
    { id: 'b', name: 'region_b', label: 'Region' },
    { id: 'a', name: 'region_a', label: 'Region' },
    { id: 'c', name: 'notes', label: '  ' },
    { id: 'd', name: 'email', label: 'email' },
    { id: 'e', name: 'region_a', label: 'Region' },
  ]), [
    'Region [region_b:b]',
    'Region [region_a:a]',
    'notes',
    'email [email:d]',
    'Region [region_a:e]',
  ]);
});

test('member CSV core contract covers user-facing profile, references, guest and communication fields', () => {
  const headers = MEMBER_CSV_CORE_FIELDS.map(field => field.header);
  for (const header of [
    'member_id', 'profile_photo_url', 'profile_image_url', 'linkedin_url',
    'organisation_id', 'organisation_name', 'department_ids', 'department_names',
    'organisation_group_id', 'organisation_group_name', 'role_id', 'role_name',
    'is_guest', 'guest_expires_at', 'communications_opted_out_all', 'tags',
    'membership_paused', 'membership_pause_restart_date', 'membership_paused_by_member_id',
    'membership_pause_reason', 'engagement_opening_balances',
  ]) assert.ok(headers.includes(header), `missing ${header}`);
  assert.equal(new Set(headers).size, headers.length);
});

test('representative audited member core values preserve blanks, IDs, names, booleans and multi-values', () => {
  const member = {
    id: 'bb718ddb-e3f8-4e1c-8ccc-bc5511d99bb4',
    first_name: 'Bob', last_name: 'Ardley', email: 'bob@example.test',
    organization_id: null, organization: null,
    organization_group_id: 'group-1', organization_group: { name: 'Retired Members' },
    role_id: null, role: null, departments: [],
    login_enabled: true, show_in_directory: true, is_guest: false,
    guest_expires_at: null, communications_opted_out_all: false,
    tags: ['North, East', 'Café'], membership_paused: false,
    membership_paused_by: 'admin-member-id',
    engagement_opening_balances: { awards: 2, eventsAttended: 7 },
  };
  const values = Object.fromEntries(MEMBER_CSV_CORE_FIELDS.map(field => [
    field.header, formatMemberCoreValueForCsv(member, field),
  ]));
  assert.equal(values.organisation_id, '');
  assert.equal(values.organisation_group_id, 'group-1');
  assert.equal(values.organisation_group_name, 'Retired Members');
  assert.equal(values.role_id, '');
  assert.equal(values.guest_expires_at, '');
  assert.equal(values.is_guest, 'No');
  assert.equal(values.tags, '["North, East","Café"]');
  assert.equal(values.membership_paused_by_member_id, 'admin-member-id');
  assert.equal(values.engagement_opening_balances, '{"awards":2,"eventsAttended":7}');
});

test('CSV escaping remains valid for commas, quotes, line breaks and Unicode', () => {
  // The shared Excel-safe CSV contract intentionally flattens embedded line
  // breaks while preserving the complete text and RFC 4180 quote escaping.
  assert.equal(escapeCsvCell('Café, "quoted"\nnext'), '"Café, ""quoted"" next"');
});

test('member CSV preference pagination uses a stable unique order', () => {
  const calls = [];
  const pages = [
    [
      { id: '1', member_id: 'member-1', field_id: 'direct-debit', value: 'true' },
      { id: '2', member_id: 'member-1', field_id: 'other', value: 'text' },
    ],
    [
      { id: '3', member_id: 'member-2', field_id: 'direct-debit', value: 'false' },
    ],
  ];
  const client = {
    from(table) {
      const call = { table, filters: [], order: null, range: null };
      calls.push(call);
      const chain = {
        select(columns) { call.columns = columns; return chain; },
        in(column, values) { call.filters.push([column, values]); return chain; },
        order(column, options) { call.order = [column, options]; return chain; },
        range(from, to) {
          call.range = [from, to];
          return Promise.resolve({ data: pages[calls.length - 1] || [], error: null });
        },
      };
      return chain;
    },
  };

  return loadMemberPreferenceValuesForCsv(
    client,
    ['member-1', 'member-2'],
    ['direct-debit', 'other'],
    { pageSize: 2 },
  ).then(result => {
    assert.deepEqual(result, {
      'member-1': { 'direct-debit': 'true', other: 'text' },
      'member-2': { 'direct-debit': 'false' },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.range), [[0, 1], [2, 3]]);
    assert.deepEqual(calls.map(call => call.order), [
      ['id', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    assert.deepEqual(calls[0].filters, [
      ['member_id', ['member-1', 'member-2']],
      ['field_id', ['direct-debit', 'other']],
    ]);
  });
});

test('selected and filtered exports share the same custom-field row formatter', () => {
  assert.equal((source.match(/const customValues = customFields\.map/g) || []).length, 1);
  assert.match(source, /return formatCustomFieldValueForCsv\(rawValue, f\)/);
});

test('member pages use a deterministic total order', () => {
  assert.match(source, /\.order\('last_name', \{ ascending: true \}\)\s*\.order\('first_name', \{ ascending: true \}\)\s*\.order\('id', \{ ascending: true \}\)/);
});
