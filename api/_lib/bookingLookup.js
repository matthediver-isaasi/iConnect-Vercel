import { supabase } from './database.js';
import { refundBookingVoucherCredit } from './voucherCreditService.js';

export const BOOKING_SOURCE_REGULAR = 'booking';
export const BOOKING_SOURCE_COMPLEX = 'complex_event_booking';

export function isComplexSource(source) {
  return source === BOOKING_SOURCE_COMPLEX;
}

export async function restoreProgramBookingEntitlement(booking, tenantId, db = supabase) {
  // Full booking lookups contain an explicit null for legacy rows. A projected
  // lookup may omit the field: in that case ask SQL rather than assume no owner.
  if (Object.hasOwn(booking, 'program_entitlement_transaction_id') && !booking.program_entitlement_transaction_id) return { handled: false };
  if (!tenantId || (booking.tenant_id && booking.tenant_id !== tenantId)) throw new Error('Programme booking tenant mismatch');
  const { data, error } = await db.rpc('restore_program_booking_entitlement', {
    p_tenant_id: tenantId, p_booking_id: booking.id,
  });
  if (error) throw new Error(`Programme entitlement restoration failed: ${error.message}`);
  return data;
}

export async function lookupBooking(bookingId, tenantId, source) {
  if (source === BOOKING_SOURCE_COMPLEX) {
    return lookupComplexEventBooking(bookingId, tenantId);
  }
  if (source === BOOKING_SOURCE_REGULAR) {
    return lookupRegularBooking(bookingId, tenantId);
  }
  const regular = await lookupRegularBooking(bookingId, tenantId);
  if (regular.data) return regular;
  return lookupComplexEventBooking(bookingId, tenantId);
}

async function lookupRegularBooking(bookingId, tenantId) {
  let query = supabase
    .from('booking')
    .select('*')
    .eq('id', bookingId);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query.single();
  if (error || !data) return { data: null, error, source: BOOKING_SOURCE_REGULAR };
  return { data, error: null, source: BOOKING_SOURCE_REGULAR };
}

async function lookupComplexEventBooking(bookingId, tenantId) {
  let query = supabase
    .from('complex_event_booking')
    .select('*')
    .eq('id', bookingId);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query.single();
  if (error || !data) return { data: null, error, source: BOOKING_SOURCE_COMPLEX };
  return { data: normalizeComplexBooking(data), error: null, source: BOOKING_SOURCE_COMPLEX };
}

export function normalizeComplexBooking(ceb) {
  if (!ceb) return null;
  return {
    ...ceb,
    _source: BOOKING_SOURCE_COMPLEX,
    total_cost: ceb.total_paid,
    discount_code_amount: ceb.discount_amount,
    account_amount: ceb.account_balance_amount,
    xero_invoice_id: ceb.xero_invoice_id || null,
    xero_invoice_number: ceb.xero_invoice_number || null,
    xero_credit_note_id: ceb.xero_credit_note_id || null,
    xero_credit_note_number: ceb.xero_credit_note_number || null,
    discount_code_id: ceb.discount_code_id || null,
  };
}

export async function lookupBookings(bookingIds, tenantId, source) {
  if (source === BOOKING_SOURCE_COMPLEX) {
    return lookupComplexEventBookings(bookingIds, tenantId);
  }
  if (source === BOOKING_SOURCE_REGULAR) {
    return lookupRegularBookings(bookingIds, tenantId);
  }
  const regular = await lookupRegularBookings(bookingIds, tenantId);
  if (regular.data && regular.data.length === bookingIds.length) return regular;
  const foundIds = new Set((regular.data || []).map(b => b.id));
  const missingIds = bookingIds.filter(id => !foundIds.has(id));
  if (missingIds.length === 0) return regular;
  const complex = await lookupComplexEventBookings(missingIds, tenantId);
  return {
    data: [...(regular.data || []), ...(complex.data || [])],
    source: 'mixed',
  };
}

async function lookupRegularBookings(bookingIds, tenantId) {
  let query = supabase
    .from('booking')
    .select('*')
    .in('id', bookingIds);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query;
  return { data: data || [], error, source: BOOKING_SOURCE_REGULAR };
}

async function lookupComplexEventBookings(bookingIds, tenantId) {
  let query = supabase
    .from('complex_event_booking')
    .select('*')
    .in('id', bookingIds);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query;
  return {
    data: (data || []).map(normalizeComplexBooking),
    error,
    source: BOOKING_SOURCE_COMPLEX,
  };
}

export async function lookupBookingBasic(bookingId, tenantId, source, selectFields) {
  const table = source === BOOKING_SOURCE_COMPLEX ? 'complex_event_booking' : 'booking';
  let query = supabase.from(table).select(selectFields).eq('id', bookingId);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query.single();
  if (source === BOOKING_SOURCE_COMPLEX && data) {
    return { data: normalizeComplexBooking(data), error: null, source };
  }
  return { data, error, source };
}

