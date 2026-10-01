import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import TimezoneSelect from "@/components/TimezoneSelect";
import { TimezoneAwareDateTimeInput } from "@/components/events/TimezoneAwareDateTimeInput";
import { validateTicketRelease } from "@shared/ticketRelease";

export function hydrateTicketRelease(ticket = {}) {
  return {
    release_at: ticket.release_at ?? null,
    release_timezone: ticket.release_timezone ?? null,
  };
}

export function ticketReleaseError(ticket) {
  if (ticket._releaseError) return ticket._releaseError;
  if (ticket.release_at == null && ticket.release_timezone == null) return "";
  if (!ticket.release_at || !ticket.release_timezone) return "Choose a release date, time and timezone, or turn off scheduled release.";
  return validateTicketRelease(ticket) || "";
}

export function validateTicketReleases(tickets) {
  return tickets.flatMap((ticket, index) => {
    const error = ticketReleaseError(ticket);
    return error ? [`${ticket.name || `Ticket ${index + 1}`}: ${error}`] : [];
  });
}

export function serializeTicketRelease(ticket) {
  const error = ticketReleaseError(ticket);
  if (error) throw new Error(error);
  return {
    release_at: ticket.release_at ? new Date(ticket.release_at).toISOString() : null,
    release_timezone: ticket.release_timezone ?? null,
  };
}

export default function TicketReleaseFields({ ticket, eventTimezone, onChange }) {
  const id = ticket._localId || ticket.id;
  const enabled = ticket.release_at != null || ticket.release_timezone != null;
  const error = ticketReleaseError(ticket);
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`ticket-release-${id}`}>
      <div className="flex items-center gap-2">
        <Switch
          id={`ticket-release-enabled-${id}`}
          checked={enabled}
          onCheckedChange={(checked) => onChange({
            release_at: null,
            release_timezone: checked ? (eventTimezone || "Europe/London") : null,
            _releaseLocalValue: undefined,
            _releaseError: "",
          })}
          data-testid={`switch-ticket-release-${id}`}
        />
        <Label htmlFor={`ticket-release-enabled-${id}`}>Schedule ticket release</Label>
      </div>
      <p className="text-xs text-slate-500">
        {enabled
          ? "This ticket cannot be booked before its release time. Its release timezone is saved independently of the event."
          : "Available immediately, subject to the event’s other booking rules."}
      </p>
      {enabled && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`ticket-release-at-${id}`}>Release date and time *</Label>
            <TimezoneAwareDateTimeInput
              id={`ticket-release-at-${id}`}
              data-testid={`input-ticket-release-${id}`}
              tz={ticket.release_timezone || eventTimezone || "Europe/London"}
              value={ticket.release_at}
              strict
              pendingLocalValue={ticket._releaseLocalValue}
              onChange={(iso, pending) => onChange({
                release_at: iso || null,
                _releaseLocalValue: pending.localValue,
                _releaseError: pending.error,
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`ticket-release-timezone-${id}`}>Release timezone *</Label>
            <TimezoneSelect
              id={`ticket-release-timezone-${id}`}
              value={ticket.release_timezone}
              onChange={(timezone) => onChange({
                release_timezone: timezone,
                // A resolved timestamp is never reinterpreted on timezone change.
                // Unresolved wall-clock input must be entered again in the new zone.
                _releaseLocalValue: undefined,
                _releaseError: "",
              })}
            />
          </div>
          {error && !ticket._releaseError && <p role="alert" className="text-sm text-destructive md:col-span-2">{error}</p>}
        </div>
      )}
    </div>
  );
}