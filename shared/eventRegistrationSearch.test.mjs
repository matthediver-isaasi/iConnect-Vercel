import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationGroupMatches, registrationIdentityMatches } from './eventRegistrationSearch.mjs';

test('literal partial matching is trimmed, case insensitive and null safe', () => {
  const identity = { first_name: " Anne ", last_name: "O'Neil (QA)", email: 'A+%_*\\@example.invalid' };
  assert.equal(registrationIdentityMatches(identity, "anne o'neil"), true);
  for (const value of ['%', '_', '*', '\\', '+', '@example']) {
    assert.equal(registrationIdentityMatches(identity, '', value), true);
  }
  assert.equal(registrationIdentityMatches(identity, '.*'), false);
  assert.equal(registrationIdentityMatches(null, 'someone'), false);
  assert.equal(registrationGroupMatches({}, ' ', ' '), true);
  assert.equal(registrationGroupMatches({ attendees: [{}] }, '', '@'), false);
});

test('combined filters cannot join different identities', () => {
  const group = {
    attendees: [{ attendee_first_name: 'Guest', attendee_email: 'guest@example.invalid' }],
    booker: { first_name: 'External', last_name: 'Booker', email: 'booker@example.invalid' },
    publicInvoicePurchaser: { first_name: 'Public', last_name: 'Buyer', email: 'buyer@example.invalid' },
  };
  assert.equal(registrationGroupMatches(group, 'External Booker', 'booker@'), true);
  assert.equal(registrationGroupMatches(group, 'Public Buyer', 'buyer@'), true);
  assert.equal(registrationGroupMatches(group, 'Guest', 'buyer@'), false);
});
