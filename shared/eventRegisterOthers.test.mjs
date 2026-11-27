import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { membersCanRegisterOthers, memberSelfOnlyViolation, REGISTER_OTHERS_DISABLED_MESSAGE } from './eventRegisterOthers.js';

const self = { email: 'Member@Example.test' };

test('existing events (missing or true setting) keep allowing members to register others', () => {
  assert.equal(membersCanRegisterOthers({}), true);
  assert.equal(membersCanRegisterOthers(null), true);
  assert.equal(membersCanRegisterOthers({ members_can_register_others: true }), true);
  assert.equal(memberSelfOnlyViolation({}, [self, { email: 'other@example.test' }], 'member@example.test'), null);
});

test('when off, only a single self attendee (case-insensitive email) is accepted', () => {
  const event = { members_can_register_others: false };
  assert.equal(memberSelfOnlyViolation(event, [self], ' member@example.test '), null);
  assert.equal(memberSelfOnlyViolation(event, [{ email: 'other@example.test' }], 'member@example.test'), REGISTER_OTHERS_DISABLED_MESSAGE);
  assert.equal(memberSelfOnlyViolation(event, [self, { email: 'other@example.test' }], 'member@example.test'), REGISTER_OTHERS_DISABLED_MESSAGE);
  assert.equal(memberSelfOnlyViolation(event, [self, self], 'member@example.test'), REGISTER_OTHERS_DISABLED_MESSAGE);
  assert.equal(memberSelfOnlyViolation(event, [], 'member@example.test'), REGISTER_OTHERS_DISABLED_MESSAGE);
  assert.equal(memberSelfOnlyViolation(event, [self], ''), REGISTER_OTHERS_DISABLED_MESSAGE);
});

test('every member booking path and editor wires the setting', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const fn = read('api/functions/[functionName].js');
  assert.match(fn, /if \(registerOthersError\) throw registerOthersError;/);
  assert.match(fn, /programSelfOnlyError = memberSelfOnlyViolation\(event, attendees/);
  const complex = read('api/public/complex-event-booking.js');
  assert.match(complex, /members_can_register_others'\)/);
  assert.match(complex, /if \(registerOthersError\) throw registerOthersError;/);
  assert.match(read('api/_lib/groupAdminEventWrite.js'), /delete out\.members_can_register_others/);
  for (const page of ['client/src/pages/EditEvent.jsx', 'client/src/pages/CreateEvent.jsx', 'client/src/pages/CreateComplexEvent.jsx']) {
    const source = read(page);
    const privateIdx = source.indexOf('<PrivateEventToggle');
    const toggleIdx = source.indexOf('<MembersRegisterOthersToggle');
    assert.ok(privateIdx > 0 && toggleIdx > privateIdx, `${page} places the toggle below Private Event`);
    assert.match(source, /members_can_register_others/);
  }
});
