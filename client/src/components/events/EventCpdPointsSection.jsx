import { useEffect, useState } from "react";
import { AlertTriangle, Coins, Info, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { attendanceCapabilityWarnings, ticketStableReference } from "@/lib/eventCpdBadgeRules";
import {
  CPD_TRIGGER_ATTENDANCE,
  CPD_TRIGGER_REGISTRATION,
  emptyEventCpdPointsConfig,
  normalizeEventCpdPointsConfig,
  validateEventCpdPointsConfig,
} from "@/lib/eventCpdPointsRules";

const INHERIT = "__inherit__";
const NO_AWARD = "__no_award__";
const OVERRIDE = "__override__";

function RuleFields({ rule, onChange, testId }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs">Points</Label>
        <Input
          value={rule?.points ?? ""}
          inputMode="decimal"
          placeholder="e.g. 1.5"
          onChange={(event) => onChange({ ...rule, points: event.target.value })}
          data-testid={`${testId}-points`}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Award when</Label>
        <Select value={rule?.trigger || CPD_TRIGGER_REGISTRATION} onValueChange={(trigger) => onChange({ ...rule, trigger })}>
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

export default function EventCpdPointsSection({ eventId = null, eventType, tickets = [], value, onChange }) {
  const config = value || emptyEventCpdPointsConfig();
  const [loading, setLoading] = useState(Boolean(eventId));
  const [error, setError] = useState("");
  const [attendanceCapabilities, setAttendanceCapabilities] = useState(null);

  useEffect(() => {
    if (!eventId) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const query = new URLSearchParams({ event_id: eventId, event_type: eventType });
    setLoading(true);
    fetch(`/api/admin/event-cpd-points-rules?${query}`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Failed to load CPD points rules");
        if (cancelled) return;
        onChange(normalizeEventCpdPointsConfig(data.rules));
        setAttendanceCapabilities(data.attendance_capabilities || null);
        setError("");
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eventId, eventType]); // Hydrate only when the edited event changes.

  const updateTicketRule = (reference, rule) => {
    const ticketRules = { ...(config.ticketRules || {}) };
    if (rule) ticketRules[reference] = rule;
    else delete ticketRules[reference];
    onChange({ ...config, ticketRules });
  };
  const validationErrors = validateEventCpdPointsConfig(config, tickets);
  const hasAttendanceRule = config.eventRule?.trigger === CPD_TRIGGER_ATTENDANCE
    || Object.values(config.ticketRules || {}).some((rule) => !rule?.no_award && rule?.trigger === CPD_TRIGGER_ATTENDANCE);
  const providerWarnings = hasAttendanceRule ? attendanceCapabilityWarnings(attendanceCapabilities) : [];

  return (
    <Card className="border-slate-200 shadow-sm" data-testid="section-event-cpd-points">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Coins className="h-5 w-5 text-indigo-600" />Points</CardTitle>
        <CardDescription>Award decimal-safe CPD points when registration or verified attendance is confirmed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p><strong>Ticket overrides take precedence.</strong> An override replaces the event-wide value for attendees on that ticket. Tickets without one inherit the event-wide rule.</p>
        </div>
        <p className="text-xs text-muted-foreground">Changes apply only to future, unprocessed awards and do not alter points already recorded.</p>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading CPD points…</div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label className="font-medium">Event-wide rule</Label>
                  <p className="text-xs text-muted-foreground">Leave unset to award no points by default.</p>
                </div>
                {config.eventRule ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...config, eventRule: null })}>Remove rule</Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...config, eventRule: { points: "", trigger: CPD_TRIGGER_REGISTRATION, no_award: false } })}>Add rule</Button>
                )}
              </div>
              {config.eventRule && <RuleFields rule={config.eventRule} onChange={(eventRule) => onChange({ ...config, eventRule })} testId="cpd-points-event-rule" />}
            </div>
            <div className="space-y-3 border-t pt-4">
              <div>
                <Label className="font-medium">Ticket-specific overrides</Label>
                <p className="text-xs text-muted-foreground">Choose a points value, explicitly award no points, or inherit the event-wide rule.</p>
              </div>
              {tickets.length === 0 ? <p className="text-sm text-muted-foreground">Add a ticket to configure an override.</p> : tickets.map((ticket, index) => {
                const reference = ticketStableReference(ticket);
                const rule = config.ticketRules?.[reference] || null;
                const mode = !rule ? INHERIT : (rule.no_award ? NO_AWARD : OVERRIDE);
                return (
                  <div key={reference} className="space-y-2 rounded-md border p-3" data-testid={`cpd-points-ticket-rule-${reference}`}>
                    <span className="text-sm font-medium">{ticket.name || `Ticket ${index + 1}`}</span>
                    <Select value={mode} onValueChange={(nextMode) => {
                      if (nextMode === INHERIT) updateTicketRule(reference, null);
                      else if (nextMode === NO_AWARD) updateTicketRule(reference, { points: null, trigger: config.eventRule?.trigger || CPD_TRIGGER_REGISTRATION, no_award: true });
                      else updateTicketRule(reference, { points: "", trigger: config.eventRule?.trigger || CPD_TRIGGER_REGISTRATION, no_award: false });
                    }}>
                      <SelectTrigger data-testid={`cpd-points-ticket-${reference}-mode`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>Use event-wide rule</SelectItem>
                        <SelectItem value={OVERRIDE}>Override with points</SelectItem>
                        <SelectItem value={NO_AWARD}>Award no points</SelectItem>
                      </SelectContent>
                    </Select>
                    {rule && !rule.no_award && <RuleFields rule={rule} onChange={(next) => updateTicketRule(reference, next)} testId={`cpd-points-ticket-${reference}`} />}
                  </div>
                );
              })}
            </div>
            {validationErrors.length > 0 && (
              <div className="text-sm text-destructive" role="alert" data-testid="cpd-points-validation">{validationErrors[0]}</div>
            )}
            {hasAttendanceRule && (
              <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p><strong>Attendance awards fail closed.</strong> Points are awarded only when supported attendance evidence is verified.</p></div>
                {providerWarnings.length > 0 && <ul className="ml-6 list-disc text-xs">{providerWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}