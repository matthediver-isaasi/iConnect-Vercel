// v2.1.0 - Added non-member guest booking support
import { useState, useMemo, Fragment } from "react";
import { resolveEventCtaLabel } from "@/lib/eventCtaLabel";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Calendar, CalendarDays, MapPin, Users, Clock, Ticket, AlertCircle, ShoppingCart, Pencil, Trash2, Video, Globe, UsersRound, Download, Upload, Search, ChevronLeft, ChevronRight, Loader2, CheckCircle2, XCircle, AlertTriangle, Send, Plus, Copy, Lock, Info } from "lucide-react";
import { format, parseISO } from "date-fns";
import { createPageUrl, getEventUrl } from "@/utils";
import { parseEventTypes } from "@/lib/utils";
import { formatEventTime, formatEventDate, is24HourFormat } from "@/utils/timeFormat";
import { base44 } from "@/api/base44Client";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import TenantCtaButton from "@/components/common/TenantCtaButton";
import { toast } from "sonner";
import { resolveAttendeeJobTitle } from "@/lib/attendeeJobTitle";
import { getSeatStatusLabels } from "@/lib/seatStatusLabels";
import TrainingMiniAgenda from "@/components/events/TrainingMiniAgenda";
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
import { listAllOrganizationsForAdmin } from '@/lib/adminOrgList';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// formatEventTime, formatEventDate, and is24HourFormat are imported from @/utils/timeFormat

// Check if event is past by comparing dates
const isEventInPast = (event) => {
  const dateStr = event.end_date || event.start_date;
  if (!dateStr) return false;
  try {
    const eventDate = typeof dateStr === 'string' 
      ? parseISO(dateStr) 
      : new Date(dateStr);
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
    return defaultConfig;
  }
};

// Helper function to get the cheapest ticket price from an event's pricing_config
// Returns null if no valid pricing is found (prevents showing "Free to attend" for missing data)
// Always returns the minimum price across every ticket class regardless of visibility_mode,
// since the displayed "Price from" is purely informational and should match for guests and members.
const getCheapestTicketPrice = (event) => {
  if (!event) return null;
  
  // Parse pricing_config if it's a string
  let pricingConfig = event.pricing_config;
  if (typeof pricingConfig === 'string') {
    try {
      pricingConfig = JSON.parse(pricingConfig);
    } catch {
      return null;
    }
  }
  
  if (!pricingConfig) return null;
  
  // Check for ticket_classes array (new format)
  if (pricingConfig.ticket_classes && Array.isArray(pricingConfig.ticket_classes) && pricingConfig.ticket_classes.length > 0) {
    // Only include prices that are explicitly set to valid numbers (including 0)
    // Do NOT convert undefined/null/NaN to 0 - that would incorrectly show "Free"
    const prices = pricingConfig.ticket_classes
      .map(tc => {
        // Only accept if price is explicitly defined as a number or numeric string
        if (tc.price === undefined || tc.price === null || tc.price === '') {
          return NaN;
        }
        return Number(tc.price);
      })
      .filter(p => Number.isFinite(p));
    
    if (prices.length > 0) {
      return Math.min(...prices);
    }
  }
  
  // Fallback to legacy ticket_price field - only if explicitly set
  if (pricingConfig.ticket_price !== undefined && pricingConfig.ticket_price !== null && pricingConfig.ticket_price !== '') {
    const price = Number(pricingConfig.ticket_price);
    if (Number.isFinite(price)) {
      return price;
    }
  }
  
  // Also check direct event.ticket_price for older events - only if explicitly set
  if (event.ticket_price !== undefined && event.ticket_price !== null && event.ticket_price !== '') {
    const price = Number(event.ticket_price);
    if (Number.isFinite(price)) {
      return price;
    }
  }
  
  return null;
};

