import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Form, FormSubmission } from "@/api/entities";
import { Search, Download, Calendar, Building2, CreditCard, Receipt, Ticket, Users, Banknote, ChevronLeft, ChevronRight, XCircle, ArrowLeftRight, Loader2, Filter, Hash, Layers, RefreshCw, Check, X, Clock, Star, Pencil, Flag, UserPlus, Tag } from "lucide-react";
import { format, parseISO } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import TransferTicketDialog from "@/components/TransferTicketDialog";
import { getFlagColorClasses } from "@/lib/flagColors";
import { toast } from "sonner";

function formatDietarySelections(value) {
  if (!Array.isArray(value)) return '';
  return value.filter(Boolean).join(', ');
}

function formatAllergySelections(value) {
  if (!Array.isArray(value)) return '';
  return value
    .filter((a) => a && a.name)
    .map((a) => (a.severity ? `${a.name} (${a.severity})` : a.name))
    .join(', ');
}

function formatAccessibilitySelections(value) {
  if (!Array.isArray(value)) return '';
  return value.filter(Boolean).join(', ');
}

const ATTENDANCE_STATUS_LABELS = {
  pending: 'Pending',
  sync_failed: 'Sync failed',
  unmatched: 'Unmatched',
  below_threshold: 'Below threshold',
  absent: 'Absent',
  attended: 'Attended',
  mixed: 'Mixed',
};

function attendanceStatusLabel(status) {
  return ATTENDANCE_STATUS_LABELS[status] || '';
}

