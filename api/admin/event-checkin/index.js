import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  resolveCheckinToken,
  markCheckin,
  undoCheckin,
  getActorLabel,
  ensureComplexSessionTokens,
  ensureBookingToken,
  getSpeakersByIds,
  getMemberPhotosByEmails,
  buildEventCheckinFlagMap,
} from '../../_lib/checkinService.js';

const FEATURE_ID = 'events.event-checkin';

async function authorize(req, res) {
  const context = await getTenantContext(req);
  if (!context.isAuthenticated) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!context.tenantId) {
    res.status(400).json({ error: 'Tenant context not found' });
    return null;
  }
  if (await hasAdminAccess(context)) {
    return context;
  }
  if (!context.roleId) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  const allowed = await hasFeatureAccess(context.roleId, FEATURE_ID);
  if (!allowed) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return context;
}

function sanitizeResolved(resolved) {
  if (!resolved) return null;
  return {
    type: resolved.type,
    token: resolved.token,
    attendee: resolved.attendee,
    event: resolved.event
      ? {
          id: resolved.event.id,
          title: resolved.event.title,
          start_date: resolved.event.start_date,
          location: resolved.event.location,
          is_online: resolved.event.is_online,
        }
      : null,
    session: resolved.session
      ? {
          id: resolved.session.id,
          title: resolved.session.title,
          start_time: resolved.session.start_time,
          end_time: resolved.session.end_time,
          location: resolved.session.location,
          track_name: resolved.session.track_name,
          is_online: resolved.session.is_online,
        }
      : null,
    ticketClassName: resolved.ticketClassName,
    bookingReference: resolved.bookingReference,
    isOnline: resolved.isOnline,
    checkedInAt: resolved.checkedInAt,
    checkedInBy: resolved.checkedInBy,
    alreadyCheckedIn: resolved.alreadyCheckedIn,
    flags: Array.isArray(resolved.flags) ? resolved.flags : [],
  };
}

/** Assert a resolved token belongs to the caller's tenant. */
function tokenInTenant(resolved, context) {
  return resolved && resolved.tenantId && resolved.tenantId === context.tenantId;
}

