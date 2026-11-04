import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Copy,
  ExternalLink,
  Edit2,
  ArchiveRestore,
  Trash2,
  Search,
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import AssignmentVersionNotice from "./AssignmentVersionNotice";
import SurveyLifecycleDialog from "./SurveyLifecycleDialog";
import SurveyAvailabilityBadge from "./SurveyAvailabilityBadge";
import { assignmentIsRemoved } from "@/lib/surveyLifecycle";

const ENDPOINT = "/api/surveys/event-assignments";

function formatDate(value, withTime = false) {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return withTime ? d.toLocaleString() : d.toLocaleDateString();
  } catch {
    return "—";
  }
}

// Convert an ISO string to a value usable by <input type="datetime-local">
function toDateTimeLocal(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

// Convert a datetime-local value back to an ISO string (or null when empty)
function fromDateTimeLocal(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isEventDeleted(row) {
  return row.event_id == null && row.complex_event_id == null;
}

export default function SurveyEventAssignmentsPanel({ formId }) {
  const [lifecycleRequest, setLifecycleRequest] = useState(null);
  const queryClient = useQueryClient();
  const listQueryKey = ["event-survey-assignments", formId];

  const {
    data: assignments = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: listQueryKey,
    queryFn: () =>
      base44.entities.EventSurveyAssignment.filter({ form_id: formId }, "-created_date"),
    enabled: !!formId,
  });

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: listQueryKey });

  // ---- Edit dialog state ----
  const [editRow, setEditRow] = useState(null);
  const [editOpensAt, setEditOpensAt] = useState("");
  const [editClosesAt, setEditClosesAt] = useState("");
  const [editAccessMode, setEditAccessMode] = useState("public");

  const openEdit = (row) => {
    setEditRow(row);
    setEditOpensAt(toDateTimeLocal(row.opens_at));
    setEditClosesAt(toDateTimeLocal(row.closes_at));
    setEditAccessMode(row.access_mode || "public");
  };

  const handleSaveEdit = () => {
    if (!editRow) return;
    const changes = {
      opens_at: fromDateTimeLocal(editOpensAt),
      closes_at: fromDateTimeLocal(editClosesAt),
      access_mode: editAccessMode,
    };
    if (changes.opens_at && changes.closes_at && Date.parse(changes.closes_at) <= Date.parse(changes.opens_at)) {
      toast.error("The closing date must be after the opening date.");
      return;
    }
    // Identical proposed settings are bound to preview and execution.
    setLifecycleRequest({ form_id: formId, assignment_id: editRow.id, action: "update_assignment", changes });
    setEditRow(null);
  };

  // ---- Copy link ----
  const handleCopy = (token) => {
    const url = `${window.location.origin}/survey/${token}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success("Assignment link copied"),
      () => toast.error("Failed to copy link")
    );
  };

  // ---- Assign dialog ----
  const [assignOpen, setAssignOpen] = useState(false);

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex min-w-0 flex-col items-start justify-between gap-4 md:flex-row">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-slate-900">Event Assignments</h3>
          <p className="text-sm text-slate-500">
            Event relationships and responses are retained when removed. Availability also depends on the survey lifecycle and the original response window.
          </p>
        </div>
        <Button
          onClick={() => setAssignOpen(true)}
          className="w-full shrink-0 bg-blue-600 hover:bg-blue-700 md:w-auto"
          data-testid="button-assign-event"
        >
          <Plus className="w-4 h-4 mr-2" />
          Assign to event
        </Button>
      </div>

      <div className="min-w-0 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              Loading assignments...
            </div>
          ) : isError ? (
            <div className="py-12 text-center text-red-600">Failed to load assignments.</div>
          ) : assignments.length === 0 ? (
            <div className="py-12 text-center text-slate-500">
              No events assigned yet. Click “Assign to event” to get started.
            </div>
          ) : (
            <div className="min-w-0 space-y-4">
                {assignments.map((row) => {
                  const deleted = isEventDeleted(row);
                  const eventUrl = row.event_type === "complex_event"
                    ? `${createPageUrl("CreateComplexEvent")}?id=${row.complex_event_id}`
                    : `${createPageUrl("EditEvent")}?id=${row.event_id}`;
                  return (
                    <Card key={row.id} className="min-w-0 border-slate-200" data-testid={`assignment-row-${row.id}`}>
                      <CardContent className="min-w-0 space-y-5 p-4 [overflow-wrap:anywhere] sm:p-5">
                      <div className="min-w-0 space-y-2">
                        <h4 className="text-base font-semibold leading-snug text-slate-900">
                          {row.event_title || "(untitled event)"}
                          {deleted && (
                            <span className="ml-1 text-xs text-red-500">(event deleted)</span>
                          )}
                        </h4>
                        <div className="text-sm text-slate-500">Event date: {formatDate(row.event_start_date)}</div>
                        {!deleted && (
                          <Button asChild variant="link" size="sm" className="h-auto p-0 text-blue-600">
                            <Link to={eventUrl}>View event</Link>
                          </Button>
                        )}
                      </div>

                      <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-5 border-t border-slate-100 pt-4 md:grid-cols-2">
                        <div className="min-w-0">
                          <dt className="mb-2 text-xs font-semibold text-slate-500">Relationship / availability</dt>
                          <dd className="min-w-0 [&_span]:whitespace-normal">
                            <SurveyAvailabilityBadge assignment={row} />
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="mb-2 text-xs font-semibold text-slate-500">Response window</dt>
                          <dd className="space-y-1 text-sm text-slate-600">
                            <div>Opens: {formatDate(row.opens_at, true)}</div>
                            <div>Closes: {formatDate(row.closes_at, true)}</div>
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="mb-2 text-xs font-semibold text-slate-500">Access</dt>
                          <dd className="text-sm text-slate-600">
                            {row.access_mode === "authenticated" ? "Members only" : "Public link"}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="mb-2 text-xs font-semibold text-slate-500">Responses</dt>
                          <dd className="space-y-1 text-sm text-slate-600">
                        {row.response_count > 0 ? (
                          <Link
                            to={`${createPageUrl("FormSubmissions")}?form=${row.form_id}&assignment=${row.id}`}
                            className="inline-block font-medium text-blue-600 hover:underline"
                            data-testid={`link-responses-${row.id}`}
                          >
                            {row.response_count}
                          </Link>
                        ) : (
                          <div className="font-medium text-slate-900">0</div>
                        )}
                        {row.response_count > 0 && (
                          <>
                            <div>First: {formatDate(row.first_response_at, true)}</div>
                            <div>Last: {formatDate(row.last_response_at, true)}</div>
                          </>
                        )}
                          </dd>
                        </div>
                      </dl>

                      <section className="min-w-0 space-y-2 [&_span]:whitespace-normal" aria-label="Survey version">
                        <h5 className="text-xs font-semibold text-slate-500">Survey version</h5>
                        <AssignmentVersionNotice assignment={row} />
                      </section>

                      <div className="min-w-0 space-y-3 border-t border-slate-200 pt-4">
                        <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Assignment actions">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCopy(row.token)}
                            title="Copy assignment link"
                            data-testid={`button-copy-${row.id}`}
                          >
                            <Copy className="mr-2 h-4 w-4 shrink-0" />
                            Copy link
                          </Button>
                          <Button asChild variant="outline" size="sm">
                            <a
                              href={`${window.location.origin}/survey/${row.token}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open assignment link"
                            >
                              <ExternalLink className="mr-2 h-4 w-4 shrink-0" />
                              Open survey
                            </a>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEdit(row)}
                            title="Edit"
                            data-testid={`button-edit-${row.id}`}
                          >
                            <Edit2 className="mr-2 h-4 w-4 shrink-0" />
                            Edit
                          </Button>
                        </div>
                        <div className="border-t border-slate-100 pt-3" aria-label="Event relationship actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            className={`h-auto max-w-full whitespace-normal text-left ${assignmentIsRemoved(row) ? "text-slate-700" : "text-red-600 hover:text-red-700"}`}
                            onClick={() => setLifecycleRequest({ form_id: formId, assignment_id: row.id, action: assignmentIsRemoved(row) ? "reattach_assignment" : "remove_assignment" })}
                            title={assignmentIsRemoved(row) ? "Reattach to Event" : "Remove from Event"}
                            data-testid={`button-${assignmentIsRemoved(row) ? "reattach" : "remove"}-${row.id}`}
                          >
                            {assignmentIsRemoved(row) ? (
                              <ArchiveRestore className="w-4 h-4 shrink-0" />
                            ) : (
                              <Trash2 className="w-4 h-4 shrink-0" />
                            )}
                            <span className="ml-1.5">{assignmentIsRemoved(row) ? "Reattach to Event" : "Remove from Event"}</span>
                          </Button>
                        </div>
                      </div>
                      </CardContent>
                    </Card>
                  );
                })}
            </div>
          )}
      </div>

      <SurveyLifecycleDialog request={lifecycleRequest} onClose={() => setLifecycleRequest(null)} onComplete={invalidateList} />
      {/* Edit dialog */}
      <Dialog open={!!editRow} onOpenChange={(open) => !open && setEditRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit assignment</DialogTitle>
            <DialogDescription>{editRow?.event_title} · Date and access changes require an impact review before they are applied.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Opens at</Label>
              <Input
                type="datetime-local"
                value={editOpensAt}
                onChange={(e) => setEditOpensAt(e.target.value)}
                data-testid="input-edit-opens-at"
              />
            </div>
            <div className="space-y-2">
              <Label>Closes at</Label>
              <Input
                type="datetime-local"
                value={editClosesAt}
                onChange={(e) => setEditClosesAt(e.target.value)}
                data-testid="input-edit-closes-at"
              />
            </div>
            <div className="space-y-2">
              <Label>Access mode</Label>
              <Select value={editAccessMode} onValueChange={setEditAccessMode}>
                <SelectTrigger data-testid="select-edit-access-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public link</SelectItem>
                  <SelectItem value="authenticated">Members only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              className="bg-blue-600 hover:bg-blue-700"
              data-testid="button-save-edit"
            >
              Review impact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign dialog */}
      <AssignEventDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        formId={formId}
        onAssigned={invalidateList}
      />
    </div>
  );
}

