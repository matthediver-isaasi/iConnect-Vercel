import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Search, Download, Calendar, Building2, CreditCard, Receipt, Ticket, Users, Banknote, ChevronLeft, ChevronRight, XCircle, ArrowLeftRight, Loader2, Filter, Hash, Layers, RefreshCw, Check, X, Clock } from "lucide-react";
import { format, parseISO } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import TransferTicketDialog from "@/components/TransferTicketDialog";
import { toast } from "sonner";

function TypeAheadInput({ value, onChange, suggestions, placeholder, renderItem, "data-testid": testId, icon: Icon }) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapperRef = useRef(null);
  const listRef = useRef(null);

  const filtered = useMemo(() => {
    if (!value || value.length < 1) return [];
    const q = value.toLowerCase();
    return suggestions.filter(s =>
      s.searchText.toLowerCase().includes(q)
    ).slice(0, 12);
  }, [value, suggestions]);

  useEffect(() => {
    setHighlightIdx(-1);
  }, [filtered.length, value]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0) {
      e.preventDefault();
      onChange(filtered[highlightIdx].value);
      setOpen(false);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }, [open, filtered, highlightIdx, onChange]);

  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const item = listRef.current.children[highlightIdx];
      if (item) item.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx]);

  return (
    <div ref={wrapperRef} className="relative">
      {Icon && <Icon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />}
      <Input
        placeholder={placeholder}
        className={Icon ? "pl-8" : ""}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => { if (value) setOpen(true); }}
        onKeyDown={handleKeyDown}
        data-testid={testId}
      />
      {open && filtered.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-50 top-full left-0 right-0 mt-1 max-h-52 overflow-y-auto rounded-md border bg-popover shadow-md"
        >
          {filtered.map((item, idx) => (
            <button
              key={item.key}
              type="button"
              className={`w-full text-left px-3 py-2 text-sm cursor-pointer ${
                idx === highlightIdx ? "bg-accent text-accent-foreground" : "hover-elevate"
              }`}
              onMouseDown={(e) => { e.preventDefault(); onChange(item.value); setOpen(false); }}
              onMouseEnter={() => setHighlightIdx(idx)}
              data-testid={`${testId}-option-${idx}`}
            >
              {renderItem ? renderItem(item) : item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ITEMS_PER_PAGE = 25;

function formatCurrency(amount) {
  if (amount === null || amount === undefined) return "\u00A30.00";
  return `\u00A3${Number(amount).toFixed(2)}`;
}

function PaymentMethodBadge({ method, totalCost }) {
  if (method === 'card') {
    return (
      <Badge variant="outline" className="gap-1">
        <CreditCard className="w-3 h-3" />
        Stripe
      </Badge>
    );
  }
  if (method === 'account') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Building2 className="w-3 h-3" />
        Account
      </Badge>
    );
  }
  if (method === 'free' || Number(totalCost) === 0) {
    return <Badge variant="secondary">Free</Badge>;
  }
  return <span className="text-muted-foreground">{method || '-'}</span>;
}

export default function EventRegistrationReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);

  const [filterEventName, setFilterEventName] = useState("");
  const [filterInternalRef, setFilterInternalRef] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  const { data: eventsForTypeAhead = [] } = useQuery({
    queryKey: ['event-registration-report-events'],
    queryFn: async () => {
      const response = await fetch('/api/reports/event-registration-report', { credentials: 'include' });
      if (!response.ok) return [];
      const data = await response.json();
      return data.events || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const eventNameSuggestions = useMemo(() => {
    const seen = new Set();
    return eventsForTypeAhead
      .filter(e => {
        const title = (e.title || '').trim();
        if (!title || seen.has(title.toLowerCase())) return false;
        seen.add(title.toLowerCase());
        return true;
      })
      .map(e => ({
        key: e.id,
        value: e.title,
        label: e.title,
        searchText: e.title,
        startDate: e.start_date,
        internalRef: e.internal_reference,
        isComplex: e.is_complex,
      }));
  }, [eventsForTypeAhead]);

  const internalRefSuggestions = useMemo(() => {
    const seen = new Set();
    return eventsForTypeAhead
      .filter(e => {
        const ref = (e.internal_reference || '').trim();
        if (!ref || seen.has(ref.toLowerCase())) return false;
        seen.add(ref.toLowerCase());
        return true;
      })
      .map(e => ({
        key: e.id,
        value: e.internal_reference,
        label: e.internal_reference,
        searchText: `${e.internal_reference} ${e.title}`,
        title: e.title,
      }));
  }, [eventsForTypeAhead]);

  const [appliedFilters, setAppliedFilters] = useState(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState("date_desc");
  const [cancelTarget, setCancelTarget] = useState(null);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [submittingCancel, setSubmittingCancel] = useState(false);
  const [transferTarget, setTransferTarget] = useState(null);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [transferIsPublic, setTransferIsPublic] = useState(false);
  const [statusFilter, setStatusFilter] = useState("active");
  const [consentFilter, setConsentFilter] = useState("all");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_EventRegistrationReport')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const buildQueryUrl = () => {
    if (!appliedFilters) return null;
    const params = new URLSearchParams();
    params.set('generate', 'true');
    if (appliedFilters.eventName) params.set('eventName', appliedFilters.eventName);
    if (appliedFilters.internalReference) params.set('internalReference', appliedFilters.internalReference);
    if (appliedFilters.dateFrom) params.set('dateFrom', appliedFilters.dateFrom);
    if (appliedFilters.dateTo) params.set('dateTo', appliedFilters.dateTo);
    return `/api/reports/event-registration-report?${params.toString()}`;
  };

  const queryUrl = buildQueryUrl();

  const { data: reportData, isLoading, isFetching } = useQuery({
    queryKey: ['event-registration-report', appliedFilters],
    queryFn: async () => {
      const url = queryUrl;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch report data');
      }
      return response.json();
    },
    enabled: !!appliedFilters,
    staleTime: 0,
    refetchOnMount: true,
  });

  const bookingGroups = reportData?.bookingGroups || [];
  const organizations = reportData?.organizations || {};

  const handleGenerateReport = () => {
    setAppliedFilters({
      eventName: filterEventName.trim(),
      internalReference: filterInternalRef.trim(),
      dateFrom: filterDateFrom,
      dateTo: filterDateTo,
    });
    setCurrentPage(1);
    setSearchQuery("");
  };

  const handleClearFilters = () => {
    setFilterEventName("");
    setFilterInternalRef("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setAppliedFilters(null);
    setSearchQuery("");
    setCurrentPage(1);
  };

  const hasActiveFilters = filterEventName || filterInternalRef || filterDateFrom || filterDateTo;
  const reportGenerated = !!appliedFilters;

  const filteredGroups = useMemo(() => {
    let result = bookingGroups;

    if (statusFilter !== "all") {
      result = result.map(group => {
        const filtered = group.attendees.filter(a =>
          statusFilter === "active" ? a.status !== 'cancelled' : a.status === statusFilter
        );
        if (filtered.length === 0) return null;
        return { ...group, attendees: filtered };
      }).filter(Boolean);
    }

    if (consentFilter !== "all") {
      result = result.map(group => {
        const filtered = group.attendees.filter(a =>
          consentFilter === "consented" ? a.third_party_consent === true : a.third_party_consent !== true
        );
        if (filtered.length === 0) return null;
        return { ...group, attendees: filtered };
      }).filter(Boolean);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(group =>
        group.attendees.some(a =>
          (a.attendee_first_name || '').toLowerCase().includes(q) ||
          (a.attendee_last_name || '').toLowerCase().includes(q) ||
          (a.attendee_email || '').toLowerCase().includes(q) ||
          (organizations[a.organization_id] || '').toLowerCase().includes(q) ||
          (a.ticket_class_name || '').toLowerCase().includes(q) ||
          (a.track_access || '').toLowerCase().includes(q)
        ) ||
        (group.groupPayment.purchaseOrderNumber || '').toLowerCase().includes(q) ||
        (group.groupPayment.bookingReference || '').toLowerCase().includes(q) ||
        (group.groupPayment.xeroInvoiceNumber || '').toLowerCase().includes(q) ||
        (group.eventTitle || '').toLowerCase().includes(q) ||
        (group.internalReference || '').toLowerCase().includes(q)
      );
    }

    result = [...result].sort((a, b) => {
      const aFirst = a.attendees[0];
      const bFirst = b.attendees[0];
      switch (sortBy) {
        case 'name_asc':
          return (`${aFirst?.attendee_last_name} ${aFirst?.attendee_first_name}`).localeCompare(`${bFirst?.attendee_last_name} ${bFirst?.attendee_first_name}`);
        case 'name_desc':
          return (`${bFirst?.attendee_last_name} ${bFirst?.attendee_first_name}`).localeCompare(`${aFirst?.attendee_last_name} ${aFirst?.attendee_first_name}`);
        case 'org_asc':
          return (organizations[aFirst?.organization_id] || 'zzz').localeCompare(organizations[bFirst?.organization_id] || 'zzz');
        case 'total_desc':
          return (b.groupPayment.totalCost || 0) - (a.groupPayment.totalCost || 0);
        case 'total_asc':
          return (a.groupPayment.totalCost || 0) - (b.groupPayment.totalCost || 0);
        case 'date_desc':
          return new Date(bFirst?.created_at || 0) - new Date(aFirst?.created_at || 0);
        case 'date_asc':
          return new Date(aFirst?.created_at || 0) - new Date(bFirst?.created_at || 0);
        default:
          return 0;
      }
    });

    return result;
  }, [bookingGroups, searchQuery, sortBy, organizations, statusFilter, consentFilter]);

  const totalAttendees = useMemo(() => {
    return filteredGroups.reduce((sum, g) => sum + g.attendees.length, 0);
  }, [filteredGroups]);

  const filteredSummary = useMemo(() => {
    let totalRevenue = 0;
    let totalVoucher = 0;
    let totalTrainingFund = 0;
    let totalDiscount = 0;
    let totalStripePayments = 0;
    const countByMethod = {};
    for (const group of filteredGroups) {
      const gp = group.groupPayment;
      totalRevenue += gp.totalCost || 0;
      totalVoucher += gp.voucherAmount || 0;
      totalTrainingFund += gp.trainingFundAmount || 0;
      totalDiscount += gp.discount || 0;
      if (gp.paymentMethod === 'card' || gp.stripePaymentIntentId) {
        totalStripePayments += gp.totalCost || 0;
      }
      const method = gp.paymentMethod || 'unknown';
      countByMethod[method] = (countByMethod[method] || 0) + 1;
    }
    return {
      totalBookings: totalAttendees,
      totalGroups: filteredGroups.length,
      totalRevenue,
      totalVoucher,
      totalTrainingFund,
      totalDiscount,
      totalStripePayments,
      countByMethod,
    };
  }, [filteredGroups, totalAttendees]);

  const totalPages = Math.ceil(filteredGroups.length / ITEMS_PER_PAGE);
  const paginatedGroups = filteredGroups.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, consentFilter]);

  const handleExportCSV = () => {
    if (filteredGroups.length === 0) return;

    const headers = [
      'Event',
      'Complex Event',
      'Internal Reference',
      'Booking Group',
      'Name',
      'Email',
      'Organisation',
      'Ticket Type',
      'Track Access',
      'Ticket Price',
      'Group Discount',
      'Group Total',
      'Voucher Amount',
      'Training Fund',
      'Account Amount',
      'Payment Method',
      'PO Number',
      'PO To Follow',
      'Stripe Payment',
      'Xero Invoice',
      'Booking Reference',
      'Status',
      'Date',
      'Guest Booking',
      'Third-party Consent',
      'Attended',
      'Zoom Join Time',
      'Zoom Leave Time',
      'Zoom Duration (mins)',
      'Sessions Attended'
    ];

    const rows = [];
    for (const group of filteredGroups) {
      const gp = group.groupPayment;
      group.attendees.forEach((a, idx) => {
        const isFirstInGroup = idx === 0;
        rows.push([
          group.eventTitle || '',
          group.isComplexEvent ? 'Yes' : 'No',
          group.internalReference || '',
          group.isGroup ? (group.groupRef || 'Group') : '',
          `${a.attendee_first_name || ''} ${a.attendee_last_name || ''}`.trim(),
          a.attendee_email || '',
          organizations[a.organization_id] || (a.is_guest_booking ? 'Guest' : 'Non-member'),
          a.ticket_class_name || '',
          a.track_access || '',
          Number(a.ticket_price || 0).toFixed(2),
          isFirstInGroup ? (gp.discount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.totalCost || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.voucherAmount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.trainingFundAmount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.accountAmount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.paymentMethod || '') : '',
          isFirstInGroup ? (gp.purchaseOrderNumber || '') : '',
          isFirstInGroup ? (gp.poToFollow ? 'Yes' : 'No') : '',
          isFirstInGroup ? (gp.stripePaymentIntentId ? 'Yes' : 'No') : '',
          isFirstInGroup ? (gp.xeroInvoiceNumber || '') : '',
          isFirstInGroup ? (gp.bookingReference || '') : '',
          a.status || '',
          a.created_at ? format(parseISO(a.created_at), 'yyyy-MM-dd HH:mm') : '',
          a.is_guest_booking ? 'Yes' : 'No',
          a.third_party_consent === true ? 'Yes' : a.third_party_consent === false ? 'No' : '',
          a.attended === true ? 'Yes' : a.attended === false ? 'Partial' : (a.attended === null && group.hasZoom ? 'No' : ''),
          a.zoom_join_time ? format(parseISO(a.zoom_join_time), 'yyyy-MM-dd HH:mm:ss') : '',
          a.zoom_leave_time ? format(parseISO(a.zoom_leave_time), 'yyyy-MM-dd HH:mm:ss') : '',
          a.zoom_duration_minutes != null ? a.zoom_duration_minutes : '',
          a.attendance_by_session ? a.attendance_by_session.filter(s => s.attended).length + '/' + a.attendance_by_session.length : ''
        ]);
      });
    }

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const datePart = format(new Date(), 'yyyy-MM-dd');
    link.download = `registration_report_${datePart}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleCancelClick = (attendee) => {
    setCancelTarget(attendee);
    setCancelReason("");
    setShowCancelDialog(true);
  };

  const handleCancelSubmit = async () => {
    if (!cancelTarget?.id) return;
    setSubmittingCancel(true);
    try {
      const response = await fetch('/api/booking-cancellation-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          booking_ids: [cancelTarget.id],
          request_type: 'individual',
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
      queryClient.invalidateQueries({ queryKey: ['event-registration-report', appliedFilters] });
    } catch (error) {
      toast.error(error.message || 'Failed to submit cancellation request');
    } finally {
      setSubmittingCancel(false);
    }
  };

  const handleTransferClick = (attendee) => {
    const isGuest = attendee.is_guest_booking || (!attendee.organization_id && !attendee.member_id);
    setTransferTarget(attendee);
    setTransferIsPublic(isGuest);
    setShowTransferDialog(true);
  };

  const handleTransferSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['event-registration-report', appliedFilters] });
  };

  const [syncingAttendance, setSyncingAttendance] = useState(false);

  const hasZoomForSelectedEvents = reportData?.hasZoomForSelectedEvents || false;
  const anyGroupHasZoom = bookingGroups.some(g => g.hasZoom);
  const showAttendanceColumn = hasZoomForSelectedEvents || anyGroupHasZoom;

  const handleSyncAttendance = async () => {
    if (!appliedFilters) return;
    setSyncingAttendance(true);
    try {
      const zoomEventIds = new Set();
      for (const group of bookingGroups) {
        if (group.hasZoom && group.eventId) {
          zoomEventIds.add(group.eventId);
        }
      }

      const eventsWithZoom = (reportData?.events || []).filter(e => zoomEventIds.has(e.id) || e.has_zoom);

      if (eventsWithZoom.length === 0) {
        toast.error('No events with Zoom integration found in current selection');
        return;
      }

      let totalParticipants = 0;
      let totalMatched = 0;
      let errors = [];
      const syncedEventIds = new Set();

      for (const event of eventsWithZoom) {
        if (syncedEventIds.has(event.id)) continue;
        syncedEventIds.add(event.id);
        try {
          const response = await fetch('/api/zoom/sync-attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ eventId: event.id }),
          });
          const data = await response.json();
          if (response.ok && data.success) {
            totalParticipants += data.participantCount || 0;
            totalMatched += data.matchedCount || 0;
          } else {
            errors.push(`${event.title}: ${data.error || 'Unknown error'}`);
          }
        } catch (err) {
          errors.push(`${event.title}: ${err.message}`);
        }
      }

      if (errors.length > 0 && totalParticipants === 0) {
        toast.error(`Sync failed: ${errors[0]}`);
      } else if (errors.length > 0) {
        toast.info(`Synced ${totalParticipants} participants (${totalMatched} matched). Some events had errors.`);
      } else {
        toast.success(`Synced ${totalParticipants} participants (${totalMatched} matched to bookings)`);
      }

      queryClient.invalidateQueries({ queryKey: ['event-registration-report', appliedFilters] });
    } catch (error) {
      toast.error(error.message || 'Failed to sync attendance');
    } finally {
      setSyncingAttendance(false);
    }
  };

  const renderAttendanceCell = (attendee) => {
    if (attendee.attended === true) {
      const durationLabel = attendee.zoom_duration_minutes != null ? `${attendee.zoom_duration_minutes} min` : '';
      const sessionCount = attendee.attendance_by_session?.length || 0;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1">
              <Check className="w-4 h-4 text-green-600" />
              <span className="text-xs text-green-600">
                {sessionCount > 1 ? `Yes (${sessionCount} sessions)` : 'Yes'}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-xs space-y-0.5">
              {attendee.zoom_join_time && <div>Joined: {format(parseISO(attendee.zoom_join_time), 'HH:mm')}</div>}
              {attendee.zoom_leave_time && <div>Left: {format(parseISO(attendee.zoom_leave_time), 'HH:mm')}</div>}
              {durationLabel && <div>Total duration: {durationLabel}</div>}
              {sessionCount > 0 && <div>Sessions attended: {sessionCount}</div>}
            </div>
          </TooltipContent>
        </Tooltip>
      );
    }
    if (attendee.attended === false) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1">
              <Clock className="w-4 h-4 text-amber-500" />
              <span className="text-xs text-amber-500">Partial</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-xs">Joined briefly ({attendee.zoom_duration_minutes || 0} min)</div>
          </TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1">
            <X className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">No</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs">Not found in Zoom participant data. Sync attendance to refresh.</div>
        </TooltipContent>
      </Tooltip>
    );
  };

  const renderActionIcons = (attendee) => {
    const isCancelled = attendee.status === 'cancelled';
    return (
      <div className="flex items-center gap-0.5 mr-1" style={{ visibility: isCancelled ? 'hidden' : 'visible' }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={(e) => { e.stopPropagation(); handleCancelClick(attendee); }}
              data-testid={`button-cancel-${attendee.id}`}
            >
              <XCircle className="w-3.5 h-3.5 text-destructive" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Request cancellation</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={(e) => { e.stopPropagation(); handleTransferClick(attendee); }}
              data-testid={`button-transfer-${attendee.id}`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Request transfer</TooltipContent>
        </Tooltip>
      </div>
    );
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="loading-access">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-full">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Event Registration Report</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Set filters below and generate a report to view registration details and payment breakdowns
          </p>
        </div>
        {reportGenerated && (
          <div className="flex items-center gap-2 flex-wrap">
            {(showAttendanceColumn || hasZoomForSelectedEvents) && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={handleSyncAttendance}
                disabled={syncingAttendance}
                data-testid="button-sync-attendance"
              >
                {syncingAttendance ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Sync Attendance
              </Button>
            )}
            {filteredGroups.length > 0 && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={handleExportCSV}
                data-testid="button-export-csv"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </Button>
            )}
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Report Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Event Name</label>
              <TypeAheadInput
                placeholder="Search by event name..."
                value={filterEventName}
                onChange={setFilterEventName}
                suggestions={eventNameSuggestions}
                data-testid="input-filter-event-name"
                renderItem={(item) => (
                  <div>
                    <div className="font-medium truncate flex items-center gap-1">
                      {item.isComplex && <Layers className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
                      {item.label}
                    </div>
                    {item.startDate && (
                      <div className="text-xs text-muted-foreground">
                        {format(parseISO(item.startDate), 'dd MMM yyyy')}
                        {item.internalRef ? ` \u00B7 ${item.internalRef}` : ''}
                        {item.isComplex ? ' \u00B7 Complex' : ''}
                      </div>
                    )}
                  </div>
                )}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Internal Reference</label>
              <TypeAheadInput
                placeholder="Search by reference..."
                value={filterInternalRef}
                onChange={setFilterInternalRef}
                suggestions={internalRefSuggestions}
                icon={Hash}
                data-testid="input-filter-internal-ref"
                renderItem={(item) => (
                  <div>
                    <div className="font-medium truncate">{item.label}</div>
                    <div className="text-xs text-muted-foreground truncate">{item.title}</div>
                  </div>
                )}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Booking Date From</label>
              <Input
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
                data-testid="input-filter-date-from"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Booking Date To</label>
              <Input
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
                data-testid="input-filter-date-to"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={handleGenerateReport}
              className="gap-2"
              data-testid="button-generate-report"
            >
              {isFetching && <Loader2 className="w-4 h-4 animate-spin" />}
              Generate Report
            </Button>
            {(hasActiveFilters || reportGenerated) && (
              <Button
                variant="outline"
                onClick={handleClearFilters}
                data-testid="button-clear-filters"
              >
                Clear Filters
              </Button>
            )}
            {!hasActiveFilters && !reportGenerated && (
              <span className="text-sm text-muted-foreground">
                Leave all filters empty and click Generate Report to show all bookings
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center h-32" data-testid="loading-data">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {reportGenerated && !isLoading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Attendees</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-registrations">{filteredSummary.totalBookings || 0}</p>
                {filteredSummary.totalGroups > 0 && filteredSummary.totalGroups !== filteredSummary.totalBookings && (
                  <p className="text-xs text-muted-foreground mt-0.5">{filteredSummary.totalGroups} booking{filteredSummary.totalGroups !== 1 ? 's' : ''}</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Banknote className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Total Revenue</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-revenue">{formatCurrency(filteredSummary.totalRevenue)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Ticket className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Vouchers Used</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-vouchers">{formatCurrency(filteredSummary.totalVoucher)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Training Fund</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-fund">{formatCurrency(filteredSummary.totalTrainingFund)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Receipt className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Discounts</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-discounts">{formatCurrency(filteredSummary.totalDiscount)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <CreditCard className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Stripe Payments</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-stripe">{formatCurrency(filteredSummary.totalStripePayments)}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-4">
              <CardTitle className="text-base">
                Registrations
                {totalAttendees > 0 && (
                  <span className="text-muted-foreground font-normal text-sm ml-2">
                    ({totalAttendees} attendee{totalAttendees !== 1 ? 's' : ''} in {filteredGroups.length} booking{filteredGroups.length !== 1 ? 's' : ''})
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search registrations..."
                    className="pl-8 w-[200px]"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    data-testid="input-search"
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active Only</SelectItem>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="cancelled">Cancelled Only</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={consentFilter} onValueChange={setConsentFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-consent-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Consent</SelectItem>
                    <SelectItem value="consented">Consented Only</SelectItem>
                    <SelectItem value="not_consented">Not Consented</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="w-[160px]" data-testid="select-sort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name_asc">Name A-Z</SelectItem>
                    <SelectItem value="name_desc">Name Z-A</SelectItem>
                    <SelectItem value="org_asc">Organisation A-Z</SelectItem>
                    <SelectItem value="total_desc">Total (High-Low)</SelectItem>
                    <SelectItem value="total_asc">Total (Low-High)</SelectItem>
                    <SelectItem value="date_desc">Newest First</SelectItem>
                    <SelectItem value="date_asc">Oldest First</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {filteredGroups.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground" data-testid="text-no-registrations">
                  {searchQuery ? 'No registrations match your search' : 'No registrations found for the selected filters'}
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="pb-3 pr-1 font-medium text-muted-foreground whitespace-nowrap w-[68px]"></th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Name</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Event</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Int. Ref</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Organisation</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap" style={{ maxWidth: '120px' }}>Ticket</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap" style={{ maxWidth: '100px' }}>Tracks</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Price</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Discount</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Total</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Voucher</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Fund</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Method</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">PO Number</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Invoice</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Status</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">3rd Party Consent</th>
                          {showAttendanceColumn && (
                            <th className="pb-3 font-medium text-muted-foreground whitespace-nowrap">Attended</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedGroups.map((group) => {
                          const gp = group.groupPayment;

                          if (!group.isGroup) {
                            const attendee = group.attendees[0];
                            const orgName = organizations[attendee.organization_id] || null;
                            const isGuest = attendee.is_guest_booking || (!attendee.organization_id && !attendee.member_id);

                            return (
                              <tr key={attendee.id} className="border-b last:border-0" data-testid={`row-booking-${attendee.id}`}>
                                <td className="py-3 pr-1">
                                  {renderActionIcons(attendee)}
                                </td>
                                <td className="py-3 pr-3">
                                  <div className="font-medium whitespace-nowrap">
                                    {`${attendee.attendee_first_name || ''} ${attendee.attendee_last_name || ''}`.trim() || 'Unknown'}
                                  </div>
                                  <div className="text-xs text-muted-foreground">{attendee.attendee_email}</div>
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap truncate" style={{ maxWidth: '160px' }} title={group.eventTitle || ''}>
                                  <div className="flex items-center gap-1">
                                    {group.isComplexEvent && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Layers className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                                        </TooltipTrigger>
                                        <TooltipContent>Complex event</TooltipContent>
                                      </Tooltip>
                                    )}
                                    <span className="truncate">{group.eventTitle || '-'}</span>
                                  </div>
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap" data-testid={`text-internal-ref-${attendee.id}`}>
                                  {group.internalReference ? (
                                    <span className="text-xs font-mono">{group.internalReference}</span>
                                  ) : '-'}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {orgName ? orgName : <span className="italic text-muted-foreground">{isGuest ? 'Guest' : 'Non-member'}</span>}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap truncate" style={{ maxWidth: '120px' }} title={attendee.ticket_class_name || ''}>{attendee.ticket_class_name || '-'}</td>
                                <td className="py-3 pr-3 whitespace-nowrap truncate" style={{ maxWidth: '100px' }} title={attendee.track_access || ''} data-testid={`text-track-access-${attendee.id}`}>
                                  {attendee.track_access ? (
                                    <span className="text-xs">{attendee.track_access}</span>
                                  ) : '-'}
                                </td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">{formatCurrency(attendee.ticket_price)}</td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">
                                  {gp.discount > 0 ? <span className="text-green-600">-{formatCurrency(gp.discount)}</span> : '-'}
                                </td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap font-medium">{formatCurrency(gp.totalCost)}</td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">
                                  {gp.voucherAmount > 0 ? formatCurrency(gp.voucherAmount) : '-'}
                                </td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">
                                  {gp.trainingFundAmount > 0 ? formatCurrency(gp.trainingFundAmount) : '-'}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  <PaymentMethodBadge method={gp.paymentMethod} totalCost={gp.totalCost} />
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {gp.purchaseOrderNumber ? (
                                    <span className="text-xs">{gp.purchaseOrderNumber}</span>
                                  ) : gp.poToFollow ? (
                                    <span className="text-xs italic text-amber-600">To follow</span>
                                  ) : '-'}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {gp.xeroInvoiceNumber ? <span className="text-xs font-mono">{gp.xeroInvoiceNumber}</span> : '-'}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  <Badge variant={attendee.status === 'confirmed' ? 'default' : attendee.status === 'cancelled' ? 'destructive' : 'secondary'}>
                                    {attendee.status || 'unknown'}
                                  </Badge>
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap" data-testid={`text-consent-${attendee.id}`}>
                                  {attendee.third_party_consent === true ? (
                                    <Badge variant="secondary">Yes</Badge>
                                  ) : attendee.third_party_consent === false ? (
                                    <span className="text-xs text-muted-foreground">No</span>
                                  ) : (
                                    <span className="text-muted-foreground">-</span>
                                  )}
                                </td>
                                {showAttendanceColumn && (
                                  <td className="py-3 whitespace-nowrap" data-testid={`text-attended-${attendee.id}`}>
                                    {group.hasZoom ? renderAttendanceCell(attendee) : <span className="text-muted-foreground">-</span>}
                                  </td>
                                )}
                              </tr>
                            );
                          }

                          return group.attendees.map((attendee, idx) => {
                            const isFirst = idx === 0;
                            const isLast = idx === group.attendees.length - 1;
                            const orgName = organizations[attendee.organization_id] || null;
                            const isGuest = attendee.is_guest_booking || (!attendee.organization_id && !attendee.member_id);

                            return (
                              <tr
                                key={attendee.id}
                                className={`${isLast ? 'border-b' : ''} ${isFirst ? 'border-t' : ''}`}
                                style={isFirst ? { borderTopWidth: '2px' } : undefined}
                                data-testid={`row-booking-${attendee.id}`}
                              >
                                <td className="py-2 pr-1">
                                  {renderActionIcons(attendee)}
                                </td>
                                <td className="py-2 pr-3">
                                  <div className="flex items-center gap-2">
                                    {isFirst && (
                                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                        {group.attendeeCount}
                                      </Badge>
                                    )}
                                    <div>
                                      <div className="font-medium whitespace-nowrap">
                                        {`${attendee.attendee_first_name || ''} ${attendee.attendee_last_name || ''}`.trim() || 'Unknown'}
                                      </div>
                                      <div className="text-xs text-muted-foreground">{attendee.attendee_email}</div>
                                    </div>
                                  </div>
                                </td>
                                {isFirst ? (
                                  <>
                                    <td className="py-2 pr-3 whitespace-nowrap truncate" style={{ maxWidth: '160px' }} title={group.eventTitle || ''} rowSpan={group.attendeeCount}>
                                      <div className="flex items-center gap-1">
                                        {group.isComplexEvent && (
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <Layers className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                                            </TooltipTrigger>
                                            <TooltipContent>Complex event</TooltipContent>
                                          </Tooltip>
                                        )}
                                        <span className="truncate">{group.eventTitle || '-'}</span>
                                      </div>
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap" rowSpan={group.attendeeCount} data-testid={`text-internal-ref-${attendee.id}`}>
                                      {group.internalReference ? (
                                        <span className="text-xs font-mono">{group.internalReference}</span>
                                      ) : '-'}
                                    </td>
                                  </>
                                ) : null}
                                <td className="py-2 pr-3 whitespace-nowrap">
                                  {orgName ? orgName : <span className="italic text-muted-foreground">{isGuest ? 'Guest' : 'Non-member'}</span>}
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap truncate" style={{ maxWidth: '120px' }} title={attendee.ticket_class_name || ''}>{attendee.ticket_class_name || '-'}</td>
                                <td className="py-2 pr-3 whitespace-nowrap truncate" style={{ maxWidth: '100px' }} title={attendee.track_access || ''} data-testid={`text-track-access-${attendee.id}`}>
                                  {attendee.track_access ? (
                                    <span className="text-xs">{attendee.track_access}</span>
                                  ) : '-'}
                                </td>
                                <td className="py-2 pr-3 text-right whitespace-nowrap">{formatCurrency(attendee.ticket_price)}</td>
                                {isFirst ? (
                                  <>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.discount > 0 ? <span className="text-green-600">-{formatCurrency(gp.discount)}</span> : '-'}
                                    </td>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap font-medium" rowSpan={group.attendeeCount}>
                                      {formatCurrency(gp.totalCost)}
                                    </td>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.voucherAmount > 0 ? formatCurrency(gp.voucherAmount) : '-'}
                                    </td>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.trainingFundAmount > 0 ? formatCurrency(gp.trainingFundAmount) : '-'}
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      <PaymentMethodBadge method={gp.paymentMethod} totalCost={gp.totalCost} />
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.purchaseOrderNumber ? (
                                        <span className="text-xs">{gp.purchaseOrderNumber}</span>
                                      ) : gp.poToFollow ? (
                                        <span className="text-xs italic text-amber-600">To follow</span>
                                      ) : '-'}
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.xeroInvoiceNumber ? <span className="text-xs font-mono">{gp.xeroInvoiceNumber}</span> : '-'}
                                    </td>
                                  </>
                                ) : null}
                                <td className="py-2 pr-3 whitespace-nowrap">
                                  <Badge variant={attendee.status === 'confirmed' ? 'default' : attendee.status === 'cancelled' ? 'destructive' : 'secondary'}>
                                    {attendee.status || 'unknown'}
                                  </Badge>
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap" data-testid={`text-consent-${attendee.id}`}>
                                  {attendee.third_party_consent === true ? (
                                    <Badge variant="secondary">Yes</Badge>
                                  ) : attendee.third_party_consent === false ? (
                                    <span className="text-xs text-muted-foreground">No</span>
                                  ) : (
                                    <span className="text-muted-foreground">-</span>
                                  )}
                                </td>
                                {showAttendanceColumn && (
                                  <td className="py-2 whitespace-nowrap" data-testid={`text-attended-${attendee.id}`}>
                                    {group.hasZoom ? renderAttendanceCell(attendee) : <span className="text-muted-foreground">-</span>}
                                  </td>
                                )}
                              </tr>
                            );
                          });
                        })}
                      </tbody>
                      {filteredGroups.length > 0 && (
                        <tfoot>
                          <tr className="border-t-2 font-medium">
                            <td className="pt-3 pr-3" colSpan={7}>
                              Totals ({totalAttendees} attendees, {filteredGroups.length} bookings)
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(filteredSummary.totalRevenue + filteredSummary.totalDiscount)}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap text-green-600">
                              {filteredSummary.totalDiscount > 0 ? `-${formatCurrency(filteredSummary.totalDiscount)}` : '-'}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(filteredSummary.totalRevenue)}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(filteredSummary.totalVoucher)}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(filteredSummary.totalTrainingFund)}
                            </td>
                            <td className="pt-3 pr-3" colSpan={4}>
                              <div className="flex gap-3 text-xs text-muted-foreground">
                                <span>Account: {filteredSummary.countByMethod?.account || 0}</span>
                                <span>Card: {filteredSummary.countByMethod?.card || 0}</span>
                              </div>
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-between mt-4 pt-4 border-t">
                      <span className="text-sm text-muted-foreground">
                        Page {currentPage} of {totalPages}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={currentPage <= 1}
                          onClick={() => setCurrentPage(p => p - 1)}
                          data-testid="button-prev-page"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={currentPage >= totalPages}
                          onClick={() => setCurrentPage(p => p + 1)}
                          data-testid="button-next-page"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {!reportGenerated && !isLoading && (
        <Card>
          <CardContent className="py-16 text-center">
            <Calendar className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2" data-testid="text-select-prompt">Set filters and generate a report</h3>
            <p className="text-sm text-muted-foreground">
              Use the filters above to narrow down results, or click Generate Report with no filters to view all bookings across all events
            </p>
          </CardContent>
        </Card>
      )}

      <Dialog open={showCancelDialog} onOpenChange={(open) => { if (!open) { setShowCancelDialog(false); setCancelTarget(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request Cancellation</DialogTitle>
            <DialogDescription>
              Submit a cancellation request for{' '}
              <span className="font-medium">
                {cancelTarget ? `${cancelTarget.attendee_first_name || ''} ${cancelTarget.attendee_last_name || ''}`.trim() || cancelTarget.attendee_email : ''}
              </span>
              {cancelTarget?.ticket_class_name ? ` (${cancelTarget.ticket_class_name})` : ''}.
              This will be added to the cancellation review queue.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Reason (optional)</label>
              <Textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Enter a reason for cancellation..."
                className="resize-none"
                rows={3}
                data-testid="input-cancel-reason"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setShowCancelDialog(false); setCancelTarget(null); }} data-testid="button-cancel-dialog-close">
              Close
            </Button>
            <Button variant="destructive" onClick={handleCancelSubmit} disabled={submittingCancel} data-testid="button-cancel-submit">
              {submittingCancel && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Submit Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TransferTicketDialog
        open={showTransferDialog}
        onOpenChange={(open) => { if (!open) { setShowTransferDialog(false); setTransferTarget(null); setTransferIsPublic(false); } }}
        booking={transferTarget}
        onSuccess={handleTransferSuccess}
        isPublicBooking={transferIsPublic}
      />
    </div>
  );
}
