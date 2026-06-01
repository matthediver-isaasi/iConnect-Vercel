import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { apiRequest } from "@/lib/queryClient";
import { createPageUrl } from "@/utils";
import { CheckCircle2, UserMinus, Search, Loader2, Users, ChevronLeft, ChevronRight, Circle } from "lucide-react";

const PAGE_SIZE = 25;

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function getInitials(first, last, email) {
  const a = (first || "").trim();
  const b = (last || "").trim();
  if (a || b) return `${a.charAt(0)}${b.charAt(0)}`.toUpperCase() || "?";
  return (email || "?").charAt(0).toUpperCase();
}

export default function EventCheckInDashboard() {
  const { toast } = useToast();
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const tenantId = memberInfo?.tenant_id;

  const [events, setEvents] = useState([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedEventType, setSelectedEventType] = useState("simple");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all"); // "all" | "checked-in"
  const [page, setPage] = useState(1);
  const [trackFilter, setTrackFilter] = useState("all");
  const [sessionFilter, setSessionFilter] = useState("all");
  const [busyToken, setBusyToken] = useState(null);
  const [deregisterTarget, setDeregisterTarget] = useState(null);
  const [deregisterReason, setDeregisterReason] = useState("");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("page_EventCheckInDashboard")) {
        window.location.href = createPageUrl("Dashboard");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const loadEvents = useCallback(async () => {
    try {
      const res = await apiRequest("GET", "/api/admin/event-checkin?action=events");
      setEvents(res.data || []);
    } catch (err) {
      toast({ title: "Failed to load events", description: err.message, variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => {
    if (accessChecked) loadEvents();
  }, [accessChecked, loadEvents]);

  const loadDashboard = useCallback(async () => {
    if (!selectedEventId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        eventId: selectedEventId,
        eventType: selectedEventType,
      });
      if (trackFilter !== "all") params.set("trackId", trackFilter);
      if (sessionFilter !== "all") params.set("sessionId", sessionFilter);
      const res = await apiRequest("GET", `/api/admin/event-checkin?${params.toString()}`);
      setData(res.data);
    } catch (err) {
      toast({ title: "Failed to load attendees", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [selectedEventId, selectedEventType, trackFilter, sessionFilter, toast]);

  useEffect(() => {
    if (selectedEventId) loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId, selectedEventType, trackFilter, sessionFilter]);

  // Reset to the first page whenever the view or search changes.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, trackFilter, sessionFilter, selectedEventId]);

  // Keep the page in range if the list shrinks (e.g. after a deregister or a
  // realtime update reduces how many rows match the current filters).
  const matchingCount = (data?.attendees || []).filter((a) => {
    if (statusFilter === "checked-in" && !a.checked_in_at) return false;
    if (!search.trim()) return true;
    const t = search.trim().toLowerCase();
    return [a.first_name, a.last_name, a.email, a.booking_reference, a.session_title]
      .filter(Boolean)
      .some((v) => v.toLowerCase().includes(t));
  }).length;
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(matchingCount / PAGE_SIZE));
    setPage((p) => Math.min(p, maxPage));
  }, [matchingCount]);

  // Live updates: refresh the attendee list/counts as scans (and un-scans)
  // happen anywhere, scoped to this tenant and the selected event. The hook
  // tears down + re-subscribes automatically when the selected event changes.
  useRealtimeSubscription("booking", [], {
    enabled: !!tenantId && !!selectedEventId && selectedEventType === "simple",
    tenantId,
    predicate: (payload) => {
      const row = payload?.new || payload?.old || {};
      return row.event_id === selectedEventId;
    },
    onEvent: () => loadDashboard(),
  });

  useRealtimeSubscription("complex_event_session_checkin", [], {
    enabled: !!tenantId && !!selectedEventId && selectedEventType === "complex",
    tenantId,
    predicate: (payload) => {
      const row = payload?.new || payload?.old || {};
      return row.complex_event_id === selectedEventId;
    },
    onEvent: () => loadDashboard(),
  });

  const handleSelectEvent = (value) => {
    const ev = events.find((e) => e.id === value);
    setSelectedEventId(value);
    setSelectedEventType(ev?.type || "simple");
    setTrackFilter("all");
    setSessionFilter("all");
    setSearch("");
    setStatusFilter("all");
    setPage(1);
    setData(null);
  };

  const handleMark = async (token) => {
    setBusyToken(token);
    try {
      await apiRequest("POST", "/api/admin/event-checkin", { action: "mark", token });
      await loadDashboard();
    } catch (err) {
      toast({ title: "Check-in failed", description: err.message, variant: "destructive" });
    } finally {
      setBusyToken(null);
    }
  };

  const openDeregister = (attendee) => {
    setDeregisterTarget(attendee);
    setDeregisterReason("");
  };

  const closeDeregister = () => {
    setDeregisterTarget(null);
    setDeregisterReason("");
  };

  const handleDeregister = async () => {
    if (!deregisterTarget) return;
    const token = deregisterTarget.token;
    const reason = deregisterReason.trim();
    if (!reason) {
      toast({ title: "A reason is required", description: "Please enter why you are deregistering this attendee.", variant: "destructive" });
      return;
    }
    setBusyToken(token);
    try {
      await apiRequest("POST", "/api/admin/event-checkin", { action: "undo", token, reason });
      toast({ title: "Attendee deregistered", description: "Their check-in has been undone." });
      closeDeregister();
      await loadDashboard();
    } catch (err) {
      toast({ title: "Deregister failed", description: err.message, variant: "destructive" });
    } finally {
      setBusyToken(null);
    }
  };

  const deregisterName = deregisterTarget
    ? [deregisterTarget.first_name, deregisterTarget.last_name].filter(Boolean).join(" ") || deregisterTarget.email
    : "";

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const allAttendees = data?.attendees || [];
  const term = search.trim().toLowerCase();
  const filteredAttendees = allAttendees.filter((a) => {
    if (statusFilter === "checked-in" && !a.checked_in_at) return false;
    if (!term) return true;
    return [a.first_name, a.last_name, a.email, a.booking_reference, a.session_title]
      .filter(Boolean)
      .some((v) => v.toLowerCase().includes(term));
  });

  const totalFiltered = filteredAttendees.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const attendees = filteredAttendees.slice(pageStart, pageStart + PAGE_SIZE);
  const rangeStart = totalFiltered === 0 ? 0 : pageStart + 1;
  const rangeEnd = Math.min(pageStart + PAGE_SIZE, totalFiltered);

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">Event Check-In</h1>
        <p className="text-sm text-muted-foreground">Track attendance for in-person events at the door.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Select an event</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select value={selectedEventId} onValueChange={handleSelectEvent}>
            <SelectTrigger data-testid="select-event">
              <SelectValue placeholder="Choose an in-person event" />
            </SelectTrigger>
            <SelectContent>
              {events.map((e) => (
                <SelectItem key={e.id} value={e.id} data-testid={`option-event-${e.id}`}>
                  {e.title}{e.type === "complex" ? " (multi-session)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {data && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-md border bg-green-50 px-3 py-2 dark:bg-green-950/30 dark:border-green-900" data-testid="stat-attended">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-300">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Checked in
                  </div>
                  <div className="mt-0.5 text-2xl font-semibold tabular-nums text-green-700 dark:text-green-200">
                    {data.counts.attended}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" data-testid="stat-registered">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Users className="h-3.5 w-3.5" /> Registered
                  </div>
                  <div className="mt-0.5 text-2xl font-semibold tabular-nums">
                    {data.counts.total}
                  </div>
                </div>
                <div className="col-span-2 rounded-md border px-3 py-2 sm:col-span-1" data-testid="stat-remaining">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Circle className="h-3.5 w-3.5" /> Yet to arrive
                  </div>
                  <div className="mt-0.5 text-2xl font-semibold tabular-nums">
                    {Math.max(0, data.counts.total - data.counts.attended)}
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <Progress
                  value={data.counts.total ? (data.counts.attended / data.counts.total) * 100 : 0}
                  className="h-2"
                  data-testid="progress-attendance"
                />
                <p className="text-xs text-muted-foreground">
                  {data.counts.total
                    ? `${Math.round((data.counts.attended / data.counts.total) * 100)}% of registrants checked in`
                    : "No registrants yet"}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedEventId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attendees</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search name, email or reference"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="input-search"
                />
              </div>

              <div className="flex items-center gap-1 rounded-md border p-1" role="group" aria-label="Filter attendees">
                <Button
                  size="sm"
                  variant={statusFilter === "all" ? "secondary" : "ghost"}
                  onClick={() => setStatusFilter("all")}
                  data-testid="button-filter-all"
                >
                  All registrants
                </Button>
                <Button
                  size="sm"
                  variant={statusFilter === "checked-in" ? "secondary" : "ghost"}
                  onClick={() => setStatusFilter("checked-in")}
                  data-testid="button-filter-checked-in"
                >
                  Checked in
                </Button>
              </div>

              {selectedEventType === "complex" && data?.tracks?.length > 0 && (
                <Select value={trackFilter} onValueChange={setTrackFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-track">
                    <SelectValue placeholder="All tracks" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All tracks</SelectItem>
                    {data.tracks.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {selectedEventType === "complex" && data?.sessions?.length > 0 && (
                <Select value={sessionFilter} onValueChange={setSessionFilter}>
                  <SelectTrigger className="w-[200px]" data-testid="select-session">
                    <SelectValue placeholder="All sessions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sessions</SelectItem>
                    {data.sessions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : attendees.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-10" data-testid="text-empty">
                No attendees found.
              </div>
            ) : (
              <div className="space-y-2">
                {attendees.map((a) => (
                  <div
                    key={a.token || `${a.bookingId}-${a.sessionId || ""}`}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 transition-colors ${
                      a.checked_in_at
                        ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30"
                        : "bg-card"
                    }`}
                    data-testid={`row-attendee-${a.token}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar className="h-9 w-9 shrink-0">
                        <AvatarFallback
                          className={
                            a.checked_in_at
                              ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-100"
                              : "bg-muted text-muted-foreground"
                          }
                        >
                          {getInitials(a.first_name, a.last_name, a.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {[a.first_name, a.last_name].filter(Boolean).join(" ") || a.email}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {a.email}
                          {a.booking_reference ? ` · ${a.booking_reference}` : ""}
                        </div>
                        {selectedEventType === "complex" && (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className="text-xs text-muted-foreground">{a.session_title}</span>
                            {a.track_name && <Badge variant="secondary">{a.track_name}</Badge>}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {a.checked_in_at ? (
                        <>
                          <Badge className="gap-1 border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-900 dark:text-green-100">
                            <CheckCircle2 className="h-3 w-3" /> {formatDate(a.checked_in_at)}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openDeregister(a)}
                            disabled={busyToken === a.token}
                            data-testid={`button-deregister-${a.token}`}
                          >
                            {busyToken === a.token ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserMinus className="h-4 w-4" />}
                            Deregister
                          </Button>
                        </>
                      ) : (
                        <>
                          <Badge variant="outline" className="gap-1 text-muted-foreground">
                            <Circle className="h-3 w-3" /> Not checked in
                          </Badge>
                          <Button
                            size="sm"
                            onClick={() => handleMark(a.token)}
                            disabled={(!!busyToken && busyToken === a.token) || !a.token}
                            data-testid={`button-checkin-${a.token}`}
                          >
                            {!!busyToken && busyToken === a.token ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            Check in
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loading && totalFiltered > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <span className="text-sm text-muted-foreground" data-testid="text-pagination-range">
                  Showing {rangeStart}–{rangeEnd} of {totalFiltered}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage <= 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground" data-testid="text-page-indicator">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage >= totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!deregisterTarget} onOpenChange={(open) => { if (!open) closeDeregister(); }}>
        <DialogContent data-testid="dialog-deregister">
          <DialogHeader>
            <DialogTitle>Deregister attendee</DialogTitle>
            <DialogDescription>
              This undoes the check-in for{deregisterName ? ` ${deregisterName}` : " this attendee"} and returns them to
              "not checked in". It does not cancel their booking or trigger any refunds or emails.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="deregister-reason">Reason</Label>
            <Textarea
              id="deregister-reason"
              placeholder="e.g. Scanned in error / wrong ticket"
              value={deregisterReason}
              onChange={(e) => setDeregisterReason(e.target.value)}
              data-testid="input-deregister-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDeregister} data-testid="button-deregister-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleDeregister}
              disabled={!deregisterReason.trim() || busyToken === deregisterTarget?.token}
              data-testid="button-deregister-confirm"
            >
              {busyToken === deregisterTarget?.token ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserMinus className="h-4 w-4" />
              )}
              Deregister
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