export async function lookupBookingsBasic(bookingIds, tenantId, source, selectFields) {
  const table = source === BOOKING_SOURCE_COMPLEX ? 'complex_event_booking' : 'booking';
  let query = supabase.from(table).select(selectFields).in('id', bookingIds);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query;
  if (source === BOOKING_SOURCE_COMPLEX && data) {
    return { data: data.map(normalizeComplexBooking), error: null, source };
  }
  return { data: data || [], error, source };
}

export function getBookingTable(source) {
  return source === BOOKING_SOURCE_COMPLEX ? 'complex_event_booking' : 'booking';
}

export async function resolveEventTitleById(eventId, tenantId) {
  if (!eventId) return null;
  try {
    const { data: ev } = await supabase
      .from('event')
      .select('id, title, tenant_id')
      .eq('id', eventId)
      .maybeSingle();
    if (ev && (!ev.tenant_id || !tenantId || ev.tenant_id === tenantId) && ev.title) {
      return ev.title;
    }
    const { data: ce } = await supabase
      .from('complex_event')
      .select('id, title, tenant_id')
      .eq('id', eventId)
      .maybeSingle();
    if (ce && (!ce.tenant_id || !tenantId || ce.tenant_id === tenantId) && ce.title) {
      return ce.title;
    }
  } catch (err) {
    console.warn('[BookingLookup] resolveEventTitleById failed (non-blocking):', err.message);
  }
  return null;
}

export async function reinstateVoucherDirect(booking, refund_allocation, reversalOptions, reversalResults, tenantId) {
  return reinstateVoucherFromTransactions({ ...booking, _source: BOOKING_SOURCE_COMPLEX },
    refund_allocation, reversalOptions, reversalResults, tenantId);
}

export async function reinstateVoucherFromTransactions(booking, refund_allocation, reversalOptions, reversalResults, tenantId) {
  if (!(Number(booking.voucher_amount) > 0)) return;
  const result = await refundBookingVoucherCredit(supabase, {
    tenantId, bookingId: booking.id,
    source: booking._source === BOOKING_SOURCE_COMPLEX ? BOOKING_SOURCE_COMPLEX : BOOKING_SOURCE_REGULAR,
    refundAllocation: refund_allocation, reversalOptions,
  });
  reversalResults.vouchers.push(...(result.vouchers || []));
  reversalResults.replacements.push(...(result.replacements || []));
}

export async function restoreComplexEventSeats(booking, tenantId) {
  if (booking._source !== BOOKING_SOURCE_COMPLEX) return;

  try {
    const { data: complexEvent } = await supabase
      .from('complex_event')
      .select('id, available_seats')
      .eq('id', booking.event_id)
      .single();

    if (complexEvent && complexEvent.available_seats !== null) {
      await supabase
        .from('complex_event')
        .update({ available_seats: complexEvent.available_seats + 1 })
        .eq('id', complexEvent.id);
      console.log(`[BookingLookup] Complex event seats restored for event ${complexEvent.id}`);
    }

    // Ticket-class available_count is the fixed maximum. Confirmed bookings
    // and commercial movements derive usage, so cancellation never increments
    // the definition.
  } catch (err) {
    console.error(`[BookingLookup] Complex event seat restoration error:`, err.message);
  }
}

export async function restoreComplexEventSeatsMultiple(bookings, count) {
  if (!bookings || bookings.length === 0 || !bookings[0]._source) return;
  if (bookings[0]._source !== BOOKING_SOURCE_COMPLEX) return;

  const eventId = bookings[0].event_id;
  try {
    const { data: complexEvent } = await supabase
      .from('complex_event')
      .select('id, available_seats')
      .eq('id', eventId)
      .single();

    if (complexEvent && complexEvent.available_seats !== null) {
      await supabase
        .from('complex_event')
        .update({ available_seats: complexEvent.available_seats + count })
        .eq('id', complexEvent.id);
      console.log(`[BookingLookup] Complex event seats restored by ${count} for event ${complexEvent.id}`);
    }

    // Ticket-class available_count is immutable capacity; do not restore it.
  } catch (err) {
    console.error(`[BookingLookup] Complex event seat restoration error:`, err.message);
  }
}

