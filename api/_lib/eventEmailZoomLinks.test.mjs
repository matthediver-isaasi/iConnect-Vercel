import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventEmailZoomResolver, personalisedZoomUrl, personaliseEmailZoomTargets } from './eventEmailZoomLinks.js';
import { listPreviewAttendees, loadPreviewBooking } from './eventEmailPreviewAttendees.js';

const personal = 'https://zoom.us/w/123?tk=fixture-only';
const generic = 'https://zoom.us/j/123?pwd=fixture';
function fixture({ required = true, registrants = [{ email: 'person@example.test', join_url: personal }], failure = false, sample = false } = {}) {
  const calls = [];
  const q = { select() { return this; }, eq(...args) { calls.push(args); return this; }, maybeSingle: async () => ({ data: { zoom_meeting_id: '123', zoom_webinar_id: '123' } }) };
  const resolve = createEventEmailZoomResolver({ from: () => q }, 'tenant', 'Person@Example.test', {
    sample, getToken: async () => 'fixture',
    readSettings: async () => { if (failure) throw new Error('Zoom request failed'); return { registration_required: required, join_url: generic }; },
    request: async (token, path, options) => {
      assert.equal(options, undefined, 'lookup must never register or patch');
      calls.push(path);
      return { registrants };
    },
  });
  return { resolve, calls };
}
test('mandatory registration resolves recipient and caches only within this render', async () => {
  const { resolve, calls } = fixture();
  for (let i = 0; i < 2; i++) assert.equal(await resolve({ zoom_meeting_id: 'local' }), personal);
  assert.equal(calls.filter(c => typeof c === 'string').length, 1);
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'tenant_id' && c[1] === 'tenant'));
});
for (const registrants of [[], [{ email: 'other@example.test', join_url: personal }], [{ email: 'person@example.test', join_url: generic }], [{ email: 'person@example.test', join_url: personal }, { email: 'person@example.test', join_url: personal }]]) {
  test('missing, wrong, generic or ambiguous registrations fail closed', async () => {
    await assert.rejects(fixture({ registrants }).resolve({ zoom_meeting_id: 'local' }), { code: 'ZOOM_EMAIL_LINK_UNAVAILABLE' });
  });
}
test('live lookup failures never fall back; unregistered meetings retain live generic link', async () => {
  await assert.rejects(fixture({ failure: true }).resolve({ zoom_meeting_id: 'local' }));
  assert.equal(await fixture({ required: false }).resolve({ zoom_meeting_id: 'local' }), generic);
});
test('sample preview omits live links without provider calls', async () => {
  const { resolve, calls } = fixture({ sample: true });
  assert.equal(await resolve({ zoom_meeting_id: 'local' }), '');
  assert.equal(calls.length, 0);
});
test('URL validation forbids host credentials and non-Zoom hosts', () => {
  for (const url of [generic, personal + '&zak=host', 'https://evil.test/w/123?tk=x', 'http://zoom.us/w/123?tk=x']) assert.equal(personalisedZoomUrl(url), null);
});
test('agenda schedule is rebuilt with personalised links', async () => {
  const agenda = { lines: [{ zoom_meeting_id: 'local', zoom_join_url: generic }], agendaScheduleHtml: generic };
  await personaliseEmailZoomTargets(fixture().resolve, {}, null, agenda);
  assert.ok(agenda.agendaScheduleHtml.includes('tk=fixture-only'));
  assert.ok(!agenda.agendaScheduleHtml.includes('pwd=fixture'));
});
test('booking preview enforces tenant, event and confirmed status', async () => {
  const calls = [];
  const q = { select() { return this; }, eq(...args) { calls.push(args); return this; },
    maybeSingle: async () => ({ data: { id: 'booking' } }) };
  await loadPreviewBooking({ from: () => q }, 'tenant', 'event', 'booking');
  for (const pair of [['tenant_id', 'tenant'], ['event_id', 'event'], ['id', 'booking'], ['status', 'confirmed']])
    assert.ok(calls.some(c => JSON.stringify(c) === JSON.stringify(pair)));
});
test('attendee search and pagination preserve ordinary names and bound the response', async () => {
  let filter;
  const q = { select() { return this; }, eq() { return this; }, order() { return this; },
    or(v) { filter = v; return this; }, maybeSingle: async () => ({ data: { id: 'event' } }),
    range: async (start, end) => { assert.equal(start, 25); assert.equal(end, 50); return { data: Array.from({ length: 26 }, (_, id) => ({ id })) }; } };
  const result = await listPreviewAttendees({ from: () => q }, 'tenant', 'event', 'Alice', 25);
  assert.ok(filter.includes('Alice'));
  assert.equal(result.items.length, 25);
  assert.equal(result.hasMore, true);
});
