import crypto from 'crypto';
import { supabase } from './database.js';
import { coerceBooleanPreferenceValue } from './booleanCoercion.js';

/**
 * Event QR check-in service.
 *
 * Two token families:
 *  - SIMPLE events: one token per booking, stored on `booking.check_in_token`.
 *  - COMPLEX events: one token per (booking, session) the attendee is
 *    registered for, stored in `complex_event_session_checkin.token`.
 *
 * Online events / online sessions never get a token (the feature is gated on
 * in-person delivery), so a token simply not existing is the natural guard.
 */

export function generateCheckinToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Resolve the public app base URL. Prefer the request host (so per-tenant
 * subdomains keep working), fall back to the configured app URL.
 */
export function getAppBaseUrl(req) {
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host) {
      return `${proto}://${host}`.replace(/\/$/, '');
    }
  }
  return (process.env.VITE_APP_URL || process.env.APP_URL || 'https://iconn.app').replace(/\/$/, '');
}

/** The staff check-in screen URL the QR encodes. */
export function buildCheckinUrl(token, req) {
  return `${getAppBaseUrl(req)}/EventCheckIn?token=${encodeURIComponent(token)}`;
}

/** Hosted QR PNG URL (safe to embed in email — not a data URI). */
export function buildQrImageUrl(token, req) {
  return `${getAppBaseUrl(req)}/api/public/checkin-qr?token=${encodeURIComponent(token)}`;
}

/** Human-readable label for who performed a check-in. */
export function getActorLabel(context) {
  if (!context) return 'unknown';
  if (context.tenantUserId) return `tenant_user:${context.tenantUserId}`;
  if (context.memberId) return `member:${context.memberId}`;
  return 'unknown';
}

/**
 * Ensure a simple booking has a check-in token, creating one if missing.
 * Returns the token, or null if the booking is ineligible (online or not
 * confirmed).
 */
export async function ensureBookingToken(bookingId, tenantId = null) {
  if (!supabase || !bookingId) return null;

  let query = supabase
    .from('booking')
    .select('id, event_id, status, check_in_token, tenant_id')
    .eq('id', bookingId);
  if (tenantId) query = query.eq('tenant_id', tenantId);

  const { data: booking, error } = await query.maybeSingle();
  if (error || !booking) return null;
  if (booking.status !== 'confirmed') return null;

  const { data: event } = await supabase
    .from('event')
    .select('id, is_online')
    .eq('id', booking.event_id)
    .maybeSingle();
  if (!event || event.is_online) return null;

  if (booking.check_in_token) return booking.check_in_token;

  const token = generateCheckinToken();
  const { data: updated, error: updErr } = await supabase
    .from('booking')
    .update({ check_in_token: token })
    .eq('id', booking.id)
    .is('check_in_token', null)
    .select('check_in_token')
    .maybeSingle();
  // On error OR a 0-row update (lost a race — another request set it first),
  // re-read the now-persisted token rather than returning our unpersisted one.
  if (updErr || !updated) {
    const { data: fresh } = await supabase
      .from('booking')
      .select('check_in_token')
      .eq('id', booking.id)
      .maybeSingle();
    return fresh?.check_in_token || null;
  }
  return updated.check_in_token;
}

/**
 * For a complex booking, return the in-person sessions the attendee is
 * registered for (via their ticket class's linked tracks), each with a
 * track name and the session details. Online sessions are excluded.
 */
