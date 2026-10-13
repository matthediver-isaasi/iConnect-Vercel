import React from "react";
import { buildEventTimeRows } from "../../../../shared/eventDisplayTimezones.js";

/**
 * Presentation only: callers supply settings and retain their legacy display
 * as children for unscheduled, date-only, invalid, or unconfigured events.
 */
export default function EventTimeDisplay({ event, systemSettings, start, end, children }) {
  const eventStart = start ?? event?.start_date;
  if (event?.status === "immediate" || event?.status === "tbc") return null;
  if (
    event?.status === "immediate" ||
    event?.status === "tbc" ||
    !eventStart ||
    (typeof eventStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(eventStart.trim()))
  ) {
    return null;
  }

  let rows;
  try {
    rows = buildEventTimeRows({
      start: eventStart,
      end,
      timezone: event?.timezone,
      settings: systemSettings,
    });
  } catch {
    return <>{children}</>;
  }
  if (!Array.isArray(rows) || rows.length === 0) return <>{children}</>;

  return (
    <dl className="grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm leading-snug" aria-label="Event times by timezone">
      {rows.map((row, index) => (
        <React.Fragment key={`${row.timezone}-${index}`}>
          <dt className="min-w-0 break-words font-medium" title={row.timezone}>
            {row.label || row.timezone}
          </dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="tabular-nums">{row.time}</span>
            {row.date && <span className="text-xs text-muted-foreground">{row.date}</span>}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
