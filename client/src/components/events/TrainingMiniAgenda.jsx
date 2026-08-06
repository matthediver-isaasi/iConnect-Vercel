// Compact agenda list for Training event cards (dates only, no times).
// Renders one line per agenda item — "MMM d, yyyy [– MMM d, yyyy] · Type" —
// in the event's configured agenda order, capped so cards stay compact.
import { CalendarDays } from "lucide-react";
import { parseISO, format, isValid } from "date-fns";

const DEFAULT_MAX_LINES = 4;

// Agenda start/end dates are date-only strings (yyyy-MM-dd), so format them
// directly — no timezone conversion, which could shift them by a day.
export function formatAgendaDate(dateStr, formatStr = "MMM d, yyyy") {
  if (!dateStr) return null;
  try {
    const d = parseISO(String(dateStr));
    if (!isValid(d)) return null;
    return format(d, formatStr);
  } catch {
    return null;
  }
}

export function formatAgendaDateRange(item) {
  const start = formatAgendaDate(item.start_date);
  if (!start) return null;
  const end = item.end_date && item.end_date !== item.start_date
    ? formatAgendaDate(item.end_date)
    : null;
  return end ? `${start} - ${end}` : start;
}

export function sortAgendaItems(items) {
  return [...(items || [])].sort((a, b) => {
    const dateCmp = String(a.start_date || '').localeCompare(String(b.start_date || ''));
    if (dateCmp !== 0) return dateCmp;
    const timeCmp = String(a.start_time || '').localeCompare(String(b.start_time || ''));
    if (timeCmp !== 0) return timeCmp;
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });
}

export default function TrainingMiniAgenda({ items, maxLines = DEFAULT_MAX_LINES, testId }) {
  const sorted = sortAgendaItems(items).filter((i) => formatAgendaDateRange(i));
  if (sorted.length === 0) return null;

  const visible = sorted.length > maxLines ? sorted.slice(0, maxLines) : sorted;
  const hiddenCount = sorted.length - visible.length;

  return (
    <div className="space-y-1.5" data-testid={testId}>
      {visible.map((item, idx) => (
        <div key={idx} className="flex items-center gap-2 text-sm text-slate-600">
          <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
          <span>{formatAgendaDateRange(item)}</span>
          {item.item_type && (
            <span className="text-slate-400 text-xs shrink-0">{item.item_type}</span>
          )}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="text-xs text-slate-400 pl-6">+{hiddenCount} more</div>
      )}
    </div>
  );
}
