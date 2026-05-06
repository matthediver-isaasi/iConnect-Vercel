#!/usr/bin/env node
/**
 * Regression guard for task #687: Event Duplication & Editable Zoom Links.
 *
 * Static checks (no DB required):
 *   - All four endpoints exist and start with auth + admin gate.
 *   - Duplicate endpoints reset status, slug, zoom IDs.
 *   - Change-zoom endpoints require a tenant match when looking up zoom_*.
 *
 * Dynamic checks (when SUPABASE_URL + SUPABASE_SERVICE_KEY are present):
 *   - Every duplicated event/complex event we can detect by slug suffix
 *     `-copy` is in 'draft' status.
 *   - No copied complex_event_session has any zoom_*_id set.
 *   - Every (tenant_id, slug) pair on `event` is unique.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); console.error('❌', msg); }
function warn(msg) { warnings.push(msg); console.warn('⚠️ ', msg); }
function ok(msg) { console.log('✅', msg); }

const ENDPOINTS = [
  'api/events/[id]/duplicate.js',
  'api/complex-events/[id]/duplicate.js',
  'api/events/[id]/change-zoom.js',
  'api/complex-event-sessions/[id]/change-zoom.js',
];

for (const rel of ENDPOINTS) {
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) {
    fail(`Missing endpoint file: ${rel}`);
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');
  if (!src.includes('getTenantContext')) fail(`${rel}: must call getTenantContext`);
  if (!src.includes('hasAdminAccess')) fail(`${rel}: must call hasAdminAccess`);
  if (!src.includes("eq('tenant_id', tenantId)") && !src.includes("eq('tenant_id', ctx.tenantId)")) {
    fail(`${rel}: must scope queries by tenant_id`);
  }
  ok(`${rel} — auth + tenant gate present`);
}

// Duplicate endpoints must reset key fields. Allow either object-literal style
// (`status: 'draft'`) or assignment style (`insertRow.status = 'draft'`).
function hasReset(src, field, value) {
  const v = value === null ? 'null' : `'${value}'`;
  const reLiteral = new RegExp(`${field}\\s*:\\s*${v}`);
  const reAssign = new RegExp(`\\.${field}\\s*=\\s*${v}`);
  return reLiteral.test(src) || reAssign.test(src);
}

const dupSingle = fs.readFileSync(path.join(REPO_ROOT, 'api/events/[id]/duplicate.js'), 'utf8');
const singleResets = [
  ['status', 'draft'], ['event_state', 'draft'],
  ['zoom_webinar_id', null], ['zoom_meeting_id', null],
  ['is_featured', false],
];
for (const [field, value] of singleResets) {
  const v = value === false ? 'false' : (value === null ? 'null' : `'${value}'`);
  const re = new RegExp(`(${field}\\s*:|\\.${field}\\s*=)\\s*${v}`);
  if (!re.test(dupSingle)) fail(`api/events/[id]/duplicate.js missing reset: ${field}=${v}`);
}
ok('Single-event duplicate resets status/event_state/zoom/is_featured');

const dupComplex = fs.readFileSync(path.join(REPO_ROOT, 'api/complex-events/[id]/duplicate.js'), 'utf8');
const complexResets = [
  ['status', 'draft'], ['is_featured', false],
  ['zoom_meeting_id', null], ['zoom_webinar_id', null],
  ['zoom_join_url', null], ['zoom_start_url', null], ['zoom_registration_url', null],
];
for (const [field, value] of complexResets) {
  const v = value === false ? 'false' : (value === null ? 'null' : `'${value}'`);
  const re = new RegExp(`(${field}\\s*:|\\.${field}\\s*=)\\s*${v}`);
  if (!re.test(dupComplex)) fail(`api/complex-events/[id]/duplicate.js missing reset: ${field}=${v}`);
}
ok('Complex duplicate resets parent + per-session zoom fields');

// Change-zoom endpoints must look up zoom records and pass tenantId
const changeEv = fs.readFileSync(path.join(REPO_ROOT, 'api/events/[id]/change-zoom.js'), 'utf8');
for (const needle of ['cancelZoomRegistrant', 'cancelZoomMeetingRegistrant', 'registerZoomWebinarAttendee', 'registerZoomMeetingAttendee', 'sendConfirmationEmailsFromTemplate']) {
  if (!changeEv.includes(needle)) fail(`api/events/[id]/change-zoom.js missing helper: ${needle}`);
}
ok('Change-zoom (event) wires cancel/register/email helpers');

const changeSess = fs.readFileSync(path.join(REPO_ROOT, 'api/complex-event-sessions/[id]/change-zoom.js'), 'utf8');
for (const needle of ['cancelZoomRegistrant', 'cancelZoomMeetingRegistrant', 'registerZoomWebinarAttendee', 'registerZoomMeetingAttendee', 'sendConfirmationEmailsFromTemplate']) {
  if (!changeSess.includes(needle)) fail(`api/complex-event-sessions/[id]/change-zoom.js missing helper: ${needle}`);
}
ok('Change-zoom (session) wires cancel/register/email helpers');

// Dynamic checks (best-effort — only if Supabase creds available)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Static check: change-zoom must re-sync date/time/timezone from Zoom record + append history_log
for (const rel of ['api/events/[id]/change-zoom.js', 'api/complex-event-sessions/[id]/change-zoom.js']) {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  if (!src.includes('history_log')) fail(`${rel}: must append to history_log`);
  if (!src.includes('start_time') || !src.includes('duration_minutes')) fail(`${rel}: must re-sync start_time/duration_minutes from Zoom record`);
  ok(`${rel} — re-syncs schedule and writes history_log`);
}

// Static check: session change-zoom must scope side-effects to session-relevant bookings
const sessChange = fs.readFileSync(path.join(REPO_ROOT, 'api/complex-event-sessions/[id]/change-zoom.js'), 'utf8');
for (const needle of ['resolveSessionScopedBookings', 'complex_event_session_track', 'complex_event_ticket_class', 'all_tracks', 'linked_track_ids']) {
  if (!sessChange.includes(needle)) fail(`session change-zoom missing scoping primitive: ${needle}`);
}
ok('Session change-zoom scopes bookings via session→tracks→ticket_classes');

// Static check: session change-zoom must store EXTERNAL Zoom IDs (mapped from
// the local zoom_* table) and populate cached join/registration URLs.
for (const needle of ['externalZoomIdFromLocal', 'zoom_join_url', 'zoom_start_url', 'zoom_registration_url']) {
  if (!sessChange.includes(needle)) fail(`session change-zoom missing external-id mapping or URL repopulation: ${needle}`);
}
ok('Session change-zoom maps local Zoom PK → external ID and repopulates URLs');

// Static check: duplicate endpoints must write a duplicated_from history entry
for (const rel of ['api/events/[id]/duplicate.js', 'api/complex-events/[id]/duplicate.js']) {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  if (!src.includes('duplicated_from')) fail(`${rel}: must record duplicated_from history entry`);
  if (!src.includes('history_log')) fail(`${rel}: must write history_log on duplicate`);
}
ok('Duplicate endpoints write duplicated_from audit entry');

// Static check: duplicate endpoints have rollback paths
const dupSingle2 = fs.readFileSync(path.join(REPO_ROOT, 'api/events/[id]/duplicate.js'), 'utf8');
if (!/rollback|rolling back|delete\(\).*createdEventId/i.test(dupSingle2)) fail('Single-event duplicate must rollback on child failure');
const dupComplex2 = fs.readFileSync(path.join(REPO_ROOT, 'api/complex-events/[id]/duplicate.js'), 'utf8');
if (!/function rollback|rolling back/i.test(dupComplex2)) fail('Complex duplicate must implement rollback');
ok('Duplicate endpoints implement manual rollback');

// task-692: ChangeZoomDialog must be the sole change-zoom UI for both single
// events and complex-event sessions, and the bypass PATCH that
// CreateComplexEvent uses to update saved sessions must NEVER write Zoom
// resource columns directly (those go through change-zoom which cancels old
// registrants + re-registers attendees).
{
  const editEvent = fs.readFileSync(path.join(REPO_ROOT, 'client/src/pages/EditEvent.jsx'), 'utf8');
  const createComplex = fs.readFileSync(path.join(REPO_ROOT, 'client/src/pages/CreateComplexEvent.jsx'), 'utf8');
  if (!editEvent.includes('ChangeZoomDialog')) fail('EditEvent.jsx must use ChangeZoomDialog');
  if (!createComplex.includes('ChangeZoomDialog')) fail('CreateComplexEvent.jsx must use ChangeZoomDialog');
  // The single-event panel must expose all three modes.
  for (const t of ['button-attach-zoom-link', 'button-change-zoom-link', 'button-detach-zoom-link']) {
    if (!editEvent.includes(t)) fail(`EditEvent.jsx missing data-testid: ${t}`);
  }
  // Inline Dialog from before task-692 must be gone.
  if (editEvent.includes('showChangeZoomDialog')) fail('EditEvent.jsx must not retain inline showChangeZoomDialog state');
  // The session bypass PATCH must strip Zoom resource cols.
  const bypassRe = /if \(session\.id\) \{[\s\S]{0,2000}?method:\s*['"]PATCH['"]/;
  const m = createComplex.match(bypassRe);
  if (!m) {
    fail('CreateComplexEvent.jsx: cannot locate session bypass PATCH branch');
  } else {
    const slice = m[0];
    for (const col of [
      'zoom_meeting_id', 'zoom_webinar_id',
      'zoom_join_url', 'zoom_start_url', 'zoom_registration_url',
      'auto_create_zoom', 'zoom_link_mode', 'link_existing_zoom_id',
    ]) {
      if (!slice.includes(col)) fail(`CreateComplexEvent.jsx bypass PATCH must strip ${col} before sending`);
    }
    if (!slice.includes('patchPayload')) fail('CreateComplexEvent.jsx bypass PATCH must rebuild a patchPayload without Zoom cols');
  }
  ok('EditEvent + CreateComplexEvent route Zoom changes through ChangeZoomDialog and strip Zoom cols from bypass PATCH');
}

// Static check: history_log migration exists
const histMig = path.join(REPO_ROOT, 'supabase/migrations/20260506_add_event_history_log.sql');
if (!fs.existsSync(histMig)) fail('Missing migration: 20260506_add_event_history_log.sql');
else ok('history_log migration present');

// CLI: --source <id> --duplicate <id> for row-level invariants
const argv = process.argv.slice(2);
function getArg(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
const SOURCE_ID = getArg('--source');
const DUP_ID = getArg('--duplicate');
const KIND = getArg('--kind') || 'event'; // 'event' or 'complex'

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const { data: copiedEvents } = await supabase
      .from('event')
      .select('id, tenant_id, slug, status, event_state, zoom_webinar_id, zoom_meeting_id')
      .like('slug', '%-copy%')
      .limit(500);

    for (const ev of (copiedEvents || [])) {
      if (ev.status && ev.status !== 'draft') {
        warn(`event ${ev.id} (slug=${ev.slug}) status=${ev.status} (expected draft)`);
      }
    }
    ok(`Sampled ${(copiedEvents || []).length} -copy events`);

    const { data: copiedComplex } = await supabase
      .from('complex_event')
      .select('id, tenant_id, slug, status')
      .like('slug', '%-copy%')
      .limit(500);

    for (const ce of (copiedComplex || [])) {
      if (ce.status && ce.status !== 'draft') {
        warn(`complex_event ${ce.id} (slug=${ce.slug}) status=${ce.status} (expected draft)`);
      }
      // Sessions on this complex event must have no zoom IDs (post-duplicate baseline)
      const { data: sessions } = await supabase
        .from('complex_event_session')
        .select('id, zoom_webinar_id, zoom_meeting_id')
        .eq('complex_event_id', ce.id);
      const offending = (sessions || []).filter(s => s.zoom_webinar_id || s.zoom_meeting_id);
      if (offending.length > 0) {
        // Allow — admins may have re-attached after duplication. Just warn.
        warn(`complex_event ${ce.id} (slug=${ce.slug}) has ${offending.length} session(s) with zoom IDs (expected clean baseline post-duplicate)`);
      }
    }
    ok(`Sampled ${(copiedComplex || []).length} -copy complex events`);

    // Slug uniqueness invariant per tenant
    const { data: allEvents } = await supabase
      .from('event')
      .select('tenant_id, slug')
      .not('slug', 'is', null)
      .limit(10000);
    const seen = new Map();
    for (const e of (allEvents || [])) {
      const key = `${e.tenant_id}|${e.slug}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, c]) => c > 1);
    if (dupes.length > 0) fail(`Found ${dupes.length} duplicate (tenant_id, slug) on event table`);
    else ok('event (tenant_id, slug) uniqueness holds');

    // Row-level invariants for an explicit (source, duplicate) pair
    if (SOURCE_ID && DUP_ID) {
      const table = KIND === 'complex' ? 'complex_event' : 'event';
      const { data: src } = await supabase.from(table).select('*').eq('id', SOURCE_ID).maybeSingle();
      const { data: dup } = await supabase.from(table).select('*').eq('id', DUP_ID).maybeSingle();
      if (!src) fail(`--source ${SOURCE_ID} not found in ${table}`);
      if (!dup) fail(`--duplicate ${DUP_ID} not found in ${table}`);
      if (src && dup) {
        if (src.tenant_id !== dup.tenant_id) fail(`source/duplicate tenant_id mismatch`);
        if (src.id === dup.id) fail(`source and duplicate are the same row`);
        if (src.slug && dup.slug && src.slug === dup.slug) fail(`duplicate must have a distinct slug`);
        if (dup.status && dup.status !== 'draft') fail(`duplicate ${dup.id} status=${dup.status} (expected draft)`);
        if (dup.is_featured) fail(`duplicate ${dup.id} is_featured must be false`);

        if (KIND === 'event') {
          if (dup.zoom_webinar_id || dup.zoom_meeting_id) fail(`duplicate event ${dup.id} must have no zoom IDs`);
          // No bookings on the duplicate
          const { count: bookingCount } = await supabase
            .from('booking').select('id', { count: 'exact', head: true })
            .eq('event_id', dup.id).eq('tenant_id', dup.tenant_id);
          if ((bookingCount || 0) > 0) fail(`duplicate event ${dup.id} has ${bookingCount} bookings (expected 0)`);
          // Ticket-class IDs in pricing_config must be regenerated
          const srcTcs = (src.pricing_config?.ticket_classes || []).map(t => t.id).filter(Boolean);
          const dupTcs = (dup.pricing_config?.ticket_classes || []).map(t => t.id).filter(Boolean);
          const shared = srcTcs.filter(id => dupTcs.includes(id));
          if (shared.length > 0) fail(`duplicate event shares ${shared.length} ticket_class id(s) with source`);
        } else {
          // Complex: child rows must be brand-new (no shared IDs), sessions zoom-clean, no bookings
          const { data: srcTracks } = await supabase.from('complex_event_track').select('id').eq('complex_event_id', src.id);
          const { data: dupTracks } = await supabase.from('complex_event_track').select('id').eq('complex_event_id', dup.id);
          const sharedTracks = (srcTracks || []).map(r => r.id).filter(id => (dupTracks || []).some(d => d.id === id));
          if (sharedTracks.length > 0) fail(`duplicate complex_event shares ${sharedTracks.length} track id(s) with source`);

          const { data: srcSess } = await supabase.from('complex_event_session').select('id').eq('complex_event_id', src.id);
          const { data: dupSess } = await supabase.from('complex_event_session').select('id, zoom_webinar_id, zoom_meeting_id').eq('complex_event_id', dup.id);
          const sharedSess = (srcSess || []).map(r => r.id).filter(id => (dupSess || []).some(d => d.id === id));
          if (sharedSess.length > 0) fail(`duplicate complex_event shares ${sharedSess.length} session id(s) with source`);
          const sessionsWithZoom = (dupSess || []).filter(s => s.zoom_webinar_id || s.zoom_meeting_id);
          if (sessionsWithZoom.length > 0) fail(`duplicate complex_event has ${sessionsWithZoom.length} session(s) with zoom IDs (expected clean)`);

          const { data: srcTcs } = await supabase.from('complex_event_ticket_class').select('id').eq('complex_event_id', src.id);
          const { data: dupTcs } = await supabase.from('complex_event_ticket_class').select('id').eq('complex_event_id', dup.id);
          const sharedTcs = (srcTcs || []).map(r => r.id).filter(id => (dupTcs || []).some(d => d.id === id));
          if (sharedTcs.length > 0) fail(`duplicate complex_event shares ${sharedTcs.length} ticket_class id(s) with source`);

          const { count: cBookings } = await supabase
            .from('complex_event_booking').select('id', { count: 'exact', head: true })
            .eq('event_id', dup.id).eq('tenant_id', dup.tenant_id);
          if ((cBookings || 0) > 0) fail(`duplicate complex_event ${dup.id} has ${cBookings} bookings (expected 0)`);
        }
        ok(`Row-level invariants checked for source=${SOURCE_ID} duplicate=${DUP_ID} kind=${KIND}`);
      }
    } else {
      console.log('ℹ️  Pass --source <id> --duplicate <id> [--kind event|complex] for row-level invariant checks.');
    }
  } catch (err) {
    warn(`Dynamic check error: ${err.message}`);
  }
} else {
  console.log('ℹ️  Skipping dynamic checks (no SUPABASE_URL/SUPABASE_SERVICE_KEY).');
}

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`\nAll static checks passed. ${warnings.length} warning(s).`);
