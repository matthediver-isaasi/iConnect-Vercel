// Task #3691 — Regression tests for immediate event server/API behaviour.
//
// Covers:
//  - suppressImmediateSchedule: schedule fields are null, is_training forced false,
//    agenda_summary suppressed
//  - memberContentVisibility: immediate events are visible to members
//  - memberContentIndexer.isIndexable: immediate simple events are indexable,
//    immediate complex_event status never is
//  - memberAiStructured.isEventRowVisible: immediate events visible
//  - source-contract: public event status allowlists include 'immediate'
//
// Run: node --test api/_lib/immediateEventPublicPayload.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  suppressImmediateSchedule,
  isImmediateEvent,
  PUBLIC_SIMPLE_EVENT_STATUSES,
  PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES,
} from '../../shared/eventTiming.js';

import { isChunkVisibleToMember } from './memberContentVisibility.js';
import { isIndexable } from './memberContentIndexer.js';
import { isEventRowVisible } from './memberAiStructured.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TENANT = 'tenant-1';
const memberCtx = (over = {}) => ({
  isAdmin: false,
  roleId: 'role-1',
  groupIds: new Set(['group-1']),
  canAccessFeature: () => true,
  tenantId: TENANT,
  now: new Date('2026-07-06T00:00:00Z'),
  ...over,
});

// ---------------------------------------------------------------------------
// suppressImmediateSchedule (shared/eventTiming.js)
// ---------------------------------------------------------------------------

test('suppressImmediateSchedule: non-immediate events pass through unchanged', () => {
  const ev = { status: 'published', start_date: '2026-09-01', is_training: true, agenda_summary: [] };
  const out = suppressImmediateSchedule(ev);
  assert.equal(out.start_date, '2026-09-01');
  assert.equal(out.is_training, true);
  assert.deepEqual(out.agenda_summary, []);
});

test('suppressImmediateSchedule: immediate events get null schedule fields', () => {
  const ev = {
    status: 'immediate',
    start_date: '2026-09-01',
    end_date: '2026-09-02',
    registration_closes_at: '2026-08-31',
    timezone: 'Europe/London',
    zoom_webinar_id: 'wid-1',
    zoom_meeting_id: 'mid-1',
    is_training: true,
    agenda_summary: [{ start_date: '2026-09-01' }],
    title: 'My Event',
  };
  const out = suppressImmediateSchedule(ev);
  assert.equal(out.start_date, null, 'start_date must be null');
  assert.equal(out.end_date, null, 'end_date must be null');
  assert.equal(out.registration_closes_at, null, 'registration_closes_at must be null');
  assert.equal(out.timezone, null, 'timezone must be null');
  assert.equal(out.zoom_webinar_id, null, 'zoom_webinar_id must be null');
  assert.equal(out.zoom_meeting_id, null, 'zoom_meeting_id must be null');
  assert.equal(out.is_training, false, 'is_training must be false');
  assert.equal(out.agenda_summary, undefined, 'agenda_summary must be undefined');
  assert.equal(out.title, 'My Event', 'title must be preserved');
  assert.equal(out.status, 'immediate', 'status must be preserved');
});

test('suppressImmediateSchedule: accepts raw string status', () => {
  const out = suppressImmediateSchedule('immediate');
  assert.equal(out, 'immediate');
});

// ---------------------------------------------------------------------------
// PUBLIC_SIMPLE_EVENT_STATUSES / PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES
// ---------------------------------------------------------------------------

test('PUBLIC_SIMPLE_EVENT_STATUSES includes immediate', () => {
  assert.ok(PUBLIC_SIMPLE_EVENT_STATUSES.includes('immediate'), 'immediate in PUBLIC_SIMPLE_EVENT_STATUSES');
  assert.ok(PUBLIC_SIMPLE_EVENT_STATUSES.includes('published'), 'published in PUBLIC_SIMPLE_EVENT_STATUSES');
  assert.ok(PUBLIC_SIMPLE_EVENT_STATUSES.includes('tbc'), 'tbc in PUBLIC_SIMPLE_EVENT_STATUSES');
});

