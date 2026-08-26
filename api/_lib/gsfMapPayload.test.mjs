import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GSF_MAP_FIELD_IDS,
  buildCountriesPayload,
  buildMembersPayload,
  resolveCountriesOfOperation,
  resolveLmicCountriesOfOperation,
} from './gsfMapPayload.js';

const countriesField = GSF_MAP_FIELD_IDS.countries_of_operation;

function fixture(rawCountries) {
  const org = {
    id: 'org-1',
    zoho_crm_id: '815132000000000001',
    name: 'Fixture Organisation',
    created_at: '2026-01-02T12:00:00.000Z',
    updated_at: '2026-01-03T12:00:00.000Z',
  };
  return {
    supabaseUrl: 'https://example.supabase.co',
    fieldMappings: [
      {
        zoho_field: 'Account_Name',
        iconnect_field: 'name',
      },
      {
        zoho_field: 'Countries_of_Operation',
        iconnect_field: `custom:${countriesField}`,
        iconnect_field_type: 'countries',
        is_multi_pick: true,
        value_map: {
          iconnect_to_zoho: {},
        },
      },
    ],
    memberOrgs: [org],
    prefByOrg: new Map([[org.id, { [countriesField]: rawCountries }]]),
    membersByOrg: new Map(),
    ceoIds: new Set(),
    publishedLogoByOrg: new Map(),
    orgLegacy: {},
    countryLookup: {
      Kenya: { id: 'country-kenya', income_group: 'Lower middle income', region: 'Africa', flag: 'Show' },
      Uganda: { id: 'country-uganda', income_group: 'Low income', region: 'Africa', flag: 'Show' },
      'Democratic Republic of the Congo': {
        id: 'country-drc',
        income_group: 'Low income',
        region: 'Africa',
        flag: 'Show',
      },
    },
    countryRowIds: {
      '815132000000000001|Kenya': { id: 'row-kenya', created_time: '2026-01-02T12:00:00+00:00' },
      '815132000000000001|Uganda': { id: 'row-uganda', created_time: '2026-01-02T12:00:00+00:00' },
      '815132000000000001|Democratic Republic of the Congo': {
        id: 'row-drc',
        created_time: '2026-01-02T12:00:00+00:00',
      },
    },
    lmicCountryCodes: ['KE', 'UG', 'CD', 'CI'],
  };
}

test('canonical country resolver never treats the location summary as a country', () => {
  assert.deepEqual(
    resolveCountriesOfOperation({
      [countriesField]: '["Kenya","Multiple locations","Uganda","Kenya"]',
    }),
    ['Kenya', 'Uganda']
  );
});

test('LMIC country resolver handles aliases and fails closed for unknown or unselected values', () => {
  assert.deepEqual(
    resolveLmicCountriesOfOperation(
      {
        [countriesField]: '["CD","DR Congo","Congo (Democratic Republic)","Iraq","United States","Atlantis"]',
      },
      ['CD', 'IQ']
    ),
    ['Congo (Democratic Republic)', 'Iraq']
  );
  assert.deepEqual(
    resolveLmicCountriesOfOperation(
      { [countriesField]: '["Kenya"]' },
      []
    ),
    []
  );
});

test('members retain the legacy individual-country array and outbound aliases', () => {
  const [member] = buildMembersPayload(
    fixture('["Kenya","Congo (Democratic Republic)","Ivory Coast","Multiple locations"]')
  );
  assert.deepEqual(
    member.Countries_of_Operation,
    ['Kenya', 'Congo, Dem. Rep.', 'Côte d’Ivoire']
  );
  assert.equal(Array.isArray(member.Countries_of_Operation), true);
  assert.equal(member.Countries_of_Operation.includes('Multiple locations'), false);
});

