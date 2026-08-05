/**
 * Saved-session "Link Existing" Zoom persistence (Task #3414).
 *
 * The complex-event save loop strips Zoom columns from the bypass PATCH for
 * existing sessions (task-692), so a Link Existing dropdown selection must be
 * persisted through the change-zoom API. These tests simulate the save path:
 * a saved session whose picker selection changed resolves the external Zoom
 * ID against the tenant Zoom list and POSTs the LOCAL row PK to
 * /api/complex-event-sessions/:id/change-zoom — proving the selection
 * persists (a reload reads zoom_meeting_id/zoom_webinar_id written by that
 * endpoint). Unchanged and legacy-unresolvable IDs are left alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPendingSessionZoomChange,
  persistSessionZoomLink,
} from './sessionZoomLink.js';

const MEETINGS = [
  { id: 'local-m1', zoom_meeting_id: '11122233344', topic: 'Members Call' },
  { id: 'local-m2', zoom_meeting_id: '22233344455', topic: 'Board Meeting' },
];
const WEBINARS = [
  { id: 'local-w1', zoom_webinar_id: '99988877766', topic: 'Conference' },
];

function makeFetch() {
  const posts = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url) === '/api/zoom/meetings') return { ok: true, json: async () => MEETINGS };
    if (String(url) === '/api/zoom/webinars') return { ok: true, json: async () => WEBINARS };
    if (String(url).includes('/change-zoom') && options.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ success: true }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { fetchImpl, posts };
}

test('no pending change for a new (unsaved) session — the POST payload handles it', () => {
  assert.equal(getPendingSessionZoomChange({
    is_online: true, zoom_link_mode: 'link_existing', link_existing_zoom_id: '11122233344',
  }), null);
});

test('no pending change when the selection matches the stored external ID', () => {
  assert.equal(getPendingSessionZoomChange({
    id: 's1', is_online: true, zoom_link_mode: 'link_existing',
    link_existing_zoom_id: '11122233344', zoom_meeting_id: '11122233344',
  }), null);
});

test('changed meeting selection on a saved session posts the LOCAL PK to change-zoom', async () => {
  const { fetchImpl, posts } = makeFetch();
  const session = {
    id: 's1', title: 'Session 1', is_online: true, zoom_type: 'meeting',
    zoom_link_mode: 'link_existing',
    zoom_meeting_id: '11122233344', // previously linked
    link_existing_zoom_id: '22233344455', // admin picked a different meeting
  };
  const result = await persistSessionZoomLink(session, { fetchImpl });
  assert.equal(result.status, 'linked');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/complex-event-sessions/s1/change-zoom');
  assert.equal(posts[0].body.zoom_meeting_id, 'local-m2', 'local PK, not external ID');
  assert.equal(posts[0].body.zoom_webinar_id, null, 'opposite ID cleared');
  assert.equal(posts[0].body.cancelOld, true, 'previous zoom triggers cancelOld');
  assert.equal(posts[0].body.registerNew, true);
  assert.equal(posts[0].body.resendConfirmations, false, 'bulk save must not mass-email');
});

test('webinar selection resolves against the webinar list and clears the meeting slot', async () => {
  const { fetchImpl, posts } = makeFetch();
  const session = {
    id: 's2', is_online: true, zoom_type: 'webinar',
    zoom_link_mode: 'link_existing',
    link_existing_zoom_id: '99988877766', // no previous zoom → attach
  };
  const result = await persistSessionZoomLink(session, { fetchImpl });
  assert.equal(result.status, 'linked');
  assert.equal(posts[0].body.zoom_webinar_id, 'local-w1');
  assert.equal(posts[0].body.zoom_meeting_id, null);
  assert.equal(posts[0].body.cancelOld, false, 'attach has nothing to cancel');
});

test('legacy manually-typed ID not in the Zoom list is left unchanged (not_found)', async () => {
  const { fetchImpl, posts } = makeFetch();
  const session = {
    id: 's3', is_online: true, zoom_type: 'meeting',
    zoom_link_mode: 'link_existing',
    zoom_meeting_id: '55500011122',
    link_existing_zoom_id: '55500011199', // unknown ID
  };
  const result = await persistSessionZoomLink(session, { fetchImpl });
  assert.equal(result.status, 'not_found');
  assert.equal(posts.length, 0, 'no change-zoom call — existing link preserved');
});

test('auto_create mode and offline sessions never trigger change-zoom', () => {
  assert.equal(getPendingSessionZoomChange({
    id: 's4', is_online: true, zoom_link_mode: 'auto_create', link_existing_zoom_id: '123',
  }), null);
  assert.equal(getPendingSessionZoomChange({
    id: 's5', is_online: false, zoom_link_mode: 'link_existing', link_existing_zoom_id: '123',
  }), null);
});

test('change-zoom API failure surfaces as an error (no silent drop)', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url) === '/api/zoom/meetings') return { ok: true, json: async () => MEETINGS };
    return { ok: false, json: async () => ({ error: 'boom' }) };
  };
  const session = {
    id: 's6', is_online: true, zoom_type: 'meeting', zoom_link_mode: 'link_existing',
    link_existing_zoom_id: '11122233344',
  };
  await assert.rejects(() => persistSessionZoomLink(session, { fetchImpl }), /boom/);
});
