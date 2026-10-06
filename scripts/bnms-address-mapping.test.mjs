import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAddress } from './bnms-address-mapping.mjs';

test('explicit UK components and corroborated town; no inferred country', () => {
  const r = mapAddress('Example Hospital\r\n10 Test Road\r\nExampletown\r\nKent\r\nME1 1AA', { org_town_city: 'Exampletown', org_country: 'United Kingdom' });
  assert.equal(r.ambiguous, false);
  assert.equal(r.proposed.org_country, null);
  assert.equal(r.proposed.org_county, 'Kent');
  assert.equal(r.proposed.org_postcode, 'ME1 1AA');
  assert.equal(r.proposed.org_address_line_2, '10 Test Road');
  assert.equal(r.ledger.length, 5);
});
test('ambiguous locality and compound county remain explicit', () => {
  const r = mapAddress('Test Road, Exampletown, District One, District Two, ME1 1AA, United Kingdom', { org_town_city: 'Exampletown' });
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.unassigned, ['District One', 'District Two']);
  assert.equal(r.proposed.org_county, null);
});
test('overflow retains all text and blocks candidate', () => {
  const r = mapAddress('Unit A; Building B; Campus C; Road D; Exampletown; ME1 1AA; UK', { org_town_city: 'Exampletown' });
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.unassigned, ['Road D']);
  assert.equal(r.proposed.org_country, 'United Kingdom');
  assert.equal(r.ledger.length + r.unassigned.length, 7);
});
test('conflict is separate from ambiguity and existing values stay untouched', () => {
  const existing = { org_address_line_1: 'Old Road', org_town_city: 'Exampletown' };
  const r = mapAddress('New Road, Exampletown, ME1 1AA, UK', existing);
  assert.deepEqual(r.conflicts, ['org_address_line_1']);
  assert.equal(existing.org_address_line_1, 'Old Road');
});
test('missing, malformed and duplicate components do not qualify', () => {
  assert.equal(mapAddress(null).missing, true);
  assert.equal(mapAddress(' \r\n ').missing, true);
  assert.equal(mapAddress('<p>Road</p>').ambiguous, true);
  const r = mapAddress('Road, Road, Exampletown, ME1 1AA, UK', { org_town_city: 'Exampletown' });
  assert.equal(r.ambiguous, true);
  assert.equal(r.ledger.filter(l => l.source === 'Road').length, 2);
});
test('foreign postal patterns need country evidence; country restriction blocks', () => {
  const r = mapAddress('Example Road, Exampletown, 74200, Pakistan', { org_town_city: 'Exampletown' });
  assert.equal(r.proposed.org_postcode, '74200');
  assert.equal(r.proposed.org_county, null);
  assert.equal(mapAddress('Example Road, 74200').proposed.org_postcode, null);
  assert.equal(mapAddress('Example Road, Exampletown, 74200, Pakistan', { org_town_city: 'Exampletown' }, { all_countries: false, selected_countries: ['GB'] }).ambiguous, true);
});