test('PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES includes immediate and draft', () => {
  assert.ok(PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES.includes('immediate'), 'immediate in detail statuses');
  assert.ok(PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES.includes('draft'), 'draft in detail statuses');
});

// ---------------------------------------------------------------------------
// memberContentVisibility: immediate event chunks are visible
// ---------------------------------------------------------------------------

test('event chunk with immediate status is visible to member', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'event',
    status: 'immediate',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), true);
});

test('event chunk: published and tbc remain visible', () => {
  for (const status of ['published', 'tbc']) {
    const chunk = { tenant_id: TENANT, content_type: 'event', status };
    assert.equal(isChunkVisibleToMember(chunk, memberCtx()), true, `${status} must be visible`);
  }
});

test('complex_event chunk with immediate status is NOT visible (complex allowlist unchanged)', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'complex_event',
    status: 'immediate',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
});

// ---------------------------------------------------------------------------
// memberContentIndexer.isIndexable: immediate simple events are indexable
// ---------------------------------------------------------------------------

test('isIndexable: immediate simple event is indexable', () => {
  assert.equal(isIndexable('event', { status: 'immediate', event_state: null }), true);
});

test('isIndexable: immediate event with draft event_state is NOT indexable', () => {
  assert.equal(isIndexable('event', { status: 'immediate', event_state: 'draft' }), false);
});

test('isIndexable: complex_event with immediate status is NOT indexable', () => {
  // complex_event allowlist is unchanged — 'immediate' is a simple-event-only status
  assert.equal(isIndexable('complex_event', { status: 'immediate', event_state: null }), false);
});

test('isIndexable: published and tbc events remain indexable', () => {
  for (const status of ['published', 'tbc']) {
    assert.equal(isIndexable('event', { status, event_state: null }), true, `${status} event should be indexable`);
    assert.equal(isIndexable('complex_event', { status, event_state: null }), true, `${status} complex_event should be indexable`);
  }
});

// ---------------------------------------------------------------------------
// memberAiStructured.isEventRowVisible: immediate events are visible
// ---------------------------------------------------------------------------

test('isEventRowVisible: immediate event is visible', () => {
  const ctx = { isAdmin: false, groupIds: new Set() };
  assert.equal(isEventRowVisible({ status: 'immediate' }, ctx), true);
});

test('isEventRowVisible: immediate event with group restriction still gated', () => {
  const ev = { status: 'immediate', member_group_id: 'g1' };
  assert.equal(isEventRowVisible(ev, { isAdmin: false, groupIds: new Set() }), false);
  assert.equal(isEventRowVisible(ev, { isAdmin: false, groupIds: new Set(['g1']) }), true);
  assert.equal(isEventRowVisible({ ...ev, group_event_public: true }, { isAdmin: false, groupIds: new Set() }), true);
});

test('isEventRowVisible: published, tbc remain visible; draft and cancelled do not', () => {
  const ctx = { isAdmin: false, groupIds: new Set() };
  assert.equal(isEventRowVisible({ status: 'published' }, ctx), true);
  assert.equal(isEventRowVisible({ status: 'tbc' }, ctx), true);
  assert.equal(isEventRowVisible({ status: 'draft' }, ctx), false);
  assert.equal(isEventRowVisible({ status: 'cancelled' }, ctx), false);
});

// ---------------------------------------------------------------------------
// Source-contract: api/public/events.js and api/public/event.js allowlists
// ---------------------------------------------------------------------------

test('api/public/events.js status allowlist includes immediate', () => {
  const src = readFileSync(join(root, 'api/public/events.js'), 'utf8');
  assert.match(src, /PUBLIC_SIMPLE_EVENT_STATUSES/, 'events.js must use the simple-event status allowlist');
  assert.match(src, /suppressImmediateSchedule/, 'suppressImmediateSchedule must be applied in events.js');
});

test('api/public/event.js status allowlist includes immediate', () => {
  const src = readFileSync(join(root, 'api/public/event.js'), 'utf8');
  assert.match(src, /PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES/, 'event.js must use the simple-event detail allowlist');
  assert.match(src, /suppressImmediateSchedule/, 'suppressImmediateSchedule must be applied in event.js');
});