export async function getComplexRegisteredSessions(complexEventId, ticketClassId, tenantId = null) {
  if (!supabase || !complexEventId) return [];

  let allTracks = false;
  let linkedTrackIds = [];
  if (ticketClassId) {
    const { data: tc } = await supabase
      .from('complex_event_ticket_class')
      .select('id, all_tracks, linked_track_ids')
      .eq('id', ticketClassId)
      .maybeSingle();
    if (tc) {
      allTracks = !!tc.all_tracks;
      linkedTrackIds = Array.isArray(tc.linked_track_ids) ? tc.linked_track_ids : [];
    }
  }

  let sessionQuery = supabase
    .from('complex_event_session')
    .select('id, title, start_time, end_time, location, is_online, complex_event_track_id, complex_event_id, tenant_id')
    .eq('complex_event_id', complexEventId)
    .order('start_time', { ascending: true });
  if (tenantId) sessionQuery = sessionQuery.eq('tenant_id', tenantId);

  if (!allTracks && linkedTrackIds.length > 0) {
    sessionQuery = sessionQuery.in('complex_event_track_id', linkedTrackIds);
  } else if (!allTracks && ticketClassId) {
    // Ticket class restricts to specific tracks but has none linked -> no sessions.
    return [];
  }

  const { data: sessions } = await sessionQuery;
  if (!sessions || sessions.length === 0) return [];

  // In-person sessions only.
  const inPerson = sessions.filter((s) => !s.is_online);
  if (inPerson.length === 0) return [];

  const trackIds = [...new Set(inPerson.map((s) => s.complex_event_track_id).filter(Boolean))];
  let trackNames = {};
  if (trackIds.length > 0) {
    const { data: tracks } = await supabase
      .from('complex_event_track')
      .select('id, name')
      .in('id', trackIds);
    for (const t of tracks || []) trackNames[t.id] = t.name;
  }

  return inPerson.map((s) => ({
    ...s,
    track_name: trackNames[s.complex_event_track_id] || null,
  }));
}

/**
 * Ensure per-session check-in tokens exist for a complex booking. Returns an
 * array of { session, token, checked_in_at } for the in-person registered
 * sessions. Skips entirely (returns []) when no in-person sessions apply.
 */
export async function ensureComplexSessionTokens(complexBooking, tenantId = null) {
  if (!supabase || !complexBooking?.id) return [];
  const complexEventId = complexBooking.event_id;
  const tid = tenantId || complexBooking.tenant_id;

  const sessions = await getComplexRegisteredSessions(
    complexEventId,
    complexBooking.ticket_class_id || complexBooking.ticketClassId,
    tid
  );
  if (sessions.length === 0) return [];

  const { data: existingRows } = await supabase
    .from('complex_event_session_checkin')
    .select('id, session_id, token, checked_in_at')
    .eq('booking_id', complexBooking.id);
  const existingBySession = {};
  for (const r of existingRows || []) existingBySession[r.session_id] = r;

  const result = [];
  for (const session of sessions) {
    let row = existingBySession[session.id];
    if (!row) {
      const token = generateCheckinToken();
      const { data: inserted, error } = await supabase
        .from('complex_event_session_checkin')
        .insert({
          tenant_id: tid,
          complex_event_id: complexEventId,
          booking_id: complexBooking.id,
          session_id: session.id,
          token,
        })
        .select('id, session_id, token, checked_in_at')
        .maybeSingle();
      if (error) {
        // Likely a unique-constraint race — re-read.
        const { data: fresh } = await supabase
          .from('complex_event_session_checkin')
          .select('id, session_id, token, checked_in_at')
          .eq('booking_id', complexBooking.id)
          .eq('session_id', session.id)
          .maybeSingle();
        row = fresh;
      } else {
        row = inserted;
      }
    }
    if (row) {
      result.push({ session, token: row.token, checked_in_at: row.checked_in_at });
    }
  }
  return result;
}

/**
 * Determine whether an attendee is a registered speaker for an event/session.
 * Matches the attendee's email (case-insensitive) against the `speaker` rows
 * whose id is in `speakerIds`, scoped to the booking's tenant. Returns the
 * matching speaker row ({ id, full_name }) or null.
 */
async function resolveSpeakerForAttendee(attendeeEmail, speakerIds, tenantId) {
  if (!supabase) return null;
  const email = (attendeeEmail || '').trim().toLowerCase();
  if (!email) return null;
  if (!Array.isArray(speakerIds) || speakerIds.length === 0) return null;

  let query = supabase
    .from('speaker')
    .select('id, full_name, email')
    .in('id', speakerIds)
    .ilike('email', email);
  if (tenantId) query = query.eq('tenant_id', tenantId);

  const { data } = await query.limit(1).maybeSingle();
  return data || null;
}

/**
 * Batch-fetch speaker rows for a set of speaker ids, scoped to a tenant.
 * Used by the check-in dashboard/list to resolve speaker status for many
 * attendees without a per-attendee query. Returns the raw rows
 * ({ id, full_name, email }); callers build whatever lookup they need.
 */
