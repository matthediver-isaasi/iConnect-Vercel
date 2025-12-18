import React from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Clock, Ticket, User, AlertCircle, Download, Pencil, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const ZOHO_PUBLIC_BACKSTAGE_SUBDOMAIN = "agcasevents";

export default function MyTicketsPage({ hasBanner }) {
  const { memberInfo, memberRole, reloadMemberInfo } = useMemberAccess();
  const [cancellingTicketId, setCancellingTicketId] = React.useState(null);
  const [showCancelDialog, setShowCancelDialog] = React.useState(false);
  const [ticketToCancel, setTicketToCancel] = React.useState(null);
  const [cancelledTicketIds, setCancelledTicketIds] = React.useState(new Set());
  const [showTour, setShowTour] = React.useState(false);
  const [tourAutoShow, setTourAutoShow] = React.useState(false);

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
      'PRODID:-//AGCAS Events//iConnect//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${ticket.id}@agcas-events.com`,
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
    setTicketToCancel(ticket);
    setShowCancelDialog(true);
  };

  const handleCancelConfirm = async () => {
    if (!ticketToCancel || !ticketToCancel.backstage_order_id) {
      toast.error('Unable to cancel: Missing ticket information');
      setShowCancelDialog(false);
      return;
    }

    setCancellingTicketId(ticketToCancel.id);
    setShowCancelDialog(false);

    try {
      const allMembers = await base44.entities.Member.listAll();
      const currentMember = allMembers.find((m) => m.email === memberInfo.email);

      if (!currentMember) {
        toast.error('Unable to verify member identity');
        setCancellingTicketId(null);
        setTicketToCancel(null);
        return;
      }

      const response = await base44.functions.invoke('cancelTicketViaFlow', {
        orderId: ticketToCancel.backstage_order_id,
        cancelReason: 'Cancelled by member via iConnect',
        memberId: currentMember.id
      });

      if (response.data.success) {
        setCancelledTicketIds((prev) => new Set([...prev, ticketToCancel.id]));
        toast.success('Ticket cancelled successfully');

        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } else {
        throw new Error(response.data.error || 'Failed to cancel ticket');
      }
    } catch (error) {
      console.error('Cancellation error:', error);
      toast.error('Failed to cancel ticket. Please try again or contact support.');
    } finally {
      setCancellingTicketId(null);
      setTicketToCancel(null);
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
        ) : (
          <div className="space-y-6">
            {myTickets.map((ticket, index) => {
              const event = events.find((e) => e.id === ticket.event_id);
              const bookedByMember = members.find((m) => m.id === ticket.member_id);

              if (!event) return null;

              const startDate = event.start_date ? new Date(event.start_date) : null;
              const isSelfBooked = ticket.member_id === memberInfo.id || memberInfo.email === ticket.attendee_email;
              const isCancelled = ticket.status === 'cancelled' || cancelledTicketIds.has(ticket.id);
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
                        
                        <div className="flex items-center gap-2 mb-2">
                          <Badge
                            id={index === 0 ? "first-ticket-status-badge" : undefined}
                            className={getStatusColor(isCancelled ? 'cancelled' : ticket.status)}
                          >
                            {isCancelled ? 'cancelled' : ticket.status}
                          </Badge>
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

                        {!isCancelled && startDate && (
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
                              
                              {ticket.backstage_order_id && (
                                <Button
                                  id={index === 0 ? "cancel-ticket-button" : undefined}
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleCancelClick(ticket)}
                                  disabled={cancellingTicketId === ticket.id}
                                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                >
                                  <Pencil className="w-4 h-4" />
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
          </div>
        )}
      </div>

      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold">Cancel Registration?</AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              Cancelling this registration will make the ticket available for reallocation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, keep registration</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              Yes, cancel registration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}