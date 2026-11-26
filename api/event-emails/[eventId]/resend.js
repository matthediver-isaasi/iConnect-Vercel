import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  isDeliveryId, resendBlockReason, findSupersedingDeliveries,
} from '../../_lib/eventEmailDelivery.js';
import { sendConfirmationEmailsFromTemplate, buildBookingPricingDetails } from '../../_lib/eventConfirmationEmail.js';
import {
  processScheduledEventEmail, SCHEDULED_EVENT_EMAIL_SELECT, SCHEDULED_EMAIL_CLAIM_MESSAGE,
} from '../../cron/send-event-reminders.js';

export const MAX_RESEND_BATCH = 25;
export const RESEND_SOURCE = 'admin_resend';
// Longer than the function's maximum duration, so a crashed request cannot
// leave a lease that another request mistakes for an expired one mid-send.
export const RESEND_LEASE_SECONDS = 600;
const CLAIM_REASONS = {
  not_found: 'Send not found',
  not_failed: 'Delivered or accepted by the provider — cannot be resent',
  in_progress: 'A resend for this recipient is already in progress',
  already_resent: 'Already resent',
};

const CONFIRMATION_TYPES = ['confirmation', 'booking_confirmation'];
const SCHEDULED_TYPES = ['reminder', 'follow_up'];
const sameFamily = (a, b) => (CONFIRMATION_TYPES.includes(a) && CONFIRMATION_TYPES.includes(b)) || a === b;