export async function getSpeakersByIds(speakerIds, tenantId = null) {
  if (!supabase) return [];
  if (!Array.isArray(speakerIds) || speakerIds.length === 0) return [];

  let query = supabase
    .from('speaker')
    .select('id, full_name, email')
    .in('id', speakerIds);
  if (tenantId) query = query.eq('tenant_id', tenantId);

  const { data } = await query;
  return data || [];
}

/**
 * Resolve a check-in token to its attendee + event (+ session) details.
 * Returns null when the token is unknown. Tries the simple-booking table
 * first, then the complex per-session table.
 */
export async function resolveCheckinToken(token) {
  if (!supabase || !token) return null;

  // Simple booking
  const { data: booking } = await supabase
    .from('booking')
    .select('id, event_id, tenant_id, attendee_first_name, attendee_last_name, attendee_email, designation, dietary_selections, allergy_selections, accessibility_selections, ticket_class_name, booking_reference, status, check_in_token, checked_in_at, checked_in_by')
    .eq('check_in_token', token)
    .maybeSingle();

  if (booking) {
    const { data: event } = await supabase
      .from('event')
      .select('id, title, start_date, location, is_online, tenant_id, speaker_ids')
      .eq('id', booking.event_id)
      .maybeSingle();
    const [speaker, flags] = await Promise.all([
      resolveSpeakerForAttendee(
        booking.attendee_email,
        event?.speaker_ids,
        booking.tenant_id || event?.tenant_id
      ),
      resolveCheckinFlags({
        tenantId: booking.tenant_id || event?.tenant_id,
        eventId: booking.event_id,
        attendeeEmail: booking.attendee_email,
      }),
    ]);
    return {
      type: 'simple',
      token,
      tenantId: booking.tenant_id,
      booking,
      event: event || null,
      session: null,
      flags,
      attendee: {
        first_name: booking.attendee_first_name,
        last_name: booking.attendee_last_name,
        email: booking.attendee_email,
        designation: booking.designation || null,
        dietary_selections: booking.dietary_selections || null,
        allergy_selections: booking.allergy_selections || null,
        accessibility_selections: booking.accessibility_selections || null,
        isSpeaker: !!speaker,
        speakerName: speaker?.full_name || null,
      },
      ticketClassName: booking.ticket_class_name,
      bookingReference: booking.booking_reference,
      isOnline: !!event?.is_online,
      checkedInAt: booking.checked_in_at,
      checkedInBy: booking.checked_in_by,
      alreadyCheckedIn: !!booking.checked_in_at,
    };
  }

  // Complex per-session check-in
  const { data: ci } = await supabase
    .from('complex_event_session_checkin')
    .select('id, tenant_id, complex_event_id, booking_id, session_id, token, checked_in_at, checked_in_by')
    .eq('token', token)
    .maybeSingle();

  if (ci) {
    const [{ data: cb }, { data: ce }, { data: session }] = await Promise.all([
      supabase
        .from('complex_event_booking')
        .select('id, attendee_first_name, attendee_last_name, attendee_email, designation, dietary_selections, allergy_selections, accessibility_selections, ticket_class_name, booking_reference, status')
        .eq('id', ci.booking_id)
        .maybeSingle(),
      supabase
        .from('complex_event')
        .select('id, title, start_date, location, is_online, tenant_id')
        .eq('id', ci.complex_event_id)
        .maybeSingle(),
      supabase
        .from('complex_event_session')
        .select('id, title, start_time, end_time, location, is_online, complex_event_track_id, speaker_ids')
        .eq('id', ci.session_id)
        .maybeSingle(),
    ]);

    const [speaker, flags] = await Promise.all([
      resolveSpeakerForAttendee(
        cb?.attendee_email,
        session?.speaker_ids,
        ci.tenant_id || ce?.tenant_id
      ),
      resolveCheckinFlags({
        tenantId: ci.tenant_id || ce?.tenant_id,
        eventId: ci.complex_event_id,
        attendeeEmail: cb?.attendee_email,
      }),
    ]);

    let trackName = null;
    if (session?.complex_event_track_id) {
      const { data: track } = await supabase
        .from('complex_event_track')
        .select('name')
        .eq('id', session.complex_event_track_id)
        .maybeSingle();
      trackName = track?.name || null;
    }

    return {
      type: 'complex',
      token,
      tenantId: ci.tenant_id,
      booking: cb || null,
      event: ce || null,
      session: session ? { ...session, track_name: trackName } : null,
      flags,
      attendee: {
        first_name: cb?.attendee_first_name,
        last_name: cb?.attendee_last_name,
        email: cb?.attendee_email,
        designation: cb?.designation || null,
        dietary_selections: cb?.dietary_selections || null,
        allergy_selections: cb?.allergy_selections || null,
        accessibility_selections: cb?.accessibility_selections || null,
        isSpeaker: !!speaker,
        speakerName: speaker?.full_name || null,
      },
      ticketClassName: cb?.ticket_class_name,
      bookingReference: cb?.booking_reference,
      isOnline: !!session?.is_online,
      checkedInAt: ci.checked_in_at,
      checkedInBy: ci.checked_in_by,
      alreadyCheckedIn: !!ci.checked_in_at,
    };
  }

  return null;
}

