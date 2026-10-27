import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readZoomRegistration, enableZoomRegistration, listZoomRegistrations, registerWithZoom, safeZoomAttendeeUrl } from './zoomRegistration.js';
const original = global.fetch;
afterEach(() => { global.fetch = original; });
const reply = data => new Response(JSON.stringify(data), { status: 200 });
test('safe attendee URLs reject host credentials, foreign hosts and unsafe schemes', () => {
  for (const url of ['https://zoom.us/s/123?zak=secret', 'https://zoom.us/j/123?zak=secret', 'https://evil.example/j/123', 'javascript:alert(1)']) assert.equal(safeZoomAttendeeUrl(url), null);
  assert.equal(safeZoomAttendeeUrl('https://us02web.zoom.us/j/123'), 'https://us02web.zoom.us/j/123');
});
test('live setting overrides cached intent and missing setting fails closed', async () => {
  global.fetch = async () => reply({ id: 123, settings: { approval_type: 2 } });
  assert.equal((await readZoomRegistration('token','meetings','123')).registration_required, false);
  global.fetch = async () => reply({ id: 123 });
  await assert.rejects(readZoomRegistration('token','meetings','123'), /unavailable/);
});
test('enable sends only registration settings and verifies afterwards', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(options);
    return options.method === 'PATCH' ? new Response(null, { status: 204 }) : reply({ id: 123, type: 2, settings: { approval_type: calls.length === 1 ? 2 : 0 } });
  };
  assert.equal((await enableZoomRegistration('token','meetings','123')).registration_required, true);
  assert.deepEqual(JSON.parse(calls[1].body), { settings: { approval_type: 0, registration_type: 1 } });
  assert.equal(calls.length, 3);
});
test('registrants paginate every status; failure is not empty evidence', async () => {
  const calls = [];
  global.fetch = async url => {
    const q = new URL(url).searchParams;
    calls.push(q.get('status'));
    return reply({ registrants: [{ email: `${q.get('status')}${q.get('next_page_token')}@example.invalid` }], next_page_token: q.get('next_page_token') ? '' : 'second' });
  };
  assert.equal((await listZoomRegistrations('token','meetings','123')).size, 6);
  assert.equal(calls.length, 6);
  global.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(listZoomRegistrations('token','meetings','123'), /403/);
});
test('same-target retry preserves existing, pending and denied and deduplicates new registrations', async () => {
  let posts = 0;
  global.fetch = async () => { posts++; return reply({ join_url: 'https://zoom.us/w/123?tk=private' }); };
  const rows = new Map([['a@example.invalid',{ status:'approved', join_url:'personal' }],['b@example.invalid',{status:'pending'}],['c@example.invalid',{status:'denied'}]]);
  for (const [email, outcome] of [['a','existing'],['b','pending'],['c','denied']]) assert.equal((await registerWithZoom('t','meetings','123',{email:`${email}@example.invalid`},rows)).outcome,outcome);
  assert.equal(posts,0);
  assert.equal((await registerWithZoom('t','meetings','123',{email:''},rows)).outcome,'missing_email');
  assert.equal((await registerWithZoom('t','meetings','123',{email:'d@example.invalid'},rows)).outcome,'new');
  assert.equal((await registerWithZoom('t','meetings','123',{email:'D@example.invalid'},rows)).outcome,'existing');
  assert.equal(posts,1);
});
