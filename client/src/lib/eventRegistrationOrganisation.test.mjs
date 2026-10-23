import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registrationOrganisationName, registrationOrganisationLabel } from './eventRegistrationOrganisation.mjs';

test('linked organisation wins over registration text', () => {
  assert.equal(registrationOrganisationLabel({
    organization_id: 'org', attendee_organization: 'Written name', is_guest_booking: true,
  }, { org: 'Linked organisation' }), 'Linked organisation');
});

test('registration text is used for missing or unresolved organisation links', () => {
  for (const organization_id of [null, 'missing']) {
    assert.equal(registrationOrganisationLabel({
      organization_id, attendee_organization: ' NHS Lothian ',
    }), 'NHS Lothian');
  }
  assert.equal(registrationOrganisationLabel({ guest_organisation_name: 'UCLH' }), 'UCLH');
});

test('empty or invalid values fall through without inferring membership', () => {
  for (const is_guest_booking of [true, false]) {
    for (const member_id of [null, 'member']) {
      const attendee = { is_guest_booking, member_id, attendee_organization: ' ', organization_id: 'org' };
      assert.equal(registrationOrganisationLabel(attendee, { org: ' ' }), 'Not provided');
      assert.equal(registrationOrganisationName(attendee), '');
    }
  }
  assert.equal(registrationOrganisationLabel(undefined), 'Not provided');
  assert.equal(registrationOrganisationLabel({ attendee_organization: 123 }), 'Not provided');
});

test('report uses the same resolver for both row layouts, exports, search and sorting', () => {
  const page = readFileSync(new URL('../pages/EventRegistrationReport.jsx', import.meta.url), 'utf8');
  assert.equal((page.match(/const orgName = registrationOrganisationName\(attendee, organizations\)/g) || []).length, 2);
  assert.match(page, /label: 'Organisation', get: \(\{ a \}\) => registrationOrganisationLabel\(a, organizations\)/);
  assert.match(page, /registrationOrganisationLabel\(a, organizations\)\.toLowerCase\(\)\.includes\(q\)/);
  assert.match(page, /registrationOrganisationLabel\(aFirst, organizations\)\.localeCompare/);
  assert.doesNotMatch(page, /isGuest \? 'Guest' : 'Non-member'/);
  assert.match(page, /setTransferIsPublic\(isGuest\)/, 'Transfer eligibility must remain unchanged');
});
