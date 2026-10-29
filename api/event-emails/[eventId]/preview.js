// Admin-only preview of an event confirmation/reminder email.
// Accepts the CURRENT draft subject/body from the editor (unsaved is fine)
// and returns the fully rendered subject + HTML using the exact same
// placeholder-substitution pipeline the real send uses — including the
// day-grouped session schedule for complex events — with clearly-labelled
// sample attendee/booking values. Render-only: no send, no token generation.

import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { renderEventEmailPreview } from '../../_lib/eventConfirmationEmail.js';
import { loadFollowUpEvent, loadFollowUpProgramme, calculateBookingFollowUps } from '../../_lib/eventFollowUps.js';
import { renderFollowUp } from '../../_lib/eventFollowUpRendering.js';
import { validateFollowUpConfig } from '../../_lib/eventFollowUpTargets.js';
import { listPreviewAttendees, loadPreviewBooking } from '../../_lib/eventEmailPreviewAttendees.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
  if (!ctx.tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { eventId } = req.query;
  if (!eventId) return res.status(400).json({ error: 'Event ID is required' });

  const { subject, body } = req.body || {};
  if (req.body?.action === 'attendees') {
    try {
      return res.status(200).json(await listPreviewAttendees(supabase, ctx.tenantId, eventId, req.body.search, req.body.offset));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to load attendees' });
    }
  }
  if (typeof subject !== 'string' && typeof body !== 'string') {
    return res.status(400).json({ error: 'subject or body is required' });
  }

  try {
    const previewBooking = req.body?.bookingId
      ? await loadPreviewBooking(supabase, ctx.tenantId, eventId, req.body.bookingId)
      : null;
    if (req.body?.reminder?.email_type === 'follow_up') {
      try { validateFollowUpConfig(req.body.reminder); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      const event = await loadFollowUpEvent(supabase, eventId);
      if (event.tenant_id !== ctx.tenantId) return res.status(404).json({ error: 'Event not found' });
      const programme = await loadFollowUpProgramme(supabase, event);
      const booking = { event_id: event.id, status: 'confirmed', attendee_first_name: 'Jane',
        attendee_last_name: 'Example', attendee_email: 'jane.example@example.com',
        booking_reference: 'SAMPLE-REF-001', ticket_class_id: req.body.ticketClassId || null };
      const email = { ...req.body.reminder, subject, body,
        event_survey_assignment_id: req.body.event_survey_assignment_id || null };
      const calculation = calculateBookingFollowUps(event, email, programme, booking, new Date());
      const target = req.body.sessionId ? calculation.eligible.find(t => t.key === req.body.sessionId) : calculation.eligible[0];
      const reminderContext = {
        isFollowUp: true, scope: email.follow_up_scope, timezone: calculation.timezone,
        ticketClasses: programme.tickets.map(t => ({ id: t.id, name: t.name })),
        selectedTicketClassId: booking.ticket_class_id,
        entries: calculation.eligible.map(t => ({ id: t.key, sessionId: t.key, sessionDate: t.end.toISOString(),
          description: t.label, sendAt: t.scheduledTime.toISOString() })),
        selectedId: target?.key || null, sendAt: target?.scheduledTime.toISOString() || null,
        emptyReason: target ? null : event.is_complex && email.follow_up_scope !== 'event' && !booking.ticket_class_id
          ? 'Choose a sample ticket class to preview entitled day/session follow-ups.'
          : 'No eligible future follow-up. Check explicit end times, ticket entitlement and delay; missed send times are not caught up.',
        warnings: calculation.skipped,
      };
      const rendered = target ? await renderFollowUp(supabase,
        { event, booking, programme, target, timezone: calculation.timezone }, email) : { subject: '', html: '' };
      return res.status(200).json({ ...rendered, is_complex: event.is_complex, reminderContext });
    }
    const result = await renderEventEmailPreview({
      previewBooking,
      eventId,
      tenantId: ctx.tenantId,
      subject: typeof subject === 'string' ? subject : '',
      body: typeof body === 'string' ? body : '',
      event_survey_assignment_id: req.body?.event_survey_assignment_id || null,
      reminder: req.body?.reminder,
      sessionId: req.body?.sessionId || null,
    });
    if (!result.found) return res.status(404).json({ error: 'Event not found' });
    return res.status(200).json({
      subject: result.subject,
      html: result.html,
      is_complex: result.isComplex,
      reminderContext: result.reminderContext,
      attendee: result.attendee,
      previewNotice: result.previewNotice,
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.code === 'ZOOM_EMAIL_LINK_UNAVAILABLE') return res.status(409).json({ error: err.message });
    if (err.message?.startsWith('Event survey:')) return res.status(400).json({ error: err.message });
    console.error('[event-emails preview] Error:', err);
    return res.status(500).json({ error: 'Failed to render preview' });
  }
}