function formatAttendanceMinutes(value) {
  if (value == null || Number.isNaN(Number(value))) return '';
  const minutes = Number(value);
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(2)} min`;
}

function formatAttendanceDetail(detail) {
  const target = detail.target_title || (
    detail.target_type === 'complex_event_session'
      ? 'Session'
      : detail.target_type === 'agenda_item' ? 'Agenda item' : 'Event'
  );
  const parts = [
    `${target}: ${attendanceStatusLabel(detail.status) || detail.status || 'Unknown'}`,
    `${formatAttendanceMinutes(detail.duration_minutes || 0)} / ${formatAttendanceMinutes(detail.threshold_minutes || 0)} threshold`,
  ];
  if (detail.provider) parts.push(detail.provider);
  if (detail.sync_error_message) parts.push(detail.sync_error_message);
  return parts.join(' | ');
}

const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function isEmailValue(v) {
  return typeof v === 'string' && /\S+@\S+\.\S+/.test(v.trim());
}

// Mirrors the email soft-join used by the Form Submissions page: prefer the
// authenticated submitter email, then any email-looking field, then any
// email-looking value anywhere in the submission data.
function extractSubmissionEmail(submission, fields) {
  if (isEmailValue(submission?.submitted_by_email)) {
    return submission.submitted_by_email.trim();
  }
  const data = submission?.submission_data || {};
  for (const field of (fields || [])) {
    if (!field || !field.id) continue;
    const idLower = (field.id || '').toLowerCase();
    const labelLower = (field.label || '').toLowerCase();
    const looksLikeEmail =
      field.type === 'email' ||
      idLower.includes('email') || idLower.includes('e-mail') ||
      labelLower.includes('email') || labelLower.includes('e-mail');
    if (!looksLikeEmail) continue;
    const val = data[field.id];
    if (isEmailValue(val)) return val.trim();
  }
  for (const value of Object.values(data)) {
    if (isEmailValue(value)) return value.trim();
  }
  return null;
}

// Format a linked-form answer for CSV output, mirroring how the Form
// Submissions UI renders values (arrays joined with ', ', booleans as Yes/No).
function formatLinkedAnswer(val) {
  if (val == null) return '';
  if (Array.isArray(val)) {
    return val
      .map((v) => {
        if (v == null) return '';
        if (typeof v === 'object') {
          if (v.name) return v.severity ? `${v.name} (${v.severity})` : v.name;
          if (v.label) return v.label;
          if (v.file_url) return String(v.file_url);
          return JSON.stringify(v);
        }
        return String(v);
      })
      .filter(Boolean)
      .join(', ');
  }
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'object') {
    if (val.file_url) return String(val.file_url);
    return JSON.stringify(val);
  }
  return String(val);
}

function TypeAheadInput({ value, onChange, onSelect, suggestions, placeholder, renderItem, "data-testid": testId, icon: Icon }) {
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
      const item = filtered[highlightIdx];
      if (onSelect) onSelect(item);
      else onChange(item.value);
      setOpen(false);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }, [open, filtered, highlightIdx, onChange, onSelect]);

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
              onMouseDown={(e) => { e.preventDefault(); if (onSelect) onSelect(item); else onChange(item.value); setOpen(false); }}
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
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [filterInternalRef, setFilterInternalRef] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterEventDateFrom, setFilterEventDateFrom] = useState("");
  const [filterEventDateTo, setFilterEventDateTo] = useState("");

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
  const [showColumnChooser, setShowColumnChooser] = useState(false);
  const [selectedColumnKeys, setSelectedColumnKeys] = useState(() => new Set());
  const knownColumnKeysRef = useRef(new Set());

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
    if (appliedFilters.eventId) {
      params.set('eventId', appliedFilters.eventId);
    } else if (appliedFilters.eventName) {
      params.set('eventName', appliedFilters.eventName);
    }
    if (!appliedFilters.eventId && appliedFilters.internalReference) params.set('internalReference', appliedFilters.internalReference);
    if (appliedFilters.dateFrom) params.set('dateFrom', appliedFilters.dateFrom);
    if (appliedFilters.dateTo) params.set('dateTo', appliedFilters.dateTo);
    if (appliedFilters.eventDateFrom) params.set('eventDateFrom', appliedFilters.eventDateFrom);
    if (appliedFilters.eventDateTo) params.set('eventDateTo', appliedFilters.eventDateTo);
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

  const [editingDesignationId, setEditingDesignationId] = useState(null);
  const [designationDraft, setDesignationDraft] = useState("");

  const updateDesignationMutation = useMutation({
    mutationFn: async ({ eventId, bookingId, designation }) => {
      const response = await fetch(`/api/admin/events/${eventId}/attendees/designation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookingId, designation }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update designation');
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['event-registration-report', appliedFilters], (old) => {
        if (!old?.bookingGroups) return old;
        return {
          ...old,
          bookingGroups: old.bookingGroups.map(group => ({
            ...group,
            attendees: group.attendees.map(a =>
              a.id === data.bookingId ? { ...a, designation: data.designation } : a
            ),
          })),
        };
      });
      setEditingDesignationId(null);
      setDesignationDraft("");
      toast.success(data.designation ? 'Designation updated' : 'Designation cleared');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update designation');
    },
  });

  const updateBuddyMutation = useMutation({
    mutationFn: async ({ eventId, bookingId, buddy }) => {
      const response = await fetch(`/api/admin/events/${eventId}/attendees/buddy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookingId, buddy }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update buddy');
      return data;
    },
    onMutate: async ({ bookingId, buddy }) => {
      const key = ['event-registration-report', appliedFilters];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (old) => {
        if (!old?.bookingGroups) return old;
        return {
          ...old,
          bookingGroups: old.bookingGroups.map(group => ({
            ...group,
            attendees: group.attendees.map(a =>
              a.id === bookingId ? { ...a, buddy } : a
            ),
          })),
        };
      });
      return { previous, key };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous && ctx?.key) {
        queryClient.setQueryData(ctx.key, ctx.previous);
      }
      toast.error(error.message || 'Failed to update buddy');
    },
    onSuccess: (data, _vars, ctx) => {
      queryClient.setQueryData(ctx?.key || ['event-registration-report', appliedFilters], (old) => {
        if (!old?.bookingGroups) return old;
        return {
          ...old,
          bookingGroups: old.bookingGroups.map(group => ({
            ...group,
            attendees: group.attendees.map(a =>
              a.id === data.bookingId ? { ...a, buddy: !!data.buddy } : a
            ),
          })),
        };
      });
    },
  });

  const renderBuddyCell = (attendee, eventId) => {
    const pending =
      updateBuddyMutation.isPending &&
      updateBuddyMutation.variables?.bookingId === attendee.id;
    return (
      <div className="flex items-center gap-1.5">
        <Switch
          checked={!!attendee.buddy}
          onCheckedChange={(checked) => {
            if (!attendee.id || !eventId) return;
            updateBuddyMutation.mutate({ eventId, bookingId: attendee.id, buddy: checked });
          }}
          disabled={!attendee.id || !eventId || pending}
          aria-label={attendee.buddy ? 'Unmark as buddy' : 'Mark as buddy'}
          data-testid={`switch-buddy-${attendee.id}`}
        />
        {attendee.buddy && (
          <Badge variant="secondary" className="gap-1" data-testid={`badge-buddy-${attendee.id}`}>
            <UserPlus className="w-3 h-3" />
            Buddy
          </Badge>
        )}
      </div>
    );
  };

  const updateBadgeMutation = useMutation({
    mutationFn: async ({ eventId, bookingId, badge }) => {
      const response = await fetch(`/api/admin/events/${eventId}/attendees/badge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookingId, badge }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update badge');
      return data;
    },
    onMutate: async ({ bookingId, badge }) => {
      const key = ['event-registration-report', appliedFilters];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (old) => {
        if (!old?.bookingGroups) return old;
        return {
          ...old,
          bookingGroups: old.bookingGroups.map(group => ({
            ...group,
            attendees: group.attendees.map(a =>
              a.id === bookingId ? { ...a, badge } : a
            ),
          })),
        };
      });
      return { previous, key };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous && ctx?.key) {
        queryClient.setQueryData(ctx.key, ctx.previous);
      }
      toast.error(error.message || 'Failed to update badge');
    },
    onSuccess: (data, _vars, ctx) => {
      queryClient.setQueryData(ctx?.key || ['event-registration-report', appliedFilters], (old) => {
        if (!old?.bookingGroups) return old;
        return {
          ...old,
          bookingGroups: old.bookingGroups.map(group => ({
            ...group,
            attendees: group.attendees.map(a =>
              a.id === data.bookingId ? { ...a, badge: data.badge !== false } : a
            ),
          })),
        };
      });
    },
  });

  const renderBadgeCell = (attendee, eventId) => {
    const badgeOn = attendee.badge !== false;
    const pending =
      updateBadgeMutation.isPending &&
      updateBadgeMutation.variables?.bookingId === attendee.id;
    return (
      <div className="flex items-center gap-1.5">
        <Switch
          checked={badgeOn}
          onCheckedChange={(checked) => {
            if (!attendee.id || !eventId) return;
            updateBadgeMutation.mutate({ eventId, bookingId: attendee.id, badge: checked });
          }}
          disabled={!attendee.id || !eventId || pending}
          aria-label={badgeOn ? 'Mark as not requiring a badge' : 'Mark as requiring a badge'}
          data-testid={`switch-badge-${attendee.id}`}
        />
        {badgeOn && (
          <Badge variant="outline" className="gap-1" data-testid={`badge-badge-${attendee.id}`}>
            <Tag className="w-3 h-3" />
            Badge
          </Badge>
        )}
      </div>
    );
  };

  const startEditingDesignation = (attendee) => {
    setEditingDesignationId(attendee.id);
    setDesignationDraft(attendee.designation || "");
  };

  const cancelEditingDesignation = () => {
    setEditingDesignationId(null);
    setDesignationDraft("");
  };

  const saveDesignation = (attendee, eventId) => {
    const next = (designationDraft || "").trim();
    if (next === (attendee.designation || "").trim()) {
      cancelEditingDesignation();
      return;
    }
    updateDesignationMutation.mutate({ eventId, bookingId: attendee.id, designation: next });
  };

  const renderDesignationCell = (attendee, eventId) => {
    if (editingDesignationId === attendee.id) {
      return (
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={designationDraft}
            onChange={(e) => setDesignationDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); saveDesignation(attendee, eventId); }
              else if (e.key === 'Escape') { e.preventDefault(); cancelEditingDesignation(); }
            }}
            placeholder="e.g. VIP Guest"
            maxLength={120}
            className="h-9 w-36"
            disabled={updateDesignationMutation.isPending}
            data-testid={`input-designation-${attendee.id}`}
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => saveDesignation(attendee, eventId)}
            disabled={updateDesignationMutation.isPending}
            aria-label="Save designation"
            data-testid={`button-save-designation-${attendee.id}`}
          >
            {updateDesignationMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={cancelEditingDesignation}
            disabled={updateDesignationMutation.isPending}
            aria-label="Cancel editing designation"
            data-testid={`button-cancel-designation-${attendee.id}`}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5">
        {attendee.designation ? (
          <Badge variant="secondary" className="gap-1" data-testid={`badge-designation-${attendee.id}`}>
            <Star className="w-3 h-3" />
            {attendee.designation}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-sm">-</span>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={() => attendee.id && eventId && startEditingDesignation(attendee)}
          disabled={!attendee.id || !eventId}
          aria-label={attendee.designation ? 'Edit designation' : 'Add designation'}
          data-testid={`button-edit-designation-${attendee.id}`}
        >
          <Pencil className="w-4 h-4" />
        </Button>
      </div>
    );
  };

  const renderOptionsCell = (attendee) => {
    const dietary = formatDietarySelections(attendee.dietary_selections);
    const allergies = formatAllergySelections(attendee.allergy_selections);
    const accessibility = formatAccessibilitySelections(attendee.accessibility_selections);
    if (!dietary && !allergies && !accessibility) {
      return <span className="text-muted-foreground text-sm">-</span>;
    }
    return (
      <div className="space-y-0.5 text-xs" data-testid={`text-options-${attendee.id}`}>
        {dietary && <div><span className="text-muted-foreground">Dietary:</span> {dietary}</div>}
        {allergies && <div><span className="text-muted-foreground">Allergies:</span> {allergies}</div>}
        {accessibility && <div><span className="text-muted-foreground">Access:</span> {accessibility}</div>}
      </div>
    );
  };

  const renderFlagBadges = (attendee) => {
    const flags = Array.isArray(attendee.flags) ? attendee.flags : [];
    if (flags.length === 0) return null;
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1" data-testid={`flags-${attendee.id}`}>
        {flags.map((flag) => (
          <a
            key={flag.field_id}
            href={`/FormSubmission/${flag.form_submission_id}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`badge-flag-${attendee.id}-${flag.field_id}`}
          >
            <Badge className={`gap-1 ${getFlagColorClasses(flag.color).surface}`}>
              <Flag className="h-3 w-3" />
              {flag.label}
            </Badge>
          </a>
        ))}
      </div>
    );
  };

  const handleEventNameChange = (val) => {
    setFilterEventName(val);
    // Manual typing breaks the exact-event link; fall back to name search.
    if (selectedEvent && val !== selectedEvent.title) {
      setSelectedEvent(null);
    }
  };

  const handleEventNameSelect = (item) => {
    setFilterEventName(item.value);
    setSelectedEvent({ id: item.key, title: item.value, isComplex: !!item.isComplex });
  };

  const handleGenerateReport = () => {
    const exactEvent = selectedEvent && selectedEvent.title === filterEventName.trim() ? selectedEvent : null;
    setAppliedFilters({
      eventId: exactEvent ? exactEvent.id : null,
      eventName: filterEventName.trim(),
      internalReference: filterInternalRef.trim(),
      dateFrom: filterDateFrom,
      dateTo: filterDateTo,
      eventDateFrom: filterEventDateFrom,
      eventDateTo: filterEventDateTo,
    });
    setCurrentPage(1);
    setSearchQuery("");
  };

  const handleClearFilters = () => {
    setFilterEventName("");
    setSelectedEvent(null);
    setFilterInternalRef("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterEventDateFrom("");
    setFilterEventDateTo("");
    setAppliedFilters(null);
    setSearchQuery("");
    setCurrentPage(1);
  };

  const hasActiveFilters = filterEventName || filterInternalRef || filterDateFrom || filterDateTo || filterEventDateFrom || filterEventDateTo;
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

  const distinctEvents = useMemo(() => {
    const seen = new Map();
    for (const group of bookingGroups) {
      if (!group.eventId || seen.has(group.eventId)) continue;
      seen.set(group.eventId, {
        eventId: group.eventId,
        title: group.eventTitle || '',
        isComplex: !!group.isComplexEvent,
        startDate: group.eventStartDate || null,
        endDate: group.eventEndDate || null,
      });
    }
    return Array.from(seen.values());
  }, [bookingGroups]);

  const formatEventDateRange = (event) => {
    if (!event?.startDate) return '';
    let start;
    try {
      start = format(parseISO(event.startDate), 'dd MMM yyyy');
    } catch {
      return '';
    }
    if (event.isComplex && event.endDate) {
      try {
        const end = format(parseISO(event.endDate), 'dd MMM yyyy');
        if (end !== start) return `${start} \u2013 ${end}`;
      } catch {
        return start;
      }
    }
    return start;
  };

  // --- Column chooser: standard columns + linked-form field columns ---

  const scopeEventIds = useMemo(() => {
    const s = new Set();
    for (const g of filteredGroups) if (g.eventId) s.add(String(g.eventId));
    return s;
  }, [filteredGroups]);

  const { data: allForms = [] } = useQuery({
    queryKey: ['event-report-forms'],
    queryFn: () => Form.list(),
    enabled: reportGenerated,
    staleTime: 5 * 60 * 1000,
  });

  const linkedForms = useMemo(() => {
    return (allForms || []).filter(
      (f) => f && f.is_event_related && f.related_event_id && scopeEventIds.has(String(f.related_event_id))
    );
  }, [allForms, scopeEventIds]);

  const linkedFormIds = useMemo(() => linkedForms.map((f) => f.id).sort(), [linkedForms]);

  const { data: linkedSubmissions = [] } = useQuery({
    queryKey: ['event-report-linked-submissions', linkedFormIds],
    queryFn: async () => {
      if (linkedFormIds.length === 0) return [];
      const batches = await Promise.all(
        linkedFormIds.map((id) => FormSubmission.listAll({ filter: { form_id: id } }))
      );
      return batches.flat();
    },
    enabled: reportGenerated && linkedFormIds.length > 0,
    staleTime: 60 * 1000,
  });

  // email -> { [formId]: { [fieldId]: formattedAnswer } }; newest submission wins per form.
  const linkedAnswerLookup = useMemo(() => {
    const formsById = {};
    for (const f of linkedForms) formsById[f.id] = f;
    const sorted = [...linkedSubmissions].sort(
      (a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0)
    );
    const map = new Map();
    for (const sub of sorted) {
      const form = formsById[sub.form_id];
      if (!form) continue;
      const email = normEmail(extractSubmissionEmail(sub, form.fields));
      if (!email) continue;
      if (!map.has(email)) map.set(email, {});
      const byForm = map.get(email);
      if (byForm[sub.form_id]) continue; // keep newest
      const data = sub.submission_data || {};
      const answers = {};
      for (const field of (form.fields || [])) {
        if (!field || !field.id) continue;
        answers[field.id] = formatLinkedAnswer(data[field.id]);
      }
      byForm[sub.form_id] = answers;
    }
    return map;
  }, [linkedForms, linkedSubmissions]);

  const standardColumns = useMemo(() => ([
    { key: 'std:event', label: 'Event', get: ({ group }) => group.eventTitle || '' },
    { key: 'std:complex', label: 'Complex Event', get: ({ group }) => (group.isComplexEvent ? 'Yes' : 'No') },
    { key: 'std:eventDate', label: 'Event Date', get: ({ group }) => formatEventDateRange({ startDate: group.eventStartDate, endDate: group.eventEndDate, isComplex: group.isComplexEvent }) },
    { key: 'std:internalRef', label: 'Internal Reference', get: ({ group }) => group.internalReference || '' },
    { key: 'std:bookingGroup', label: 'Booking Group', get: ({ group }) => (group.isGroup ? (group.groupRef || 'Group') : '') },
    { key: 'std:name', label: 'Name', get: ({ a }) => `${a.attendee_first_name || ''} ${a.attendee_last_name || ''}`.trim() },
    { key: 'std:email', label: 'Email', get: ({ a }) => a.attendee_email || '' },
    { key: 'std:jobTitle', label: 'Job Title', get: ({ a }) => a.attendee_job_title || '' },
    { key: 'std:designation', label: 'Designation', get: ({ a }) => a.designation || '' },
    { key: 'std:buddy', label: 'Buddy', get: ({ a }) => (a.buddy ? 'Yes' : 'No') },
    { key: 'std:badge', label: 'Badge', get: ({ a }) => (a.badge !== false ? 'Yes' : 'No') },
    { key: 'std:dietary', label: 'Dietary Requirements', get: ({ a }) => formatDietarySelections(a.dietary_selections) },
    { key: 'std:allergies', label: 'Allergies', get: ({ a }) => formatAllergySelections(a.allergy_selections) },
    { key: 'std:accessibility', label: 'Accessibility Needs', get: ({ a }) => formatAccessibilitySelections(a.accessibility_selections) },
    { key: 'std:org', label: 'Organisation', get: ({ a }) => organizations[a.organization_id] || (a.is_guest_booking ? 'Guest' : 'Non-member') },
    { key: 'std:ticketType', label: 'Ticket Type', get: ({ a }) => a.ticket_class_name || '' },
    { key: 'std:trackAccess', label: 'Track Access', get: ({ a }) => a.track_access || '' },
    { key: 'std:ticketPrice', label: 'Ticket Price', get: ({ a }) => Number(a.ticket_price || 0).toFixed(2) },
    { key: 'std:groupDiscount', label: 'Group Discount', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.discount || 0).toFixed(2) : '') },
    { key: 'std:discountCode', label: 'Discount Code', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.discountCode || '') : '') },
    { key: 'std:groupTotal', label: 'Group Total', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.totalCost || 0).toFixed(2) : '') },
    { key: 'std:voucher', label: 'Voucher Amount', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.voucherAmount || 0).toFixed(2) : '') },
    { key: 'std:trainingFund', label: 'Training Fund', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.trainingFundAmount || 0).toFixed(2) : '') },
    { key: 'std:accountAmount', label: 'Account Amount', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.accountAmount || 0).toFixed(2) : '') },
    { key: 'std:paymentMethod', label: 'Payment Method', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.paymentMethod || '') : '') },
    { key: 'std:poNumber', label: 'PO Number', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.purchaseOrderNumber || '') : '') },
    { key: 'std:poToFollow', label: 'PO To Follow', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.poToFollow ? 'Yes' : 'No') : '') },
    { key: 'std:stripe', label: 'Stripe Payment', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.stripePaymentIntentId ? 'Yes' : 'No') : '') },
    { key: 'std:xero', label: 'Xero Invoice', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.xeroInvoiceNumber || '') : '') },
    { key: 'std:bookingRef', label: 'Booking Reference', get: ({ gp, isFirstInGroup }) => (isFirstInGroup ? (gp.bookingReference || '') : '') },
    { key: 'std:status', label: 'Status', get: ({ a }) => a.status || '' },
    { key: 'std:date', label: 'Date', get: ({ a }) => (a.created_at ? format(parseISO(a.created_at), 'yyyy-MM-dd HH:mm') : '') },
    { key: 'std:guest', label: 'Guest Booking', get: ({ a }) => (a.is_guest_booking ? 'Yes' : 'No') },
    { key: 'std:consent', label: 'Third-party Consent', get: ({ a }) => (a.third_party_consent === true ? 'Yes' : a.third_party_consent === false ? 'No' : '') },
    { key: 'std:attendanceStatus', label: 'Attendance Status', get: ({ a }) => attendanceStatusLabel(a.attendance_status) },
    { key: 'std:attendanceDuration', label: 'Attendance Duration (mins)', get: ({ a }) => (a.attendance_duration_minutes != null ? a.attendance_duration_minutes : '') },
    { key: 'std:attendanceThreshold', label: 'Attendance Threshold (mins)', get: ({ a }) => (a.attendance_threshold_minutes != null ? a.attendance_threshold_minutes : '') },
    { key: 'std:attendanceTargets', label: 'Attendance Target Detail', get: ({ a }) => (a.attendance_details || []).map(formatAttendanceDetail).join('; ') },
    { key: 'std:attendanceSessions', label: 'Session Attendance Detail', get: ({ a }) => (a.attendance_details || []).filter((d) => d.target_type === 'complex_event_session').map(formatAttendanceDetail).join('; ') },
    { key: 'std:attendanceAgenda', label: 'Agenda Attendance Detail', get: ({ a }) => (a.attendance_details || []).filter((d) => d.target_type === 'agenda_item').map(formatAttendanceDetail).join('; ') },
    { key: 'std:attendanceProviders', label: 'Attendance Provider(s)', get: ({ a }) => [...new Set((a.attendance_details || []).map((d) => d.provider).filter(Boolean))].join(', ') },
    { key: 'std:attended', label: 'Attended (legacy)', get: ({ a }) => (a.attended === true ? 'Yes' : a.attended === false ? 'No' : '') },
    { key: 'std:zoomJoin', label: 'Zoom Join Time', get: ({ a }) => (a.zoom_join_time ? format(parseISO(a.zoom_join_time), 'yyyy-MM-dd HH:mm:ss') : '') },
    { key: 'std:zoomLeave', label: 'Zoom Leave Time', get: ({ a }) => (a.zoom_leave_time ? format(parseISO(a.zoom_leave_time), 'yyyy-MM-dd HH:mm:ss') : '') },
    { key: 'std:zoomDuration', label: 'Zoom Duration (mins)', get: ({ a }) => (a.zoom_duration_minutes != null ? a.zoom_duration_minutes : '') },
    { key: 'std:sessions', label: 'Sessions Attended', get: ({ a }) => (a.attendance_by_session ? a.attendance_by_session.filter((s) => s.attended).length + '/' + a.attendance_by_session.length : '') },
  ]), [organizations]); // eslint-disable-line react-hooks/exhaustive-deps

  const linkedColumnsByForm = useMemo(() => {
    return linkedForms.map((form) => {
      const fields = (Array.isArray(form.fields) ? form.fields : []).filter((f) => f && f.id);
      return {
        formId: form.id,
        formName: form.name || 'Form',
        columns: fields.map((field) => ({
          key: `form:${form.id}:${field.id}`,
          label: field.label || field.id,
          get: ({ a }) => {
            const email = normEmail(a.attendee_email);
            if (!email) return '';
            const byForm = linkedAnswerLookup.get(email);
            const answers = byForm && byForm[form.id];
            return (answers && answers[field.id]) || '';
          },
        })),
      };
    });
  }, [linkedForms, linkedAnswerLookup]);

  const allColumnKeys = useMemo(() => {
    const keys = standardColumns.map((c) => c.key);
    for (const grp of linkedColumnsByForm) for (const c of grp.columns) keys.push(c.key);
    return keys;
  }, [standardColumns, linkedColumnsByForm]);

  // Default new columns to selected (preserving any user deselections) and drop
  // columns that no longer exist after the report scope changes.
  useEffect(() => {
    const current = new Set(allColumnKeys);
    setSelectedColumnKeys((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const k of current) {
        if (!knownColumnKeysRef.current.has(k)) { next.add(k); changed = true; }
      }
      for (const k of Array.from(next)) {
        if (!current.has(k)) { next.delete(k); changed = true; }
      }
      return changed ? next : prev;
    });
    knownColumnKeysRef.current = current;
  }, [allColumnKeys]);

  const toggleColumn = (key) => {
    setSelectedColumnKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const filteredSummary = useMemo(() => {
    let totalRevenue = 0;
    let totalVoucher = 0;
    let totalTrainingFund = 0;
    let totalDiscount = 0;
    let totalStripePayments = 0;
    const countByMethod = {};
    for (const group of filteredGroups) {
      const gp = group.groupPayment;
      totalRevenue += (gp.totalCost || 0) - (gp.codeDiscount || 0);
      totalVoucher += gp.voucherAmount || 0;
      totalTrainingFund += gp.trainingFundAmount || 0;
      totalDiscount += gp.discount || 0;
      if (gp.paymentMethod === 'card' || gp.stripePaymentIntentId) {
        totalStripePayments += (gp.totalCost || 0) - (gp.codeDiscount || 0);
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
    setShowColumnChooser(true);
  };

  const runExport = () => {
    if (filteredGroups.length === 0) return;

    const orderedColumns = [];
    for (const c of standardColumns) {
      if (selectedColumnKeys.has(c.key)) orderedColumns.push(c);
    }
    for (const grp of linkedColumnsByForm) {
      for (const c of grp.columns) {
        if (selectedColumnKeys.has(c.key)) orderedColumns.push(c);
      }
    }
    if (orderedColumns.length === 0) return;

    const headers = orderedColumns.map(c => c.label);

    const rows = [];
    for (const group of filteredGroups) {
      const gp = group.groupPayment || {};
      group.attendees.forEach((a, idx) => {
        const ctx = { group, a, gp, isFirstInGroup: idx === 0 };
        rows.push(orderedColumns.map(c => {
          const v = c.get(ctx);
          return v == null ? '' : v;
        }));
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
    setShowColumnChooser(false);
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
  const hasAttendanceForSelectedEvents = reportData?.hasAttendanceForSelectedEvents || false;
  const anyGroupHasAttendance = bookingGroups.some(g => g.hasAttendance);
  const showAttendanceColumn = hasAttendanceForSelectedEvents || anyGroupHasAttendance;

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
    const status = attendee.attendance_status;
    const details = Array.isArray(attendee.attendance_details) ? attendee.attendance_details : [];
    const duration = formatAttendanceMinutes(attendee.attendance_duration_minutes);
    const statusStyle = {
      attended: { icon: Check, className: 'text-green-600' },
      below_threshold: { icon: Clock, className: 'text-warning' },
      pending: { icon: Clock, className: 'text-muted-foreground' },
      sync_failed: { icon: XCircle, className: 'text-destructive' },
      unmatched: { icon: Users, className: 'text-warning' },
      absent: { icon: X, className: 'text-muted-foreground' },
      mixed: { icon: Layers, className: 'text-warning' },
    }[status];

    if (statusStyle) {
      const StatusIcon = statusStyle.icon;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`flex items-center gap-1 ${statusStyle.className}`}>
              <StatusIcon className="w-4 h-4" />
              <span className="text-xs">
                {attendanceStatusLabel(status)}
                {duration && status !== 'pending' && status !== 'sync_failed' ? ` (${duration})` : ''}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <div className="text-xs space-y-1">
              {details.length ? details.map((detail) => (
                <div key={detail.attendance_target_id}>
                  <div className="font-medium">
                    {detail.target_title || (detail.target_type === 'agenda_item' ? 'Agenda item' : detail.target_type === 'complex_event_session' ? 'Session' : 'Event')}
                  </div>
                  <div>
                    {attendanceStatusLabel(detail.status)}
                    {' · '}{formatAttendanceMinutes(detail.duration_minutes || 0)}
                    {' / '}{formatAttendanceMinutes(detail.threshold_minutes || 0)} threshold
                    {detail.provider ? ` · ${detail.provider}` : ''}
                  </div>
                  {detail.sync_error_message && <div className="text-destructive">{detail.sync_error_message}</div>}
                </div>
              )) : <div>Attendance outcome has not been created yet.</div>}
            </div>
          </TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1">
            <X className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Not tracked</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs">No provider-neutral attendance target applies to this booking.</div>
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
            {(hasZoomForSelectedEvents || anyGroupHasZoom) && (
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
                onChange={handleEventNameChange}
                onSelect={handleEventNameSelect}
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
            <div>
              <label className="text-sm font-medium mb-1.5 block">Event Date From</label>
              <Input
                type="date"
                value={filterEventDateFrom}
                onChange={(e) => setFilterEventDateFrom(e.target.value)}
                data-testid="input-filter-event-date-from"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Event Date To</label>
              <Input
                type="date"
                value={filterEventDateTo}
                onChange={(e) => setFilterEventDateTo(e.target.value)}
                data-testid="input-filter-event-date-to"
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

      {reportGenerated && !isLoading && distinctEvents.length > 0 && (
        <Card data-testid="card-event-details">
          <CardContent className="pt-4 pb-4">
            {distinctEvents.length === 1 ? (
              <div>
                <div className="flex items-center gap-2">
                  {distinctEvents[0].isComplex && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Layers className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent>Complex event</TooltipContent>
                    </Tooltip>
                  )}
                  <h2 className="text-lg font-semibold" data-testid={`text-event-title-${distinctEvents[0].eventId}`}>
                    {distinctEvents[0].title || 'Untitled event'}
                  </h2>
                </div>
                {formatEventDateRange(distinctEvents[0]) && (
                  <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5" data-testid={`text-event-date-${distinctEvents[0].eventId}`}>
                    <Calendar className="w-3.5 h-3.5" />
                    {formatEventDateRange(distinctEvents[0])}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {distinctEvents.length} events
                </div>
                <div className="space-y-1.5">
                  {distinctEvents.map((event) => (
                    <div
                      key={event.eventId}
                      className="flex items-center justify-between gap-3 flex-wrap"
                      data-testid={`row-event-${event.eventId}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {event.isComplex && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Layers className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            </TooltipTrigger>
                            <TooltipContent>Complex event</TooltipContent>
                          </Tooltip>
                        )}
                        <span className="font-medium truncate" data-testid={`text-event-title-${event.eventId}`}>
                          {event.title || 'Untitled event'}
                        </span>
                      </div>
                      {formatEventDateRange(event) && (
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5 flex-shrink-0" data-testid={`text-event-date-${event.eventId}`}>
                          <Calendar className="w-3.5 h-3.5" />
                          {formatEventDateRange(event)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
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
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Designation</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Buddy</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Badge</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Dietary &amp; Access</th>
                          {showAttendanceColumn && (
                            <th className="pb-3 font-medium text-muted-foreground whitespace-nowrap">Attendance</th>
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
                                  {renderFlagBadges(attendee)}
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
                                  {gp.discountCode && <div className="text-xs text-muted-foreground" data-testid={`text-discount-code-${attendee.id}`}>{gp.discountCode}</div>}
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
                                    <span className="text-xs italic text-warning">To follow</span>
                                  ) : '-'}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {gp.xeroInvoiceNumber ? (
                                    <span className="text-xs font-mono">{gp.xeroInvoiceNumber}</span>
                                  ) : gp.xeroInvoiceError ? (
                                    <span className="text-xs italic text-warning" title={gp.xeroInvoiceError} data-testid={`text-invoice-failed-${attendee.id}`}>Failed</span>
                                  ) : '-'}
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
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {renderDesignationCell(attendee, group.eventId)}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap" data-testid={`cell-buddy-${attendee.id}`}>
                                  {renderBuddyCell(attendee, group.eventId)}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap" data-testid={`cell-badge-${attendee.id}`}>
                                  {renderBadgeCell(attendee, group.eventId)}
                                </td>
                                <td className="py-3 pr-3 align-top">
                                  {renderOptionsCell(attendee)}
                                </td>
                                {showAttendanceColumn && (
                                  <td className="py-3 whitespace-nowrap" data-testid={`text-attended-${attendee.id}`}>
                                    {group.hasAttendance ? renderAttendanceCell(attendee) : <span className="text-muted-foreground">-</span>}
                                  </td>
                                )}
                              </tr>
                            );
                          }

                          const visibleAttendeeCount = group.attendees.length;
                          const bookerInVisible = !!group.booker && group.attendees.some(a => a.is_booker);
                          const showBookerHeader = !!group.booker && !bookerInVisible;
                          const groupRowCount = visibleAttendeeCount + (showBookerHeader ? 1 : 0);

                          const rows = [];

                          const renderEventCells = (keyAttendeeId) => (
                            <>
                              <td className="py-2 pr-3 whitespace-nowrap truncate" style={{ maxWidth: '160px' }} title={group.eventTitle || ''} rowSpan={groupRowCount}>
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
                              <td className="py-2 pr-3 whitespace-nowrap" rowSpan={groupRowCount} data-testid={`text-internal-ref-${keyAttendeeId}`}>
                                {group.internalReference ? (
                                  <span className="text-xs font-mono">{group.internalReference}</span>
                                ) : '-'}
                              </td>
                            </>
                          );

                          const renderPaymentCells = (keyAttendeeId) => (
                            <>
                              <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={groupRowCount}>
                                {gp.discount > 0 ? <span className="text-green-600">-{formatCurrency(gp.discount)}</span> : '-'}
                                {gp.discountCode && <div className="text-xs text-muted-foreground" data-testid={`text-discount-code-${keyAttendeeId}`}>{gp.discountCode}</div>}
                              </td>
                              <td className="py-2 pr-3 text-right whitespace-nowrap font-medium" rowSpan={groupRowCount}>
                                {formatCurrency(gp.totalCost)}
                              </td>
                              <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={groupRowCount}>
                                {gp.voucherAmount > 0 ? formatCurrency(gp.voucherAmount) : '-'}
                              </td>
                              <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={groupRowCount}>
                                {gp.trainingFundAmount > 0 ? formatCurrency(gp.trainingFundAmount) : '-'}
                              </td>
                              <td className="py-2 pr-3 whitespace-nowrap" rowSpan={groupRowCount}>
                                <PaymentMethodBadge method={gp.paymentMethod} totalCost={gp.totalCost} />
                              </td>
                              <td className="py-2 pr-3 whitespace-nowrap" rowSpan={groupRowCount}>
                                {gp.purchaseOrderNumber ? (
                                  <span className="text-xs">{gp.purchaseOrderNumber}</span>
                                ) : gp.poToFollow ? (
                                  <span className="text-xs italic text-warning">To follow</span>
                                ) : '-'}
                              </td>
                              <td className="py-2 pr-3 whitespace-nowrap" rowSpan={groupRowCount}>
                                {gp.xeroInvoiceNumber ? (
                                  <span className="text-xs font-mono">{gp.xeroInvoiceNumber}</span>
                                ) : gp.xeroInvoiceError ? (
                                  <span className="text-xs italic text-warning" title={gp.xeroInvoiceError} data-testid={`text-invoice-failed-group-${group.groupRef || keyAttendeeId}`}>Failed</span>
                                ) : '-'}
                              </td>
                            </>
                          );

                          if (showBookerHeader) {
                            const bookerName = `${group.booker.first_name || ''} ${group.booker.last_name || ''}`.trim();
                            const headerKey = group.groupRef || group.attendees[0].id;
                            rows.push(
                              <tr
                                key={`${headerKey}-booker-header`}
                                className="border-t bg-muted/30"
                                style={{ borderTopWidth: '2px' }}
                                data-testid={`row-booker-header-${headerKey}`}
                              >
                                <td className="py-2 pr-1"></td>
                                <td className="py-2 pr-3">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                      {group.attendeeCount}
                                    </Badge>
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                      Booker
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">
                                      Booked by{' '}
                                      <span className="font-medium text-foreground">
                                        {bookerName || 'Unknown'}
                                      </span>
                                      {group.booker.email ? (
                                        <span className="ml-1">({group.booker.email})</span>
                                      ) : null}
                                    </span>
                                  </div>
                                </td>
                                {renderEventCells(headerKey)}
                                <td className="py-2 pr-3"></td>
                                <td className="py-2 pr-3"></td>
                                <td className="py-2 pr-3"></td>
                                <td className="py-2 pr-3 text-right whitespace-nowrap"></td>
                                {renderPaymentCells(headerKey)}
                                <td className="py-2 pr-3"></td>
                                <td className="py-2 pr-3"></td>
                                <td className="py-2 pr-3"></td>
                                <td className="py-2 pr-3"></td>
                                <td className="py-2 pr-3"></td>
                                {showAttendanceColumn && <td className="py-2"></td>}
                              </tr>
                            );
                          }

                          group.attendees.forEach((attendee, idx) => {
                            const isFirst = idx === 0;
                            const isLast = idx === group.attendees.length - 1;
                            const isFirstRowInGroup = isFirst && !showBookerHeader;
                            const renderGroupSpannedCells = isFirst && !showBookerHeader;
                            const orgName = organizations[attendee.organization_id] || null;
                            const isGuest = attendee.is_guest_booking || (!attendee.organization_id && !attendee.member_id);

                            rows.push(
                              <tr
                                key={attendee.id}
                                className={`${isLast ? 'border-b' : ''} ${isFirstRowInGroup ? 'border-t' : ''}`}
                                style={isFirstRowInGroup ? { borderTopWidth: '2px' } : undefined}
                                data-testid={`row-booking-${attendee.id}`}
                              >
                                <td className="py-2 pr-1">
                                  {renderActionIcons(attendee)}
                                </td>
                                <td className="py-2 pr-3">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {isFirst && !showBookerHeader && (
                                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                        {group.attendeeCount}
                                      </Badge>
                                    )}
                                    {attendee.is_booker && group.isGroup && (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0" data-testid={`badge-booker-${attendee.id}`}>
                                        Booker
                                      </Badge>
                                    )}
                                    <div>
                                      <div className="font-medium whitespace-nowrap">
                                        {`${attendee.attendee_first_name || ''} ${attendee.attendee_last_name || ''}`.trim() || 'Unknown'}
                                      </div>
                                      <div className="text-xs text-muted-foreground">{attendee.attendee_email}</div>
                                      {renderFlagBadges(attendee)}
                                    </div>
                                  </div>
                                </td>
                                {renderGroupSpannedCells ? renderEventCells(attendee.id) : null}
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
                                {renderGroupSpannedCells ? renderPaymentCells(attendee.id) : null}
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
                                <td className="py-2 pr-3 whitespace-nowrap">
                                  {renderDesignationCell(attendee, group.eventId)}
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap" data-testid={`cell-buddy-${attendee.id}`}>
                                  {renderBuddyCell(attendee, group.eventId)}
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap" data-testid={`cell-badge-${attendee.id}`}>
                                  {renderBadgeCell(attendee, group.eventId)}
                                </td>
                                <td className="py-2 pr-3 align-top">
                                  {renderOptionsCell(attendee)}
                                </td>
                                {showAttendanceColumn && (
                                  <td className="py-2 whitespace-nowrap" data-testid={`text-attended-${attendee.id}`}>
                                    {group.hasAttendance ? renderAttendanceCell(attendee) : <span className="text-muted-foreground">-</span>}
                                  </td>
                                )}
                              </tr>
                            );
                          });

                          return rows;
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

      <Dialog open={showColumnChooser} onOpenChange={setShowColumnChooser}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Choose Export Columns</DialogTitle>
            <DialogDescription>
              Select the columns to include in the CSV export. All columns are selected by default.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedColumnKeys(new Set(allColumnKeys))}
              data-testid="button-select-all-columns"
            >
              Select all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedColumnKeys(new Set())}
              data-testid="button-clear-all-columns"
            >
              Clear all
            </Button>
          </div>
          <ScrollArea className="max-h-[55vh] pr-4">
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium mb-2">Standard Columns</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {standardColumns.map(col => (
                    <label
                      key={col.key}
                      className="flex items-center gap-2 rounded-md p-2 hover-elevate cursor-pointer"
                      data-testid={`label-column-${col.key}`}
                    >
                      <Checkbox
                        checked={selectedColumnKeys.has(col.key)}
                        onCheckedChange={() => toggleColumn(col.key)}
                        data-testid={`checkbox-column-${col.key}`}
                      />
                      <span className="text-sm">{col.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              {linkedColumnsByForm.filter(grp => grp.columns.length > 0).map(grp => (
                <div key={grp.formId}>
                  <h4 className="text-sm font-medium mb-2">
                    {grp.formName} <span className="text-muted-foreground font-normal">(linked form)</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {grp.columns.map(col => (
                      <label
                        key={col.key}
                        className="flex items-center gap-2 rounded-md p-2 hover-elevate cursor-pointer"
                        data-testid={`label-column-${col.key}`}
                      >
                        <Checkbox
                          checked={selectedColumnKeys.has(col.key)}
                          onCheckedChange={() => toggleColumn(col.key)}
                          data-testid={`checkbox-column-${col.key}`}
                        />
                        <span className="text-sm">{col.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowColumnChooser(false)}
              data-testid="button-cancel-export"
            >
              Cancel
            </Button>
            <Button
              className="gap-2"
              onClick={runExport}
              disabled={selectedColumnKeys.size === 0}
              data-testid="button-confirm-export"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