export default function EventCard({ event, organizationInfo, isFeatureExcluded, isAdmin, onEventDeleted, joinLinkSettings, webinars, systemSettings = [], memberInfo, joinLocked = false, agendaSummary = null, groupAdminMode = false }) {
  const queryClient = useQueryClient();
  // Task e1476154: group-admin override. When the caller (MemberGroupDetail)
  // confirms the viewer administers the event's group, show the four admin
  // action buttons and enable the admin dialogs/queries independently of the
  // tenant RBAC feature-exclusion checks. Tenant-admin behavior is unchanged.
  const canManageEvent = isAdmin || groupAdminMode === true;
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [showAttendeesModal, setShowAttendeesModal] = useState(false);
  const [organizationFilter, setOrganizationFilter] = useState("all");
  const [searchFilter, setSearchFilter] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 25;
  
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importRows, setImportRows] = useState([
    { first_name: "", last_name: "", email: "", organization: "", job_title: "", designation: "" },
  ]);
  const [importTicketClassId, setImportTicketClassId] = useState("");
  const [importSendConfirmations, setImportSendConfirmations] = useState(true);
  const [importTicketClasses, setImportTicketClasses] = useState([]);
  const [importResults, setImportResults] = useState(null);

  // Fetch bookings for this event when attendees modal is open
  const { data: bookingsData, isLoading: bookingsLoading } = useQuery({
    queryKey: ['event-bookings', event.id],
    queryFn: async () => {
      // Complex (multi-session) events store bookings in complex_event_booking;
      // simple events use booking. Both key on event_id.
      const entity = event.is_complex
        ? base44.entities.ComplexEventBooking
        : base44.entities.Booking;
      const bookings = await entity.filter({ event_id: event.id });
      return bookings;
    },
    enabled: showAttendeesModal && canManageEvent,
  });

  // Fetch organizations when attendees modal is open
  const { data: organizationsData } = useQuery({
    queryKey: ['organizations-for-attendees'],
    queryFn: async () => {
      return await listAllOrganizationsForAdmin();
    },
    enabled: showAttendeesModal && canManageEvent,
  });

  // Fetch members when attendees modal is open
  const { data: membersData } = useQuery({
    queryKey: ['members-for-attendees'],
    queryFn: async () => {
      return await base44.entities.Member.listAll();
    },
    enabled: showAttendeesModal && canManageEvent,
  });

  // Create organization lookup map
  const organizationMap = useMemo(() => {
    if (!organizationsData) return {};
    return organizationsData.reduce((acc, org) => {
      acc[org.id] = org.name;
      return acc;
    }, {});
  }, [organizationsData]);

  // Create member info lookup map (used only for the legacy booker fallback)
  const memberInfoMap = useMemo(() => {
    if (!membersData) return {};
    return membersData.reduce((acc, member) => {
      acc[member.id] = member;
      return acc;
    }, {});
  }, [membersData]);

  const activeBookings = useMemo(() => {
    if (!bookingsData) return [];
    return bookingsData.filter(b => b.status !== 'cancelled');
  }, [bookingsData]);

  // Get unique organizations from bookings for filter dropdown
  const uniqueOrganizations = useMemo(() => {
    if (!activeBookings || activeBookings.length === 0) return [];
    const orgIds = [...new Set(activeBookings.map(b => b.organization_id).filter(Boolean))];
    const orgs = orgIds.map(id => ({
      id,
      name: organizationMap[id] || 'Unknown Organization'
    })).sort((a, b) => a.name.localeCompare(b.name));
    
    // Check if there are any non-member (NULL organization_id) bookings
    const hasNonMemberBookings = activeBookings.some(b => !b.organization_id);
    if (hasNonMemberBookings) {
      orgs.push({ id: 'non-member', name: 'Non-member' });
    }
    
    return orgs;
  }, [activeBookings, organizationMap]);

  // Filter attendees based on organization and search
  const filteredAttendees = useMemo(() => {
    if (!activeBookings) return [];
    return activeBookings
      .filter(booking => {
        // Filter by organization
        if (organizationFilter !== "all") {
          if (organizationFilter === "non-member") {
            // Filter for bookings with NULL organization_id
            if (booking.organization_id) return false;
          } else if (booking.organization_id !== organizationFilter) {
            return false;
          }
        }
        // Filter by search term
        if (searchFilter) {
          const search = searchFilter.toLowerCase();
          const name = `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.toLowerCase();
          const email = (booking.attendee_email || '').toLowerCase();
          const org = booking.organization_id ? (organizationMap[booking.organization_id] || '').toLowerCase() : 'non-member';
          return name.includes(search) || email.includes(search) || org.includes(search);
        }
        return true;
      })
      .sort((a, b) => {
        const nameA = `${a.attendee_first_name || ''} ${a.attendee_last_name || ''}`;
        const nameB = `${b.attendee_first_name || ''} ${b.attendee_last_name || ''}`;
        return nameA.localeCompare(nameB);
      });
  }, [activeBookings, organizationFilter, searchFilter, organizationMap]);

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

    const headers = ['Name', 'Job Title', 'Organisation', 'Email'];
    const rows = filteredAttendees.map(booking => [
      `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim(),
      resolveAttendeeJobTitle(booking, memberInfoMap[booking.member_id]),
      booking.organization_id ? (organizationMap[booking.organization_id] || '') : 'Non-member',
      booking.attendee_email || ''
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
  
  // For TBC events, we don't show dates
  const isTbcEvent = event.status === 'tbc';
  
  // Check if event is in the past
  const isEventPast = isEventInPast(event);

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

  // Tenant-customizable seat-status labels (Event Settings)
  const seatStatusLabels = getSeatStatusLabels(systemSettings);

  const [deleteOrganiserMessage, setDeleteOrganiserMessage] = useState("");
  const [deleteSendEmails, setDeleteSendEmails] = useState(true);
  const [deleteResultSummary, setDeleteResultSummary] = useState(null);
  const [deletePreview, setDeletePreview] = useState(null);
  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false);
  const [deletePreviewError, setDeletePreviewError] = useState(null);

  // Complex (multi-session) events use the complex-event endpoints. EventCard
  // only renders complex events on the member-group page (Events.jsx renders
  // them inline), so these branches only run there.
  const eventApiBase = event.is_complex
    ? `/api/complex-events/${event.id}`
    : `/api/events/${event.id}`;

  const deleteEventMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${eventApiBase}/delete-with-cancellations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          organiser_message: deleteSendEmails ? (deleteOrganiserMessage || null) : null,
          suppress_emails: !deleteSendEmails,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = new Error(data.error || `Delete failed (${response.status})`);
        err.payload = data;
        throw err;
      }
      return data;
    },
    onSuccess: (data) => {
      const total = data.totalBookings || 0;
      const succeeded = (data.succeeded || 0) + (data.alreadyCancelled || 0);
      const manual = (data.requiresManualAction || []).length;
      let msg = total === 0
        ? 'Event deleted successfully'
        : `Event deleted — ${succeeded}/${total} bookings cancelled`;
      if (manual > 0) msg += ` (${manual} need manual refund/credit-note follow-up)`;
      toast.success(msg);
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: ['complex-events-for-listing'] });
      queryClient.invalidateQueries({ queryKey: ['member-group-events'] });
      setShowDeleteDialog(false);
      setDeleteConfirmText("");
      setDeleteOrganiserMessage("");
      setDeleteSendEmails(true);
      setDeleteResultSummary(null);
      if (onEventDeleted) {
        onEventDeleted(event.id);
      }
    },
    onError: (error) => {
      console.error('Delete event error:', error);
      const payload = error.payload;
      if (payload && Array.isArray(payload.failed) && payload.failed.length > 0) {
        setDeleteResultSummary(payload);
        toast.error(`${payload.failed.length} booking(s) failed to cancel — see details below. Resolve and re-run.`);
      } else {
        toast.error('Failed to delete event: ' + (error.message || 'Unknown error'));
      }
    }
  });

  const [resendingBookingId, setResendingBookingId] = useState(null);

  const resendConfirmationMutation = useMutation({
    mutationFn: async (bookingId) => {
      const response = await fetch(`/api/admin/events/${event.id}/attendees/resend-confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookingId })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to resend confirmation email');
      }
      return response.json();
    },
    onMutate: (bookingId) => {
      setResendingBookingId(bookingId);
    },
    onSuccess: (data) => {
      toast.success(`Confirmation email resent to ${data.email}`);
    },
    onError: (error) => {
      console.error('Resend confirmation error:', error);
      toast.error(error.message || 'Failed to resend confirmation email');
    },
    onSettled: () => {
      setResendingBookingId(null);
    }
  });

  const importAttendeesMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch(`/api/admin/events/${event.id}/attendees/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Import failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      const results = data.results || {};
      setImportResults(results);
      queryClient.invalidateQueries({ queryKey: ['event-bookings', event.id] });
      const memberCount = results.registeredMembers?.length || 0;
      const guestCount = results.registeredGuests?.length || 0;
      const total = memberCount + guestCount;
      if (total > 0) {
        toast.success(`Successfully registered ${total} attendee(s) (${memberCount} member${memberCount === 1 ? '' : 's'}, ${guestCount} guest${guestCount === 1 ? '' : 's'})`);
      }
      if ((results.errors?.length || 0) > 0) {
        toast.error(`${results.errors.length} row(s) could not be imported`);
      }
    },
    onError: (error) => {
      console.error('Import attendees error:', error);
      toast.error('Failed to import attendees: ' + (error.message || 'Unknown error'));
    }
  });

  // Load ticket classes for the event from pricing_config (single events only).
  // EventCard is only rendered for non-complex events.
  const loadImportTicketClasses = () => {
    try {
      let pricingConfig = event.pricing_config;
      if (typeof pricingConfig === 'string') {
        try { pricingConfig = JSON.parse(pricingConfig); } catch { pricingConfig = null; }
      }
      const tcs = pricingConfig?.ticket_classes;
      setImportTicketClasses(Array.isArray(tcs) ? tcs : []);
    } catch (e) {
      console.error('Failed to load ticket classes for import:', e);
      setImportTicketClasses([]);
    }
  };

  const resetImportState = () => {
    setImportResults(null);
    setImportRows([{ first_name: "", last_name: "", email: "", organization: "", job_title: "", designation: "" }]);
    setImportTicketClassId("");
    setImportSendConfirmations(true);
    setImportTicketClasses([]);
  };

  const handleImportClick = () => {
    resetImportState();
    loadImportTicketClasses();
    setShowImportDialog(true);
  };

  const isRowEmpty = (row) => {
    const trim = (v) => (typeof v === 'string' ? v.trim() : '');
    return (
      !trim(row.first_name) &&
      !trim(row.last_name) &&
      !trim(row.email) &&
      !trim(row.organization) &&
      !trim(row.job_title)
    );
  };

  const isValidEmail = (email) => {
    if (!email) return false;
    // Basic syntactic email check; backend does the authoritative validation.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  };

  const getRowError = (row) => {
    if (isRowEmpty(row)) return null;
    const email = (row.email || "").trim();
    if (!email) return "Email is required";
    if (!isValidEmail(email)) return "Invalid email address";
    return null;
  };

  const importRowErrors = useMemo(() => importRows.map(getRowError), [importRows]);

  const hasAnyEmail = useMemo(
    () => importRows.some(r => (r.email || "").trim() && isValidEmail(r.email)),
    [importRows]
  );

  const hasUnresolvedErrors = useMemo(
    () => importRowErrors.some(e => e !== null),
    [importRowErrors]
  );

  const updateImportRow = (index, field, value) => {
    setImportRows(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  const addImportRow = () => {
    setImportRows(prev => [...prev, { first_name: "", last_name: "", email: "", organization: "", job_title: "", designation: "" }]);
  };

  const removeImportRow = (index) => {
    setImportRows(prev => {
      if (prev.length <= 1) {
        // Never remove the last row — clear it instead.
        return [{ first_name: "", last_name: "", email: "", organization: "", job_title: "", designation: "" }];
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleImportSubmit = () => {
    if (hasUnresolvedErrors) {
      toast.error('Please fix the highlighted row errors before importing.');
      return;
    }

    const rows = importRows
      .filter(r => !isRowEmpty(r))
      .map(r => ({
        first_name: (r.first_name || "").trim(),
        last_name: (r.last_name || "").trim(),
        email: (r.email || "").trim(),
        organization: (r.organization || "").trim(),
        job_title: (r.job_title || "").trim(),
        designation: (r.designation || "").trim(),
      }));

    if (rows.length === 0) {
      toast.error('Please add at least one row with a valid email address.');
      return;
    }

    importAttendeesMutation.mutate({
      rows,
      ticket_class_id: importTicketClassId || undefined,
      send_confirmations: importSendConfirmations,
    });
  };

  const handleDeleteClick = async (e) => {
    e.stopPropagation();
    setShowDeleteDialog(true);
    setDeletePreview(null);
    setDeletePreviewError(null);
    setDeletePreviewLoading(true);
    try {
      const r = await fetch(`${eventApiBase}/delete-preview`, { credentials: 'include' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDeletePreviewError(data.error || `Preview failed (${r.status})`);
      } else {
        setDeletePreview(data);
      }
    } catch (err) {
      setDeletePreviewError(err.message || 'Failed to load delete preview');
    } finally {
      setDeletePreviewLoading(false);
    }
  };

  const handleEditClick = (e) => {
    e.stopPropagation();
    // Complex (multi-session) events open in the complex editor; simple events
    // use EditEvent. When the event belongs to a member group, carry the group
    // context so the editor opens directly in the gated group-event UI and
    // returns to the member group page after saving.
    const base = event.is_complex
      ? createPageUrl('CreateComplexEvent')
      : createPageUrl('EditEvent');
    let url = base + '?id=' + event.id;
    if (event.member_group_id) {
      url += '&group_event=1&group_id=' + event.member_group_id;
    }
    window.location.href = url;
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
  const parsedEventTypes = parseEventTypes(event.event_type);
  const hasBadges = event.status === 'draft' || event.status === 'tbc' || isEventPast || parsedEventTypes.length > 0 || event.program_tag || event.member_group_id;

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
                style={getFocalPointStyle(event.image_focal_point)}
              />
            </div>
          ) : (
            <div className={`h-24 ${isEventPast ? 'bg-gradient-to-r from-slate-100 to-slate-50' : 'bg-gradient-to-r from-slate-50 to-blue-50'}`} />
          )}
          
          {/* Badges Overlay - Top Left */}
          {hasBadges && (
            <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5 max-w-[calc(100%-1rem)]">
              {event.status === 'draft' && (
                <Badge variant="warning" className="shadow-sm">
                  Draft
                </Badge>
              )}
              {event.status === 'tbc' && (
                <Badge variant="secondary" className="bg-blue-100/95 text-blue-700 border-blue-200 shadow-sm">
                  TBC
                </Badge>
              )}
              {(event.event_state === 'closed' || (!event.event_state && event.status === 'closed') || (event.registration_closes_at && new Date() > new Date(event.registration_closes_at))) && (
                <Badge variant="secondary" className="bg-red-100/95 text-red-700 border-red-200 shadow-sm" data-testid={`badge-closed-event-${event.id}`}>
                  Registration Closed
                </Badge>
              )}
              {isEventPast && (
                <Badge variant="secondary" className="bg-slate-200/95 text-slate-600 border-slate-300 shadow-sm">
                  Past Event
                </Badge>
              )}
              {parsedEventTypes.map((typeName, etIdx) => {
                const eventTypeStyle = getEventTypeStyle(typeName, systemSettings);
                return (
                  <Badge 
                    key={etIdx}
                    variant="secondary" 
                    className="border-0 shadow-sm"
                    style={{ 
                      backgroundColor: `${eventTypeStyle.bgColor}f2`,
                      color: eventTypeStyle.textColor 
                    }}
                  >
                    {typeName}
                  </Badge>
                );
              })}
              {event.program_tag && (
                <Badge variant="secondary" className="bg-purple-100/95 text-purple-700 border-purple-200 shadow-sm">
                  {event.program_tag}
                </Badge>
              )}
              {event.member_group_id && (
                <Badge
                  variant="secondary"
                  className="bg-indigo-100/95 text-indigo-700 border-indigo-200 shadow-sm"
                  data-testid={`badge-group-event-${event.id}`}
                >
                  {event.group_event_public === true ? 'Group event' : 'Members only'}
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
          <div className="flex items-start gap-2 p-3 bg-warning/10 border-b border-warning/30">
            <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-medium text-warning">Purchase tickets to attend</p>
            </div>
          </div>
        )}
        
        <CardHeader className="pb-3">
          <h3 className={`font-bold text-lg text-slate-900 ${
            // Check if title clamp is enabled (default to true if not set)
            (() => {
              const titleClampSetting = Array.isArray(systemSettings) 
                ? systemSettings.find(s => s.setting_key === 'event_card_title_clamp')
                : null;
              return titleClampSetting?.setting_value !== 'false' ? 'line-clamp-2' : '';
            })()
          }`}>
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
          ) : (event.is_training && Array.isArray(agendaSummary) && agendaSummary.length > 0) ? (
            /* Training events with an agenda show a compact date+type agenda
               instead of the single date/time rows (empty agenda falls back). */
            <TrainingMiniAgenda items={agendaSummary} testId={`agenda-event-${event.id}`} />
          ) : (
            <>
              {event.start_date && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Calendar className="w-4 h-4 text-slate-400" />
                  <span>{formatEventDate(event.start_date, "MMM d, yyyy", event.timezone)}</span>
                  {event.end_date && event.start_date !== event.end_date && !event.days_nonconsecutive && (
                    <span className="text-slate-400">- {formatEventDate(event.end_date, "MMM d, yyyy", event.timezone)}</span>
                  )}
                </div>
              )}

              {/* Task #3266: non-consecutive complex event days — show day count instead of end date */}
              {event.days_nonconsecutive && event.day_count > 1 && (
                <div className="flex items-center gap-2 text-sm text-slate-600" data-testid={`text-event-day-count-${event.id}`}>
                  <CalendarDays className="w-4 h-4 text-slate-400" />
                  <span>{event.day_count} days</span>
                </div>
              )}
              {event.days_nonconsecutive && event.day_count > 1 && event.custom_duration_explainer && (
                <div className="flex items-center gap-2 text-sm text-slate-600" data-testid={`text-event-duration-explainer-${event.id}`}>
                  <Info className="w-4 h-4 text-slate-400 shrink-0" />
                  <span>{event.custom_duration_explainer}</span>
                </div>
              )}

              {event.start_date && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Clock className="w-4 h-4 text-slate-400" />
                  <span>{formatEventTime(event.start_date, systemSettings, event.timezone, true)}</span>
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
                <span className="text-green-600 font-medium">{seatStatusLabels.unlimited}</span>
              ) : event.available_seats > 0 ? (
                <span className="text-green-600 font-medium">
                  {seatStatusLabels.available(event.available_seats)}
                </span>
              ) : (
                <span className="text-red-600 font-medium">{seatStatusLabels.soldOut}</span>
              )}
            </div>
          )}

          {/* Ticket Price Display */}
          {(() => {
            const showPricesSetting = Array.isArray(systemSettings) 
              ? systemSettings.find(s => s.setting_key === 'show_event_card_prices')
              : null;
            const showPrices = showPricesSetting?.setting_value === 'true';
            
            if (!showPrices) return null;
            
            // Always show the cheapest ticket price across all ticket classes,
            // regardless of viewer login state or ticket visibility_mode.
            // Prefer the server-provided cheapest_price (which sees members-only tickets
            // hidden from public payloads); fall back to local computation for older
            // payloads / admin surfaces that still pass full pricing data.
            const serverCheapest = (event && event.cheapest_price !== undefined && event.cheapest_price !== null)
              ? Number(event.cheapest_price)
              : null;
            const cheapestPrice = (serverCheapest !== null && Number.isFinite(serverCheapest))
              ? serverCheapest
              : getCheapestTicketPrice(event);
            
            // Only show if we have pricing info
            if (cheapestPrice === null) return null;
            
            return (
              <div className="flex items-center gap-2 text-sm" data-testid={`text-ticket-price-${event.id}`}>
                <Ticket className="w-4 h-4 text-slate-400 shrink-0" />
                {cheapestPrice === 0 ? (
                  <span className="text-green-600 font-medium">Free to register</span>
                ) : (
                  <span className="text-slate-600">
                    Price from <span className="font-semibold text-slate-800">£{cheapestPrice.toFixed(2)}</span>
                  </span>
                )}
              </div>
            );
          })()}

          <div className="pt-3 border-t border-slate-100">
            {/* Event Controls - only shown when logged in and features are not excluded */}
            {memberInfo && (groupAdminMode || !isFeatureExcluded?.('events.browse-events.create') || !isFeatureExcluded?.('events.browse-events.view-attendees')) && (
              <TooltipProvider delayDuration={100}>
                <div className="flex items-center gap-2 mb-3">
                  {(groupAdminMode || !isFeatureExcluded?.('events.browse-events.create')) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={handleEditClick}
                          className="flex-1"
                          aria-label="Edit"
                          data-testid={`button-edit-event-${event.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit</TooltipContent>
                    </Tooltip>
                  )}
                  {(groupAdminMode || !isFeatureExcluded?.('events.browse-events.view-attendees')) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={handleAttendeesClick}
                          className="flex-1 text-purple-600 hover:text-purple-700 hover:bg-purple-50 border-purple-200"
                          aria-label="Attendees"
                          data-testid={`button-attendees-event-${event.id}`}
                        >
                          <UsersRound className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Attendees</TooltipContent>
                    </Tooltip>
                  )}
                  {(groupAdminMode || !isFeatureExcluded?.('events.browse-events.create')) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const resp = await fetch(`${eventApiBase}/duplicate`, {
                                method: 'POST',
                                credentials: 'include',
                                headers: { 'Content-Type': 'application/json' },
                              });
                              if (!resp.ok) {
                                const err = await resp.json().catch(() => ({}));
                                throw new Error(err.error || 'Duplicate failed');
                              }
                              const data = await resp.json();
                              toast.success('Event duplicated as draft');
                              queryClient.invalidateQueries({ queryKey: ['events'] });
                              queryClient.invalidateQueries({ queryKey: ['complex-events-for-listing'] });
                              queryClient.invalidateQueries({ queryKey: ['member-group-events'] });
                              // Carry group context so the duplicate opens directly in
                              // the gated group-event UI and returns to the group page.
                              let dupUrl = createPageUrl(event.is_complex ? 'CreateComplexEvent' : 'EditEvent') + '?id=' + data.id;
                              if (event.member_group_id) {
                                dupUrl += '&group_event=1&group_id=' + event.member_group_id;
                              }
                              window.location.href = dupUrl;
                            } catch (err) {
                              toast.error('Duplicate failed: ' + err.message);
                            }
                          }}
                          className="flex-1"
                          aria-label="Duplicate"
                          data-testid={`button-duplicate-event-${event.id}`}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Duplicate</TooltipContent>
                    </Tooltip>
                  )}
                  {(groupAdminMode || !isFeatureExcluded?.('events.browse-events.create')) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={handleDeleteClick}
                          className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                          aria-label="Delete"
                          data-testid={`button-delete-event-${event.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TooltipProvider>
            )}

            {/* Hide CTA button if event-details page is excluded */}
            {!isFeatureExcluded?.('events.event-details') && (
              <>
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
                  joinLocked ? (
                    <Button
                      className="w-full"
                      variant="secondary"
                      disabled
                      data-testid={`button-join-locked-${event.id}`}
                    >
                      <Lock className="w-4 h-4 mr-2" />
                      Join group to access
                    </Button>
                  ) : (
                    <Button 
                      className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700"
                      onClick={() => window.location.href = createPageUrl('BuyProgramTickets')}
                      data-testid={`button-buy-tickets-${event.id}`}
                    >
                      <ShoppingCart className="w-4 h-4 mr-2" />
                      Buy Tickets
                    </Button>
                  )
                ) : (() => {
                  const ctaConfig = getCtaButtonConfig(systemSettings);
                  const isSoldOut = !hasUnlimitedCapacity && event.available_seats === 0;
                  // Registration is closed if event_state is 'closed' (or legacy status='closed' when event_state is null) OR if registration_closes_at has passed
                  const isRegistrationClosed = event.event_state === 'closed' || 
                    (!event.event_state && event.status === 'closed') ||
                    (event.registration_closes_at && new Date() > new Date(event.registration_closes_at));
                  // Resolution order: status label > per-event label > Event Settings default
                  const buttonLabel = resolveEventCtaLabel({
                    isRegistrationClosed,
                    isSoldOut,
                    perEventLabel: event.cta_button_label,
                    defaultLabel: ctaConfig.label,
                  });
                  const isGradient = ctaConfig.style === 'gradient';
                  // Registration closed/sold-out are inactive states — keep
                  // their existing look. Only the active register CTA picks up
                  // the tenant Primary button style (falls back to the existing
                  // gradient / blue when no Primary style is configured).
                  const isActiveCta = !isRegistrationClosed && !isSoldOut;
                  const handleRegisterClick = () => {
                    if (event.cta_override_url && event.cta_override_mode !== 'detail_page') {
                      window.location.href = event.cta_override_url;
                    } else {
                      // Complex events have their own detail routes.
                      window.location.href = event.is_complex
                        ? (event.slug ? `/session-events/${encodeURIComponent(event.slug)}` : createPageUrl('ComplexEventDetail') + '?id=' + event.id)
                        : getEventUrl(event);
                    }
                  };

                  if (!isActiveCta) {
                    return (
                      <Button
                        variant={isRegistrationClosed ? "secondary" : "default"}
                        className={`w-full ${!isRegistrationClosed && isGradient
                          ? 'bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white shadow-lg'
                          : !isRegistrationClosed ? 'bg-blue-600' : ''}`}
                        disabled={isSoldOut}
                        onClick={handleRegisterClick}
                        data-testid={`button-register-event-${event.id}`}
                      >
                        {buttonLabel}
                      </Button>
                    );
                  }

                  if (joinLocked) {
                    return (
                      <Button
                        className="w-full"
                        variant="secondary"
                        disabled
                        data-testid={`button-join-locked-${event.id}`}
                      >
                        <Lock className="w-4 h-4 mr-2" />
                        Join group to access
                      </Button>
                    );
                  }

                  return (
                    <TenantCtaButton
                      className="w-full"
                      fallbackClassName={isGradient
                        ? 'bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white shadow-lg'
                        : 'bg-blue-600'}
                      onClick={handleRegisterClick}
                      data-testid={`button-register-event-${event.id}`}
                    >
                      {buttonLabel}
                    </TenantCtaButton>
                  );
                })()}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog - Only render for admins */}
      {canManageEvent && (
        <Dialog open={showDeleteDialog} onOpenChange={(open) => {
          setShowDeleteDialog(open);
          if (!open) {
            setDeleteConfirmText("");
            setDeleteOrganiserMessage("");
            setDeleteSendEmails(true);
            setDeleteResultSummary(null);
          }
        }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-red-600">Delete Event</DialogTitle>
              <DialogDescription className="space-y-3">
                <p>
                  Are you sure you want to delete <strong>"{event.title}"</strong>?
                </p>
                <p className="text-red-600 font-medium">
                  {deleteSendEmails
                    ? "All active bookings will be cancelled, refunds processed, credit notes raised, Zoom registrations removed, and attendees emailed. This cannot be undone."
                    : "All active bookings will be cancelled, refunds processed, credit notes raised, and Zoom registrations removed. No cancellation emails will be sent. This cannot be undone."}
                </p>
                <p>
                  To confirm deletion, please type <strong>DELETE EVENT</strong> below:
                </p>
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-3">
              {deletePreviewLoading && (
                <div className="text-sm text-slate-500" data-testid="text-delete-preview-loading">Loading preview…</div>
              )}
              {deletePreviewError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700" data-testid="text-delete-preview-error">{deletePreviewError}</div>
              )}
              {deletePreview && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs space-y-1" data-testid="text-delete-preview-summary">
                  <p><strong>{deletePreview.activeBookings}</strong> active booking(s) will be cancelled
                    {deletePreview.alreadyCancelledBookings > 0 ? ` (${deletePreview.alreadyCancelledBookings} already cancelled)` : ''}.</p>
                  {deletePreview.stripeRefundCount > 0 && (
                    <p>{deletePreview.stripeRefundCount} card refund(s) — total {Object.entries(deletePreview.refundByCurrency || {}).map(([c, a]) => `${c} ${Number(a).toFixed(2)}`).join(', ') || '£0.00'}</p>
                  )}
                  {deletePreview.xeroCreditNoteCount > 0 && (
                    <p>{deletePreview.xeroCreditNoteCount} Xero credit note(s) — total £{Number(deletePreview.totalCreditNote || 0).toFixed(2)}</p>
                  )}
                  {(deletePreview.totalTrainingFundReinstatement > 0 || deletePreview.totalVoucherReinstatement > 0) && (
                    <p>Training fund: £{Number(deletePreview.totalTrainingFundReinstatement || 0).toFixed(2)} · Vouchers: £{Number(deletePreview.totalVoucherReinstatement || 0).toFixed(2)} reinstated</p>
                  )}
                  {deletePreview.requiresManualActionCount > 0 && (
                    <p className="text-warning">⚠ {deletePreview.requiresManualActionCount} booking(s) will need manual refund/credit-note follow-up.</p>
                  )}
                </div>
              )}
              <div className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3">
                <div>
                  <Label htmlFor={`switch-delete-send-emails-${event.id}`} className="text-sm font-medium text-slate-700">
                    Send cancellation email to attendees
                  </Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Turn off if attendees have already been told another way (e.g. a test event). Refunds and reversals still happen.
                  </p>
                </div>
                <Switch
                  id={`switch-delete-send-emails-${event.id}`}
                  checked={deleteSendEmails}
                  onCheckedChange={setDeleteSendEmails}
                  data-testid="switch-delete-send-emails"
                />
              </div>
              {deleteSendEmails && (
                <div>
                  <label className="text-sm font-medium text-slate-700 block mb-1">Optional message to attendees</label>
                  <textarea
                    className="w-full rounded-md border border-slate-200 p-2 text-sm focus:border-slate-400 focus:outline-none"
                    rows={3}
                    placeholder="e.g. We're very sorry — the venue had to cancel at short notice."
                    value={deleteOrganiserMessage}
                    onChange={(e) => setDeleteOrganiserMessage(e.target.value)}
                    data-testid="textarea-delete-organiser-message"
                  />
                </div>
              )}
              <Input
                placeholder="Type DELETE EVENT to confirm"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="border-red-200 focus:border-red-400"
                data-testid="input-delete-confirmation"
              />
              {deleteResultSummary && Array.isArray(deleteResultSummary.failed) && deleteResultSummary.failed.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs space-y-1" data-testid="text-delete-failure-summary">
                  <p className="font-semibold text-red-700">{deleteResultSummary.failed.length} booking(s) failed:</p>
                  <ul className="list-disc pl-4 text-red-700 max-h-32 overflow-auto">
                    {deleteResultSummary.failed.slice(0, 10).map((f, i) => (
                      <li key={i}>{f.bookingReference || f.bookingId}: {f.error}</li>
                    ))}
                  </ul>
                  <p className="text-red-700">Event left in 'cancelling' state. Resolve and re-run delete.</p>
                </div>
              )}
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
      {canManageEvent && (
        <Dialog open={showAttendeesModal} onOpenChange={(open) => {
          setShowAttendeesModal(open);
          if (!open) {
            setOrganizationFilter("all");
            setSearchFilter("");
            setCurrentPage(1);
          }
        }}>
          <DialogContent className="sm:max-w-5xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UsersRound className="w-5 h-5 text-purple-600" />
                Attendees - {event.title}
              </DialogTitle>
              <DialogDescription>
                {activeBookings?.length || 0} registered attendee{activeBookings?.length !== 1 ? 's' : ''}
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
              {/* Import loads ticket classes from pricing_config, which only
                  exists on simple events — hide it for complex events (the
                  Events page has its own complex import flow). */}
              {!event.is_complex && (
                <Button 
                  variant="outline" 
                  onClick={handleImportClick}
                  data-testid="button-import-attendees"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Import
                </Button>
              )}
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
                  {activeBookings?.length === 0 ? (
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
                      <TableHead>Job Title</TableHead>
                      <TableHead>Organisation</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedAttendees.map((booking, index) => {
                      const isResending = resendingBookingId === booking.id;
                      return (
                        <TableRow key={booking.id || index} data-testid={`row-attendee-${booking.id || index}`}>
                          <TableCell className="font-medium">
                            {`${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim() || '-'}
                          </TableCell>
                          <TableCell>
                            {resolveAttendeeJobTitle(booking, memberInfoMap[booking.member_id])
                              || <span className="text-muted-foreground">-</span>
                            }
                          </TableCell>
                          <TableCell>
                            {booking.organization_id 
                              ? (organizationMap[booking.organization_id] || '-')
                              : <span className="text-muted-foreground italic">Non-member</span>
                            }
                          </TableCell>
                          <TableCell>
                            <a 
                              href={`mailto:${booking.attendee_email}`} 
                              className="text-blue-600 hover:underline"
                            >
                              {booking.attendee_email || '-'}
                            </a>
                          </TableCell>
                          <TableCell className="text-right">
                            <TooltipProvider delayDuration={100}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => booking.id && resendConfirmationMutation.mutate(booking.id)}
                                    disabled={!booking.id || isResending}
                                    aria-label="Resend confirmation email"
                                    data-testid={`button-resend-confirmation-${booking.id}`}
                                  >
                                    {isResending ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Send className="w-4 h-4" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Resend confirmation email
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>

            {/* Footer with pagination */}
            {filteredAttendees.length > 0 && (
              <div className="pt-3 border-t flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-sm text-slate-500">
                  Showing {startIndex + 1}-{Math.min(endIndex, filteredAttendees.length)} of {filteredAttendees.length} attendee{filteredAttendees.length !== 1 ? 's' : ''}
                  {organizationFilter !== "all" || searchFilter ? ` (filtered from ${activeBookings?.length || 0})` : ''}
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

      {/* Import Attendees Dialog */}
      {canManageEvent && (
        <Dialog open={showImportDialog} onOpenChange={(open) => {
          setShowImportDialog(open);
          if (!open) {
            resetImportState();
          }
        }}>
          <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="w-5 h-5 text-purple-600" />
                Import Attendees
              </DialogTitle>
              <DialogDescription>
                Add attendees one row at a time. Emails matching an existing member become member bookings; any other email is added as a guest using the typed name, organization and job title.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              {importTicketClasses.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="import-ticket-class">Ticket class</Label>
                  <Select
                    value={importTicketClassId || "__default__"}
                    onValueChange={(v) => setImportTicketClassId(v === "__default__" ? "" : v)}
                    disabled={importAttendeesMutation.isPending}
                  >
                    <SelectTrigger id="import-ticket-class" data-testid="select-import-ticket-class">
                      <SelectValue placeholder="Select a ticket class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">No ticket class</SelectItem>
                      {importTicketClasses.map(tc => {
                        const isMembersOnly = tc.visibility_mode
                          ? tc.visibility_mode === 'members_only'
                          : tc.is_public === false;
                        return (
                          <SelectItem key={tc.id} value={String(tc.id)}>
                            {tc.name || 'Ticket'}{isMembersOnly ? ' (members-only)' : ''}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>Attendees</Label>
                <div className="border rounded-md overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[14%]">First name</TableHead>
                        <TableHead className="w-[14%]">Last name</TableHead>
                        <TableHead className="w-[20%]">Email *</TableHead>
                        <TableHead className="w-[15%]">Organization</TableHead>
                        <TableHead className="w-[15%]">Job title</TableHead>
                        <TableHead className="w-[15%]">Designation</TableHead>
                        <TableHead className="w-[7%]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {importRows.map((row, index) => {
                        const rowError = importRowErrors[index];
                        return (
                          <Fragment key={`row-${index}`}>
                            <TableRow>
                              <TableCell className="align-top p-2">
                                <Input
                                  value={row.first_name}
                                  onChange={(e) => updateImportRow(index, 'first_name', e.target.value)}
                                  disabled={importAttendeesMutation.isPending}
                                  placeholder="Jane"
                                  data-testid={`input-import-first-name-${index}`}
                                />
                              </TableCell>
                              <TableCell className="align-top p-2">
                                <Input
                                  value={row.last_name}
                                  onChange={(e) => updateImportRow(index, 'last_name', e.target.value)}
                                  disabled={importAttendeesMutation.isPending}
                                  placeholder="Doe"
                                  data-testid={`input-import-last-name-${index}`}
                                />
                              </TableCell>
                              <TableCell className="align-top p-2">
                                <Input
                                  type="email"
                                  value={row.email}
                                  onChange={(e) => updateImportRow(index, 'email', e.target.value)}
                                  disabled={importAttendeesMutation.isPending}
                                  placeholder="jane@example.com"
                                  aria-invalid={rowError ? true : false}
                                  className={rowError ? "border-red-500 focus-visible:ring-red-500" : ""}
                                  data-testid={`input-import-email-${index}`}
                                />
                              </TableCell>
                              <TableCell className="align-top p-2">
                                <Input
                                  value={row.organization}
                                  onChange={(e) => updateImportRow(index, 'organization', e.target.value)}
                                  disabled={importAttendeesMutation.isPending}
                                  placeholder="Acme Ltd"
                                  data-testid={`input-import-organization-${index}`}
                                />
                              </TableCell>
                              <TableCell className="align-top p-2">
                                <Input
                                  value={row.job_title}
                                  onChange={(e) => updateImportRow(index, 'job_title', e.target.value)}
                                  disabled={importAttendeesMutation.isPending}
                                  placeholder="Manager"
                                  data-testid={`input-import-job-title-${index}`}
                                />
                              </TableCell>
                              <TableCell className="align-top p-2">
                                <Input
                                  value={row.designation}
                                  onChange={(e) => updateImportRow(index, 'designation', e.target.value)}
                                  disabled={importAttendeesMutation.isPending}
                                  placeholder="VIP Guest"
                                  data-testid={`input-import-designation-${index}`}
                                />
                              </TableCell>
                              <TableCell className="align-top p-2">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => removeImportRow(index)}
                                  disabled={importAttendeesMutation.isPending}
                                  aria-label="Remove row"
                                  data-testid={`button-import-remove-row-${index}`}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                            {rowError && (
                              <TableRow>
                                <TableCell colSpan={7} className="p-2 pt-0">
                                  <p
                                    className="text-xs text-red-600"
                                    data-testid={`text-import-row-error-${index}`}
                                  >
                                    {rowError}
                                  </p>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addImportRow}
                    disabled={importAttendeesMutation.isPending}
                    data-testid="button-import-add-row"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add row
                  </Button>
                  <p className="text-xs text-slate-500">
                    Email is required per row. Other fields are used when the email isn't a member.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="import-send-confirmations"
                  checked={importSendConfirmations}
                  onCheckedChange={(v) => setImportSendConfirmations(v === true)}
                  disabled={importAttendeesMutation.isPending}
                  data-testid="checkbox-import-send-confirmations"
                />
                <div className="-mt-0.5">
                  <Label
                    htmlFor="import-send-confirmations"
                    className="cursor-pointer"
                  >
                    Send confirmation emails now
                  </Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Sends the event's confirmation email to every newly-imported attendee (members and guests).
                  </p>
                </div>
              </div>
            </div>

            {importResults && (
              <div className="space-y-3 py-2 border-t">
                {(importResults.registeredMembers?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-green-700">Registered — Members ({importResults.registeredMembers.length})</p>
                      <p className="text-slate-600 text-xs mt-1">{importResults.registeredMembers.join(', ')}</p>
                    </div>
                  </div>
                )}
                {(importResults.registeredGuests?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-green-700">Registered — Guests ({importResults.registeredGuests.length})</p>
                      <p className="text-slate-600 text-xs mt-1">{importResults.registeredGuests.join(', ')}</p>
                    </div>
                  </div>
                )}
                {(importResults.alreadyRegistered?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-warning">Already Registered ({importResults.alreadyRegistered.length})</p>
                      <p className="text-slate-600 text-xs mt-1">{importResults.alreadyRegistered.join(', ')}</p>
                    </div>
                  </div>
                )}
                {(importResults.warnings?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-warning">Warnings ({importResults.warnings.length})</p>
                      <p className="text-slate-600 text-xs mt-1">
                        {importResults.warnings.map(w => `${w.email}: ${w.reason}`).join('; ')}
                      </p>
                    </div>
                  </div>
                )}
                {(importResults.errors?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-red-700">Errors ({importResults.errors.length})</p>
                      <p className="text-slate-600 text-xs mt-1">
                        {importResults.errors.map(e => {
                          const prefix = e.row ? `Row ${e.row}` : (e.email || 'Row');
                          return `${prefix}${e.email && e.row ? ` (${e.email})` : ''}: ${e.error}`;
                        }).join('; ')}
                      </p>
                    </div>
                  </div>
                )}
                {importResults.sendConfirmations && (
                  <div className="flex items-start gap-2 text-sm">
                    <Send className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-blue-700">
                        Emails sent ({importResults.emailsSent?.length || 0})
                        {(importResults.emailsFailed?.length || 0) > 0
                          ? ` · failed (${importResults.emailsFailed.length})`
                          : ''}
                      </p>
                      {(importResults.emailsFailed?.length || 0) > 0 && (
                        <p className="text-slate-600 text-xs mt-1">
                          Failed: {importResults.emailsFailed.map(f => `${f.email}: ${f.error}`).join('; ')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <DialogFooter className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowImportDialog(false)}
                disabled={importAttendeesMutation.isPending}
                data-testid="button-cancel-import"
              >
                {importResults ? 'Close' : 'Cancel'}
              </Button>
              {!importResults && (
                <Button
                  onClick={handleImportSubmit}
                  disabled={!hasAnyEmail || hasUnresolvedErrors || importAttendeesMutation.isPending}
                  data-testid="button-submit-import"
                >
                  {importAttendeesMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    'Import Attendees'
                  )}
                </Button>
              )}
              {importResults && (
                <Button
                  onClick={() => {
                    setImportResults(null);
                    setImportRows([{ first_name: "", last_name: "", email: "", organization: "", job_title: "", designation: "" }]);
                  }}
                  data-testid="button-import-more"
                >
                  Import More
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
