import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAttendeeJobTitles } from './attendeeJobTitleRequirement.js';
import { requireAttendeeJobTitle, missingAttendeeJobTitle } from '../../shared/attendeeJobTitleRequirement.js';

function db(settings = [], members = [], failure = false) {
  return { from(table) {
    const filters = [];
    const q = {
      select() { return q; }, limit() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      ilike(k, v) { filters.push(r => r[k].toLowerCase() === v); return q; },
      then(resolve) { return Promise.resolve(resolve({
        data: (table === 'system_settings' ? settings : members).filter(r => filters.every(f => f(r))),
        error: failure ? new Error('offline') : null,
      })); },
    };
    return q;
  } };
}
const enabled = [{ tenant_id: 'a', setting_key: 'require_attendee_job_title', setting_value: 'true' }];
test('absent, disabled, and other tenant settings preserve optional behavior', async () => {
  for (const settings of [[], [{ ...enabled[0], setting_value: 'false' }], [{ ...enabled[0], tenant_id: 'b' }]]) {
    await enforceAttendeeJobTitles(db(settings), 'a', [{}]);
  }
  assert.equal(requireAttendeeJobTitle([]), false);
});
test('own profile fallback is persisted in request only; explicit values win', async () => {
  const members = [{ tenant_id: 'a', email: 'own@example.test', job_title: 'Director' }];
  const attendees = [{ email: 'OWN@example.test' }, { email: 'own@example.test', job_title: ' Editor ' }];
  await enforceAttendeeJobTitles(db(enabled, members), 'a', attendees);
  assert.deepEqual(attendees.map(a => a.job_title), ['Director', 'Editor']);
  assert.equal(members[0].job_title, 'Director');
});
test('never borrow booker or other tenant titles; later missing attendee remains actionable', async () => {
  const members = [{ tenant_id: 'b', email: 'guest@example.test', job_title: 'Director' }];
  const attendees = [{ email: 'booker@example.test', job_title: 'Manager' }, { first_name: 'Guest', email: 'guest@example.test', job_title: '\t' }];
  await assert.rejects(enforceAttendeeJobTitles(db(enabled, members), 'a', attendees), /attendee 2 \(Guest\)/);
  assert.match(missingAttendeeJobTitle(attendees), /Guest/);
  assert.equal(attendees[0].job_title, 'Manager');
});
test('settings failure is not absence; missing quantity details fail closed', async () => {
  await assert.rejects(enforceAttendeeJobTitles(db([], [], true), 'a', []), e => e.statusCode === 503);
  await assert.rejects(enforceAttendeeJobTitles(db(enabled), 'a', [{ job_title: 'Manager' }], 2), e => e.statusCode === 400);
});
