// Shared event-deletion helper used by:
//   - api/events/[id]/delete-with-cancellations.js (simple Event)
//   - api/complex-events/[id]/delete-with-cancellations.js (ComplexEvent)
//
// Flow per task-700:
//   1. Mark the event row status='cancelling' so concurrent /api/functions/createBooking
//      and /api/public/complex-event-booking can hard-fail before charging anyone.
//   2. Loop every active booking through cancelBookingForEventDeletion:
//        refund + credit-note + voucher / training-fund / discount reinstatement
//        + Zoom unregister + cancellation email (reason='event_deleted').
//      Each booking gets an auto-approved booking_cancellation_request audit row.
//   3. If every booking either succeeded or was already cancelled (re-run is
//      idempotent), clean up event-scoped orphans (event_sponsor_assignment,
//      zoom_attendance, resource.linked_events JSON, complex_event_*) and
//      hard-delete the event row.
//   4. If any booking failed, leave the event in 'cancelling' state and return
//      a per-booking failure report so the admin can resolve manual actions
//      (Stripe / Xero) and re-run the same endpoint.

import { supabase } from './database.js';
import {
  cancelBookingForEventDeletion,
  sendEventDeletionCancellationEmail,
  CANCELLATION_REASON_EVENT_DELETED,
} from './bookingCancellation.js';
import { BOOKING_SOURCE_REGULAR, BOOKING_SOURCE_COMPLEX, normalizeComplexBooking } from './bookingLookup.js';

/**
 * @param {object} args
 * @param {string} args.eventId
 * @param {string} args.tenantId
 * @param {'event'|'complex_event'} args.eventTable
 * @param {string} [args.organiserMessage]
 * @param {string} [args.adminLabel]   used as reviewed_by on the audit row
 * @param {boolean} [args.suppressEmails]
 * @returns {Promise<{success:boolean, status:'deleted'|'partial'|'not_found', event?:object, totalBookings:number, succeeded:number, alreadyCancelled:number, requiresManualAction:Array, failed:Array, cleanupSummary?:object, error?:string}>}
 */