/**
 * Mark a token as checked in. Returns { ok, alreadyCheckedIn, resolved }.
 * Rejects online events. Idempotent: re-marking an already-checked-in token
 * returns alreadyCheckedIn:true without changing the original timestamp.
 */
export async function markCheckin(token, actorLabel) {
  const resolved = await resolveCheckinToken(token);
  if (!resolved) return { ok: false, reason: 'not_found' };
  if (resolved.isOnline) return { ok: false, reason: 'online_event', resolved };
  if (resolved.alreadyCheckedIn) {
    return { ok: true, alreadyCheckedIn: true, resolved };
  }

  const now = new Date().toISOString();
  if (resolved.type === 'simple') {
    const { data: updated } = await supabase
      .from('booking')
      .update({ checked_in_at: now, checked_in_by: actorLabel })
      .eq('check_in_token', token)
      .is('checked_in_at', null)
      .select('checked_in_at, checked_in_by')
      .maybeSingle();
    if (!updated) {
      const fresh = await resolveCheckinToken(token);
      return { ok: true, alreadyCheckedIn: true, resolved: fresh };
    }
  } else {
    const { data: updated } = await supabase
      .from('complex_event_session_checkin')
      .update({ checked_in_at: now, checked_in_by: actorLabel })
      .eq('token', token)
      .is('checked_in_at', null)
      .select('checked_in_at, checked_in_by')
      .maybeSingle();
    if (!updated) {
      const fresh = await resolveCheckinToken(token);
      return { ok: true, alreadyCheckedIn: true, resolved: fresh };
    }
  }

  const fresh = await resolveCheckinToken(token);
  return { ok: true, alreadyCheckedIn: false, resolved: fresh };
}

/**
 * Undo (reverse) a check-in. Clears the check-in timestamp/actor and records
 * who reversed it, when, and why. This only undoes the check-in — it does NOT
 * touch the underlying booking (no refunds, seat changes, or emails).
 */
export async function undoCheckin(token, { reason = null, actorLabel = null } = {}) {
  const resolved = await resolveCheckinToken(token);
  if (!resolved) return { ok: false, reason: 'not_found' };

  const reversal = {
    checked_in_at: null,
    checked_in_by: null,
    check_in_reversed_at: new Date().toISOString(),
    check_in_reversed_by: actorLabel,
    check_in_reversal_reason: reason,
  };

  if (resolved.type === 'simple') {
    await supabase
      .from('booking')
      .update(reversal)
      .eq('check_in_token', token);
  } else {
    await supabase
      .from('complex_event_session_checkin')
      .update(reversal)
      .eq('token', token);
  }

  const fresh = await resolveCheckinToken(token);
  return { ok: true, resolved: fresh };
}

/**
 * Extract the boolean fields of a form that are flagged for check-in.
 * Returns [{ field_id, label }]. The label prefers the admin-configured
 * `flag_label`, falling back to the field's own label.
 */
function extractFlaggedBooleanFields(fields) {
  const arr = Array.isArray(fields) ? fields : [];
  return arr
    .filter((f) => f && f.type === 'boolean' && f.flag_on_checkin === true && f.id)
    .map((f) => ({
      field_id: f.id,
      label: (f.flag_label && String(f.flag_label).trim()) || f.label || 'Flagged response',
    }));
}

