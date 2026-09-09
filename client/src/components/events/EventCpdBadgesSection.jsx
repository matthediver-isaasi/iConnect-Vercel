import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Award, CheckCircle2, Info, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CPD_TRIGGER_ATTENDANCE,
  CPD_TRIGGER_REGISTRATION,
  emptyEventCpdBadgeConfig,
  normalizeEventCpdBadgeConfig,
  ticketStableReference,
  attendanceCapabilityWarnings,
  canonicalEventCpdBadgeConfig,
} from "@/lib/eventCpdBadgeRules";

const INHERIT = "__inherit__";
const NO_AWARD = "__no_award__";

function RuleFields({ rule, badges, onChange, allowNoAward = false, noAwardTrigger, testId }) {
  const badgeValue = rule?.no_award ? NO_AWARD : (rule?.badge_id || INHERIT);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs">Badge</Label>
        <Select value={badgeValue} onValueChange={(value) => {
          if (value === INHERIT) onChange(null);
          else if (value === NO_AWARD) onChange({ badge_id: null, trigger: noAwardTrigger || rule?.trigger || CPD_TRIGGER_REGISTRATION, no_award: true });
          else onChange({ badge_id: value, trigger: rule?.trigger || CPD_TRIGGER_REGISTRATION, no_award: false });
        }}>
          <SelectTrigger data-testid={`${testId}-badge`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{allowNoAward ? "Use event-wide rule" : "No event-wide badge"}</SelectItem>
            {allowNoAward && <SelectItem value={NO_AWARD}>Award no badge</SelectItem>}
            {badges.map((badge) => <SelectItem key={badge.id} value={badge.id}>{badge.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Award when</Label>
        <Select
          disabled={!rule || rule.no_award}
          value={rule?.trigger || CPD_TRIGGER_REGISTRATION}
          onValueChange={(trigger) => onChange({ ...rule, trigger })}
        >
          <SelectTrigger data-testid={`${testId}-trigger`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={CPD_TRIGGER_REGISTRATION}>Registration is confirmed</SelectItem>
            <SelectItem value={CPD_TRIGGER_ATTENDANCE}>Attendance is verified</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export default function EventCpdBadgesSection({ eventId = null, eventType, tickets = [], value, onChange }) {
  const config = value || emptyEventCpdBadgeConfig();
  const [badges, setBadges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attendanceCapabilities, setAttendanceCapabilities] = useState(null);
  const [syncState, setSyncState] = useState({ checking: false, open: false, running: false, message: "", error: "" });
  const [syncStatus, setSyncStatus] = useState({ loading: false, error: "", data: null });

  const refreshSyncStatus = useCallback(async () => {
    if (!eventId) {
      setSyncStatus({ loading: false, error: "", data: null });
      return;
    }
    setSyncStatus((state) => ({ ...state, loading: true, error: "" }));
    try {
      const query = new URLSearchParams({ event_type: eventType, event_id: eventId });
      const response = await fetch(`/api/admin/event-cpd-badge-replay?${query}`, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load badge sync status");
      setSyncStatus({ loading: false, error: "", data: data.sync || null });
    } catch (err) {
      setSyncStatus((state) => ({ ...state, loading: false, error: err.message }));
    }
  }, [eventId, eventType]);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ event_type: eventType });
    if (eventId) query.set("event_id", eventId);
    setLoading(true);
    fetch(`/api/admin/event-cpd-badge-rules?${query}`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Failed to load CPD badges");
        if (cancelled) return;
        setBadges(data.badges || []);
        setAttendanceCapabilities(data.attendance_capabilities || null);
        if (eventId) onChange(normalizeEventCpdBadgeConfig(data.rules));
        setError("");
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eventId, eventType]); // Deliberately hydrate only when the target event changes.

  useEffect(() => {
    refreshSyncStatus();
  }, [refreshSyncStatus]);

  const updateTicketRule = (reference, rule) => {
    const nextRules = { ...(config.ticketRules || {}) };
    if (rule) nextRules[reference] = rule;
    else delete nextRules[reference];
    onChange({ ...config, ticketRules: nextRules });
  };

  const checkBeforeSync = async () => {
    if (!eventId || syncState.checking || syncState.running) return;
    setSyncState((state) => ({ ...state, checking: true, message: "", error: "" }));
    try {
      const query = new URLSearchParams({ event_type: eventType, event_id: eventId });
      const response = await fetch(`/api/admin/event-cpd-badge-rules?${query}`, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to check saved badge rules");
      const saved = normalizeEventCpdBadgeConfig(data.rules);
      if (canonicalEventCpdBadgeConfig(saved) !== canonicalEventCpdBadgeConfig(config)) {
        setSyncState((state) => ({
          ...state, checking: false,
          error: "Save your badge rule changes before syncing. The sync always uses the last saved rules.",
        }));
        return;
      }
      setSyncState((state) => ({ ...state, checking: false, open: true }));
    } catch (err) {
      setSyncState((state) => ({ ...state, checking: false, error: err.message }));
    }
  };

  const runSync = async () => {
    setSyncState((state) => ({ ...state, open: false, running: true, message: "", error: "" }));
    try {
      const response = await fetch("/api/admin/event-cpd-badge-replay", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId, event_type: eventType }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to queue badge sync");
      const count = Number(data.enqueued_count) || 0;
      setSyncState((state) => ({
        ...state, running: false,
        message: count === 0
          ? "No badge checks were queued. There may be no saved award rules or no matching historical registrations or attendance."
          : `${count} badge ${count === 1 ? "check was" : "checks were"} queued. Awards will be processed in the background.`,
      }));
      await refreshSyncStatus();
    } catch (err) {
      setSyncState((state) => ({ ...state, running: false, error: err.message }));
    }
  };
  const hasAttendanceRule = config.eventRule?.trigger === CPD_TRIGGER_ATTENDANCE
    || Object.values(config.ticketRules || {}).some((rule) => rule?.trigger === CPD_TRIGGER_ATTENDANCE);
  const providerWarnings = hasAttendanceRule ? attendanceCapabilityWarnings(attendanceCapabilities) : [];
  const attendanceNotice = hasAttendanceRule && (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="cpd-attendance-capability-warning">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <p><strong>Attendance awards fail closed.</strong> If provider evidence setup is unavailable or unresolved, no badge is granted. Available QR check-ins and Zoom attendance can still qualify independently.</p>
      </div>
      {providerWarnings.length > 0 && (
        <ul className="ml-6 list-disc space-y-1 text-xs">
          {providerWarnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
        </ul>
      )}
    </div>
  );

  return (
    <Card className="border-slate-200 shadow-sm" data-testid="section-event-cpd-badges">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Award className="h-5 w-5 text-indigo-600" />Badges</CardTitle>
        <CardDescription>Grant a badge from the active tenant badge library when registration or attendance is confirmed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p><strong>Ticket rules take precedence.</strong> A ticket override replaces the event-wide rule. Choose “Award no badge” to explicitly prevent an award for that ticket. Tickets without an override use the event-wide rule.</p>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="cpd-history-note">
          Configuration changes affect future, unprocessed awards only. They never silently revoke badge awards already recorded in member history.
        </p>
        <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Sync historical badge awards</p>
              <p className="text-xs text-muted-foreground">
                Queue confirmed registrations and verified QR, Zoom, or Teams attendance using the last saved badge rules.
              </p>
            </div>
            <Button
              type="button" variant="outline" onClick={checkBeforeSync}
              disabled={!eventId || syncState.checking || syncState.running}
              data-testid="button-sync-cpd-badges"
            >
              {syncState.checking || syncState.running
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <RefreshCw className="mr-2 h-4 w-4" />}
              {syncState.running ? "Queuing…" : syncState.checking ? "Checking…" : "Sync historical awards"}
            </Button>
          </div>
          {!eventId && <p className="text-xs text-amber-700">Save this event before running a badge sync.</p>}
          {syncState.message && (
            <p className="flex items-start gap-2 text-xs text-emerald-700" role="status" data-testid="cpd-badge-sync-success">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />{syncState.message}
            </p>
          )}
          {syncState.error && <p className="text-xs text-destructive" role="alert" data-testid="cpd-badge-sync-error">{syncState.error}</p>}
          {eventId && (
            <div className="space-y-2 border-t border-slate-200 pt-3" data-testid="cpd-badge-sync-status">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-slate-700">Most recent sync</p>
                  {syncStatus.data?.created_at && (
                    <p className="text-xs text-muted-foreground">
                      Started {new Date(syncStatus.data.created_at).toLocaleString()}
                    </p>
                  )}
                </div>
                <Button
                  type="button" variant="ghost" size="sm" onClick={refreshSyncStatus}
                  disabled={syncStatus.loading}
                  data-testid="button-refresh-cpd-badge-sync-status"
                >
                  {syncStatus.loading
                    ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                  Refresh status
                </Button>
              </div>
              {syncStatus.error ? (
                <p className="text-xs text-destructive" role="alert">{syncStatus.error}</p>
              ) : !syncStatus.loading && !syncStatus.data ? (
                <p className="text-xs text-muted-foreground">No historical badge sync has been run for this event.</p>
              ) : syncStatus.data ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      ["Pending", syncStatus.data.pending],
                      ["Completed", syncStatus.data.completed],
                      ["Retrying", syncStatus.data.retrying],
                      ["Permanently failed", syncStatus.data.permanently_failed],
                    ].map(([label, count]) => (
                      <div key={label} className="rounded border bg-white px-2 py-1.5 text-center">
                        <div className="text-base font-semibold text-slate-800">{Number(count) || 0}</div>
                        <div className="text-[11px] text-muted-foreground">{label}</div>
                      </div>
                    ))}
                  </div>
                  {(Number(syncStatus.data.pending) || 0) + (Number(syncStatus.data.retrying) || 0) === 0 ? (
                    <p className="flex items-start gap-2 text-xs text-emerald-700" role="status" data-testid="cpd-badge-sync-finished">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {Number(syncStatus.data.permanently_failed) > 0
                        ? "Sync finished, with some checks permanently failed."
                        : "Sync finished. All queued checks have completed."}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground" role="status">Sync processing is still in progress.</p>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading active badges…</div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : badges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active badges are available. Create or activate one in Badge Management first.</p>
        ) : (
          <>
            <div className="space-y-2">
              <div>
                <Label className="font-medium">Event-wide rule</Label>
                <p className="text-xs text-muted-foreground">Used for every ticket unless a ticket-specific override is set below.</p>
              </div>
              <RuleFields rule={config.eventRule} badges={badges} onChange={(eventRule) => {
                const ticketRules = { ...(config.ticketRules || {}) };
                if (eventRule?.trigger) {
                  Object.entries(ticketRules).forEach(([reference, ticketRule]) => {
                    if (ticketRule?.no_award) ticketRules[reference] = { ...ticketRule, trigger: eventRule.trigger };
                  });
                }
                onChange({ ...config, eventRule, ticketRules });
              }} testId="cpd-event-rule" />
              {config.eventRule?.trigger === CPD_TRIGGER_ATTENDANCE && attendanceNotice}
            </div>
            <div className="space-y-3 border-t pt-4">
              <div>
                <Label className="font-medium">Ticket-specific overrides</Label>
                <p className="text-xs text-muted-foreground">References remain stable while new tickets are unsaved and are resolved to database IDs after creation.</p>
              </div>
              {tickets.length === 0 ? <p className="text-sm text-muted-foreground">Add a ticket to configure an override.</p> : tickets.map((ticket, index) => {
                const reference = ticketStableReference(ticket);
                const rule = config.ticketRules?.[reference] || null;
                return (
                  <div key={reference} className="space-y-2 rounded-md border p-3" data-testid={`cpd-ticket-rule-${reference}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{ticket.name || `Ticket ${index + 1}`}</span>
                      {rule && <Button type="button" variant="ghost" size="sm" onClick={() => updateTicketRule(reference, null)}>Use event-wide rule</Button>}
                    </div>
                    <RuleFields rule={rule} badges={badges} allowNoAward noAwardTrigger={config.eventRule?.trigger} onChange={(next) => updateTicketRule(reference, next)} testId={`cpd-ticket-${reference}`} />
                  </div>
                );
              })}
              {config.eventRule?.trigger !== CPD_TRIGGER_ATTENDANCE
                && Object.values(config.ticketRules || {}).some((rule) => rule?.trigger === CPD_TRIGGER_ATTENDANCE)
                && attendanceNotice}
            </div>
          </>
        )}
      </CardContent>
      <AlertDialog open={syncState.open} onOpenChange={(open) => setSyncState((state) => ({ ...state, open }))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync historical badge awards?</AlertDialogTitle>
            <AlertDialogDescription>
              This queues checks for all historical confirmed registrations and current verified attendance evidence.
              It uses saved event-wide and ticket-specific rules. Existing awards will not be duplicated or revoked.
              Rule changes saved while the queue is processing can affect checks that have not run yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runSync} data-testid="button-confirm-sync-cpd-badges">Queue badge checks</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