export async function deleteEventWithCancellations({
  eventId,
  tenantId,
  eventTable,
  organiserMessage = null,
  adminLabel = 'Admin',
  suppressEmails = false,
}) {
  if (!eventId || !tenantId) {
    return { success: false, status: 'not_found', error: 'eventId and tenantId required', totalBookings: 0, succeeded: 0, alreadyCancelled: 0, requiresManualAction: [], failed: [] };
  }

  const isComplex = eventTable === 'complex_event';
  const bookingTable = isComplex ? 'complex_event_booking' : 'booking';
  const source = isComplex ? BOOKING_SOURCE_COMPLEX : BOOKING_SOURCE_REGULAR;

  // 1. Load the event (tenant-scoped) so a wrong tenant ID returns not_found.
  const { data: event, error: evErr } = await supabase
    .from(eventTable)
    .select('id, tenant_id, title, status')
    .eq('id', eventId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (evErr || !event) {
    return { success: false, status: 'not_found', error: 'Event not found', totalBookings: 0, succeeded: 0, alreadyCancelled: 0, requiresManualAction: [], failed: [] };
  }

  // 2. Flip event into 'cancelling' state immediately so creators are blocked.
  if (event.status !== 'cancelling') {
    const { error: lockErr } = await supabase
      .from(eventTable)
      .update({ status: 'cancelling' })
      .eq('id', eventId)
      .eq('tenant_id', tenantId);
    if (lockErr) {
      return { success: false, status: 'partial', error: 'Failed to lock event: ' + lockErr.message, totalBookings: 0, succeeded: 0, alreadyCancelled: 0, requiresManualAction: [], failed: [] };
    }
  }

  // 3. Fetch every booking (active OR already cancelled — we still need to
  //    report on cancelled ones so the caller knows they're handled).
  const { data: bookingRows, error: bkErr } = await supabase
    .from(bookingTable)
    .select('*')
    .eq('event_id', eventId)
    .eq('tenant_id', tenantId);
  if (bkErr) {
    return { success: false, status: 'partial', error: 'Failed to fetch bookings: ' + bkErr.message, totalBookings: 0, succeeded: 0, alreadyCancelled: 0, requiresManualAction: [], failed: [] };
  }

  const bookings = (bookingRows || []).map(b => isComplex ? normalizeComplexBooking(b) : b);

  // 4. Per-booking cancellation pipeline.
  const succeeded = [];
  const alreadyCancelled = [];
  const requiresManualAction = [];
  const failed = [];

  for (const booking of bookings) {
    try {
      const result = await cancelBookingForEventDeletion({
        booking,
        source,
        tenantId,
        reason: CANCELLATION_REASON_EVENT_DELETED,
      });

      if (!result.success) {
        failed.push({ bookingId: booking.id, bookingReference: booking.booking_reference || null, attendeeEmail: booking.attendee_email || null, error: result.error || 'Unknown error' });
        continue;
      }

      // Audit row in booking_cancellation_request (auto-approved). Idempotent
      // by booking_id: if a row already exists from a prior run, skip insert.
      try {
        const { data: existing } = await supabase
          .from('booking_cancellation_request')
          .select('id')
          .eq('booking_id', booking.id)
          .eq('tenant_id', tenantId)
          .eq('reason', `event_deleted:${eventId}`)
          .maybeSingle();
        if (!existing) {
          await supabase.from('booking_cancellation_request').insert({
            tenant_id: tenantId,
            booking_id: booking.id,
            booking_group_reference: booking.booking_group_reference || null,
            event_id: booking.event_id || null,
            member_id: booking.member_id || null,
            request_type: 'individual',
            reason: `event_deleted:${eventId}`,
            status: 'approved',
            reviewed_by: adminLabel,
            reviewed_at: new Date().toISOString(),
            review_notes: 'Auto-approved: event cancelled by organiser via delete-with-cancellations',
            booking_source: source,
          });
        }
      } catch (auditErr) {
        console.error('[EventDeletion] Audit row insert failed (non-blocking):', auditErr.message);
      }

      // Send cancellation email (skip if booking was already cancelled before
      // this run — they will have already been notified).
      if (!suppressEmails && !result.alreadyCancelled) {
        try {
          await sendEventDeletionCancellationEmail({
            booking,
            source,
            tenantId,
            reason: CANCELLATION_REASON_EVENT_DELETED,
            organiserMessage,
            eventName: event.title,
            reversalResults: result.reversalResults,
          });
        } catch (emailErr) {
          console.error('[EventDeletion] Email send failed (non-blocking):', emailErr.message);
        }
      }

      const summary = {
        bookingId: booking.id,
        bookingReference: booking.booking_reference || null,
        attendeeEmail: booking.attendee_email || null,
        reversalResults: result.reversalResults,
      };

      if (result.alreadyCancelled) {
        alreadyCancelled.push(summary);
      } else if (result.requiresManualAction) {
        requiresManualAction.push(summary);
      } else {
        succeeded.push(summary);
      }
    } catch (err) {
      console.error(`[EventDeletion] Unexpected error cancelling booking ${booking.id}:`, err);
      failed.push({ bookingId: booking.id, bookingReference: booking.booking_reference || null, attendeeEmail: booking.attendee_email || null, error: err.message || 'Unexpected error' });
    }
  }

  // 5. If any booking failed, leave the event in 'cancelling' so the admin can
  //    resolve and re-run. Manual-action bookings DO NOT block deletion — the
  //    Stripe/Xero step will be retried by ops, the booking is already
  //    cancelled and the attendee was emailed.
  if (failed.length > 0) {
    return {
      success: false,
      status: 'partial',
      event,
      totalBookings: bookings.length,
      succeeded: succeeded.length,
      alreadyCancelled: alreadyCancelled.length,
      requiresManualAction,
      failed,
      error: `${failed.length} booking(s) failed to cancel — event left in 'cancelling' state. Resolve and re-run.`,
    };
  }

  // 6. Cleanup orphan rows.
  const cleanupSummary = await cleanupEventOrphans({ eventId, tenantId, isComplex });

  // 7. Hard-delete the event row.
  const { error: delErr } = await supabase
    .from(eventTable)
    .delete()
    .eq('id', eventId)
    .eq('tenant_id', tenantId);
  if (delErr) {
    return {
      success: false,
      status: 'partial',
      event,
      totalBookings: bookings.length,
      succeeded: succeeded.length,
      alreadyCancelled: alreadyCancelled.length,
      requiresManualAction,
      failed: [{ bookingId: null, error: 'All bookings cancelled but event row delete failed: ' + delErr.message }],
      cleanupSummary,
      error: 'Event row delete failed after cancellations completed',
    };
  }

  return {
    success: true,
    status: 'deleted',
    event,
    totalBookings: bookings.length,
    succeeded: succeeded.length,
    alreadyCancelled: alreadyCancelled.length,
    requiresManualAction,
    failed: [],
    cleanupSummary,
  };
}

/**
 * Read-only "what will happen if I delete this event?" report for the admin
 * confirmation dialog. Counts active vs already-cancelled bookings, totals
 * refundable amounts, lists per-currency totals, and flags bookings that will
 * need a manual Stripe / Xero follow-up because the integration isn't
 * configured for this tenant. Does NOT mutate state.
 */
export async function previewEventDeletion({ eventId, tenantId, eventTable }) {
  if (!eventId || !tenantId) return { found: false, error: 'eventId and tenantId required' };
  const isComplex = eventTable === 'complex_event';
  const bookingTable = isComplex ? 'complex_event_booking' : 'booking';

  const { data: event } = await supabase
    .from(eventTable)
    .select('id, tenant_id, title, status')
    .eq('id', eventId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!event) return { found: false };

  const { data: bookings } = await supabase
    .from(bookingTable)
    .select('id, status, total_cost, training_fund_amount, voucher_amount, discount_code_amount, account_amount, payment_method, stripe_payment_intent_id, xero_invoice_id, currency, attendee_email')
    .eq('event_id', eventId)
    .eq('tenant_id', tenantId);

  const all = bookings || [];
  const active = all.filter(b => b.status !== 'cancelled');
  const alreadyCancelled = all.filter(b => b.status === 'cancelled');

  let totalRefundable = 0;
  let totalCreditNote = 0;
  let totalTrainingFund = 0;
  let totalVoucher = 0;
  let stripeRefundCount = 0;
  let xeroCreditNoteCount = 0;
  const refundByCurrency = {};
  const manualActionWarnings = [];

  // Detect tenant Stripe + Xero readiness once, using the SAME helper the
  // refund path uses at runtime — keeps preview manual-action warnings in
  // sync with what the cancellation flow will actually attempt.
  let stripeConfigured = false;
  let xeroConfigured = false;
  try {
    const { getStripeCredentials } = await import('./stripeCredentials.js');
    const creds = await getStripeCredentials(tenantId, 'events');
    stripeConfigured = !!(creds && creds.secret_key && creds.is_enabled !== false);
  } catch {}
  try {
    const { data: xeroRow } = await supabase
      .from('xero_token')
      .select('tenant_id')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    xeroConfigured = !!xeroRow;
  } catch {}

  for (const b of active) {
    const total = Number(b.total_cost) || 0;
    const tf = Number(b.training_fund_amount) || 0;
    const v = Number(b.voucher_amount) || 0;
    const dc = Number(b.discount_code_amount) || 0;
    const acct = Number(b.account_amount) || 0;
    const card = Math.max(0, total - tf - v - dc - acct);

    totalTrainingFund += tf;
    totalVoucher += v;

    if (b.stripe_payment_intent_id && b.payment_method === 'card' && card > 0) {
      stripeRefundCount += 1;
      totalRefundable += card;
      const cur = (b.currency || 'GBP').toUpperCase();
      refundByCurrency[cur] = (refundByCurrency[cur] || 0) + card;
      if (!stripeConfigured) {
        manualActionWarnings.push({
          bookingId: b.id,
          attendeeEmail: b.attendee_email,
          reason: 'Stripe events integration not configured for this tenant — card refund will need manual processing.',
        });
      }
    }

    if (b.xero_invoice_id && total > 0) {
      xeroCreditNoteCount += 1;
      totalCreditNote += total;
      if (!xeroConfigured) {
        manualActionWarnings.push({
          bookingId: b.id,
          attendeeEmail: b.attendee_email,
          reason: 'Xero connection missing — credit note will need to be raised manually.',
        });
      }
    }
  }

  // Orphan-row counts (informational only).
  let sponsorAssignmentCount = 0;
  let zoomAttendanceCount = 0;
  try {
    const { count } = await supabase
      .from('event_sponsor_assignment')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId);
    sponsorAssignmentCount = count || 0;
  } catch {}
  try {
    const { count } = await supabase
      .from('zoom_attendance')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);
    zoomAttendanceCount = count || 0;
  } catch {}

  let complexChildren = null;
  if (isComplex) {
    complexChildren = { ticketClasses: 0, sessions: 0, tracks: 0 };
    try { const { count } = await supabase.from('complex_event_ticket_class').select('id', { count: 'exact', head: true }).eq('complex_event_id', eventId).eq('tenant_id', tenantId); complexChildren.ticketClasses = count || 0; } catch {}
    try { const { count } = await supabase.from('complex_event_session').select('id', { count: 'exact', head: true }).eq('event_id', eventId).eq('tenant_id', tenantId); complexChildren.sessions = count || 0; } catch {}
    try { const { count } = await supabase.from('complex_event_track').select('id', { count: 'exact', head: true }).eq('complex_event_id', eventId).eq('tenant_id', tenantId); complexChildren.tracks = count || 0; } catch {}
  }

  return {
    found: true,
    event: { id: event.id, title: event.title, status: event.status },
    totalBookings: all.length,
    activeBookings: active.length,
    alreadyCancelledBookings: alreadyCancelled.length,
    stripeRefundCount,
    xeroCreditNoteCount,
    totalRefundable,
    totalCreditNote,
    totalTrainingFundReinstatement: totalTrainingFund,
    totalVoucherReinstatement: totalVoucher,
    refundByCurrency,
    requiresManualActionCount: manualActionWarnings.length,
    requiresManualAction: manualActionWarnings,
    cleanup: {
      sponsorAssignments: sponsorAssignmentCount,
      zoomAttendance: zoomAttendanceCount,
      complexChildren,
    },
    integrations: { stripeConfigured, xeroConfigured },
  };
}

