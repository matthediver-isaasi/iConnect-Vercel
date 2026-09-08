import { useEffect, useState } from "react";
import { AlertTriangle, Award, Info, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CPD_TRIGGER_ATTENDANCE,
  CPD_TRIGGER_REGISTRATION,
  emptyEventCpdBadgeConfig,
  normalizeEventCpdBadgeConfig,
  ticketStableReference,
  attendanceCapabilityWarnings,
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

  const updateTicketRule = (reference, rule) => {
    const nextRules = { ...(config.ticketRules || {}) };
    if (rule) nextRules[reference] = rule;
    else delete nextRules[reference];
    onChange({ ...config, ticketRules: nextRules });
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
    </Card>
  );
}
