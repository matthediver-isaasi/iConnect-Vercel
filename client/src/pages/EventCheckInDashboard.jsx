import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { CheckCircle2, UserMinus, Search, Loader2, Users } from "lucide-react";

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
      if (search.trim()) params.set("search", search.trim());
      if (trackFilter !== "all") params.set("trackId", trackFilter);
      if (sessionFilter !== "all") params.set("sessionId", sessionFilter);
      const res = await apiRequest("GET", `/api/admin/event-checkin?${params.toString()}`);
      setData(res.data);
    } catch (err) {
      toast({ title: "Failed to load attendees", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [selectedEventId, selectedEventType, search, trackFilter, sessionFilter, toast]);

  useEffect(() => {
    if (selectedEventId) loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId, selectedEventType, trackFilter, sessionFilter]);

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

  const attendees = data?.attendees || [];

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
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 rounded-md border px-3 py-2" data-testid="stat-attended">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">
                  <span className="font-semibold">{data.counts.attended}</span>
                  <span className="text-muted-foreground"> / {data.counts.total} checked in</span>
                </span>
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
                  onKeyDown={(e) => e.key === "Enter" && loadDashboard()}
                  data-testid="input-search"
                />
              </div>
              <Button variant="outline" onClick={loadDashboard} data-testid="button-search">Search</Button>

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
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                    data-testid={`row-attendee-${a.token}`}
                  >
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
                    <div className="flex items-center gap-2">
                      {a.checked_in_at ? (
                        <>
                          <Badge variant="secondary" className="gap-1">
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
                        <Button
                          size="sm"
                          onClick={() => handleMark(a.token)}
                          disabled={busyToken === a.token || !a.token}
                          data-testid={`button-checkin-${a.token}`}
                        >
                          {busyToken === a.token ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          Check in
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
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