export async function cancelComplexEventZoomRegistrations(booking, tenantId) {
  if (booking._source !== BOOKING_SOURCE_COMPLEX) return;
  if (!booking.attendee_email) return;

  const { cancelZoomRegistrant, cancelZoomMeetingRegistrant } = await import('./zoomClient.js');

  try {
    const { data: sessions } = await supabase
      .from('complex_event_session')
      .select('id, title, zoom_webinar_id, zoom_meeting_id')
      .eq('event_id', booking.event_id)
      .eq('tenant_id', tenantId)
      .eq('status', 'scheduled');

    if (!sessions || sessions.length === 0) return;

    for (const session of sessions) {
      if (session.zoom_webinar_id) {
        try {
          await cancelZoomRegistrant(tenantId, session.zoom_webinar_id, booking.attendee_email);
          console.log(`[BookingLookup] Zoom webinar registrant cancelled for ${booking.attendee_email} in session ${session.title}`);
        } catch (err) {
          console.error(`[BookingLookup] Zoom webinar cancellation error for session ${session.title}:`, err.message);
        }
      } else if (session.zoom_meeting_id) {
        try {
          await cancelZoomMeetingRegistrant(tenantId, session.zoom_meeting_id, booking.attendee_email);
          console.log(`[BookingLookup] Zoom meeting registrant cancelled for ${booking.attendee_email} in session ${session.title}`);
        } catch (err) {
          console.error(`[BookingLookup] Zoom meeting cancellation error for session ${session.title}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(`[BookingLookup] Error cancelling Zoom registrations:`, err.message);
  }
}

export async function cancelComplexEventZoomRegistrationsMultiple(bookings, tenantId) {
  if (!bookings || bookings.length === 0) return;
  if (bookings[0]._source !== BOOKING_SOURCE_COMPLEX) return;

  const { cancelZoomRegistrant, cancelZoomMeetingRegistrant } = await import('./zoomClient.js');
  const eventId = bookings[0].event_id;

  try {
    const { data: sessions } = await supabase
      .from('complex_event_session')
      .select('id, title, zoom_webinar_id, zoom_meeting_id')
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId)
      .eq('status', 'scheduled');

    if (!sessions || sessions.length === 0) return;

    for (const booking of bookings) {
      if (!booking.attendee_email) continue;
      for (const session of sessions) {
        if (session.zoom_webinar_id) {
          try {
            await cancelZoomRegistrant(tenantId, session.zoom_webinar_id, booking.attendee_email);
            console.log(`[BookingLookup] Zoom webinar registrant cancelled for ${booking.attendee_email} in session ${session.title}`);
          } catch (err) {
            console.error(`[BookingLookup] Zoom webinar cancellation error for ${booking.attendee_email} in session ${session.title}:`, err.message);
          }
        } else if (session.zoom_meeting_id) {
          try {
            await cancelZoomMeetingRegistrant(tenantId, session.zoom_meeting_id, booking.attendee_email);
            console.log(`[BookingLookup] Zoom meeting registrant cancelled for ${booking.attendee_email} in session ${session.title}`);
          } catch (err) {
            console.error(`[BookingLookup] Zoom meeting cancellation error for ${booking.attendee_email} in session ${session.title}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[BookingLookup] Error cancelling Zoom registrations:`, err.message);
  }
}

export async function swapComplexEventZoomRegistrations(booking, originalEmail, newAttendee, tenantId) {
  if (booking._source !== BOOKING_SOURCE_COMPLEX) return { success: true };

  const { cancelZoomRegistrant, cancelZoomMeetingRegistrant, registerZoomWebinarAttendee, registerZoomMeetingAttendee } = await import('./zoomClient.js');

  try {
    const { data: sessions } = await supabase
      .from('complex_event_session')
      .select('id, title, zoom_webinar_id, zoom_meeting_id, zoom_registration_required')
      .eq('event_id', booking.event_id)
      .eq('tenant_id', tenantId)
      .eq('status', 'scheduled');

    if (!sessions || sessions.length === 0) return { success: true };

    let lastJoinUrl = null;

    for (const session of sessions) {
      if (session.zoom_webinar_id) {
        try {
          await cancelZoomRegistrant(tenantId, session.zoom_webinar_id, originalEmail);
          console.log(`[BookingLookup] Zoom webinar registrant cancelled for ${originalEmail} in session ${session.title}`);
        } catch (err) {
          console.error(`[BookingLookup] Zoom webinar cancel error for session ${session.title}:`, err.message);
        }

        if (session.zoom_registration_required) {
          const webinar = { zoom_webinar_id: session.zoom_webinar_id, registration_required: true };
          const regResult = await registerZoomWebinarAttendee(tenantId, webinar, newAttendee);
          if (regResult.success && regResult.join_url) {
            lastJoinUrl = regResult.join_url;
            console.log(`[BookingLookup] Registered ${newAttendee.email} for webinar session ${session.title}`);
          }
        }
      } else if (session.zoom_meeting_id) {
        try {
          await cancelZoomMeetingRegistrant(tenantId, session.zoom_meeting_id, originalEmail);
          console.log(`[BookingLookup] Zoom meeting registrant cancelled for ${originalEmail} in session ${session.title}`);
        } catch (err) {
          console.error(`[BookingLookup] Zoom meeting cancel error for session ${session.title}:`, err.message);
        }

        if (session.zoom_registration_required) {
          const meeting = { zoom_meeting_id: session.zoom_meeting_id, registration_required: true };
          const regResult = await registerZoomMeetingAttendee(tenantId, meeting, newAttendee);
          if (regResult.success && regResult.join_url) {
            lastJoinUrl = regResult.join_url;
            console.log(`[BookingLookup] Registered ${newAttendee.email} for meeting session ${session.title}`);
          }
        }
      }
    }

    return { success: true, joinUrl: lastJoinUrl };
  } catch (err) {
    console.error(`[BookingLookup] Error swapping Zoom registrations:`, err.message);
    return { success: false, error: err.message };
  }
}
