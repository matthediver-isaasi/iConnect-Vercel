import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatches, loadInput, normalizeName, parseDomains, TENANT, GROUP } from './import-gfi-ahecs-organizations.mjs';

const input = [{ Organisation: 'Sample University', Domain: 'sample.ie' }];
const org = { id: 'test-org', tenant_id: TENANT, name: '  SAMPLE   UNIVERSITY ', organization_group_id: null };
const pref = { id: 'test-pref', organization_id: org.id, value: '["legacy.ie","sample.ie"]' };

test('source is strictly parsed as 22 unique BOM-compatible records', () => {
  assert.equal(loadInput().rows.length, 22);
});
test('normalizes Unicode composition, apostrophes, case and whitespace', () => {
  assert.equal(normalizeName(' DÚN  Queen’s '), normalizeName("du\u0301n queen's"));
});
test('preserves existing organization name and domain array without writes', () => {
  const [match] = buildMatches(input, [org], [pref]);
  assert.equal(match.existingName, org.name);
  assert.equal(match.desiredValue, pref.value);
  assert.equal(match.domainChange, false);
  assert.equal(match.groupChange, true);
});
test('merges domains without dropping legacy entries', () => {
  const [match] = buildMatches(input, [org], [{ ...pref, value: '["legacy.ie","https://legacy.ie/careers"]' }]);
  assert.deepEqual(JSON.parse(match.desiredValue), ['legacy.ie', 'https://legacy.ie/careers', 'sample.ie']);
});
test('rejects ambiguous duplicate normalized names', () => {
  assert.throws(() => buildMatches(input, [org, { ...org, id: 'second' }], []), /AMBIGUOUS_MATCH/);
});
test('rejects shared domains and name/domain disagreement', () => {
  const other = { ...org, id: 'second', name: 'Other University' };
  assert.throws(() => buildMatches(input, [org, other], [pref, { ...pref, organization_id: other.id }]), /AMBIGUOUS_MATCH/);
  assert.throws(() => buildMatches(input, [org, other], [{ ...pref, organization_id: other.id }]), /NAME_DOMAIN_CONFLICT/);
});
test('rejects unreviewed domain-only alias', () => {
  assert.throws(() => buildMatches(input, [{ ...org, name: 'Unreviewed Alias' }], [pref]), /UNREVIEWED_DOMAIN_ALIAS/);
});
test('never replaces a different existing group', () => {
  assert.throws(() => buildMatches(input, [{ ...org, organization_group_id: 'another-group' }], [pref]), /EXISTING_GROUP_CONFLICT/);
  assert.equal(buildMatches(input, [{ ...org, organization_group_id: GROUP }], [pref])[0].groupChange, false);
});
test('new organization identities are deterministic for idempotency', () => {
  assert.deepEqual(buildMatches(input, [], []), buildMatches(input, [], []));
  assert.equal(buildMatches(input, [], [])[0].desiredValue, '["sample.ie"]');
});
test('malformed existing domains cannot be silently lost', () => {
  assert.throws(() => parseDomains('not-json'), /NOT_JSON/);
  assert.throws(() => parseDomains('{"domain":"sample.ie"}'), /NOT_STRING_ARRAY/);
  assert.throws(() => parseDomains('[null]'), /NOT_STRING_ARRAY/);
});