function AssignEventDialog({ open, onOpenChange, formId, onAssigned }) {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState(null); // { type, id, title, date }
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [accessMode, setAccessMode] = useState("public");

  const resetState = () => {
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setSelected(null);
    setOpensAt("");
    setClosesAt("");
    setAccessMode("public");
  };

  const { data: simpleEvents = [], isLoading: loadingSimple } = useQuery({
    queryKey: ["assign-events-simple"],
    queryFn: () => base44.entities.Event.list("-start_date"),
    enabled: open,
  });

  const { data: complexEvents = [], isLoading: loadingComplex } = useQuery({
    queryKey: ["assign-events-complex"],
    queryFn: () => base44.entities.ComplexEvent.list("-start_date"),
    enabled: open,
  });

  const loading = loadingSimple || loadingComplex;

  const merged = useMemo(() => {
    const rows = [];
    (simpleEvents || []).forEach((e) => {
      rows.push({
        type: "event",
        typeLabel: "Simple",
        id: e.id,
        title: e.title || "(untitled)",
        date: e.start_date || null,
        venue: e.location || e.venue || "",
      });
    });
    (complexEvents || []).forEach((e) => {
      rows.push({
        type: "complex_event",
        typeLabel: "Complex",
        id: e.id,
        title: e.title || "(untitled)",
        date: e.start_date || null,
        venue: e.location || e.venue || "",
      });
    });
    return rows;
  }, [simpleEvents, complexEvents]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = dateFrom ? new Date(dateFrom).getTime() : null;
    const toTs = dateTo ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 - 1 : null;
    return merged.filter((row) => {
      if (q && !row.title.toLowerCase().includes(q)) return false;
      if ((fromTs != null || toTs != null)) {
        if (!row.date) return false;
        const ts = new Date(row.date).getTime();
        if (fromTs != null && ts < fromTs) return false;
        if (toTs != null && ts > toTs) return false;
      }
      return true;
    });
  }, [merged, search, dateFrom, dateTo]);

  const assignMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          form_id: formId,
          event_type: selected.type,
          event_id: selected.id,
          opens_at: fromDateTimeLocal(opensAt),
          closes_at: fromDateTimeLocal(closesAt),
          access_mode: accessMode,
        }),
      });
      if (!res.ok) {
        let payload = {};
        try {
          payload = await res.json();
        } catch {}
        const error = new Error(payload.error || payload.message || "Failed to assign event");
        error.status = res.status;
        throw error;
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Survey assigned to event");
      onAssigned?.();
      resetState();
      onOpenChange(false);
    },
    onError: (err) => {
      if (err.status === 409) {
        toast.error("This survey is already actively assigned to that event.");
      } else {
        toast.error(err.message || "Failed to assign event");
      }
    },
  });

  const handleOpenChange = (next) => {
    if (!next) resetState();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assign to event</DialogTitle>
          <DialogDescription>
            Search for an event and configure how respondents can access the survey.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1 sm:col-span-1">
              <Label className="text-xs">Search title</Label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Event title..."
                  className="pl-8"
                  data-testid="input-event-search"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">From date</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                data-testid="input-event-date-from"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To date</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                data-testid="input-event-date-to"
              />
            </div>
          </div>

          <div className="border border-slate-200 rounded-md max-h-64 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-slate-500">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading events...
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center text-slate-500 text-sm">No events found.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {filtered.map((row) => {
                  const isSelected =
                    selected && selected.type === row.type && selected.id === row.id;
                  return (
                    <li key={`${row.type}-${row.id}`}>
                      <button
                        type="button"
                        onClick={() => setSelected(row)}
                        className={`w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between ${
                          isSelected ? "bg-blue-50" : ""
                        }`}
                        data-testid={`event-option-${row.id}`}
                      >
                        <div>
                          <div className="font-medium text-slate-900 text-sm">{row.title}</div>
                          <div className="text-xs text-slate-500">
                            {formatDate(row.date)}
                            {row.venue ? ` · ${row.venue}` : ""}
                          </div>
                        </div>
                        <Badge variant="outline">{row.typeLabel}</Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selected && (
            <div className="border border-slate-200 rounded-md p-3 space-y-3 bg-slate-50">
              <div className="text-sm font-medium text-slate-900">
                Selected: {selected.title}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Opens at (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={opensAt}
                    onChange={(e) => setOpensAt(e.target.value)}
                    data-testid="input-assign-opens-at"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Closes at (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={closesAt}
                    onChange={(e) => setClosesAt(e.target.value)}
                    data-testid="input-assign-closes-at"
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Access mode</Label>
                  <Select value={accessMode} onValueChange={setAccessMode}>
                    <SelectTrigger data-testid="select-assign-access-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">Public link</SelectItem>
                      <SelectItem value="authenticated">Members only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => assignMutation.mutate()}
            disabled={!selected || assignMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-confirm-assign"
          >
            {assignMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