async function cleanupEventOrphans({ eventId, tenantId, isComplex }) {
  const summary = { sponsorAssignments: 0, zoomAttendance: 0, resourcesUpdated: 0, complexChildren: null };

  // event_sponsor_assignment (event_id FK).
  try {
    const { data: assignments } = await supabase
      .from('event_sponsor_assignment')
      .select('id')
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId);
    if (assignments && assignments.length > 0) {
      const { error } = await supabase
        .from('event_sponsor_assignment')
        .delete()
        .eq('event_id', eventId)
        .eq('tenant_id', tenantId);
      if (!error) summary.sponsorAssignments = assignments.length;
    }
  } catch (err) {
    console.error('[EventDeletion] event_sponsor_assignment cleanup error:', err.message);
  }

  // zoom_attendance — for complex events, also cleanup per-session rows.
  try {
    let sessionIds = [];
    if (isComplex) {
      const { data: sessions } = await supabase
        .from('complex_event_session')
        .select('id')
        .eq('event_id', eventId)
        .eq('tenant_id', tenantId);
      sessionIds = (sessions || []).map(s => s.id);
    }

    let q = supabase.from('zoom_attendance').delete();
    if (isComplex && sessionIds.length > 0) {
      q = q.or(`event_id.eq.${eventId},complex_event_session_id.in.(${sessionIds.join(',')})`);
    } else {
      q = q.eq('event_id', eventId);
    }
    const { error, count } = await q.select('id', { count: 'exact', head: true });
    if (!error && typeof count === 'number') summary.zoomAttendance = count;
  } catch (err) {
    console.error('[EventDeletion] zoom_attendance cleanup error:', err.message);
  }

  // resource.linked_events JSON — strip any entry referencing this event OR
  // (for complex events) any of its session ids.
  try {
    let sessionIdSet = new Set();
    if (isComplex) {
      const { data: sessions } = await supabase
        .from('complex_event_session')
        .select('id')
        .eq('event_id', eventId)
        .eq('tenant_id', tenantId);
      sessionIdSet = new Set((sessions || []).map(s => String(s.id)));
    }
    const { data: resources } = await supabase
      .from('resource')
      .select('id, linked_events')
      .eq('tenant_id', tenantId)
      .not('linked_events', 'is', null);
    for (const r of resources || []) {
      const arr = Array.isArray(r.linked_events) ? r.linked_events : [];
      const filtered = arr.filter(le => {
        const eid = String(le?.event_id);
        if (eid === String(eventId)) return false;
        if (sessionIdSet.has(eid)) return false;
        const sid = le?.session_id ? String(le.session_id) : null;
        if (sid && sessionIdSet.has(sid)) return false;
        return true;
      });
      if (filtered.length !== arr.length) {
        const { error } = await supabase
          .from('resource')
          .update({ linked_events: filtered })
          .eq('id', r.id)
          .eq('tenant_id', tenantId);
        if (!error) summary.resourcesUpdated += 1;
      }
    }
  } catch (err) {
    console.error('[EventDeletion] resource.linked_events cleanup error:', err.message);
  }

  // Complex event children (tracks, sessions, ticket classes).
  if (isComplex) {
    summary.complexChildren = { ticketClasses: 0, sessions: 0, tracks: 0 };
    try {
      const { count: tcCount } = await supabase
        .from('complex_event_ticket_class').delete()
        .eq('complex_event_id', eventId).eq('tenant_id', tenantId)
        .select('id', { count: 'exact', head: true });
      summary.complexChildren.ticketClasses = tcCount || 0;
    } catch (err) { console.error('[EventDeletion] ticket_class cleanup error:', err.message); }
    try {
      const { count: sCount } = await supabase
        .from('complex_event_session').delete()
        .eq('event_id', eventId).eq('tenant_id', tenantId)
        .select('id', { count: 'exact', head: true });
      summary.complexChildren.sessions = sCount || 0;
    } catch (err) { console.error('[EventDeletion] session cleanup error:', err.message); }
    try {
      const { count: trCount } = await supabase
        .from('complex_event_track').delete()
        .eq('complex_event_id', eventId).eq('tenant_id', tenantId)
        .select('id', { count: 'exact', head: true });
      summary.complexChildren.tracks = trCount || 0;
    } catch (err) { console.error('[EventDeletion] track cleanup error:', err.message); }
  }

  return summary;
}
