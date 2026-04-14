import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;
    const { eventId, eventName, internalReference, dateFrom, dateTo, generate } = req.query;

    const { data: regularEvents, error: eventsError } = await supabase
      .from('event')
      .select('id, title, start_date, status, internal_reference, is_complex, zoom_meeting_id, zoom_webinar_id')
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false });

    if (eventsError) {
      console.error('[Event Registration Report] Error fetching events:', eventsError);
      return res.status(500).json({ error: 'Failed to fetch events' });
    }

    const { data: complexEvents, error: complexEventsError } = await supabase
      .from('complex_event')
      .select('id, title, start_date, status')
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false });

    if (complexEventsError) {
      console.error('[Event Registration Report] Error fetching complex events:', complexEventsError);
    }

    const allEvents = [
      ...(regularEvents || []).map(e => ({ ...e, source: 'event', has_zoom: !!(e.zoom_meeting_id || e.zoom_webinar_id) })),
      ...(complexEvents || []).map(e => ({ ...e, is_complex: true, internal_reference: null, source: 'complex_event', has_zoom: false }))
    ].sort((a, b) => {
      const aDate = a.start_date ? new Date(a.start_date) : new Date(0);
      const bDate = b.start_date ? new Date(b.start_date) : new Date(0);
      return bDate - aDate;
    });

    let bookingGroups = [];
    let organizations = {};
    let hasZoomForSelectedEvents = false;
    let summary = {
      totalRevenue: 0,
      totalVoucher: 0,
      totalTrainingFund: 0,
      totalDiscount: 0,
      totalAccountPayments: 0,
      totalStripePayments: 0,
      countByMethod: {},
      countByStatus: {},
      totalBookings: 0,
      totalGroups: 0,
    };

    const shouldGenerate = generate === 'true' || eventId;

    if (shouldGenerate) {
      let targetEventIds = [];
      let targetComplexEventIds = [];

      if (eventId) {
        const isComplexEvent = (complexEvents || []).some(e => e.id === eventId);
        if (isComplexEvent) {
          targetComplexEventIds = [eventId];
        } else {
          targetEventIds = [eventId];
        }
      } else {
        let filteredEvents = allEvents;

        if (eventName) {
          const q = eventName.toLowerCase();
          filteredEvents = filteredEvents.filter(e =>
            (e.title || '').toLowerCase().includes(q)
          );
        }

        if (internalReference) {
          const q = internalReference.toLowerCase();
          filteredEvents = filteredEvents.filter(e =>
            (e.internal_reference || '').toLowerCase().includes(q)
          );
        }

        for (const e of filteredEvents) {
          if (e.source === 'complex_event') {
            targetComplexEventIds.push(e.id);
          } else {
            targetEventIds.push(e.id);
          }
        }
      }

      const eventMap = {};
      for (const ev of allEvents) {
        eventMap[ev.id] = { title: ev.title, internal_reference: ev.internal_reference, is_complex: ev.is_complex, source: ev.source, has_zoom: ev.has_zoom };
      }

      let allBookings = [];

      if (targetEventIds.length > 0) {
        let bookingQuery = supabase
          .from('booking')
          .select('id, event_id, member_id, attendee_email, attendee_first_name, attendee_last_name, ticket_price, total_cost, payment_method, voucher_amount, training_fund_amount, account_amount, purchase_order_number, po_to_follow, stripe_payment_intent_id, ticket_class_name, ticket_class_id, organization_id, booking_reference, booking_group_reference, xero_invoice_id, xero_invoice_number, is_guest_booking, status, created_at')
          .in('event_id', targetEventIds)
          .eq('tenant_id', tenantId)
          .order('booking_group_reference', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: false });

        if (dateFrom) {
          bookingQuery = bookingQuery.gte('created_at', new Date(dateFrom + 'T00:00:00.000Z').toISOString());
        }
        if (dateTo) {
          const toDate = new Date(dateTo + 'T00:00:00.000Z');
          toDate.setUTCDate(toDate.getUTCDate() + 1);
          bookingQuery = bookingQuery.lt('created_at', toDate.toISOString());
        }

        const { data: bookingData, error: bookingsError } = await bookingQuery;

        if (bookingsError) {
          console.error('[Event Registration Report] Error fetching bookings:', bookingsError);
          return res.status(500).json({ error: 'Failed to fetch bookings' });
        }

        allBookings.push(...(bookingData || []));
      }

      if (targetComplexEventIds.length > 0) {
        let complexBookingQuery = supabase
          .from('complex_event_booking')
          .select('id, event_id, member_id, attendee_email, attendee_first_name, attendee_last_name, ticket_price, total_paid, payment_method, voucher_amount, training_fund_amount, account_balance_amount, stripe_payment_intent_id, ticket_class_name, ticket_class_id, organization_id, booking_reference, booking_group_reference, discount_code, discount_amount, status, created_at')
          .in('event_id', targetComplexEventIds)
          .eq('tenant_id', tenantId)
          .order('booking_group_reference', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: false });

        if (dateFrom) {
          complexBookingQuery = complexBookingQuery.gte('created_at', new Date(dateFrom + 'T00:00:00.000Z').toISOString());
        }
        if (dateTo) {
          const toDate = new Date(dateTo + 'T00:00:00.000Z');
          toDate.setUTCDate(toDate.getUTCDate() + 1);
          complexBookingQuery = complexBookingQuery.lt('created_at', toDate.toISOString());
        }

        const { data: complexBookingData, error: complexBookingsError } = await complexBookingQuery;

        if (complexBookingsError) {
          console.error('[Event Registration Report] Error fetching complex event bookings:', complexBookingsError);
        } else {
          const normalizedComplexBookings = (complexBookingData || []).map(b => ({
            ...b,
            total_cost: b.total_paid || 0,
            account_amount: b.account_balance_amount || 0,
            purchase_order_number: null,
            po_to_follow: null,
            xero_invoice_id: null,
            xero_invoice_number: null,
            is_guest_booking: !b.member_id
          }));
          allBookings.push(...normalizedComplexBookings);
        }
      }

      const complexEventIds = Object.entries(eventMap)
        .filter(([, ev]) => ev.is_complex)
        .map(([id]) => id);

      let ticketClassMap = {};
      if (complexEventIds.length > 0) {
        const { data: ticketClasses } = await supabase
          .from('complex_event_ticket_class')
          .select('id, name, linked_track_ids, all_tracks, complex_event_id')
          .in('complex_event_id', complexEventIds)
          .eq('tenant_id', tenantId);

        if (ticketClasses) {
          for (const tc of ticketClasses) {
            ticketClassMap[tc.id] = tc;
          }
        }
      }

      const orgIds = [...new Set(allBookings.map(b => b.organization_id).filter(Boolean))];
      if (orgIds.length > 0) {
        const { data: orgs, error: orgsError } = await supabase
          .from('organization')
          .select('id, name')
          .in('id', orgIds);

        if (!orgsError && orgs) {
          for (const org of orgs) {
            organizations[org.id] = org.name;
          }
        }
      }

      let attendanceByBookingId = {};
      let attendanceByEmail = {};
      const allTargetIds = [...targetEventIds, ...targetComplexEventIds];
      if (allTargetIds.length > 0) {
        const { data: attendanceData } = await supabase
          .from('zoom_attendance')
          .select('id, event_id, complex_event_session_id, participant_email, participant_name, join_time, leave_time, duration_minutes, matched_booking_id, synced_at')
          .in('event_id', allTargetIds)
          .eq('tenant_id', tenantId);

        if (attendanceData) {
          for (const a of attendanceData) {
            if (a.matched_booking_id) {
              if (!attendanceByBookingId[a.matched_booking_id]) {
                attendanceByBookingId[a.matched_booking_id] = [];
              }
              attendanceByBookingId[a.matched_booking_id].push(a);
            }
            if (a.participant_email) {
              const email = a.participant_email.toLowerCase().trim();
              if (!attendanceByEmail[email]) {
                attendanceByEmail[email] = [];
              }
              attendanceByEmail[email].push(a);
            }
          }
        }
      }

      if (targetComplexEventIds.length > 0) {
        const { data: ceSessionsWithZoom } = await supabase
          .from('complex_event_session')
          .select('id, zoom_meeting_id, zoom_webinar_id, complex_event_id')
          .in('complex_event_id', targetComplexEventIds)
          .eq('tenant_id', tenantId);

        if (ceSessionsWithZoom) {
          const hasZoomSession = ceSessionsWithZoom.some(s => s.zoom_meeting_id || s.zoom_webinar_id);
          if (hasZoomSession) hasZoomForSelectedEvents = true;
          for (const ceId of targetComplexEventIds) {
            if (eventMap[ceId]) {
              eventMap[ceId].has_zoom = ceSessionsWithZoom.some(s => s.complex_event_id === ceId && (s.zoom_meeting_id || s.zoom_webinar_id));
            }
          }
        }
      }
      if (targetEventIds.length > 0) {
        for (const eid of targetEventIds) {
          if (eventMap[eid]?.has_zoom) hasZoomForSelectedEvents = true;
        }
      }

      const groupMap = new Map();
      for (const b of allBookings) {
        const groupKey = b.booking_group_reference || `single_${b.id}`;
        if (!groupMap.has(groupKey)) {
          groupMap.set(groupKey, []);
        }
        groupMap.get(groupKey).push(b);
      }

      let totalRevenue = 0;
      let totalVoucher = 0;
      let totalTrainingFund = 0;
      let totalDiscount = 0;
      let totalAccountPayments = 0;
      let totalStripePayments = 0;
      const countByMethod = {};
      const countByStatus = {};

      for (const [groupRef, members] of groupMap) {
        const first = members[0];
        const isGroup = members.length > 1;

        const groupTicketTotal = members.reduce((sum, b) => sum + (Number(b.ticket_price) || 0), 0);
        const groupTotalCost = members.reduce((sum, b) => sum + (Number(b.total_cost) || 0), 0);

        const groupVoucher = members.reduce((sum, b) => sum + (Number(b.voucher_amount) || 0), 0);
        const groupTrainingFund = members.reduce((sum, b) => sum + (Number(b.training_fund_amount) || 0), 0);
        const groupAccountAmount = members.reduce((sum, b) => sum + (Number(b.account_amount) || 0), 0);
        const groupDiscount = Math.max(0, groupTicketTotal - groupTotalCost);

        totalRevenue += groupTotalCost;
        totalVoucher += groupVoucher;
        totalTrainingFund += groupTrainingFund;
        totalDiscount += groupDiscount;
        totalAccountPayments += groupAccountAmount;

        if (first.payment_method === 'card' || first.stripe_payment_intent_id) {
          totalStripePayments += groupTotalCost;
        }

        const method = first.payment_method || 'unknown';
        countByMethod[method] = (countByMethod[method] || 0) + 1;

        for (const b of members) {
          const status = b.status || 'unknown';
          countByStatus[status] = (countByStatus[status] || 0) + 1;
        }

        const eventInfo = eventMap[first.event_id] || {};

        bookingGroups.push({
          groupRef: groupRef.startsWith('single_') ? null : groupRef,
          isGroup,
          attendeeCount: members.length,
          eventTitle: eventInfo.title || '',
          internalReference: eventInfo.internal_reference || '',
          eventId: first.event_id,
          isComplexEvent: eventInfo.is_complex || false,
          groupPayment: {
            ticketTotal: groupTicketTotal,
            totalCost: groupTotalCost,
            discount: groupDiscount,
            voucherAmount: groupVoucher,
            trainingFundAmount: groupTrainingFund,
            accountAmount: groupAccountAmount,
            paymentMethod: first.payment_method,
            purchaseOrderNumber: first.purchase_order_number,
            poToFollow: first.po_to_follow,
            stripePaymentIntentId: first.stripe_payment_intent_id,
            xeroInvoiceNumber: first.xero_invoice_number,
            xeroInvoiceId: first.xero_invoice_id,
            bookingReference: first.booking_reference,
          },
          hasZoom: eventInfo.has_zoom || false,
          attendees: members.map(b => {
            const tcInfo = b.ticket_class_id ? ticketClassMap[b.ticket_class_id] : null;

            let attendanceRecords = attendanceByBookingId[b.id] || [];
            if (attendanceRecords.length === 0 && b.attendee_email) {
              const email = b.attendee_email.toLowerCase().trim();
              attendanceRecords = (attendanceByEmail[email] || []).filter(a => a.event_id === b.event_id);
            }

            let attended = null;
            let zoom_join_time = null;
            let zoom_leave_time = null;
            let zoom_duration_minutes = null;
            let attendance_by_session = null;

            if (attendanceRecords.length > 0) {
              zoom_duration_minutes = attendanceRecords.reduce((sum, r) => sum + (r.duration_minutes || 0), 0);
              const sorted = [...attendanceRecords].sort((a, b) => new Date(a.join_time) - new Date(b.join_time));
              zoom_join_time = sorted[0].join_time;
              zoom_leave_time = sorted[sorted.length - 1].leave_time;

              if (zoom_duration_minutes >= 1) {
                attended = true;
              } else {
                attended = false;
              }

              if (eventInfo.is_complex) {
                const sessionMap = {};
                for (const rec of attendanceRecords) {
                  const sid = rec.complex_event_session_id || '_overall';
                  if (!sessionMap[sid]) {
                    sessionMap[sid] = [];
                  }
                  sessionMap[sid].push(rec);
                }
                attendance_by_session = Object.entries(sessionMap)
                  .filter(([sid]) => sid !== '_overall')
                  .map(([sid, recs]) => {
                    const totalDur = recs.reduce((s, r) => s + (r.duration_minutes || 0), 0);
                    const sSorted = [...recs].sort((x, y) => new Date(x.join_time) - new Date(y.join_time));
                    return {
                      session_id: sid,
                      attended: totalDur >= 1,
                      join_time: sSorted[0].join_time,
                      leave_time: sSorted[sSorted.length - 1].leave_time,
                      duration_minutes: totalDur,
                    };
                  });
                if (attendance_by_session.length === 0) attendance_by_session = null;
              }
            }

            return {
              id: b.id,
              attendee_first_name: b.attendee_first_name,
              attendee_last_name: b.attendee_last_name,
              attendee_email: b.attendee_email,
              ticket_class_name: b.ticket_class_name,
              ticket_class_id: b.ticket_class_id || null,
              ticket_price: b.ticket_price,
              total_cost: b.total_cost,
              organization_id: b.organization_id,
              is_guest_booking: b.is_guest_booking,
              member_id: b.member_id,
              status: b.status,
              created_at: b.created_at,
              track_access: tcInfo ? (tcInfo.all_tracks ? 'All Tracks' : (tcInfo.linked_track_ids || []).length + ' track(s)') : null,
              attended,
              zoom_join_time,
              zoom_leave_time,
              zoom_duration_minutes,
              attendance_by_session,
            };
          }),
        });
      }

      summary = {
        totalRevenue,
        totalVoucher,
        totalTrainingFund,
        totalDiscount,
        totalAccountPayments,
        totalStripePayments,
        countByMethod,
        countByStatus,
        totalBookings: allBookings.length,
        totalGroups: groupMap.size,
      };
    }

    return res.status(200).json({
      events: allEvents,
      bookingGroups,
      organizations,
      summary,
      hasZoomForSelectedEvents,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Event Registration Report] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch report data' });
  }
}