/**
 * Resolve form-driven check-in flags for a single attendee.
 *
 * Loads the event's linked forms (`is_event_related` + `related_event_id`),
 * finds boolean fields marked `flag_on_checkin`, looks up the attendee's
 * submission(s) for that event by lowercased email, and returns a flag entry
 * for each flagged field answered truthy. Returns [] on any miss so callers
 * can spread it unconditionally. Works generically for simple events
 * (eventId = booking.event_id) and complex events (eventId = complex_event_id).
 */
export async function resolveCheckinFlags({ tenantId, eventId, attendeeEmail }) {
  if (!supabase || !tenantId || !eventId || !attendeeEmail) return [];
  const email = String(attendeeEmail).trim().toLowerCase();
  if (!email) return [];

  const { data: forms } = await supabase
    .from('form')
    .select('id, fields')
    .eq('tenant_id', tenantId)
    .eq('is_event_related', true)
    .eq('related_event_id', eventId);
  if (!forms || forms.length === 0) return [];

  const flaggedByForm = new Map();
  const formIds = [];
  for (const form of forms) {
    const flagged = extractFlaggedBooleanFields(form.fields);
    if (flagged.length > 0) {
      flaggedByForm.set(form.id, flagged);
      formIds.push(form.id);
    }
  }
  if (formIds.length === 0) return [];

  const { data: submissions } = await supabase
    .from('form_submission')
    .select('id, form_id, submission_data')
    .eq('tenant_id', tenantId)
    .eq('event_id', eventId)
    .eq('submitted_by_email', email)
    .in('form_id', formIds);
  if (!submissions || submissions.length === 0) return [];

  const flags = [];
  for (const sub of submissions) {
    const flagged = flaggedByForm.get(sub.form_id);
    if (!flagged) continue;
    const data = sub.submission_data || {};
    for (const f of flagged) {
      if (coerceBooleanPreferenceValue(data[f.field_id]) === 'true') {
        flags.push({
          field_id: f.field_id,
          label: f.label,
          form_submission_id: sub.id,
          form_id: sub.form_id,
        });
      }
    }
  }
  return flags;
}

/**
 * Batch variant of resolveCheckinFlags for the check-in dashboard and reports.
 * Given a set of event ids, returns a Map keyed `${eventId}::${lowercased
 * email}` -> [{ field_id, label, form_submission_id, form_id }]. Loads all
 * linked forms and submissions for the events in two queries.
 */
export async function buildEventCheckinFlagMap({ tenantId, eventIds }) {
  const map = new Map();
  if (!supabase || !tenantId || !Array.isArray(eventIds)) return map;
  const ids = [...new Set(eventIds.filter(Boolean))];
  if (ids.length === 0) return map;

  const { data: forms } = await supabase
    .from('form')
    .select('id, fields, related_event_id')
    .eq('tenant_id', tenantId)
    .eq('is_event_related', true)
    .in('related_event_id', ids);
  if (!forms || forms.length === 0) return map;

  const flaggedByForm = new Map();
  const eventByForm = new Map();
  const formIds = [];
  for (const form of forms) {
    const flagged = extractFlaggedBooleanFields(form.fields);
    if (flagged.length > 0) {
      flaggedByForm.set(form.id, flagged);
      eventByForm.set(form.id, form.related_event_id);
      formIds.push(form.id);
    }
  }
  if (formIds.length === 0) return map;

  const { data: submissions } = await supabase
    .from('form_submission')
    .select('id, form_id, submission_data, submitted_by_email, event_id')
    .eq('tenant_id', tenantId)
    .in('event_id', ids)
    .in('form_id', formIds);
  if (!submissions || submissions.length === 0) return map;

  for (const sub of submissions) {
    const flagged = flaggedByForm.get(sub.form_id);
    if (!flagged) continue;
    const eventId = sub.event_id || eventByForm.get(sub.form_id);
    const email = (sub.submitted_by_email || '').trim().toLowerCase();
    if (!eventId || !email) continue;
    const data = sub.submission_data || {};
    for (const f of flagged) {
      if (coerceBooleanPreferenceValue(data[f.field_id]) === 'true') {
        const key = `${eventId}::${email}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
          field_id: f.field_id,
          label: f.label,
          form_submission_id: sub.id,
          form_id: sub.form_id,
        });
      }
    }
  }
  return map;
}
