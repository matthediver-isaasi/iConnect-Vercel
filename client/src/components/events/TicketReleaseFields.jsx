import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import TimezoneSelect from "@/components/TimezoneSelect";
import { TimezoneAwareDateTimeInput } from "@/components/events/TimezoneAwareDateTimeInput";
import { validateTicketRelease } from "@shared/ticketRelease";

export function hydrateTicketRelease(ticket = {}) {
  return {
    release_at: ticket.release_at ?? null,
    release_timezone: ticket.release_timezone ?? null,
    close_at: ticket.close_at ?? null,
    close_timezone: ticket.close_timezone ?? null,
  };
}

export function ticketReleaseError(ticket) {
  if (ticket._releaseError) return ticket._releaseError;
  if (ticket._closeError) return ticket._closeError;
  const releaseEnabled = ticket.release_at != null || ticket.release_timezone != null;
  const closeEnabled = ticket.close_at != null || ticket.close_timezone != null;
  if (releaseEnabled && (!ticket.release_at || !ticket.release_timezone)) return "Choose a release date, time and timezone, or turn off scheduled release.";
  if (closeEnabled && (!ticket.close_at || !ticket.close_timezone)) return "Choose an auto close date, time and timezone, or turn off auto close.";
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
    close_at: ticket.close_at ? new Date(ticket.close_at).toISOString() : null,
    close_timezone: ticket.close_timezone ?? null,
  };
}

export default function TicketReleaseFields({ ticket, eventTimezone, onChange }) {
  const id = ticket._localId || ticket.id;
  const enabled = ticket.release_at != null || ticket.release_timezone != null;
  const closeEnabled = ticket.close_at != null || ticket.close_timezone != null;
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
        </div>
      )}
      <div className="flex items-center gap-2">
        <Switch
          id={`ticket-close-enabled-${id}`}
          checked={closeEnabled}
          onCheckedChange={(checked) => onChange({
            close_at: null,
            close_timezone: checked ? (eventTimezone || "Europe/London") : null,
            _closeLocalValue: undefined,
            _closeError: "",
          })}
          data-testid={`switch-ticket-close-${id}`}
        />
        <Label htmlFor={`ticket-close-enabled-${id}`}>Auto close ticket bookings</Label>
      </div>
      <p className="text-xs text-slate-500">
        {closeEnabled
          ? "This ticket cannot be booked at or after its auto close time. Its close timezone is saved independently of the event."
          : "No ticket-specific auto close time. The event’s other booking rules still apply."}
      </p>
      {closeEnabled && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid={`ticket-close-${id}`}>
          <div className="space-y-1.5">
            <Label htmlFor={`ticket-close-at-${id}`}>Auto close date and time *</Label>
            <TimezoneAwareDateTimeInput
              id={`ticket-close-at-${id}`}
              data-testid={`input-ticket-close-${id}`}
              tz={ticket.close_timezone || eventTimezone || "Europe/London"}
              value={ticket.close_at}
              strict
              pendingLocalValue={ticket._closeLocalValue}
              onChange={(iso, pending) => onChange({
                close_at: iso || null,
                _closeLocalValue: pending.localValue,
                _closeError: pending.error,
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`ticket-close-timezone-${id}`}>Auto close timezone *</Label>
            <TimezoneSelect
              id={`ticket-close-timezone-${id}`}
              value={ticket.close_timezone}
              onChange={(timezone) => onChange({
                close_timezone: timezone,
                // Preserve resolved instants; unresolved wall-clock input must
                // be entered again rather than reinterpreted in the new zone.
                _closeLocalValue: undefined,
                _closeError: "",
              })}
            />
          </div>
        </div>
      )}
      {error && error !== ticket._releaseError && error !== ticket._closeError && (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}