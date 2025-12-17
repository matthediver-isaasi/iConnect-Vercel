import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar, MapPin, Users, Clock, Ticket, AlertCircle, ShoppingCart, Pencil, Trash2, Video, Globe, UsersRound, Download, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const DEFAULT_TIMEZONE = "Europe/London";

// Helper function to format date in event's timezone
const formatEventDate = (dateStr, timezone = DEFAULT_TIMEZONE, formatStr = "MMM d, yyyy") => {
  if (!dateStr) return null;
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    return formatInTimeZone(date, timezone, formatStr);
  } catch (e) {
    console.error('Error formatting date:', e);
    return format(new Date(dateStr), formatStr);
  }
};

// Helper function to format time in event's timezone
const formatEventTime = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  if (!dateStr) return null;
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    return formatInTimeZone(date, timezone, "h:mm a");
  } catch (e) {
    console.error('Error formatting time:', e);
    return format(new Date(dateStr), "h:mm a");
  }
};

// Helper to get timezone abbreviation for a specific date (handles DST correctly)
const getTimezoneAbbr = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  try {
    // Use the event date to get the correct DST-aware abbreviation
    const eventDate = dateStr ? (typeof dateStr === 'string' ? parseISO(dateStr) : dateStr) : new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      timeZoneName: 'short'
    });
    const parts = formatter.formatToParts(eventDate);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart ? tzPart.value : timezone;
  } catch {
    return timezone;
  }
};

// Check if event is past using timezone-aware comparison
const isEventInPast = (event, timezone = DEFAULT_TIMEZONE) => {
  if (!event.start_date) return false;
  try {
    const eventDate = typeof event.start_date === 'string' 
      ? parseISO(event.start_date) 
      : new Date(event.start_date);
    const now = new Date();
    return eventDate < now;
  } catch {
    return false;
  }
};

const ZOHO_PUBLIC_BACKSTAGE_SUBDOMAIN = "agcasevents";

// Helper function to get event type styling from system settings
const getEventTypeStyle = (eventTypeName, systemSettings) => {
  const defaultStyle = { bgColor: '#dcfce7', textColor: '#15803d' }; // green default
  
  if (!eventTypeName || !systemSettings?.length) return defaultStyle;
  
  const eventTypesSetting = systemSettings.find(s => s.setting_key === 'event_types');
  if (!eventTypesSetting?.setting_value) return defaultStyle;
  
  try {
    const eventTypes = JSON.parse(eventTypesSetting.setting_value);
    // Handle both old string format and new object format
    const eventType = eventTypes.find(t => 
      (typeof t === 'string' && t === eventTypeName) ||
      (typeof t === 'object' && t.name === eventTypeName)
    );
    
    if (eventType && typeof eventType === 'object') {
      return {
        bgColor: eventType.bgColor || defaultStyle.bgColor,
        textColor: eventType.textColor || defaultStyle.textColor
      };
    }
  } catch (e) {
    console.error('Error parsing event types:', e);
  }
  
  return defaultStyle;
};

// Helper function to get CTA button configuration from system settings
const getCtaButtonConfig = (systemSettings) => {
  const defaultConfig = { style: 'default', label: 'Register' };
  
  if (!systemSettings?.length) return defaultConfig;
  
  const ctaSetting = systemSettings.find(s => s.setting_key === 'event_cta_button');
  if (!ctaSetting?.setting_value) return defaultConfig;
  
  try {
    const config = JSON.parse(ctaSetting.setting_value);
    return {
      style: config.style || 'default',
      label: config.label || 'Register'
    };
  } catch (e) {
    console.error('Error parsing CTA button config:', e);
  }
  
  return defaultConfig;
};

