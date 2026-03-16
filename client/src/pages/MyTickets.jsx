import React from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Clock, Ticket, User, AlertCircle, Download, ExternalLink, Search, ArrowUpDown, ChevronLeft, ChevronRight, XCircle, Loader2, ArrowRightLeft } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import TransferTicketDialog from "@/components/TransferTicketDialog";

const ZOHO_PUBLIC_BACKSTAGE_SUBDOMAIN = "agcasevents";

export default function MyTicketsPage({ hasBanner }) {
  const { memberInfo, memberRole, reloadMemberInfo } = useMemberAccess();
  const queryClient = useQueryClient();
  const [showCancelDialog, setShowCancelDialog] = React.useState(false);
  const [cancelTarget, setCancelTarget] = React.useState(null);
  const [cancelReason, setCancelReason] = React.useState('');
  const [submittingCancel, setSubmittingCancel] = React.useState(false);
  const [termsAgreed, setTermsAgreed] = React.useState(false);
  const [deadlinePassed, setDeadlinePassed] = React.useState(false);
  const [showTermsModal, setShowTermsModal] = React.useState(false);
  const [showTour, setShowTour] = React.useState(false);
  const [tourAutoShow, setTourAutoShow] = React.useState(false);
  const [sortOrder, setSortOrder] = React.useState('desc');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [currentPage, setCurrentPage] = React.useState(1);
  const PAGE_SIZE = 10;

  const hasAutoStartedTour = React.useRef(false);

  const shouldShowTours = memberRole?.show_tours !== false;
  const hasSeenTour = memberInfo?.page_tours_seen?.MyTickets === true;

  React.useEffect(() => {
    if (shouldShowTours && !hasSeenTour && memberInfo && !hasAutoStartedTour.current) {
      hasAutoStartedTour.current = true;
      setTourAutoShow(true);
      setShowTour(true);
    }
  }, [shouldShowTours, hasSeenTour, memberInfo]);

  // Fetch only this user's tickets - filtered server-side by attendee_email
  const { data: myTickets = [], isLoading: loadingTickets } = useQuery({
    queryKey: ['my-tickets', memberInfo?.email],
    queryFn: async () => {
      if (!memberInfo?.email) return [];
      // Use server-side filtering by attendee_email
      return base44.entities.Booking.list({
        filter: { attendee_email: memberInfo.email }
      });
    },
    enabled: !!memberInfo?.email,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Get unique event IDs from user's tickets, then fetch only those events
  const eventIds = [...new Set(myTickets.map(t => t.event_id).filter(Boolean))];
  
  const { data: events = [], isLoading: loadingEvents } = useQuery({
    queryKey: ['events-for-tickets', eventIds],
    queryFn: async () => {
      if (eventIds.length === 0) return [];
      // Fetch only the events that are in user's bookings
      return base44.entities.Event.list({
        filter: { id: { in: eventIds } }
      });
    },
    enabled: eventIds.length > 0,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Get unique member IDs from user's tickets (for "booked by" info)
  const memberIds = [...new Set(myTickets.map(t => t.member_id).filter(Boolean))];
  
  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['members-for-tickets', memberIds],
    queryFn: async () => {
      if (memberIds.length === 0) return [];
      // Fetch only the members who made these bookings
      return base44.entities.Member.list({
        filter: { id: { in: memberIds } }
      });
    },
    enabled: memberIds.length > 0,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: cancellationRequests = [] } = useQuery({
    queryKey: ['my-cancellation-requests'],
    queryFn: async () => {
      const response = await fetch('/api/booking-cancellation-requests', {
        credentials: 'include',
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.requests || [];
    },
    enabled: !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: cancellationSettings } = useQuery({
    queryKey: ['system-setting', 'cancellation_settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const termsSetting = allSettings.find(s => s.setting_key === 'event_booking_terms');
      const deadlineSetting = allSettings.find(s => s.setting_key === 'cancellation_deadline_hours');
      const allowTransferSetting = allSettings.find(s => s.setting_key === 'allow_ticket_transfer');
      const allowCancellationSetting = allSettings.find(s => s.setting_key === 'allow_ticket_cancellation');
      return {
        termsContent: termsSetting?.setting_value || '',
        deadlineHours: parseInt(deadlineSetting?.setting_value) || 0,
        allowTicketTransfer: allowTransferSetting ? allowTransferSetting.setting_value !== 'false' : true,
        allowTicketCancellation: allowCancellationSetting ? allowCancellationSetting.setting_value !== 'false' : true,
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  const bookingTermsContent = cancellationSettings?.termsContent || '';
  const cancellationDeadlineHours = cancellationSettings?.deadlineHours || 0;
  const allowTicketTransfer = cancellationSettings?.allowTicketTransfer !== false;
  const allowTicketCancellation = cancellationSettings?.allowTicketCancellation !== false;

  const pendingCancelBookingIds = React.useMemo(() => {
    return new Set(
      cancellationRequests
        .filter(r => r.status === 'pending')
        .map(r => r.booking_id)
    );
  }, [cancellationRequests]);

  const [showTransferDialog, setShowTransferDialog] = React.useState(false);
  const [transferTarget, setTransferTarget] = React.useState(null);

  const { data: transferRequests = [] } = useQuery({
    queryKey: ['my-transfer-requests'],
    queryFn: async () => {
      const response = await fetch('/api/booking-transfer-requests', {
        credentials: 'include',
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.requests || [];
    },
    enabled: !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const pendingTransferBookingIds = React.useMemo(() => {
    return new Set(
      transferRequests
        .filter(r => r.status === 'pending')
        .map(r => r.booking_id)
    );
  }, [transferRequests]);

  const handleTransferClick = (ticket) => {
    setTransferTarget(ticket);
    setShowTransferDialog(true);
  };

  const handleTourComplete = async () => {
    setShowTour(false);
    setTourAutoShow(false);
  };

  const handleTourDismiss = async () => {
    setShowTour(false);
    setTourAutoShow(false);
    await updateMemberTourStatus('MyTickets');
  };

  const handleStartTour = () => {
    setShowTour(false);
    setTourAutoShow(false);

    setTimeout(() => {
      setShowTour(true);
      setTourAutoShow(true);
    }, 10);
  };

  const updateMemberTourStatus = async (tourKey) => {
    if (memberInfo && !memberInfo.is_team_member) {
      try {
        const currentMember = await base44.entities.Member.get(memberInfo.id);

        if (currentMember) {
          const updatedTours = { ...(currentMember.page_tours_seen || {}), [tourKey]: true };
          await base44.entities.Member.update(currentMember.id, {
            page_tours_seen: updatedTours
          });

          const updatedMemberInfo = { ...memberInfo, page_tours_seen: updatedTours };
          localStorage.setItem('agcas_member', JSON.stringify(updatedMemberInfo));
          
          if (reloadMemberInfo) {
            reloadMemberInfo();
          }
        }
      } catch (error) {
        console.error('Failed to update tour status:', error);
      }
    }
  };

  if (!memberInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const isLoading = loadingTickets || loadingEvents || loadingMembers;

  const filteredAndSortedTickets = React.useMemo(() => {
    const ticketsWithEvents = myTickets.map(ticket => ({
      ticket,
      event: events.find(e => e.id === ticket.event_id)
    })).filter(item => item.event);

    const query = searchQuery.toLowerCase().trim();
    const filtered = query
      ? ticketsWithEvents.filter(({ ticket, event }) => {
          return (
            (event.title || '').toLowerCase().includes(query) ||
            (event.location || '').toLowerCase().includes(query) ||
            (ticket.booking_reference || '').toLowerCase().includes(query) ||
            (ticket.backstage_order_id || '').toLowerCase().includes(query) ||
            (ticket.status || '').toLowerCase().includes(query)
          );
        })
      : ticketsWithEvents;

    filtered.sort((a, b) => {
      const dateA = a.event.start_date ? new Date(a.event.start_date).getTime() : 0;
      const dateB = b.event.start_date ? new Date(b.event.start_date).getTime() : 0;
      return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });

    return filtered;
  }, [myTickets, events, searchQuery, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filteredAndSortedTickets.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const paginatedTickets = filteredAndSortedTickets.slice(
    (safeCurrentPage - 1) * PAGE_SIZE,
    safeCurrentPage * PAGE_SIZE
  );

  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortOrder]);

  React.useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [totalPages, currentPage]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'confirmed':
        return 'bg-green-100 text-green-700 border-green-200';
      case 'pending':
        return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'cancelled':
        return 'bg-red-100 text-red-700 border-red-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const formatDateForICS = (date) => {
    if (!date) return '';
    const d = new Date(date);
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  };

  const downloadICS = (event, ticket) => {
    const startDate = event.start_date ? new Date(event.start_date) : null;
    const endDate = event.end_date ? new Date(event.end_date) : null;

    if (!startDate) return;

    const eventEndDate = endDate || new Date(startDate.getTime() + 60 * 60 * 1000);

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//iconn.app//Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${ticket.id}@iconn.app`,
      `DTSTAMP:${formatDateForICS(new Date())}`,
      `DTSTART:${formatDateForICS(startDate)}`,
      `DTEND:${formatDateForICS(eventEndDate)}`,
      `SUMMARY:${event.title}`,
      event.description ? `DESCRIPTION:${event.description.replace(/\n/g, '\\n')}` : '',
      event.location ? `LOCATION:${event.location}` : '',
      `STATUS:${ticket.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].filter((line) => line).join('\r\n');

    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${event.title.replace(/[^a-z0-9]/gi, '_')}.ics`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const handleCancelClick = (ticket) => {
    setCancelTarget({ type: 'individual', bookings: [ticket] });
    setCancelReason('');
    setTermsAgreed(false);

    if (cancellationDeadlineHours > 0 && ticket.event_id) {
      const event = events.find(e => e.id === ticket.event_id);
      if (event?.start_date) {
        const eventStart = new Date(event.start_date);
        const now = new Date();
        const hoursUntilEvent = (eventStart.getTime() - now.getTime()) / (1000 * 60 * 60);
        setDeadlinePassed(hoursUntilEvent < cancellationDeadlineHours);
      } else {
        setDeadlinePassed(false);
      }
    } else {
      setDeadlinePassed(false);
    }

    setShowCancelDialog(true);
  };

  const handleCancelSubmit = async () => {
    if (!cancelTarget || cancelTarget.bookings.length === 0) {
      setShowCancelDialog(false);
      return;
    }

    if (bookingTermsContent && !termsAgreed) {
      toast.error('You must agree to the cancellation terms and conditions before submitting.');
      return;
    }

    setSubmittingCancel(true);

    try {
      const response = await fetch('/api/booking-cancellation-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          booking_ids: cancelTarget.bookings.map(b => b.id),
          booking_group_reference: null,
          request_type: cancelTarget.type,
          reason: cancelReason.trim() || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to submit cancellation request');
      }

      toast.success('Cancellation request submitted');
      setShowCancelDialog(false);
      setCancelTarget(null);
      setCancelReason('');
      setTermsAgreed(false);
      setDeadlinePassed(false);
      queryClient.invalidateQueries({ queryKey: ['my-cancellation-requests'] });
    } catch (error) {
      console.error('Cancellation request error:', error);
      toast.error(error.message || 'Failed to submit cancellation request. Please try again.');
    } finally {
      setSubmittingCancel(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {showTour && shouldShowTours && (
        <PageTour
          tourGroupName="MyTickets"
          viewId={null}
          onComplete={handleTourComplete}
          onDismissPermanently={handleTourDismiss}
          autoShow={tourAutoShow}
        />
      )}

      <div className="max-w-7xl mx-auto">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                My Tickets
              </h1>
              {shouldShowTours && (
                <TourButton onClick={handleStartTour} />
              )}
            </div>
            <p className="text-slate-600">
              Events you are registered to attend
            </p>
          </div>
        )}

        {!isLoading && myTickets.length > 0 && (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by event, location, reference..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-tickets"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="default"
                onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
                data-testid="button-toggle-sort"
              >
                <ArrowUpDown className="h-4 w-4 mr-2" />
                Date {sortOrder === 'desc' ? 'Newest first' : 'Oldest first'}
              </Button>
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {filteredAndSortedTickets.length} ticket{filteredAndSortedTickets.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-6">
            {Array(4).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <CardHeader>
                  <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-1/2" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="h-4 bg-slate-200 rounded" />
                    <div className="h-4 bg-slate-200 rounded w-5/6" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : myTickets.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Ticket className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No tickets yet
              </h3>
              <p className="text-slate-600 mb-6">
                You don't have any event tickets registered in your name yet
              </p>
              <Link to={createPageUrl('Events')}>
                <button className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
                  Browse Events
                </button>
              </Link>
            </CardContent>
          </Card>
        ) : filteredAndSortedTickets.length === 0 && searchQuery ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No matching tickets
              </h3>
              <p className="text-slate-600 mb-6">
                No tickets match your search for "{searchQuery}"
              </p>
              <Button
                variant="outline"
                onClick={() => setSearchQuery('')}
                data-testid="button-clear-search"
              >
                Clear search
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {paginatedTickets.map(({ ticket, event }, index) => {
              const bookedByMember = members.find((m) => m.id === ticket.member_id);

              const startDate = event.start_date ? new Date(event.start_date) : null;
              const isSelfBooked = ticket.member_id === memberInfo.id || memberInfo.email === ticket.attendee_email;
              const isCancelled = ticket.status === 'cancelled';
              const hasPendingCancel = pendingCancelBookingIds.has(ticket.id);
              const hasPendingTransfer = pendingTransferBookingIds.has(ticket.id);
              const hasPendingRequest = hasPendingCancel || hasPendingTransfer;
              const backstageEventUrl = event.backstage_public_url || null;

              return (
                <Card
                  key={ticket.id}
                  id={index === 0 ? "first-my-ticket-card" : undefined}
                  className={`border-slate-200 shadow-sm hover:shadow-md transition-shadow ${
                    isCancelled ? 'opacity-75 border-red-300 bg-red-50/30' : ''
                  }`}
                >
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <CardTitle className={`text-xl ${isCancelled ? 'line-through text-slate-500' : ''}`}>
                            {event.title}
                          </CardTitle>
                          {event.program_tag && (
                            <Badge className="bg-blue-100 text-blue-700 border-blue-200">
                              {event.program_tag}
                            </Badge>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <Badge
                            id={index === 0 ? "first-ticket-status-badge" : undefined}
                            className={getStatusColor(isCancelled ? 'cancelled' : ticket.status)}
                          >
                            {isCancelled ? 'cancelled' : ticket.status}
                          </Badge>
                          {hasPendingCancel && !isCancelled && (
                            <Badge className="bg-amber-100 text-amber-700 border-amber-200" data-testid={`badge-pending-cancel-${ticket.id}`}>
                              Cancellation Pending
                            </Badge>
                          )}
                          {hasPendingTransfer && !isCancelled && (
                            <Badge className="bg-blue-100 text-blue-700 border-blue-200" data-testid={`badge-pending-transfer-${ticket.id}`}>
                              Transfer Pending
                            </Badge>
                          )}
                        </div>

                        {!isSelfBooked && bookedByMember && (
                          <div className="flex items-center gap-2 text-xs text-slate-500 mt-2">
                            <User className="w-3 h-3" />
                            <span>
                              Booked by {bookedByMember.first_name} {bookedByMember.last_name}
                            </span>
                          </div>
                        )}
                      </div>
                      
                      {event.image_url && (
                        <img
                          src={event.image_url}
                          alt={event.title}
                          className={`w-24 h-24 object-cover rounded-lg shrink-0 ${isCancelled ? 'grayscale' : ''}`}
                          style={getFocalPointStyle(event.image_focal_point)}
                        />
                      )}
                    </div>
                  </CardHeader>
                  
                  <CardContent className="pt-6">
                    <div className="grid md:grid-cols-2 gap-6">
                      <div className="space-y-3">
                        {startDate && (
                          <div className={`flex items-center gap-2 text-sm ${isCancelled ? 'text-slate-400' : 'text-slate-600'}`}>
                            <Calendar className="w-4 h-4 text-slate-400" />
                            <span>{format(startDate, "EEEE, MMMM d, yyyy")}</span>
                          </div>
                        )}

                        {startDate && (
                          <div className={`flex items-center gap-2 text-sm ${isCancelled ? 'text-slate-400' : 'text-slate-600'}`}>
                            <Clock className="w-4 h-4 text-slate-400" />
                            <span>{format(startDate, "h:mm a")}</span>
                          </div>
                        )}

                        {event.location && (
                          <div className={`flex items-center gap-2 text-sm ${isCancelled ? 'text-slate-400' : 'text-slate-600'}`}>
                            <MapPin className="w-4 h-4 text-slate-400" />
                            <span className="line-clamp-1">{event.location}</span>
                          </div>
                        )}
                      </div>

                      <div className="space-y-3">
                        {ticket.backstage_order_id && (
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <Ticket className="w-3 h-3 text-purple-400" />
                            <span className="text-slate-600">Ticket ID:</span>
                            <span className="font-mono text-purple-600 bg-purple-50 px-2 py-0.5 rounded">
                              {ticket.backstage_order_id}
                            </span>
                          </div>
                        )}

                        {ticket.booking_reference && (
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span className="text-slate-600">Booking Ref:</span>
                            <span className="font-semibold text-slate-900">{ticket.booking_reference}</span>
                          </div>
                        )}

                        {!isCancelled && !hasPendingRequest && startDate && (
                          <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                              <Button
                                id={index === 0 ? "add-to-calendar-button" : undefined}
                                variant="outline"
                                size="sm"
                                onClick={() => downloadICS(event, ticket)}
                                className="flex-1"
                              >
                                <Download className="w-4 h-4 mr-2" />
                                Add to Calendar
                              </Button>
                              
                              {allowTicketTransfer && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleTransferClick(ticket)}
                                  data-testid={`button-transfer-ticket-${ticket.id}`}
                                >
                                  <ArrowRightLeft className="w-4 h-4" />
                                </Button>
                              )}

                              {allowTicketCancellation && (
                                <Button
                                  id={index === 0 ? "cancel-ticket-button" : undefined}
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleCancelClick(ticket)}
                                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                  data-testid={`button-cancel-ticket-${ticket.id}`}
                                >
                                  <XCircle className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                            
                            {backstageEventUrl && (
                              <Button
                                id={index === 0 ? "go-to-event-page-button" : undefined}
                                variant="outline"
                                size="sm"
                                asChild
                                className="w-full"
                              >
                                <a href={backstageEventUrl} target="_blank" rel="noopener noreferrer">
                                  <ExternalLink className="w-4 h-4 mr-2" />
                                  Go to Event Page
                                </a>
                              </Button>
                            )}
                          </div>
                        )}
                        
                        {hasPendingCancel && !isCancelled && (
                          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <p className="text-xs text-amber-800 font-medium">
                              Cancellation request submitted — awaiting admin review
                            </p>
                          </div>
                        )}
                        {hasPendingTransfer && !isCancelled && (
                          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                            <ArrowRightLeft className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                            <p className="text-xs text-blue-800 font-medium">
                              Transfer request submitted — awaiting admin review
                            </p>
                          </div>
                        )}
                        {isCancelled && (
                          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                            <p className="text-xs text-red-800 font-medium">
                              This ticket has been cancelled
                            </p>
                          </div>
                        )}
                      </div>
                    </div>

                    {ticket.status === 'pending' && !isCancelled && (
                      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mt-4">
                        <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                        <p className="text-xs text-amber-800">
                          This ticket is pending confirmation. Please check your email for the confirmation link.
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 pt-4">
                <Button
                  variant="outline"
                  size="default"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={safeCurrentPage <= 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {safeCurrentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="default"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={safeCurrentPage >= totalPages}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={showCancelDialog} onOpenChange={(open) => { if (!open) { setShowCancelDialog(false); setCancelTarget(null); setCancelReason(''); setTermsAgreed(false); setDeadlinePassed(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deadlinePassed ? 'Cancellation Not Available' : 'Request Cancellation'}</DialogTitle>
            <DialogDescription>
              {deadlinePassed
                ? `Cancellation requests cannot be submitted within ${cancellationDeadlineHours} hour${cancellationDeadlineHours !== 1 ? 's' : ''} of the event start time.`
                : 'Submit a cancellation request for this ticket. An administrator will review your request.'}
            </DialogDescription>
          </DialogHeader>
          {deadlinePassed ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-md">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium mb-1">Cancellation deadline has passed</p>
                  <p>
                    Cancellation requests must be submitted at least {cancellationDeadlineHours} hour{cancellationDeadlineHours !== 1 ? 's' : ''} before the event starts. Please contact an administrator directly if you need to cancel.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => { setShowCancelDialog(false); setCancelTarget(null); setDeadlinePassed(false); }}
                  data-testid="button-deadline-close"
                >
                  Close
                </Button>
              </DialogFooter>
            </div>
          ) : (
          <>
          {cancelTarget && (
            <div className="space-y-4">
              <div className="space-y-2">
                {cancelTarget.bookings.map(b => (
                  <div key={b.id} className="flex items-center gap-2 text-sm p-2 bg-slate-50 rounded-md border border-slate-200">
                    <User className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="text-slate-700 truncate" data-testid={`text-cancel-attendee-${b.id}`}>
                      {b.attendee_first_name && b.attendee_last_name
                        ? `${b.attendee_first_name} ${b.attendee_last_name}`
                        : b.attendee_email || 'Unknown attendee'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Reason for cancellation (optional)
                </label>
                <Textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Let us know why you need to cancel..."
                  className="resize-none"
                  rows={3}
                  data-testid="input-cancel-reason"
                />
              </div>
              {bookingTermsContent && (
                <div className="space-y-2 pt-2 border-t border-slate-200">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="terms-agreement"
                      checked={termsAgreed}
                      onCheckedChange={setTermsAgreed}
                      data-testid="switch-terms-agreement"
                    />
                    <Label htmlFor="terms-agreement" className="text-sm text-slate-700 cursor-pointer">
                      I agree to the cancellation terms and conditions
                    </Label>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowTermsModal(true)}
                    className="text-sm text-blue-600 hover:text-blue-800 underline inline-block cursor-pointer"
                    data-testid="button-view-terms"
                  >
                    View Terms & Conditions
                  </button>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setShowCancelDialog(false); setCancelTarget(null); setCancelReason(''); setTermsAgreed(false); setDeadlinePassed(false); }}
              data-testid="button-cancel-dialog-close"
            >
              Keep Registration
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelSubmit}
              disabled={submittingCancel || (bookingTermsContent && !termsAgreed)}
              data-testid="button-submit-cancellation"
            >
              {submittingCancel ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                'Submit Cancellation Request'
              )}
            </Button>
          </DialogFooter>
          </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showTermsModal} onOpenChange={setShowTermsModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Terms & Conditions</DialogTitle>
          </DialogHeader>
          <div
            className="flex-1 overflow-y-auto prose prose-sm max-w-none text-slate-700"
            dangerouslySetInnerHTML={{ __html: bookingTermsContent }}
            data-testid="text-terms-content"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowTermsModal(false)}
              data-testid="button-close-terms"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TransferTicketDialog
        open={showTransferDialog}
        onOpenChange={(open) => { if (!open) { setShowTransferDialog(false); setTransferTarget(null); } }}
        booking={transferTarget}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['my-transfer-requests'] });
        }}
      />
    </div>
  );
}