// Admin-triggered resend of failed / not-sent event emails from the delivery
// list. Nothing here runs automatically: every call is an explicit admin
// request for specific ledger rows. Each resend goes through the normal tracked
// send path, so it creates a new ledger row; the original failed row is kept.
export function createResendHandler({
  db = supabase,
  getContext = getTenantContext,
  isAdmin = hasAdminAccess,
  sendConfirmation = sendConfirmationEmailsFromTemplate,
  processScheduled = processScheduledEventEmail,
} = {}) {
  async function resendConfirmation(ctx, eventTable, eventId, setting, row) {
    if (!setting.is_enabled) return { outcome: 'skipped', reason: 'This confirmation email is turned off' };
    const bookingTable = eventTable === 'complex_event' ? 'complex_event_booking' : 'booking';
    const { data: booking, error } = await db.from(bookingTable).select('*')
      .eq('id', row.booking_id).eq('event_id', eventId).maybeSingle();
    if (error) throw error;
    if (!booking || (booking.tenant_id && booking.tenant_id !== ctx.tenantId)) return { outcome: 'skipped', reason: 'Booking not found' };
    if (booking.status === 'cancelled') return { outcome: 'skipped', reason: 'Booking is cancelled' };
    if (!booking.attendee_email) return { outcome: 'skipped', reason: 'Booking has no attendee email' };
    const forSend = bookingTable === 'complex_event_booking' ? { ...booking, total_cost: booking.total_paid } : booking;
    const results = await sendConfirmation(eventId, forSend, {
      first_name: booking.attendee_first_name || '',
      last_name: booking.attendee_last_name || '',
      email: booking.attendee_email,
    }, null, buildBookingPricingDetails(forSend), ctx.tenantId, { emailConfigs: [setting], source: RESEND_SOURCE });
    const result = results?.[0];
    if (!result) return { outcome: 'failed', reason: 'Email could not be prepared' };
    return result.success
      ? { outcome: 'sent', email: booking.attendee_email }
      : { outcome: 'failed', reason: result.error || 'Send failed' };
  }

  async function resendScheduled(row) {
    const { data: scheduled, error } = await db.from('scheduled_email')
      .select(`status, error_message, ${SCHEDULED_EVENT_EMAIL_SELECT}`)
      .eq('id', row.scheduled_email_id).maybeSingle();
    if (error) throw error;
    if (!scheduled || scheduled.event_email_id !== row.event_email_id) return { outcome: 'skipped', reason: 'Scheduled send not found' };
    if (scheduled.status === 'pending') return { outcome: 'skipped', reason: 'Already queued to send' };
    if (scheduled.status === 'cancelled') {
      return { outcome: 'skipped', reason: scheduled.error_message ? `No longer eligible: ${scheduled.error_message}` : 'No longer eligible' };
    }
    if (!['sent', 'failed'].includes(scheduled.status)) return { outcome: 'skipped', reason: 'Scheduled send is not in a resendable state' };
    // A worker that has claimed the row (or crashed after claiming) may still
    // be sending; re-queueing it could send twice.
    if (scheduled.status === 'failed' && scheduled.error_message === SCHEDULED_EMAIL_CLAIM_MESSAGE) {
      return { outcome: 'skipped', reason: 'A send for this recipient is in progress or its outcome is unknown; check the list again shortly' };
    }
    // Re-queue the same scheduled row (its identity is unique) only if it is
    // exactly as observed, then send through the normal worker claim.
    let requeue = db.from('scheduled_email')
      .update({ status: 'pending', error_message: 'Admin resend requested' })
      .eq('id', scheduled.id).eq('status', scheduled.status)
      .eq('scheduled_send_time', scheduled.scheduled_send_time);
    requeue = scheduled.error_message == null ? requeue.is('error_message', null) : requeue.eq('error_message', scheduled.error_message);
    const { data: requeued, error: requeueError } = await requeue.select('id');
    if (requeueError) throw requeueError;
    if (!requeued?.length) return { outcome: 'skipped', reason: 'Changed while resending; reload and try again' };
    const { status: _status, error_message: _message, ...scheduledEmail } = scheduled;
    const result = await processScheduled(scheduledEmail, { source: RESEND_SOURCE });
    if (result?.outcome === 'sent') return { outcome: 'sent', email: scheduled.attendee_email };
    if (result?.outcome === 'not_claimed' || result?.outcome === 'claim_error') {
      // The row stays queued; the scheduled sender delivers it within minutes.
      return { outcome: 'queued', email: scheduled.attendee_email, reason: 'Queued; the scheduled sender will send it shortly' };
    }
    if (result?.outcome === 'skipped') return { outcome: 'skipped', reason: result.skipped?.reason || 'No longer eligible' };
    return { outcome: 'failed', reason: result?.reason || 'Send failed' };
  }

  async function claim(ctx, eventId, emailId, deliveryId) {
    const { data, error } = await db.rpc('claim_event_email_resend', {
      p_tenant_id: ctx.tenantId, p_event_id: eventId, p_event_email_id: emailId,
      p_delivery_id: deliveryId, p_lease_seconds: RESEND_LEASE_SECONDS,
    });
    if (error) throw Object.assign(new Error(error.message || 'Resend claim unavailable'), { claimUnavailable: true });
    return data || {};
  }

  async function release(token) {
    try {
      const { error } = await db.rpc('release_event_email_resend_claim', { p_token: token });
      if (error) throw error;
    } catch (err) {
      // The lease simply expires; never retried or escalated into a send.
      console.warn('[event-emails/resend] Could not release claim:', err?.message || err);
    }
  }

  return async function handler(req, res) {
    if (!db) return res.status(500).json({ error: 'Database not configured' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { eventId } = req.query || {};
    const { emailId, deliveryIds, confirm } = req.body || {};
    if (!isDeliveryId(eventId)) return res.status(400).json({ error: 'Event ID is required' });
    if (!isDeliveryId(emailId)) return res.status(400).json({ error: 'Invalid email setting' });
    if (confirm !== true) return res.status(400).json({ error: 'Resend must be explicitly confirmed' });
    const ids = Array.isArray(deliveryIds) ? [...new Set(deliveryIds)] : [];
    if (!ids.length || !ids.every(isDeliveryId)) return res.status(400).json({ error: 'Select at least one recipient to resend' });
    if (ids.length > MAX_RESEND_BATCH) return res.status(400).json({ error: `Resend at most ${MAX_RESEND_BATCH} recipients at a time` });

    const ctx = await getContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!ctx.tenantId || !await isAdmin(ctx)) return res.status(403).json({ error: 'Admin access required' });

    try {
      let eventTable = null;
      for (const table of ['event', 'complex_event']) {
        const { data, error } = await db.from(table).select('id').eq('id', eventId)
          .eq('tenant_id', ctx.tenantId).maybeSingle();
        if (error) throw error;
        if (data) { eventTable = table; break; }
      }
      if (!eventTable) return res.status(404).json({ error: 'Event not found' });

      const { data: setting, error: settingError } = await db.from('event_email').select('*')
        .eq('id', emailId).eq('event_id', eventId).maybeSingle();
      if (settingError) throw settingError;
      if (!setting) return res.status(404).json({ error: 'Email setting not found' });

      const { data: rows, error: rowsError } = await db.from('event_email_delivery')
        .select('id, event_email_id, email_type, booking_id, scheduled_email_id, recipient_email, status, created_at')
        .eq('tenant_id', ctx.tenantId).eq('event_id', eventId).eq('event_email_id', emailId)
        .in('id', ids);
      if (rowsError) throw rowsError;
      const byId = new Map((rows || []).map(row => [row.id, row]));
      const superseded = await findSupersedingDeliveries(db, ctx.tenantId, eventId, emailId, rows || []);

      const results = [];
      for (const id of ids) {
        const row = byId.get(id);
        const base = { deliveryId: id, email: row?.recipient_email || null };
        const blocked = resendBlockReason(row) || (superseded.has(id) ? 'Already resent' : null);
        if (blocked) { results.push({ ...base, outcome: 'skipped', reason: blocked }); continue; }
        if (!sameFamily(row.email_type, setting.email_type)) {
          results.push({ ...base, outcome: 'skipped', reason: 'The email setting has changed type since this send' });
          continue;
        }
        // Persisted per-recipient lease, taken before any preparation and
        // re-checking eligibility under lock. Overlapping requests (or two
        // failed rows for the same attendee) cannot both resend.
        let claimed;
        try {
          claimed = await claim(ctx, eventId, emailId, id);
        } catch (err) {
          console.error('[event-emails/resend] Claim failed:', id, err?.message || err);
          results.push({ ...base, outcome: 'failed', reason: 'Resend is unavailable right now; nothing was sent' });
          continue;
        }
        if (!claimed.claimed || !claimed.token) {
          results.push({ ...base, outcome: 'skipped', reason: CLAIM_REASONS[claimed.reason] || 'Cannot be resent' });
          continue;
        }
        let outcome;
        try {
          outcome = SCHEDULED_TYPES.includes(row.email_type)
            ? await resendScheduled(row)
            : await resendConfirmation(ctx, eventTable, eventId, setting, row);
        } catch (err) {
          console.error('[event-emails/resend] Resend failed:', id, err?.message || err);
          // Outcome unknown: keep the lease so nothing overlaps a possible send.
          outcome = { outcome: 'failed', reason: 'Resend could not be completed; check the list before trying again', keepClaim: true };
        }
        if ((outcome.outcome === 'skipped' || outcome.outcome === 'failed') && !outcome.keepClaim) await release(claimed.token);
        const { keepClaim: _keep, ...visible } = outcome;
        results.push({ ...base, ...visible });
      }
      const count = outcome => results.filter(r => r.outcome === outcome).length;
      return res.status(200).json({ sent: count('sent'), queued: count('queued'), failed: count('failed'), skipped: count('skipped'), results });
    } catch (err) {
      console.error('[event-emails/resend] Error:', err?.message || err);
      return res.status(500).json({ error: 'Unable to resend emails' });
    }
  };
}

export default createResendHandler();