test('api/public/search.js includes immediate events', () => {
  const src = readFileSync(join(root, 'api/public/search.js'), 'utf8');
  assert.match(src, /PUBLIC_SIMPLE_EVENT_STATUSES/, 'search.js must use the simple-event status allowlist');
  assert.match(src, /status\.eq\.immediate/, 'search.js must OR-include immediate events without date filter');
});

test('api/public/prerender.js event lookup includes immediate', () => {
  const src = readFileSync(join(root, 'api/public/prerender.js'), 'utf8');
  assert.match(src, /PUBLIC_SIMPLE_EVENT_STATUSES/, 'prerender.js must use the simple-event status allowlist');
  assert.match(src, /!isImmediateEvent\(event\) && event\.start_date/, 'single-event prerender must suppress immediate dates');
  assert.match(src, /!isImmediateEvent\(e\) && e\.start_date/, 'list prerender must suppress immediate dates');
});

test('api/public/sitemap.xml.js event query includes immediate', () => {
  const src = readFileSync(join(root, 'api/public/sitemap.xml.js'), 'utf8');
  assert.match(src, /PUBLIC_SIMPLE_EVENT_STATUSES/, 'sitemap must use the simple-event status allowlist');
  assert.match(src, /isImmediateEvent\(event\) \? null/, 'sitemap must not use an immediate schedule date as lastmod');
});

test('api/_lib/entityMeta.js event lookup includes immediate', () => {
  const src = readFileSync(join(root, 'api/_lib/entityMeta.js'), 'utf8');
  assert.match(src, /PUBLIC_SIMPLE_EVENT_STATUSES/, 'metadata must use the simple-event status allowlist');
  assert.match(src, /!isImmediateEvent\(data\) && data\.start_date/, 'metadata must suppress immediate dates');
});

test('structured event retrieval includes immediate only for simple events', () => {
  const src = readFileSync(join(root, 'api/_lib/memberAiStructured.js'), 'utf8');
  assert.match(
    src,
    /\.in\('status', complex \? \['published', 'tbc'\] : PUBLIC_SIMPLE_EVENT_STATUSES\)/,
  );
});

test('public agenda endpoints reject immediate events even with stale training data', () => {
  const detail = readFileSync(join(root, 'api/public/event-agenda.js'), 'utf8');
  const summaries = readFileSync(join(root, 'api/public/event-agenda-summaries.js'), 'utf8');
  assert.doesNotMatch(detail, /'draft', 'immediate'/);
  assert.match(summaries, /\.neq\('status', 'immediate'\)/);
});

test('migration adds immediate to event status constraint', () => {
  const migrationDir = join(root, 'supabase/migrations');
  const files = readdirSync(migrationDir).filter(f => f.includes('immediate'));
  assert.ok(files.length > 0, 'A migration file referencing immediate must exist');
  const migrationSrc = readFileSync(join(migrationDir, files[0]), 'utf8');
  assert.match(migrationSrc, /event.*ADD.*CONSTRAINT|ADD.*CONSTRAINT.*event/s, 'must alter the event table constraint');
  assert.match(migrationSrc, /'immediate'/, 'migration must include immediate in the constraint');
  assert.match(
    migrationSrc,
    /event_immediate_eligibility_check[\s\S]*is_training IS NOT TRUE[\s\S]*member_group_id IS NULL/,
    'migration must enforce standard non-training immediate events at the database boundary',
  );
  assert.ok(
    !migrationSrc.match(/ALTER TABLE complex_event.*ADD CONSTRAINT complex_event_status_check.*immediate/s),
    'complex_event constraint must NOT include immediate'
  );
});

test('generic entity writes enforce immediate timing before tenant-admin bypass', () => {
  const src = readFileSync(join(root, 'api/_lib/groupAdminEventWrite.js'), 'utf8');
  const guardIndex = src.indexOf('normalizeSimpleEventWrite(body, existingRow)');
  const adminIndex = src.indexOf('const isAdmin = await hasAdminAccess');
  assert.ok(guardIndex >= 0, 'simple-event writes must use the authoritative timing guard');
  assert.ok(adminIndex > guardIndex, 'timing guard must run for tenant admins too');
  assert.match(src, /Immediate access is not available for multi-session events/);
});
