import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUnresolvedCountryValues,
  MAX_EXAMPLE_RECORDS,
} from './countryDataQuality.js';

const org = (id, label) => ({ id, label });

test('resolvable values (code, name, alias, curly apostrophe) never appear', () => {
  const issues = collectUnresolvedCountryValues([
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('1', 'A'), value: 'KE' },
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('2', 'B'), value: 'Kenya' },
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('3', 'C'), value: 'Congo, Dem. Rep.' },
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('4', 'D'), value: 'C\u00f4te d\u2019Ivoire' },
  ]);
  assert.deepEqual(issues, []);
});

test('unresolvable value is grouped with its records; empty values skipped', () => {
  const issues = collectUnresolvedCountryValues([
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('1', 'Acme'), value: 'Untied Kingdom' },
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('2', 'Beta'), value: 'untied kingdom' },
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('3', 'Gamma'), value: '' },
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country', record: org('4', 'Delta'), value: null },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].recordCount, 2);
  assert.deepEqual(issues[0].records.map(r => r.label), ['Acme', 'Beta']);
});

test('multi-pick arrays: only the bad element surfaces, per-record dedupe', () => {
  const issues = collectUnresolvedCountryValues([
    {
      source: 'organization',
      fieldKey: 'custom:f1',
      fieldLabel: 'Countries of operation',
      record: org('1', 'Acme'),
      value: ['Kenya', 'Untied Kingdom', 'Untied Kingdom', { value: 'IN' }],
    },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].value, 'Untied Kingdom');
  assert.equal(issues[0].recordCount, 1);
});

test('same value on different fields/sources stays as separate issues', () => {
  const issues = collectUnresolvedCountryValues([
    { source: 'organization', fieldKey: 'system:country', fieldLabel: 'Org Country', record: org('1', 'A'), value: 'Narnia' },
    { source: 'member', fieldKey: 'custom:f9', fieldLabel: 'Member Country', record: org('m1', 'x@y.z'), value: 'Narnia' },
  ]);
  assert.equal(issues.length, 2);
});

test('sorted by record count desc; example records capped', () => {
  const entries = [];
  for (let i = 0; i < MAX_EXAMPLE_RECORDS + 5; i += 1) {
    entries.push({
      source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country',
      record: org(`big-${i}`, `Org ${i}`), value: 'Freedonia',
    });
  }
  entries.push({
    source: 'organization', fieldKey: 'system:country', fieldLabel: 'Country',
    record: org('solo', 'Solo'), value: 'Narnia',
  });
  const issues = collectUnresolvedCountryValues(entries);
  assert.equal(issues[0].value, 'Freedonia');
  assert.equal(issues[0].recordCount, MAX_EXAMPLE_RECORDS + 5);
  assert.equal(issues[0].records.length, MAX_EXAMPLE_RECORDS);
  assert.equal(issues[1].value, 'Narnia');
});
