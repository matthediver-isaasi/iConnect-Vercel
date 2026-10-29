import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, Calendar, UserCheck, UserPlus, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { useDateFormat } from "@/hooks/useDateFormat";
import RelatedOpportunityActivity from "@/components/opportunities/RelatedOpportunityActivity";
import ActivityInvoiceActions from "@/components/ActivityInvoiceActions";
import { HistoricalInvoicesTable } from "@/components/membership/HistoricalInvoices";
import { useHistoricalInvoiceTenant } from "@/hooks/useHistoricalInvoices";
import { useAllHistoricalInvoices, mergeHistoricalInvoiceActivity } from "@/components/membership/activityInvoices";
import { bookingActivityDate, validActivityDate } from "@/lib/memberActivityDates";

/**
 * Shared member Activity timeline.
 *
 * This is the single source of truth for the member Activity timeline used by
 * both member detail screens (`pages/MemberDetail.jsx` and
 * `components/MemberDetailView.jsx`). Data fetching, unified item building and
 * per-row rendering (bookings, check-ins, group join/leave and historical
 * invoices, including renewal invoices) all live here so
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
 * @param {string} [props.activeTenantId] Tenant fallback for archive reads and PDF actions.
 */
export default function MemberActivityTimeline(props) {
  const tenantId = useHistoricalInvoiceTenant(props.activeTenantId);
  return <MemberActivityTimelineContent key={`${tenantId || "portal"}:${props.memberId}`} {...props} tenantId={tenantId} />;
}

function MemberActivityTimelineContent({
  memberId,
  memberEmail,
  enabled = true,
  title = "Activity Timeline",
  emptyText = "No activity found",
  emptyTestId = "text-no-activity",
  tenantId,
  request = fetch,
}) {
  const { formatDate } = useDateFormat();
  const [page, setPage] = useState(0);
  const displayDate = value => validActivityDate(value) ? formatDate(value) : '—';

  const id = memberId;
  const queriesEnabled = !!id && enabled;
  const invoices = useAllHistoricalInvoices({ memberId: id, activeTenantId: tenantId, enabled: queriesEnabled, request });

  const { data: memberBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['member-detail-bookings', id, memberEmail, tenantId],
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
    queryKey: ['member-detail-complex-bookings', id, memberEmail, tenantId],
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

  const { data: events = [], isLoading: eventsLoading } = useQuery({
    queryKey: ['events-for-member-detail', tenantId],
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

  const { data: complexEvents = [], isLoading: complexEventsLoading } = useQuery({
    queryKey: ['complex-events-for-member-detail', complexEventIds, tenantId],
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
    queryKey: ['member-detail-group-activity', id, tenantId],
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
    queryKey: ['member-detail-complex-checkins', complexBookingIds, tenantId],
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

  const { data: checkinSessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['member-detail-checkin-sessions', checkinSessionIds, tenantId],
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
      const bookingDate = validActivityDate(b.created_date) || validActivityDate(b.created_at);
      return {
        key: `simple-${b.id}`,
        booking: b,
        id: b.id,
        source: 'simple',
        title: event?.title || 'Unknown Event',
        eventDate: event?.start_date || null,
        bookingDate,
        date: bookingActivityDate(event, b),
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
      const bookingDate = validActivityDate(b.created_at) || validActivityDate(b.created_date);
      return {
        key: `complex-${b.id}`,
        booking: b,
        id: b.id,
        source: 'complex',
        title: ev?.title || 'Unknown Event',
        eventDate: ev?.start_date || null,
        bookingDate,
        date: bookingActivityDate(ev, b),
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

    return mergeHistoricalInvoiceActivity(
      [...simpleItems, ...complexItems, ...groupItems, ...simpleCheckinItems, ...complexCheckinItems],
      invoices.data?.records || [],
    );
  }, [memberBookings, complexBookings, events, complexEvents, id, memberEmailLower, groupActivityEvents, complexCheckins, checkinSessions, invoices.data]);

  const anyBookingsLoading = bookingsLoading || complexBookingsLoading || groupActivityLoading || complexCheckinsLoading
    || eventsLoading || complexEventsLoading || sessionsLoading || invoices.isLoading;
  const totalPages = Math.max(1, Math.ceil(unifiedBookings.length / 50));
  const currentPage = Math.min(page, totalPages - 1);
  const visibleActivity = unifiedBookings.slice(currentPage * 50, (currentPage + 1) * 50);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-blue-600" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
        {anyBookingsLoading ? (
          <div role="status" aria-label="Loading activity" className="space-y-3 animate-pulse py-4">
            {[0, 1, 2].map(row => <div key={row} className="h-16 rounded-lg bg-muted" />)}
            <span className="sr-only">Loading activity and invoices…</span>
          </div>
        ) : invoices.error ? (
          <div role="alert" className="space-y-3 text-sm text-destructive">
            <p>{invoices.error.message}</p>
            <p>The complete activity timeline cannot be shown until invoices have loaded.</p>
            <Button type="button" variant="outline" size="sm" disabled={invoices.isFetching} onClick={() => invoices.refetch()}>Retry</Button>
          </div>
        ) : unifiedBookings.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8" data-testid={emptyTestId}>{emptyText}</p>
        ) : (
          <div className="space-y-3">
            {visibleActivity.map(item => {
              if (item.source === 'historical_invoice') {
                return <HistoricalInvoicesTable
                  key={item.key}
                  activity
                  records={[item.record]}
                  canAccessInvoices={invoices.data?.canAccessInvoices === true}
                  tenantId={tenantId}
                  request={request}
                />;
              }
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
                          {displayDate(item.date)}
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
                          Event: {displayDate(item.eventDate)}
                        </span>
                        <span data-testid={`text-booking-booked-on-${item.source}-${item.id}`}>
                          Booked: {displayDate(item.bookingDate)}
                        </span>
                      </div>
                      <ActivityInvoiceActions booking={item.booking} />
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
        {!anyBookingsLoading && !invoices.error && invoices.data?.total > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">Historical invoices are read-only records, not evidence of current membership entitlement. Historical invoice dates and membership payment or start dates determine their position; unknown dates appear last.</p>
        )}
        {!anyBookingsLoading && !invoices.error && totalPages > 1 && (
          <nav aria-label="Activity pages" className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Page {currentPage + 1} of {totalPages} · {unifiedBookings.length} activities</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
              <Button type="button" size="sm" variant="outline" disabled={currentPage + 1 >= totalPages} onClick={() => setPage(currentPage + 1)}>Next</Button>
            </div>
          </nav>
        )}
        </CardContent>
      </Card>
      <RelatedOpportunityActivity memberId={memberId} enabled={queriesEnabled} />
    </div>
  );
}
