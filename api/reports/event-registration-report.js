import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { buildEventCheckinFlagMap } from '../_lib/checkinService.js';

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
    const { eventId, eventName, internalReference, dateFrom, dateTo, eventDateFrom, eventDateTo, generate } = req.query;

    let { data: regularEvents, error: eventsError } = await supabase
      .from('event')
      .select('id, title, start_date, end_date, status, internal_reference, is_complex, zoom_meeting_id, zoom_webinar_id, attendance_tracking_enabled, attendance_provider')
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false });

    if (eventsError && /end_date/i.test(eventsError.message || '')) {
      console.warn('[Event Registration Report] event.end_date column unavailable, retrying without it');
      const fallback = await supabase
        .from('event')
        .select('id, title, start_date, status, internal_reference, is_complex, zoom_meeting_id, zoom_webinar_id, attendance_tracking_enabled, attendance_provider')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false });
      regularEvents = fallback.data;
      eventsError = fallback.error;
    }

    if (eventsError) {
      console.error('[Event Registration Report] Error fetching events:', eventsError);
      return res.status(500).json({ error: 'Failed to fetch events' });
    }

    let { data: complexEvents, error: complexEventsError } = await supabase
      .from('complex_event')
      .select('id, title, start_date, end_date, status, attendance_tracking_enabled, attendance_provider')
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false });

    if (complexEventsError && /end_date/i.test(complexEventsError.message || '')) {
      console.warn('[Event Registration Report] complex_event.end_date column unavailable, retrying without it');
      const fallback = await supabase
        .from('complex_event')
        .select('id, title, start_date, status, attendance_tracking_enabled, attendance_provider')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false });
      complexEvents = fallback.data;
      complexEventsError = fallback.error;
    }

    if (complexEventsError) {
      console.error('[Event Registration Report] Error fetching complex events:', complexEventsError);
    }

    // Exclude "To be confirmed" events: they are interest-gatherers that
    // frequently get cancelled/replaced and must never inflate reporting.
    regularEvents = (regularEvents || []).filter(e => e.status !== 'tbc');
    complexEvents = (complexEvents || []).filter(e => e.status !== 'tbc');

    const allEvents = [
      ...(regularEvents || []).map(e => ({
        ...e,
        source: 'event',
        has_zoom: !!(e.zoom_meeting_id || e.zoom_webinar_id),
        has_attendance: !!e.attendance_tracking_enabled,
      })),
      ...(complexEvents || []).map(e => ({
        ...e,
        is_complex: true,
        internal_reference: null,
        source: 'complex_event',
        has_zoom: false,
        has_attendance: !!e.attendance_tracking_enabled,
      }))
    ].sort((a, b) => {
      const aDate = a.start_date ? new Date(a.start_date) : new Date(0);
      const bDate = b.start_date ? new Date(b.start_date) : new Date(0);
      return bDate - aDate;
    });

    let bookingGroups = [];
    let organizations = {};
    let hasZoomForSelectedEvents = false;
    let hasAttendanceForSelectedEvents = false;
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
        // Validate the requested eventId against the TBC-filtered lists. A
        // directly-requested TBC event is absent from both, so it resolves to
        // no target ids and yields no counted data.
        const isComplexEvent = (complexEvents || []).some(e => e.id === eventId);
        const isRegularEvent = (regularEvents || []).some(e => e.id === eventId);
        if (isComplexEvent) {
          targetComplexEventIds = [eventId];
        } else if (isRegularEvent) {
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

      // Event date range filter: simple events use event.start_date; complex
      // events use the earliest complex_event_session start_time, falling back
      // to complex_event.start_date when the event has no sessions. Applied to
      // the target ID lists (including the direct eventId path) BEFORE bookings
      // are fetched. Bounds are whole days, inclusive.
      if (eventDateFrom || eventDateTo) {
        const fromMs = eventDateFrom ? new Date(eventDateFrom + 'T00:00:00.000Z').getTime() : null;
        let toMs = null;
        if (eventDateTo) {
          const toDate = new Date(eventDateTo + 'T00:00:00.000Z');
          toDate.setUTCDate(toDate.getUTCDate() + 1);
          toMs = toDate.getTime();
        }

        const inRange = (dateValue) => {
          if (!dateValue) return false;
          const ms = new Date(dateValue).getTime();
          if (Number.isNaN(ms)) return false;
          if (fromMs !== null && ms < fromMs) return false;
          if (toMs !== null && ms >= toMs) return false;
          return true;
        };

        if (targetEventIds.length > 0) {
          const startDateById = new Map((regularEvents || []).map(e => [e.id, e.start_date]));
          targetEventIds = targetEventIds.filter(id => inRange(startDateById.get(id)));
        }

        if (targetComplexEventIds.length > 0) {
          const earliestSessionByEvent = new Map();
          const { data: sessionRows, error: sessionsError } = await supabase
            .from('complex_event_session')
            .select('complex_event_id, start_time')
            .in('complex_event_id', targetComplexEventIds)
            .eq('tenant_id', tenantId);

          if (sessionsError) {
            console.error('[Event Registration Report] Error fetching complex event sessions for date filter:', sessionsError);
          } else {
            for (const s of sessionRows || []) {
              if (!s.start_time) continue;
              const ms = new Date(s.start_time).getTime();
              if (Number.isNaN(ms)) continue;
              const existing = earliestSessionByEvent.get(s.complex_event_id);
              if (existing === undefined || ms < existing) {
                earliestSessionByEvent.set(s.complex_event_id, ms);
              }
            }
          }

          const complexStartById = new Map((complexEvents || []).map(e => [e.id, e.start_date]));
          targetComplexEventIds = targetComplexEventIds.filter(id => {
            const sessionMs = earliestSessionByEvent.get(id);
            if (sessionMs !== undefined) {
              if (fromMs !== null && sessionMs < fromMs) return false;
              if (toMs !== null && sessionMs >= toMs) return false;
              return true;
            }
            return inRange(complexStartById.get(id));
          });
        }
      }

      const eventMap = {};
      for (const ev of allEvents) {
        eventMap[ev.id] = {
          title: ev.title,
          internal_reference: ev.internal_reference,
          is_complex: ev.is_complex,
          source: ev.source,
          has_zoom: ev.has_zoom,
           has_attendance: ev.has_attendance,
           has_teams: false,
          start_date: ev.start_date || null,
          end_date: ev.end_date || null,
        };
      }

      let allBookings = [];

      if (targetEventIds.length > 0) {
        let bookingQuery = supabase
          .from('booking')
          .select('id, event_id, member_id, attendee_email, attendee_first_name, attendee_last_name, ticket_price, total_cost, payment_method, voucher_amount, training_fund_amount, account_amount, purchase_order_number, po_to_follow, stripe_payment_intent_id, ticket_class_name, ticket_class_id, organization_id, booking_reference, booking_group_reference, xero_invoice_id, xero_invoice_number, xero_invoice_error, is_guest_booking, status, created_at, third_party_consent, designation, buddy, badge, dietary_selections, allergy_selections, accessibility_selections, discount_code_id, discount_code_amount, attendee_job_title')
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
          .select('id, event_id, member_id, attendee_email, attendee_first_name, attendee_last_name, ticket_price, total_paid, payment_method, voucher_amount, training_fund_amount, account_balance_amount, stripe_payment_intent_id, ticket_class_name, ticket_class_id, organization_id, booking_reference, booking_group_reference, discount_code, discount_amount, status, created_at, third_party_consent, designation, buddy, badge, dietary_selections, allergy_selections, accessibility_selections, attendee_job_title')
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
            is_guest_booking: !b.member_id,
            // Normalize discount-code fields to the common shape used by standard bookings.
            // Complex events store the code amount in `discount_amount` and the code string in `discount_code`;
            // their `total_paid`/`ticket_price` are already net of the code, so folding `discount_amount`
            // into the group discount does NOT double count.
            discount_code_amount: b.discount_amount || 0,
            discount_code_label: b.discount_code || null
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

      // Resolve discount-code labels for standard bookings (which store discount_code_id, not the code string).
      // Complex bookings already carry `discount_code_label` from normalization above.
      const discountCodeIds = [...new Set(allBookings.map(b => b.discount_code_id).filter(Boolean))];
      if (discountCodeIds.length > 0) {
        const { data: discountCodes } = await supabase
          .from('discount_code')
          .select('id, code')
          .in('id', discountCodeIds)
          .eq('tenant_id', tenantId);
        const codeById = new Map((discountCodes || []).map(c => [c.id, c.code]));
        for (const b of allBookings) {
          if (b.discount_code_id && !b.discount_code_label) {
            b.discount_code_label = codeById.get(b.discount_code_id) || null;
          }
        }
      }

      const attendanceByBookingId = {};
      const attendanceTargetsByEventId = {};
      const allTargetIds = [...targetEventIds, ...targetComplexEventIds];

      let flagMap = new Map();
      if (allTargetIds.length > 0) {
        flagMap = await buildEventCheckinFlagMap({ tenantId, eventIds: allTargetIds });
      }

      if (allTargetIds.length > 0) {
        // A Teams identity is useful before its first Graph report creates an
        // attendance_target. Surface it rather than making first-sync meetings
        // look like they have no Teams attendance configured.
        const { data: teamBindings, error: teamBindingsError } = await supabase
          .from('teams_attendance_binding').select('event_id')
          .in('event_id', allTargetIds).eq('tenant_id', tenantId).eq('enabled', true);
        if (teamBindingsError) {
          console.error('[Event Registration Report] Error fetching Teams attendance bindings:', teamBindingsError);
        } else {
          for (const binding of teamBindings || []) {
            if (eventMap[binding.event_id]) eventMap[binding.event_id].has_teams = true;
            const eventSummary = allEvents.find(event => event.id === binding.event_id);
            if (eventSummary) eventSummary.has_teams = true;
          }
        }
        const { data: targets, error: targetsError } = await supabase
          .from('attendance_target')
          .select('id, provider, target_type, target_id, event_id, provider_target_type, effective_threshold_minutes, tracking_enabled, scheduled_end_at')
          .in('event_id', allTargetIds)
          .eq('tenant_id', tenantId);

        if (targetsError) {
          throw new Error(`Failed to fetch attendance targets: ${targetsError.message}`);
        } else if (targets?.length) {
          const activeTargets = targets.filter(target => target.tracking_enabled !== false);
          const attendanceTargetIds = activeTargets.map(target => target.id);
          const targetById = new Map(activeTargets.map(target => [target.id, target]));

          for (const target of activeTargets) {
            if (!attendanceTargetsByEventId[target.event_id]) attendanceTargetsByEventId[target.event_id] = [];
            attendanceTargetsByEventId[target.event_id].push(target);
            if (eventMap[target.event_id]) eventMap[target.event_id].has_attendance = true;
            if (eventMap[target.event_id] && target.provider === 'teams') {
              eventMap[target.event_id].has_teams = true;
              const eventSummary = allEvents.find((event) => event.id === target.event_id);
              if (eventSummary) eventSummary.has_teams = true;
            }
          }
          hasAttendanceForSelectedEvents = activeTargets.length > 0;

          const sessionTargetIds = activeTargets
            .filter(target => target.target_type === 'complex_event_session')
            .map(target => target.target_id);
          const agendaTargetIds = activeTargets
            .filter(target => target.target_type === 'agenda_item')
            .map(target => target.target_id);
          const targetLabels = new Map();

          if (sessionTargetIds.length > 0) {
            const { data: sessions, error } = await supabase
              .from('complex_event_session')
              .select('id, title, start_time, end_time')
              .in('id', sessionTargetIds)
              .eq('tenant_id', tenantId);
            if (error) {
              console.error('[Event Registration Report] Error fetching attendance session labels:', error);
            } else {
              for (const session of sessions || []) {
                targetLabels.set(session.id, {
                  title: session.title || 'Session',
                  start_at: session.start_time || null,
                  end_at: session.end_time || null,
                });
              }
            }
          }

          if (agendaTargetIds.length > 0) {
            const { data: agendaItems, error } = await supabase
              .from('event_agenda_item')
              .select('id, description, item_type, start_date, end_date')
              .in('id', agendaTargetIds)
              .eq('tenant_id', tenantId);
            if (error) {
              console.error('[Event Registration Report] Error fetching attendance agenda labels:', error);
            } else {
              for (const item of agendaItems || []) {
                targetLabels.set(item.id, {
                  title: item.description || item.item_type || 'Agenda item',
                  start_at: item.start_date || null,
                  end_at: item.end_date || null,
                });
              }
            }
          }

          const latestRunByTarget = new Map();
          const { data: syncRuns, error: syncRunsError } = await supabase
            .from('attendance_sync_run')
            .select('id, attendance_target_id, status, attempted_at, completed_at, error_code, error_message')
            .in('attendance_target_id', attendanceTargetIds)
            .eq('tenant_id', tenantId)
            .order('attempted_at', { ascending: false });
          if (syncRunsError) {
            throw new Error(`Failed to fetch attendance sync state: ${syncRunsError.message}`);
          } else {
            for (const run of syncRuns || []) {
              if (!latestRunByTarget.has(run.attendance_target_id)) {
                latestRunByTarget.set(run.attendance_target_id, run);
              }
            }
          }

          const bookingIds = allBookings.map(booking => booking.id);
          let currentOutcomes = [];
          let participantMatches = [];
          if (bookingIds.length > 0) {
            const outcomesResult = await supabase
              .from('attendance_current_outcome')
              .select('provider, attendance_target_id, booking_type, booking_id, status, duration_seconds, threshold_minutes, updated_at')
              .in('attendance_target_id', attendanceTargetIds)
              .in('booking_id', bookingIds)
              .eq('tenant_id', tenantId);
            if (outcomesResult.error) {
              throw new Error(`Failed to fetch current attendance outcomes: ${outcomesResult.error.message}`);
            } else {
              currentOutcomes = outcomesResult.data || [];
            }

            const matchesResult = await supabase
              .from('attendance_participant_match')
              .select('attendance_target_id, participant_key, booking_id, booking_type, match_status, matched_by')
              .in('attendance_target_id', attendanceTargetIds)
              .in('booking_id', bookingIds)
              .eq('tenant_id', tenantId);
            if (matchesResult.error) {
              console.error('[Event Registration Report] Error fetching attendance matches:', matchesResult.error);
            } else {
              participantMatches = matchesResult.data || [];
            }
          }

          const intervalsByTargetAndParticipant = new Map();
          if (participantMatches.length > 0) {
            const { data: intervals, error } = await supabase
              .from('attendance_participant_interval')
              .select('attendance_target_id, participant_key, joined_at, left_at, duration_seconds')
              .in('attendance_target_id', attendanceTargetIds)
              .eq('tenant_id', tenantId);
            if (error) {
              console.error('[Event Registration Report] Error fetching attendance intervals:', error);
            } else {
              for (const interval of intervals || []) {
                const key = `${interval.attendance_target_id}::${interval.participant_key}`;
                if (!intervalsByTargetAndParticipant.has(key)) intervalsByTargetAndParticipant.set(key, []);
                intervalsByTargetAndParticipant.get(key).push(interval);
              }
            }
          }

          const matchByTargetAndBooking = new Map();
          for (const match of participantMatches) {
            matchByTargetAndBooking.set(`${match.attendance_target_id}::${match.booking_id}`, match);
          }
          const outcomeByTargetAndBooking = new Map();
          for (const outcome of currentOutcomes) {
            outcomeByTargetAndBooking.set(`${outcome.attendance_target_id}::${outcome.booking_id}`, outcome);
          }

          for (const booking of allBookings) {
            const bookingType = eventMap[booking.event_id]?.is_complex ? 'complex_event_booking' : 'booking';
            const applicableTargets = attendanceTargetsByEventId[booking.event_id] || [];
            const details = applicableTargets.map(target => {
              const outcome = outcomeByTargetAndBooking.get(`${target.id}::${booking.id}`);
              const run = latestRunByTarget.get(target.id);
              const match = matchByTargetAndBooking.get(`${target.id}::${booking.id}`);
              const intervals = match
                ? (intervalsByTargetAndParticipant.get(`${target.id}::${match.participant_key}`) || [])
                : [];
              const timestamps = intervals
                .filter(interval => interval.joined_at)
                .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
              let status = outcome?.status || null;
              if (!status && (run?.status === 'pending' || run?.status === 'running')) status = 'pending';
              if (!status && run?.status === 'error') status = 'sync_failed';
              if (!status && booking.status === 'confirmed') status = 'pending';
              if (status === 'error') status = 'sync_failed';
              const label = targetLabels.get(target.target_id);
              return {
                target_id: target.target_id,
                attendance_target_id: target.id,
                target_type: target.target_type,
                target_title: label?.title || (target.target_type === 'event' ? eventMap[booking.event_id]?.title : null),
                target_start_at: label?.start_at || null,
                target_end_at: label?.end_at || null,
                provider: outcome?.provider || target.provider,
                provider_target_type: target.provider_target_type,
                booking_type: outcome?.booking_type || bookingType,
                status,
                duration_seconds: outcome?.duration_seconds ?? 0,
                duration_minutes: outcome ? Number((outcome.duration_seconds / 60).toFixed(2)) : 0,
                threshold_minutes: outcome?.threshold_minutes ?? target.effective_threshold_minutes,
                joined_at: timestamps[0]?.joined_at || null,
                left_at: timestamps.length ? timestamps[timestamps.length - 1].left_at : null,
                interval_count: intervals.length,
                match_status: match?.match_status || null,
                matched_by: match?.matched_by || null,
                outcome_updated_at: outcome?.updated_at || null,
                sync_status: run?.status || null,
                sync_attempted_at: run?.attempted_at || null,
                sync_error_code: run?.error_code || null,
                sync_error_message: run?.error_message || null,
              };
            }).filter(detail => detail.status);
            if (details.length) attendanceByBookingId[booking.id] = details;
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

      const groupBookerInfo = new Map();
      const realGroupRefs = [...groupMap.keys()].filter(k => !k.startsWith('single_'));

      if (realGroupRefs.length > 0) {
        const { data: egbRows } = await supabase
          .from('event_group_booking')
          .select('booking_reference, booker_email, booker_first_name, booker_last_name')
          .eq('tenant_id', tenantId)
          .in('booking_reference', realGroupRefs);

        if (egbRows) {
          for (const row of egbRows) {
            if (row.booking_reference && row.booker_email) {
              groupBookerInfo.set(row.booking_reference, {
                email: row.booker_email,
                first_name: row.booker_first_name || null,
                last_name: row.booker_last_name || null,
                source: 'event_group_booking',
              });
            }
          }
        }
      }

      // Look up member info for booker resolution (groups without explicit booker info)
      // and for the legacy attendee-job-title fallback (all bookings with a member_id).
      const memberIdsToLookup = new Set();
      for (const b of allBookings) {
        if (b.member_id) memberIdsToLookup.add(b.member_id);
      }

      const memberInfoById = new Map();
      if (memberIdsToLookup.size > 0) {
        const { data: memberRows } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, job_title')
          .in('id', [...memberIdsToLookup]);
        if (memberRows) {
          for (const m of memberRows) {
            memberInfoById.set(m.id, m);
          }
        }
      }

      for (const [groupKey, members] of groupMap) {
        if (groupBookerInfo.has(groupKey)) continue;

        const memberBooking = members.find(b => b.member_id && memberInfoById.has(b.member_id));
        if (memberBooking) {
          const m = memberInfoById.get(memberBooking.member_id);
          if (m?.email) {
            groupBookerInfo.set(groupKey, {
              email: m.email,
              first_name: m.first_name || null,
              last_name: m.last_name || null,
              source: 'member',
            });
            continue;
          }
        }

        const earliest = [...members].sort((a, b) => {
          const aT = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bT = b.created_at ? new Date(b.created_at).getTime() : 0;
          return aT - bT;
        })[0];
        if (earliest?.attendee_email) {
          groupBookerInfo.set(groupKey, {
            email: earliest.attendee_email,
            first_name: earliest.attendee_first_name || null,
            last_name: earliest.attendee_last_name || null,
            source: 'earliest_attendee',
          });
        }
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
        const bookerInfo = groupBookerInfo.get(groupRef) || null;
        const bookerEmailNorm = bookerInfo?.email ? bookerInfo.email.toLowerCase().trim() : null;

        let bookerInAttendees = false;
        if (bookerEmailNorm) {
          const bookerIdx = members.findIndex(b => (b.attendee_email || '').toLowerCase().trim() === bookerEmailNorm);
          if (bookerIdx >= 0) {
            bookerInAttendees = true;
            if (bookerIdx > 0) {
              const [bookerMember] = members.splice(bookerIdx, 1);
              members.unshift(bookerMember);
            }
          }
        }

        const first = members[0];
        const isGroup = members.length > 1;

        const groupTicketTotal = members.reduce((sum, b) => sum + (Number(b.ticket_price) || 0), 0);
        const groupTotalCost = members.reduce((sum, b) => sum + (Number(b.total_cost) || 0), 0);

        const groupVoucher = members.reduce((sum, b) => sum + (Number(b.voucher_amount) || 0), 0);
        const groupTrainingFund = members.reduce((sum, b) => sum + (Number(b.training_fund_amount) || 0), 0);
        const groupAccountAmount = members.reduce((sum, b) => sum + (Number(b.account_amount) || 0), 0);
        // Ticket-offer discount (BOGO, early-bird, etc.) is what's left after ticket price minus stored cost.
        // Discount-code amounts are stored separately (not reflected in total_cost/total_paid), so add them.
        const groupOfferDiscount = Math.max(0, groupTicketTotal - groupTotalCost);
        const groupCodeDiscount = members.reduce((sum, b) => sum + (Number(b.discount_code_amount) || 0), 0);
        const groupDiscount = groupOfferDiscount + groupCodeDiscount;
        const groupDiscountCode = (members.find(b => b.discount_code_label)?.discount_code_label) || null;

        totalRevenue += groupTotalCost - groupCodeDiscount;
        totalVoucher += groupVoucher;
        totalTrainingFund += groupTrainingFund;
        totalDiscount += groupDiscount;
        totalAccountPayments += groupAccountAmount;

        if (first.payment_method === 'card' || first.stripe_payment_intent_id) {
          totalStripePayments += groupTotalCost - groupCodeDiscount;
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
          eventStartDate: eventInfo.start_date || null,
          eventEndDate: eventInfo.end_date || null,
          groupPayment: {
            ticketTotal: groupTicketTotal,
            totalCost: groupTotalCost,
            discount: groupDiscount,
            offerDiscount: groupOfferDiscount,
            codeDiscount: groupCodeDiscount,
            discountCode: groupDiscountCode,
            voucherAmount: groupVoucher,
            trainingFundAmount: groupTrainingFund,
            accountAmount: groupAccountAmount,
            paymentMethod: first.payment_method,
            purchaseOrderNumber: first.purchase_order_number,
            poToFollow: first.po_to_follow,
            stripePaymentIntentId: first.stripe_payment_intent_id,
            xeroInvoiceNumber: first.xero_invoice_number,
            xeroInvoiceId: first.xero_invoice_id,
            xeroInvoiceError: first.xero_invoice_error || null,
            bookingReference: first.booking_reference,
          },
          hasZoom: eventInfo.has_zoom || false,
          hasTeams: eventInfo.has_teams || false,
          hasAttendance: eventInfo.has_attendance || false,
          booker: bookerInfo ? {
            email: bookerInfo.email,
            first_name: bookerInfo.first_name,
            last_name: bookerInfo.last_name,
            in_attendees: bookerInAttendees,
          } : null,
          attendees: members.map(b => {
            const tcInfo = b.ticket_class_id ? ticketClassMap[b.ticket_class_id] : null;

            const attendanceDetails = attendanceByBookingId[b.id] || [];
            let attended = null;
            let zoom_join_time = null;
            let zoom_leave_time = null;
            let zoom_duration_minutes = null;
            let attendance_by_session = null;
            const attendanceStatuses = [...new Set(attendanceDetails.map(detail => detail.status))];
            const attendance_status = attendanceStatuses.length === 1
              ? attendanceStatuses[0]
              : (attendanceStatuses.length > 1 ? 'mixed' : null);
            const attendance_duration_seconds = attendanceDetails.reduce(
              (sum, detail) => sum + (Number(detail.duration_seconds) || 0), 0,
            );
            const thresholdSnapshots = [...new Set(attendanceDetails.map(detail => detail.threshold_minutes))];
            const attendance_threshold_minutes = thresholdSnapshots.length === 1 ? thresholdSnapshots[0] : null;

            // Keep the former fields for existing report consumers, but derive
            // them exclusively from durable provider-neutral outcomes.
            attended = attendance_status === 'attended'
              ? true
              : (attendance_status === 'below_threshold' || attendance_status === 'absent' ? false : null);
            zoom_duration_minutes = attendanceDetails.length
              ? Number((attendance_duration_seconds / 60).toFixed(2))
              : null;
            const timedDetails = attendanceDetails.filter(detail => detail.joined_at);
            if (timedDetails.length) {
              const sorted = [...timedDetails].sort((x, y) => new Date(x.joined_at) - new Date(y.joined_at));
              zoom_join_time = sorted[0].joined_at;
              zoom_leave_time = sorted[sorted.length - 1].left_at;
            }
            const sessionDetails = attendanceDetails.filter(detail => detail.target_type !== 'event');
            if (sessionDetails.length) {
              attendance_by_session = sessionDetails.map(detail => ({
                session_id: detail.target_id,
                target_type: detail.target_type,
                title: detail.target_title,
                status: detail.status,
                attended: detail.status === 'attended',
                join_time: detail.joined_at,
                leave_time: detail.left_at,
                duration_minutes: detail.duration_minutes,
                threshold_minutes: detail.threshold_minutes,
                provider: detail.provider,
              }));
            }

            const isBooker = bookerInAttendees && bookerEmailNorm
              ? (b.attendee_email || '').toLowerCase().trim() === bookerEmailNorm
              : false;

            // Per-attendee job title: stored value wins; legacy fallback to the
            // booker's member-profile title only when the attendee IS the booker
            // (matching email or full name) — never attribute it to someone else.
            let attendeeJobTitle = (b.attendee_job_title || '').trim() || null;
            if (!attendeeJobTitle && b.member_id) {
              const m = memberInfoById.get(b.member_id);
              if (m) {
                const normStr = (v) => (v || '').toLowerCase().trim();
                const emailMatches = normStr(b.attendee_email) && normStr(b.attendee_email) === normStr(m.email);
                const attendeeName = `${normStr(b.attendee_first_name)} ${normStr(b.attendee_last_name)}`.trim();
                const memberName = `${normStr(m.first_name)} ${normStr(m.last_name)}`.trim();
                const nameMatches = attendeeName && attendeeName === memberName;
                if (emailMatches || nameMatches) {
                  attendeeJobTitle = m.job_title || null;
                }
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
              attendance_status,
              attendance_duration_seconds,
              attendance_duration_minutes: attendanceDetails.length
                ? Number((attendance_duration_seconds / 60).toFixed(2))
                : null,
              attendance_threshold_minutes,
              attendance_details: attendanceDetails,
              zoom_join_time,
              zoom_leave_time,
              zoom_duration_minutes,
              attendance_by_session,
              third_party_consent: b.third_party_consent ?? null,
              designation: b.designation || null,
              attendee_job_title: attendeeJobTitle,
              buddy: !!b.buddy,
              badge: b.badge !== false,
              dietary_selections: b.dietary_selections || null,
              allergy_selections: b.allergy_selections || null,
              accessibility_selections: b.accessibility_selections || null,
              event_id: b.event_id,
              is_booker: isBooker,
              flags: flagMap.get(`${b.event_id}::${(b.attendee_email || '').trim().toLowerCase()}`) || [],
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
      hasAttendanceForSelectedEvents,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Event Registration Report] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch report data' });
  }
}
