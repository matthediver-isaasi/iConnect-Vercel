import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ClipboardList, Calendar, UserCheck, UserPlus, UserMinus } from "lucide-react";
import { format } from "date-fns";
import { useDateFormat } from "@/hooks/useDateFormat";

/**
 * Shared member Activity timeline.
 *
 * This is the single source of truth for the member Activity timeline used by
 * both member detail screens (`pages/MemberDetail.jsx` and
 * `components/MemberDetailView.jsx`). Data fetching, unified item building and
 * per-row rendering (bookings, check-ins and group join/leave) all live here so
 * that adding a new Activity item type in the future updates both screens at
 * once.
 *
 * @param {object} props
 * @param {string} props.memberId       Member id to load activity for.
 * @param {string} [props.memberEmail]  Member email (used to match bookings where
 *                                       the member is the attendee, not the buyer).
 * @param {boolean} [props.enabled]     Whether queries should run (e.g. only when
 *                                       the Activity tab is active). Defaults to true.
 * @param {string} [props.title]        Card heading text.
 * @param {string} [props.emptyText]    Empty-state message.
 * @param {string} [props.emptyTestId]  data-testid for the empty-state message.
 */
export default function MemberActivityTimeline({
  memberId,
  memberEmail,
  enabled = true,
  title = "Activity Timeline",
  emptyText = "No activity found",
  emptyTestId = "text-no-activity",
}) {
  const { formatDate } = useDateFormat();

  const id = memberId;
  const queriesEnabled = !!id && enabled;

  const { data: memberBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['member-detail-bookings', id, memberEmail],
    enabled: queriesEnabled,
    queryFn: async () => {
      const email = (memberEmail || '').trim();
      try {
        const queries = [
          base44.entities.Booking.list({ filter: { member_id: id } })
        ];
        if (email) {
          queries.push(
            base44.entities.Booking.list({ filter: { attendee_email: { ilike: email } } })
          );
        }
        const results = await Promise.all(queries.map(p => p.catch((err) => {
          console.error('[MemberActivityTimeline] member-detail-bookings sub-query failed', err);
          return [];
        })));
        const seen = new Set();
        const merged = [];
        for (const list of results) {
          for (const b of (list || [])) {
            if (b && b.id && !seen.has(b.id)) {
              seen.add(b.id);
              merged.push(b);
            }
          }
        }
        return merged.sort((a, b) =>
          new Date(b.created_date || 0) - new Date(a.created_date || 0)
        );
      } catch (err) {
        console.error('[MemberActivityTimeline] member-detail-bookings query failed', err);
        return [];
      }
    }
  });

  const { data: complexBookings = [], isLoading: complexBookingsLoading } = useQuery({
    queryKey: ['member-detail-complex-bookings', id, memberEmail],
    enabled: queriesEnabled,
    queryFn: async () => {
      const email = (memberEmail || '').trim();
      try {
        const queries = [
          base44.entities.ComplexEventBooking.list({ filter: { member_id: id } })
        ];
        if (email) {
          queries.push(
            base44.entities.ComplexEventBooking.list({ filter: { attendee_email: { ilike: email } } })
          );
        }
        const results = await Promise.all(queries.map(p => p.catch((err) => {
          console.error('[MemberActivityTimeline] member-detail-complex-bookings sub-query failed', err);
          return [];
        })));
        const seen = new Set();
        const merged = [];
        for (const list of results) {
          for (const b of (list || [])) {
            if (b && b.id && !seen.has(b.id)) {
              seen.add(b.id);
              merged.push(b);
            }
          }
        }
        return merged;
      } catch (err) {
        console.error('[MemberActivityTimeline] member-detail-complex-bookings query failed', err);
        return [];
      }
    }
  });

  const { data: events = [] } = useQuery({
    queryKey: ['events-for-member-detail'],
    enabled: queriesEnabled && memberBookings.length > 0,
    queryFn: async () => {
      try {
        return await base44.entities.Event.list();
      } catch (err) {
        console.error('[MemberActivityTimeline] events-for-member-detail query failed', err);
        return [];
      }
    }
  });

  const complexEventIds = useMemo(() => {
    const ids = new Set();
    for (const b of complexBookings) {
      if (b?.event_id) ids.add(b.event_id);
    }
    return Array.from(ids);
  }, [complexBookings]);

  const { data: complexEvents = [] } = useQuery({
    queryKey: ['complex-events-for-member-detail', complexEventIds],
    enabled: queriesEnabled && complexEventIds.length > 0,
    queryFn: async () => {
      try {
        return await base44.entities.ComplexEvent.list({
          filter: { id: { in: complexEventIds } }
        }) || [];
      } catch (err) {
        console.error('[MemberActivityTimeline] complex-events-for-member-detail query failed', err);
        return [];
      }
    }
  });

  const memberEmailLower = (memberEmail || '').trim().toLowerCase();

  const { data: groupActivityEvents = [], isLoading: groupActivityLoading } = useQuery({
    queryKey: ['member-detail-group-activity', id],
    enabled: queriesEnabled,
    queryFn: async () => {
      try {
        return await base44.entities.MemberGroupActivity.list({ filter: { member_id: id } });
      } catch (err) {
        console.error('[MemberActivityTimeline] member-detail-group-activity query failed', err);
        return [];
      }
    }
  });

  const complexBookingIds = useMemo(() => {
    const ids = new Set();
    for (const b of complexBookings) {
      if (b?.id) ids.add(b.id);
    }
    return Array.from(ids);
  }, [complexBookings]);

  const { data: complexCheckins = [], isLoading: complexCheckinsLoading } = useQuery({
    queryKey: ['member-detail-complex-checkins', complexBookingIds],
    enabled: queriesEnabled && complexBookingIds.length > 0,
    queryFn: async () => {
      try {
        return await base44.entities.ComplexEventSessionCheckin.list({
          filter: { booking_id: { in: complexBookingIds } }
        }) || [];
      } catch (err) {
        console.error('[MemberActivityTimeline] member-detail-complex-checkins query failed', err);
        return [];
      }
    }
  });

  const checkinSessionIds = useMemo(() => {
    const ids = new Set();
    for (const ci of complexCheckins) {
      if (ci?.checked_in_at && ci?.session_id) ids.add(ci.session_id);
    }
    return Array.from(ids);
  }, [complexCheckins]);

  const { data: checkinSessions = [] } = useQuery({
    queryKey: ['member-detail-checkin-sessions', checkinSessionIds],
    enabled: queriesEnabled && checkinSessionIds.length > 0,
    queryFn: async () => {
      try {
        return await base44.entities.ComplexEventSession.list({
          filter: { id: { in: checkinSessionIds } }
        }) || [];
      } catch (err) {
        console.error('[MemberActivityTimeline] member-detail-checkin-sessions query failed', err);
        return [];
      }
    }
  });

  const unifiedBookings = useMemo(() => {
    const buildAttendeeName = (b) => {
      const first = (b?.attendee_first_name || '').trim();
      const last = (b?.attendee_last_name || '').trim();
      const full = `${first} ${last}`.trim();
      return full || (b?.attendee_email || '').trim() || '';
    };

    const simpleItems = (memberBookings || []).map(b => {
      const event = events.find(e => e.id === b.event_id);
      const isBuyer = !!(id && b.member_id && b.member_id === id);
      const attendeeEmail = (b.attendee_email || '').trim().toLowerCase();
      const isAttendee = !!(memberEmailLower && attendeeEmail === memberEmailLower);
      const bookingDate = b.created_date || b.created_at || null;
      return {
        key: `simple-${b.id}`,
        id: b.id,
        source: 'simple',
        title: event?.title || 'Unknown Event',
        eventDate: event?.start_date || null,
        bookingDate,
        date: bookingDate,
        attendeeName: buildAttendeeName(b),
        ticketClassName: b.ticket_class_name || null,
        status: b.status || 'confirmed',
        isAttendeeOnly: !isBuyer && isAttendee,
      };
    });

    const complexItems = (complexBookings || []).map(b => {
      const ev = complexEvents.find(e => e.id === b.event_id);
      const isBuyer = !!(id && b.member_id && b.member_id === id);
      const attendeeEmail = (b.attendee_email || '').trim().toLowerCase();
      const isAttendee = !!(memberEmailLower && attendeeEmail === memberEmailLower);
      const bookingDate = b.created_at || null;
      return {
        key: `complex-${b.id}`,
        id: b.id,
        source: 'complex',
        title: ev?.title || 'Unknown Event',
        eventDate: ev?.start_date || null,
        bookingDate,
        date: bookingDate,
        attendeeName: buildAttendeeName(b),
        ticketClassName: b.ticket_class_name || null,
        status: b.status || 'confirmed',
        isAttendeeOnly: !isBuyer && isAttendee,
      };
    });

    const groupItems = (groupActivityEvents || []).map(ev => ({
      key: `group-activity-${ev.id}`,
      id: ev.id,
      source: 'group_activity',
      action: ev.action,
      groupName: ev.group_name || '(unknown group)',
      date: ev.created_at || null,
    }));

    // Simple-event check-ins: derived from live booking state. A reversed
    // (deregistered) check-in nulls checked_in_at, so it drops out here.
    const simpleCheckinItems = (memberBookings || [])
      .filter(b => b?.checked_in_at)
      .map(b => {
        const event = events.find(e => e.id === b.event_id);
        return {
          key: `checkin-simple-${b.id}`,
          id: b.id,
          source: 'checkin',
          title: event?.title || 'Unknown Event',
          sessionName: null,
          date: b.checked_in_at,
        };
      });

    // Complex-event per-session check-ins. Same reversal semantics.
    const complexCheckinItems = (complexCheckins || [])
      .filter(ci => ci?.checked_in_at)
      .map(ci => {
        const ev = complexEvents.find(e => e.id === ci.complex_event_id);
        const session = checkinSessions.find(s => s.id === ci.session_id);
        return {
          key: `checkin-complex-${ci.id}`,
          id: ci.id,
          source: 'checkin',
          title: ev?.title || 'Unknown Event',
          sessionName: session?.title || null,
          date: ci.checked_in_at,
        };
      });

    return [...simpleItems, ...complexItems, ...groupItems, ...simpleCheckinItems, ...complexCheckinItems]
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 50);
  }, [memberBookings, complexBookings, events, complexEvents, id, memberEmailLower, groupActivityEvents, complexCheckins, checkinSessions]);

  const anyBookingsLoading = bookingsLoading || complexBookingsLoading || groupActivityLoading || complexCheckinsLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-blue-600" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {anyBookingsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : unifiedBookings.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8" data-testid={emptyTestId}>{emptyText}</p>
        ) : (
          <div className="space-y-3">
            {unifiedBookings.map(item => {
              if (item.source === 'group_activity') {
                const isJoined = item.action === 'joined';
                return (
                  <div
                    key={item.key}
                    className="flex items-start justify-between gap-3 p-3 bg-slate-50 rounded-lg"
                    data-testid={`row-group-activity-${item.id}`}
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isJoined ? 'bg-green-100' : 'bg-slate-100'}`}>
                        {isJoined
                          ? <UserPlus className="w-5 h-5 text-green-600" />
                          : <UserMinus className="w-5 h-5 text-slate-500" />
                        }
                      </div>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="font-medium text-sm" data-testid={`text-group-activity-label-${item.id}`}>
                          {isJoined ? 'Joined group' : 'Left group'}{' '}
                          <span className="font-semibold">{item.groupName}</span>
                        </p>
                        <p className="text-xs text-slate-500" data-testid={`text-group-activity-date-${item.id}`}>
                          {item.date ? formatDate(item.date) : '—'}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <Badge
                        variant={isJoined ? 'outline' : 'secondary'}
                        data-testid={`badge-group-activity-action-${item.id}`}
                      >
                        {isJoined ? 'Joined' : 'Left'}
                      </Badge>
                    </div>
                  </div>
                );
              }
              if (item.source === 'checkin') {
                return (
                  <div
                    key={item.key}
                    className="flex items-start justify-between gap-3 p-3 bg-slate-50 rounded-lg"
                    data-testid={`row-checkin-${item.id}`}
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                        <UserCheck className="w-5 h-5 text-green-600" />
                      </div>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="font-medium text-sm" data-testid={`text-checkin-label-${item.id}`}>
                          Checked in to{' '}
                          <span className="font-semibold">{item.title}</span>
                          {item.sessionName ? ` · ${item.sessionName}` : ''}
                        </p>
                        <p className="text-xs text-slate-500" data-testid={`text-checkin-date-${item.id}`}>
                          {item.date && !isNaN(new Date(item.date).getTime())
                            ? `${formatDate(item.date)} · ${format(new Date(item.date), 'HH:mm')}`
                            : '—'}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <Badge variant="outline" data-testid={`badge-checkin-${item.id}`}>
                        Checked in
                      </Badge>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={item.key}
                  className="flex items-start justify-between gap-3 p-3 bg-slate-50 rounded-lg"
                  data-testid={`row-booking-${item.source}-${item.id}`}
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                      <Calendar className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-medium text-sm truncate" data-testid={`text-booking-title-${item.source}-${item.id}`}>
                        {item.title}
                      </p>
                      {item.attendeeName && (
                        <p className="text-xs text-slate-600 truncate" data-testid={`text-booking-attendee-${item.source}-${item.id}`}>
                          Attendee: {item.attendeeName}
                          {item.ticketClassName ? ` · ${item.ticketClassName}` : ''}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                        <span data-testid={`text-booking-event-date-${item.source}-${item.id}`}>
                          Event: {item.eventDate ? formatDate(item.eventDate) : '—'}
                        </span>
                        <span data-testid={`text-booking-booked-on-${item.source}-${item.id}`}>
                          Booked: {item.bookingDate ? formatDate(item.bookingDate) : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {item.isAttendeeOnly && (
                      <Badge variant="secondary" data-testid={`badge-attendee-${item.source}-${item.id}`}>Attendee</Badge>
                    )}
                    <Badge variant="outline" data-testid={`badge-booking-status-${item.source}-${item.id}`}>
                      {item.status}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