export default async function handler(req, res) {
  const context = await authorize(req, res);
  if (!context) return;

  try {
    if (req.method === 'GET') {
      const action = (req.query.action || '').toString();

      if (action === 'events') {
        return await listEvents(req, res, context);
      }

      const token = (req.query.token || '').toString().trim();
      if (token) {
        const resolved = await resolveCheckinToken(token);
        if (!resolved || !tokenInTenant(resolved, context)) {
          return res.status(404).json({ error: 'Invalid check-in token' });
        }
        return res.status(200).json({ data: sanitizeResolved(resolved) });
      }

      const eventId = (req.query.eventId || '').toString().trim();
      if (eventId) {
        return await dashboard(req, res, context);
      }

      return res.status(400).json({ error: 'Missing token, eventId, or action' });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = (body.action || '').toString();
      const token = (body.token || '').toString().trim();
      if (!token) return res.status(400).json({ error: 'Missing token' });

      const resolved = await resolveCheckinToken(token);
      if (!resolved || !tokenInTenant(resolved, context)) {
        return res.status(404).json({ error: 'Invalid check-in token' });
      }

      if (action === 'undo') {
        const reason = (body.reason || '').toString().trim();
        if (!reason) {
          return res.status(400).json({ error: 'A reason is required to deregister an attendee' });
        }
        const result = await undoCheckin(token, {
          reason,
          actorLabel: getActorLabel(context),
        });
        return res.status(200).json({ data: sanitizeResolved(result.resolved) });
      }

      // default: mark / manual_mark
      const result = await markCheckin(token, getActorLabel(context));
      if (!result.ok) {
        if (result.reason === 'online_event') {
          return res.status(400).json({ error: 'Online events cannot be checked in' });
        }
        return res.status(404).json({ error: 'Invalid check-in token' });
      }
      return res.status(200).json({
        data: sanitizeResolved(result.resolved),
        alreadyCheckedIn: result.alreadyCheckedIn,
      });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[event-checkin] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Picker data: in-person simple events + in-person complex events. */
async function listEvents(req, res, context) {
  // Only surface events whose entrance QR check-in is enabled. The flag
  // (`qr_on_confirmation`) defaults to enabled, so treat NULL or true as on and
  // exclude only rows explicitly set to false.
  const QR_ENABLED_FILTER = 'qr_on_confirmation.is.null,qr_on_confirmation.eq.true';
  const [{ data: events }, { data: complex }] = await Promise.all([
    supabase
      .from('event')
      .select('id, title, start_date, end_date, is_online, is_complex')
      .eq('tenant_id', context.tenantId)
      .eq('is_online', false)
      .or(QR_ENABLED_FILTER)
      .order('start_date', { ascending: false })
      .limit(200),
    supabase
      .from('complex_event')
      .select('id, title, start_date, end_date, is_online')
      .eq('tenant_id', context.tenantId)
      .eq('is_online', false)
      .or(QR_ENABLED_FILTER)
      .order('start_date', { ascending: false })
      .limit(200),
  ]);

  const simple = (events || [])
    .filter((e) => !e.is_complex)
    .map((e) => ({ id: e.id, title: e.title, start_date: e.start_date, end_date: e.end_date, type: 'simple' }));
  const complexList = (complex || []).map((e) => ({
    id: e.id,
    title: e.title,
    start_date: e.start_date,
    end_date: e.end_date,
    type: 'complex',
  }));

  return res.status(200).json({ data: [...simple, ...complexList] });
}

async function dashboard(req, res, context) {
  const eventId = (req.query.eventId || '').toString().trim();
  const eventType = (req.query.eventType || 'simple').toString();
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const sessionFilter = (req.query.sessionId || '').toString().trim();
  const trackFilter = (req.query.trackId || '').toString().trim();

  if (eventType === 'complex') {
    return await complexDashboard(req, res, context, eventId, { search, sessionFilter, trackFilter });
  }

  const { data: event } = await supabase
    .from('event')
    .select('id, title, start_date, location, is_online, tenant_id, speaker_ids')
    .eq('id', eventId)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { data: bookings } = await supabase
    .from('booking')
    .select('id, attendee_first_name, attendee_last_name, attendee_email, designation, buddy, dietary_selections, allergy_selections, accessibility_selections, ticket_class_name, booking_reference, check_in_token, checked_in_at, checked_in_by')
    .eq('event_id', eventId)
    .eq('tenant_id', context.tenantId)
    .eq('status', 'confirmed')
    .order('attendee_last_name', { ascending: true });

  // Build an email -> speaker-name lookup once for the event's speakers, so we
  // can flag speaker attendees in the list without a per-attendee query.
  const speakers = await getSpeakersByIds(event.speaker_ids, context.tenantId);
  const speakerByEmail = new Map();
  for (const s of speakers) {
    const e = (s.email || '').trim().toLowerCase();
    if (e) speakerByEmail.set(e, s.full_name || null);
  }

  // Lazily ensure every confirmed in-person booking has a check-in token, so a
  // booking created before tokens existed (or whose token generation failed)
  // can still be checked in from the dashboard. Online events stay token-free.
  if (!event.is_online) {
    const missing = (bookings || []).filter((b) => !b.check_in_token);
    for (const b of missing) {
      const token = await ensureBookingToken(b.id, context.tenantId);
      if (token) b.check_in_token = token;
    }
  }

  const [flagMap, photoByEmail] = await Promise.all([
    buildEventCheckinFlagMap({ tenantId: context.tenantId, eventIds: [eventId] }),
    getMemberPhotosByEmails(
      (bookings || []).map((b) => b.attendee_email),
      context.tenantId
    ),
  ]);

  let attendees = (bookings || []).map((b) => {
    const email = (b.attendee_email || '').trim().toLowerCase();
    const isSpeaker = speakerByEmail.has(email);
    return {
      token: b.check_in_token,
      bookingId: b.id,
      first_name: b.attendee_first_name,
      last_name: b.attendee_last_name,
      email: b.attendee_email,
      designation: b.designation || null,
      buddy: !!b.buddy,
      dietary_selections: b.dietary_selections || null,
      allergy_selections: b.allergy_selections || null,
      accessibility_selections: b.accessibility_selections || null,
      isSpeaker,
      speakerName: isSpeaker ? speakerByEmail.get(email) : null,
      profile_photo_url: photoByEmail.get(email) || null,
      ticket_class_name: b.ticket_class_name,
      booking_reference: b.booking_reference,
      checked_in_at: b.checked_in_at,
      checked_in_by: b.checked_in_by,
      flags: flagMap.get(`${eventId}::${email}`) || [],
    };
  });

  const total = attendees.length;
  const attended = attendees.filter((a) => a.checked_in_at).length;

  if (search) {
    attendees = attendees.filter((a) =>
      [a.first_name, a.last_name, a.email, a.booking_reference]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(search))
    );
  }

  return res.status(200).json({
    data: {
      event: { id: event.id, title: event.title, start_date: event.start_date, location: event.location, type: 'simple' },
      counts: { total, attended },
      tracks: [],
      sessions: [],
      attendees,
    },
  });
}

async function complexDashboard(req, res, context, eventId, filters) {
  const { search, sessionFilter, trackFilter } = filters;

  const { data: event } = await supabase
    .from('complex_event')
    .select('id, title, start_date, location, is_online, tenant_id')
    .eq('id', eventId)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Lazily ensure per-session tokens exist for all confirmed bookings so the
  // dashboard reflects every registered attendee/session.
  const { data: confirmedBookings } = await supabase
    .from('complex_event_booking')
    .select('id, tenant_id, event_id, ticket_class_id, attendee_first_name, attendee_last_name, attendee_email, designation, buddy, dietary_selections, allergy_selections, accessibility_selections, ticket_class_name, booking_reference')
    .eq('event_id', eventId)
    .eq('tenant_id', context.tenantId)
    .eq('status', 'confirmed');

  for (const cb of confirmedBookings || []) {
    await ensureComplexSessionTokens(cb, context.tenantId);
  }

  const [{ data: tracks }, { data: sessions }] = await Promise.all([
    supabase.from('complex_event_track').select('id, name').eq('complex_event_id', eventId).eq('tenant_id', context.tenantId),
    supabase
      .from('complex_event_session')
      .select('id, title, start_time, complex_event_track_id, is_online, speaker_ids')
      .eq('complex_event_id', eventId)
      .eq('tenant_id', context.tenantId)
      .eq('is_online', false)
      .order('start_time', { ascending: true }),
  ]);

  // Speakers are configured per-session for complex events. Batch-fetch every
  // speaker referenced across the in-person sessions, then resolve per row by
  // matching the attendee's email against that session's speakers.
  const allSpeakerIds = [
    ...new Set(
      (sessions || []).flatMap((s) => (Array.isArray(s.speaker_ids) ? s.speaker_ids : []))
    ),
  ];
  const speakerRows = await getSpeakersByIds(allSpeakerIds, context.tenantId);
  const speakerById = new Map(speakerRows.map((s) => [s.id, s]));

  let checkinQuery = supabase
    .from('complex_event_session_checkin')
    .select('id, booking_id, session_id, token, checked_in_at, checked_in_by')
    .eq('complex_event_id', eventId)
    .eq('tenant_id', context.tenantId);
  if (sessionFilter) checkinQuery = checkinQuery.eq('session_id', sessionFilter);
  const { data: checkins } = await checkinQuery;

  const [flagMap, photoByEmail] = await Promise.all([
    buildEventCheckinFlagMap({ tenantId: context.tenantId, eventIds: [eventId] }),
    getMemberPhotosByEmails(
      (confirmedBookings || []).map((cb) => cb.attendee_email),
      context.tenantId
    ),
  ]);

  const bookingById = {};
  for (const cb of confirmedBookings || []) bookingById[cb.id] = cb;
  const sessionById = {};
  for (const s of sessions || []) sessionById[s.id] = s;
  const trackNameById = {};
  for (const t of tracks || []) trackNameById[t.id] = t.name;

  let rows = (checkins || [])
    .filter((c) => sessionById[c.session_id]) // in-person sessions only
    .filter((c) => bookingById[c.booking_id]) // confirmed bookings only
    .map((c) => {
      const cb = bookingById[c.booking_id];
      const s = sessionById[c.session_id];
      const email = (cb.attendee_email || '').trim().toLowerCase();
      const sessSpeakerIds = Array.isArray(s.speaker_ids) ? s.speaker_ids : [];
      let isSpeaker = false;
      let speakerName = null;
      for (const sid of sessSpeakerIds) {
        const sp = speakerById.get(sid);
        if (sp && (sp.email || '').trim().toLowerCase() === email && email) {
          isSpeaker = true;
          speakerName = sp.full_name || null;
          break;
        }
      }
      return {
        token: c.token,
        bookingId: c.booking_id,
        sessionId: c.session_id,
        session_title: s.title,
        track_id: s.complex_event_track_id,
        track_name: trackNameById[s.complex_event_track_id] || null,
        first_name: cb.attendee_first_name,
        last_name: cb.attendee_last_name,
        email: cb.attendee_email,
        designation: cb.designation || null,
        buddy: !!cb.buddy,
        dietary_selections: cb.dietary_selections || null,
        allergy_selections: cb.allergy_selections || null,
        accessibility_selections: cb.accessibility_selections || null,
        isSpeaker,
        speakerName,
        profile_photo_url: photoByEmail.get(email) || null,
        ticket_class_name: cb.ticket_class_name,
        booking_reference: cb.booking_reference,
        checked_in_at: c.checked_in_at,
        checked_in_by: c.checked_in_by,
        flags: flagMap.get(`${eventId}::${email}`) || [],
      };
    });

  if (trackFilter) rows = rows.filter((r) => r.track_id === trackFilter);
  if (sessionFilter) rows = rows.filter((r) => r.sessionId === sessionFilter);

  const total = rows.length;
  const attended = rows.filter((r) => r.checked_in_at).length;

  if (search) {
    rows = rows.filter((r) =>
      [r.first_name, r.last_name, r.email, r.booking_reference, r.session_title]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(search))
    );
  }

  return res.status(200).json({
    data: {
      event: { id: event.id, title: event.title, start_date: event.start_date, location: event.location, type: 'complex' },
      counts: { total, attended },
      tracks: (tracks || []).map((t) => ({ id: t.id, name: t.name })),
      sessions: (sessions || []).map((s) => ({ id: s.id, title: s.title, track_id: s.complex_event_track_id })),
      attendees: rows,
    },
  });
}
