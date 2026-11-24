export function formatBadgeEventDate(value, timeZone) {
  if (!value) return "";
  // Date-only event values are calendar dates, not UTC instants.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return "";
  const options = { day: "numeric", month: "short", year: "numeric", timeZone: dateOnly ? "UTC" : timeZone || undefined };
  try {
    return date.toLocaleDateString("en-GB", options);
  } catch {
    // An invalid legacy timezone must not break the credential card.
    return date.toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
  }
}

export default function BadgeEventDetails({ events = [] }) {
  if (!events.length) return null;
  return (
    <div className="text-xs text-muted-foreground space-y-2 my-2 min-w-0 break-words" data-testid="badge-event-details">
      {events.map(event => (
        <div key={`${event.event_type}:${event.event_id}`}>
          <p>Event: {event.event_name || "Event no longer available"}</p>
          <p>Event start date: {formatBadgeEventDate(event.event_start_date, event.event_timezone) || "Unavailable"}</p>
        </div>
      ))}
    </div>
  );
}