test('countries expand to one exact Zoho-shaped row per individual country', () => {
  const rows = buildCountriesPayload(fixture('["Kenya","Uganda","Multiple locations"]'));
  assert.deepEqual(rows.map((row) => row.id), ['row-kenya', 'row-uganda']);
  assert.deepEqual(rows.map((row) => row.Country.name), ['Kenya', 'Uganda']);
  assert.deepEqual(rows.map((row) => row.Parent_Id), [
    { name: 'Fixture Organisation', id: '815132000000000001' },
    { name: 'Fixture Organisation', id: '815132000000000001' },
  ]);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    '$approval', '$approval_state', '$approved', '$currency_symbol',
    '$editable', '$field_states', '$in_merge', '$layout_id',
    '$orchestration', '$process_flow', '$review', '$review_process', '$state',
    'Country', 'Created_Time', 'Flag', 'GSF_Region_Classification',
    'Income_Group', 'Layout', 'Parent_Id', 'id',
  ].sort());
  assert.deepEqual(rows[0].Country, { name: 'Kenya', id: 'country-kenya' });
  assert.equal(rows.some((row) => row.Country.name === 'Multiple locations'), false);
});

test('member and country payloads preserve their distinct legacy Ivory Coast alias', () => {
  const data = fixture('["Ivory Coast"]');
  data.countryLookup['Côte d’Ivoire'] = {
    id: 'country-ivory-coast',
    income_group: 'Lower middle income',
    region: 'Africa',
    flag: 'Show',
  };
  assert.deepEqual(
    buildMembersPayload(data)[0].Countries_of_Operation,
    ['Côte d’Ivoire']
  );
  assert.deepEqual(
    buildCountriesPayload(data)[0].Country,
    { name: 'Côte d’Ivoire', id: 'country-ivory-coast' }
  );
});

test('single-country input keeps the same array and row contracts', () => {
  const data = fixture('Kenya');
  assert.deepEqual(buildMembersPayload(data)[0].Countries_of_Operation, ['Kenya']);
  assert.equal(buildCountriesPayload(data).length, 1);
});

test('member and country payloads use the same tenant-LMIC filtered set', () => {
  const data = fixture('["Kenya","United States","Atlantis","Uganda"]');
  data.lmicCountryCodes = ['KE'];
  assert.deepEqual(buildMembersPayload(data)[0].Countries_of_Operation, ['Kenya']);
  assert.deepEqual(
    buildCountriesPayload(data).map((row) => row.Country.name),
    ['Kenya']
  );
});

test('equivalent aliases and ISO codes emit one canonical Zoho-compatible country', () => {
  const data = fixture('["CD","DR Congo","Congo, Dem. Rep.","Congo (Democratic Republic)"]');
  data.lmicCountryCodes = ['CD'];

  assert.deepEqual(
    buildMembersPayload(data)[0].Countries_of_Operation,
    ['Congo, Dem. Rep.']
  );
  const countries = buildCountriesPayload(data);
  assert.equal(countries.length, 1);
  assert.equal(countries[0].Country.name, 'Democratic Republic of the Congo');
  assert.equal(countries[0].Country.id, 'country-drc');
  assert.equal(countries[0].Flag, 'Show');
});

test('an intentionally empty tenant LMIC list emits no member countries or country rows', () => {
  const data = fixture('["Kenya","Uganda"]');
  data.lmicCountryCodes = [];
  assert.deepEqual(buildMembersPayload(data)[0].Countries_of_Operation, []);
  assert.deepEqual(buildCountriesPayload(data), []);
});

test('Justice Rising preserves the Zoho multi-country array used by the Multiple Locations tooltip', () => {
  const data = fixture('["Congo (Democratic Republic)","Iraq","Syria"]');
  data.memberOrgs[0].name = 'Justice Rising';
  data.lmicCountryCodes = ['CD', 'IQ', 'SY'];
  data.countryLookup.Iraq = {
    id: 'country-iraq',
    income_group: 'Upper middle income',
    region: 'Asia',
    flag: 'Show',
  };
  data.countryLookup.Syria = {
    id: 'country-syria',
    income_group: 'Low income',
    region: 'Asia',
    flag: 'Show',
  };

  const [member] = buildMembersPayload(data);
  const countries = buildCountriesPayload(data);
  assert.deepEqual(
    member.Countries_of_Operation,
    ['Congo, Dem. Rep.', 'Iraq', 'Syria']
  );
  assert.deepEqual(
    countries.map((row) => row.Country.name),
    ['Democratic Republic of the Congo', 'Iraq', 'Syria']
  );
  assert.deepEqual(countries.map((row) => row.Flag), ['Show', 'Show', 'Show']);
});