export default function EventCard({ event, organizationInfo, isFeatureExcluded, isAdmin, onEventDeleted, joinLinkSettings, webinars, systemSettings = [] }) {
  const queryClient = useQueryClient();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [showAttendeesModal, setShowAttendeesModal] = useState(false);
  const [organizationFilter, setOrganizationFilter] = useState("all");
  const [searchFilter, setSearchFilter] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 25;

  // Fetch bookings for this event when attendees modal is open
  const { data: bookingsData, isLoading: bookingsLoading } = useQuery({
    queryKey: ['event-bookings', event.id],
    queryFn: async () => {
      // Use the filter method to get only bookings for this event
      const bookings = await base44.entities.Booking.filter({ event_id: event.id });
      return bookings;
    },
    enabled: showAttendeesModal && isAdmin,
  });

  // Fetch organizations when attendees modal is open
  const { data: organizationsData } = useQuery({
    queryKey: ['organizations-for-attendees'],
    queryFn: async () => {
      return await base44.entities.Organization.listAll();
    },
    enabled: showAttendeesModal && isAdmin,
  });

  // Create organization lookup map
  const organizationMap = useMemo(() => {
    if (!organizationsData) return {};
    return organizationsData.reduce((acc, org) => {
      acc[org.id] = org.name;
      return acc;
    }, {});
  }, [organizationsData]);

  // Get unique organizations from bookings for filter dropdown
  const uniqueOrganizations = useMemo(() => {
    if (!bookingsData) return [];
    const orgIds = [...new Set(bookingsData.map(b => b.organization_id).filter(Boolean))];
    return orgIds.map(id => ({
      id,
      name: organizationMap[id] || 'Unknown Organization'
    })).sort((a, b) => a.name.localeCompare(b.name));
  }, [bookingsData, organizationMap]);

  // Filter attendees based on organization and search
  const filteredAttendees = useMemo(() => {
    if (!bookingsData) return [];
    return bookingsData
      .filter(booking => {
        // Filter by organization
        if (organizationFilter !== "all" && booking.organization_id !== organizationFilter) {
          return false;
        }
        // Filter by search term
        if (searchFilter) {
          const search = searchFilter.toLowerCase();
          const name = `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.toLowerCase();
          const email = (booking.attendee_email || '').toLowerCase();
          const org = (organizationMap[booking.organization_id] || '').toLowerCase();
          return name.includes(search) || email.includes(search) || org.includes(search);
        }
        return true;
      })
      .sort((a, b) => {
        const nameA = `${a.attendee_first_name || ''} ${a.attendee_last_name || ''}`;
        const nameB = `${b.attendee_first_name || ''} ${b.attendee_last_name || ''}`;
        return nameA.localeCompare(nameB);
      });
  }, [bookingsData, organizationFilter, searchFilter, organizationMap]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAttendees.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedAttendees = filteredAttendees.slice(startIndex, endIndex);

  // Generate page numbers for pagination controls
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  // Reset to page 1 when filters change
  useMemo(() => {
    setCurrentPage(1);
  }, [organizationFilter, searchFilter]);

  // Export to CSV function
  const exportToCSV = () => {
    if (!filteredAttendees.length) {
      toast.error('No attendees to export');
      return;
    }

    const headers = ['Name', 'Email', 'Organisation'];
    const rows = filteredAttendees.map(booking => [
      `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim(),
      booking.attendee_email || '',
      organizationMap[booking.organization_id] || ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${(cell || '').replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `attendees-${event.title.replace(/[^a-z0-9]/gi, '-')}-${format(new Date(), 'yyyy-MM-dd')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success('Attendees exported to CSV');
  };

  const handleAttendeesClick = (e) => {
    e.stopPropagation();
    setShowAttendeesModal(true);
  };
  
  // Get the event's timezone (default to Europe/London for UK events)
  const eventTimezone = event.timezone || DEFAULT_TIMEZONE;
  // Pass event date to get correct DST-aware abbreviation (GMT vs BST)
  // For TBC events, don't compute timezone abbr since there's no date
  const isTbcEvent = event.status === 'tbc';
  const timezoneAbbr = isTbcEvent ? '' : getTimezoneAbbr(event.start_date, eventTimezone);
  
  // Check if event is in the past using timezone-aware comparison
  const isEventPast = isEventInPast(event, eventTimezone);

  const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;

  // Determine if this is an online event using the is_online field
  const isOnlineEvent = event.is_online === true;

  const availableTickets = event.program_tag && organizationInfo?.program_ticket_balances 
    ? (organizationInfo.program_ticket_balances[event.program_tag] || 0)
    : 0;
  
  const hasTickets = availableTickets > 0;
  const needsTickets = event.program_tag && !hasTickets;

  const backstageEventUrl = event.backstage_public_url || null;

  // Check system setting for showing seats (global override)
  // Default to true (show seats) to preserve existing UX - only hide if explicitly set to 'false'
  const showSeatsSetting = Array.isArray(systemSettings) 
    ? systemSettings.find(s => s.setting_key === 'show_event_seats')
    : null;
  const globalShowSeats = showSeatsSetting?.setting_value !== 'false';
  
  // Per-event visibility: when global is ON, check per-event setting (default to true if not set)
  // When global is OFF, never show regardless of per-event setting
  const perEventShowSeats = event.show_seat_count !== false;
  const showSeatsEnabled = globalShowSeats && perEventShowSeats;
  
  // Combine both role-based permission and system setting
  const showAvailableSeats = showSeatsEnabled && (!isFeatureExcluded || !isFeatureExcluded('element_AvailableSeatsDisplay'));

  const deleteEventMutation = useMutation({
    mutationFn: async () => {
      return base44.entities.Event.delete(event.id);
    },
    onSuccess: () => {
      toast.success('Event deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['events'] });
      setShowDeleteDialog(false);
      setDeleteConfirmText("");
      if (onEventDeleted) {
        onEventDeleted(event.id);
      }
    },
    onError: (error) => {
      console.error('Delete event error:', error);
      toast.error('Failed to delete event: ' + (error.message || 'Unknown error'));
    }
  });

  const handleDeleteClick = (e) => {
    e.stopPropagation();
    setShowDeleteDialog(true);
  };

  const handleEditClick = (e) => {
    e.stopPropagation();
    window.location.href = createPageUrl('EditEvent') + '?id=' + event.id;
  };

  const handleConfirmDelete = () => {
    if (deleteConfirmText === "DELETE EVENT") {
      deleteEventMutation.mutate();
    } else {
      toast.error('Please type "DELETE EVENT" to confirm deletion');
    }
  };

  const isDeleteButtonDisabled = deleteConfirmText !== "DELETE EVENT" || deleteEventMutation.isPending;

  // Check if any badges should be shown
  const hasBadges = event.status === 'draft' || event.status === 'tbc' || isEventPast || event.event_type || event.program_tag;

  return (
    <>
      <Card className="overflow-hidden hover:shadow-lg transition-shadow duration-300 border-slate-200 bg-white">
        {/* Event Image with Badge Overlay */}
        <div className="relative">
          {event.image_url ? (
            <div className="h-48 overflow-hidden bg-slate-100">
              <img 
                src={event.image_url} 
                alt={event.title}
                className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
              />
            </div>
          ) : (
            <div className={`h-24 ${isEventPast ? 'bg-gradient-to-r from-slate-100 to-slate-50' : 'bg-gradient-to-r from-slate-50 to-blue-50'}`} />
          )}
          
          {/* Badges Overlay - Top Left */}
          {hasBadges && (
            <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5 max-w-[calc(100%-1rem)]">
              {event.status === 'draft' && (
                <Badge variant="secondary" className="bg-amber-100/95 text-amber-700 border-amber-200 shadow-sm">
                  Draft
                </Badge>
              )}
              {event.status === 'tbc' && (
                <Badge variant="secondary" className="bg-blue-100/95 text-blue-700 border-blue-200 shadow-sm">
                  TBC
                </Badge>
              )}
              {isEventPast && (
                <Badge variant="secondary" className="bg-slate-200/95 text-slate-600 border-slate-300 shadow-sm">
                  Past Event
                </Badge>
              )}
              {event.event_type && (() => {
                const eventTypeStyle = getEventTypeStyle(event.event_type, systemSettings);
                return (
                  <Badge 
                    variant="secondary" 
                    className="border-0 shadow-sm"
                    style={{ 
                      backgroundColor: `${eventTypeStyle.bgColor}f2`, // add slight transparency
                      color: eventTypeStyle.textColor 
                    }}
                  >
                    {event.event_type}
                  </Badge>
                );
              })()}
              {event.program_tag && (
                <Badge variant="secondary" className="bg-purple-100/95 text-purple-700 border-purple-200 shadow-sm">
                  {event.program_tag}
                </Badge>
              )}
            </div>
          )}
          
          {/* Program Ticket Count - Top Right */}
          {organizationInfo && event.program_tag && (
            <div className="absolute top-2 right-2 flex items-center gap-1 text-xs bg-white/95 text-slate-600 px-2 py-1 rounded-full shadow-sm">
              <Ticket className="w-3 h-3 text-purple-600" />
              <span className="font-medium">{availableTickets}</span>
            </div>
          )}
        </div>
        
        {/* Purchase Tickets Banner */}
        {needsTickets && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 border-b border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-medium text-amber-900">Purchase tickets to attend</p>
            </div>
          </div>
        )}
        
        <CardHeader className="pb-3">
          <h3 className="font-bold text-lg text-slate-900 line-clamp-2">
            {event.title}
          </h3>
          
          {event.summary && (
            <p className="text-sm text-slate-600 mt-2" data-testid="text-event-summary">
              {event.summary}
            </p>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {/* For TBC events, show "To be confirmed" instead of dates */}
          {event.status === 'tbc' ? (
            <div className="flex items-center gap-2 text-sm text-blue-600">
              <Calendar className="w-4 h-4 text-blue-400" />
              <span className="font-medium">Date to be confirmed</span>
            </div>
          ) : (
            <>
              {event.start_date && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Calendar className="w-4 h-4 text-slate-400" />
                  <span>{formatEventDate(event.start_date, eventTimezone)}</span>
                  {event.end_date && event.start_date !== event.end_date && (
                    <span className="text-slate-400">- {formatEventDate(event.end_date, eventTimezone)}</span>
                  )}
                </div>
              )}

              {event.start_date && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Clock className="w-4 h-4 text-slate-400" />
                  <span>{formatEventTime(event.start_date, eventTimezone)}</span>
                  <span className="text-slate-400 text-xs">({timezoneAbbr})</span>
                </div>
              )}
            </>
          )}

          {(isOnlineEvent || event.location) && (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              {isOnlineEvent ? (
                <>
                  <Video className="w-4 h-4 text-green-500" />
                  <span className="text-green-600 font-medium">Online</span>
                </>
              ) : (
                <>
                  <MapPin className="w-4 h-4 text-slate-400" />
                  <span className="line-clamp-1">{event.location}</span>
                </>
              )}
            </div>
          )}

          {showAvailableSeats && (
            <div className="flex items-center gap-2 text-sm">
              <Users className="w-4 h-4 text-slate-400" />
              {hasUnlimitedCapacity ? (
                <span className="text-green-600 font-medium">Open Registration</span>
              ) : event.available_seats > 0 ? (
                <span className="text-green-600 font-medium">
                  {event.available_seats} seats available
                </span>
              ) : (
                <span className="text-red-600 font-medium">Sold out</span>
              )}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100">
            {/* Event Controls - shown unless features are excluded */}
            {(!isFeatureExcluded?.('events.browse-events.create') || !isFeatureExcluded?.('events.browse-events.view-attendees')) && (
              <div className="flex items-center gap-2 mb-3">
                {!isFeatureExcluded?.('events.browse-events.create') && (
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={handleEditClick}
                    className="flex-1"
                    data-testid={`button-edit-event-${event.id}`}
                  >
                    <Pencil className="w-4 h-4 mr-1" />
                    Edit
                  </Button>
                )}
                {!isFeatureExcluded?.('events.browse-events.view-attendees') && (
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={handleAttendeesClick}
                    className="flex-1 text-purple-600 hover:text-purple-700 hover:bg-purple-50 border-purple-200"
                    data-testid={`button-attendees-event-${event.id}`}
                  >
                    <UsersRound className="w-4 h-4 mr-1" />
                    Attendees
                  </Button>
                )}
                {!isFeatureExcluded?.('events.browse-events.create') && (
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={handleDeleteClick}
                    className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                    data-testid={`button-delete-event-${event.id}`}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Delete
                  </Button>
                )}
              </div>
            )}

            {isEventPast ? (
              <Button 
                className="w-full"
                variant="secondary"
                disabled
                data-testid={`button-event-ended-${event.id}`}
              >
                Event Ended
              </Button>
            ) : needsTickets ? (
              <Button 
                className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700"
                onClick={() => window.location.href = createPageUrl('BuyProgramTickets')}
                data-testid={`button-buy-tickets-${event.id}`}
              >
                <ShoppingCart className="w-4 h-4 mr-2" />
                Buy Tickets
              </Button>
            ) : (() => {
              const ctaConfig = getCtaButtonConfig(systemSettings);
              const isSoldOut = !hasUnlimitedCapacity && event.available_seats === 0;
              const buttonLabel = isSoldOut ? "Sold Out" : ctaConfig.label;
              const isGradient = ctaConfig.style === 'gradient';
              
              return (
                <Button 
                  className={`w-full ${isGradient 
                    ? 'bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:from-indigo-700 hover:via-purple-700 hover:to-pink-700 text-white shadow-lg' 
                    : 'bg-blue-600 hover:bg-blue-700'}`}
                  disabled={isSoldOut}
                  onClick={() => {
                    if (event.cta_override_url) {
                      window.location.href = event.cta_override_url;
                    } else {
                      window.location.href = createPageUrl('EventDetails') + '?id=' + event.id;
                    }
                  }}
                  data-testid={`button-register-event-${event.id}`}
                >
                  {buttonLabel}
                </Button>
              );
            })()}
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog - Only render for admins */}
      {isAdmin && (
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-red-600">Delete Event</DialogTitle>
              <DialogDescription className="space-y-3">
                <p>
                  Are you sure you want to delete <strong>"{event.title}"</strong>?
                </p>
                <p className="text-red-600 font-medium">
                  This action cannot be undone. All bookings and registrations for this event will also be affected.
                </p>
                <p>
                  To confirm deletion, please type <strong>DELETE EVENT</strong> below:
                </p>
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                placeholder="Type DELETE EVENT to confirm"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="border-red-200 focus:border-red-400"
                data-testid="input-delete-confirmation"
              />
            </div>
            <DialogFooter className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteDialog(false);
                  setDeleteConfirmText("");
                }}
                disabled={deleteEventMutation.isPending}
                data-testid="button-cancel-delete"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirmDelete}
                disabled={isDeleteButtonDisabled}
                data-testid="button-confirm-delete"
              >
                {deleteEventMutation.isPending ? "Deleting..." : "Delete Event"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Attendees Modal - Only render for admins */}
      {isAdmin && (
        <Dialog open={showAttendeesModal} onOpenChange={(open) => {
          setShowAttendeesModal(open);
          if (!open) {
            setOrganizationFilter("all");
            setSearchFilter("");
            setCurrentPage(1);
          }
        }}>
          <DialogContent className="sm:max-w-3xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UsersRound className="w-5 h-5 text-purple-600" />
                Attendees - {event.title}
              </DialogTitle>
              <DialogDescription>
                {bookingsData?.length || 0} registered attendee{bookingsData?.length !== 1 ? 's' : ''}
              </DialogDescription>
            </DialogHeader>

            {/* Filters and Export */}
            <div className="flex flex-col sm:flex-row gap-3 py-4 border-b">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by name, email or organisation..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className="pl-9"
                  data-testid="input-attendee-search"
                />
              </div>
              <Select value={organizationFilter} onValueChange={setOrganizationFilter}>
                <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-organization-filter">
                  <SelectValue placeholder="Filter by organisation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Organisations</SelectItem>
                  {uniqueOrganizations.map(org => (
                    <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button 
                variant="outline" 
                onClick={exportToCSV}
                disabled={!filteredAttendees.length}
                data-testid="button-export-csv"
              >
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
            </div>

            {/* Attendees Table */}
            <div className="flex-1 overflow-auto">
              {bookingsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
                </div>
              ) : filteredAttendees.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  {bookingsData?.length === 0 ? (
                    <p>No attendees registered for this event yet.</p>
                  ) : (
                    <p>No attendees match your search criteria.</p>
                  )}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Organisation</TableHead>
                      <TableHead>Email</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedAttendees.map((booking, index) => (
                      <TableRow key={booking.id || index} data-testid={`row-attendee-${booking.id || index}`}>
                        <TableCell className="font-medium">
                          {`${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim() || '-'}
                        </TableCell>
                        <TableCell>
                          {organizationMap[booking.organization_id] || '-'}
                        </TableCell>
                        <TableCell>
                          <a 
                            href={`mailto:${booking.attendee_email}`} 
                            className="text-blue-600 hover:underline"
                          >
                            {booking.attendee_email || '-'}
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            {/* Footer with pagination */}
            {filteredAttendees.length > 0 && (
              <div className="pt-3 border-t flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-sm text-slate-500">
                  Showing {startIndex + 1}-{Math.min(endIndex, filteredAttendees.length)} of {filteredAttendees.length} attendee{filteredAttendees.length !== 1 ? 's' : ''}
                  {organizationFilter !== "all" || searchFilter ? ` (filtered from ${bookingsData?.length || 0})` : ''}
                </div>
                
                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    
                    {getPageNumbers().map((page, idx) => (
                      page === '...' ? (
                        <span key={`ellipsis-${idx}`} className="px-2 text-slate-400">...</span>
                      ) : (
                        <Button
                          key={page}
                          variant={currentPage === page ? "default" : "outline"}
                          size="sm"
                          onClick={() => setCurrentPage(page)}
                          className="min-w-[36px]"
                          data-testid={`button-page-${page}`}
                        >
                          {page}
                        </Button>
                      )
                    ))}
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                      data-testid="button-next-page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
