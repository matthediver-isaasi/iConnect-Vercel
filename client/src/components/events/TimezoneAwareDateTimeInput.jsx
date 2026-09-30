import { Input } from "@/components/ui/input";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * Format an ISO timestamp (or anything `new Date(...)` accepts) as a
 * `yyyy-MM-dd'T'HH:mm` string in the given timezone, suitable for
 * `<input type="datetime-local">` value/min/max attributes.
 *
 * Returns "" when the input is empty/invalid or `isReady` is false.
 */
export function formatIsoForDateTimeLocal(isoString, tz, isReady = true) {
  if (!isReady) return "";
  if (!isoString) return "";
  try {
    return formatInTimeZone(new Date(isoString), tz, "yyyy-MM-dd'T'HH:mm");
  } catch {
    return "";
  }
}

/**
 * Convert a `yyyy-MM-dd'T'HH:mm` datetime-local string back to a UTC ISO
 * timestamp, interpreting the wall-clock time in the given timezone.
 *
 * Returns "" for empty/invalid input.
 */
export function dateTimeLocalToIso(localValue, tz) {
  if (!localValue) return "";
  try {
    return fromZonedTime(localValue, tz).toISOString();
  } catch {
    return "";
  }
}

/**
 * Shared `<input type="datetime-local">` that reads/writes UTC ISO strings
 * while displaying and accepting wall-clock time in a given timezone.
 *
 * Props:
 *   tz        - IANA timezone (e.g. "Europe/London")
 *   value     - UTC ISO string (or "" / null)
 *   onChange  - (iso: string) => void; receives a UTC ISO string or "" when cleared
 *   max/min   - optional UTC ISO bounds; formatted into the input's tz for the
 *               native attribute
 *   isReady   - when false (e.g. timezone still loading), the input renders blank
 *
 * Any other props are forwarded to the underlying <Input>.
 */
export function TimezoneAwareDateTimeInput({
  tz,
  value,
  onChange,
  max,
  min,
  isReady = true,
  ...rest
}) {
  const display = formatIsoForDateTimeLocal(value, tz, isReady);
  const maxDisplay = formatIsoForDateTimeLocal(max, tz, isReady);
  const minDisplay = formatIsoForDateTimeLocal(min, tz, isReady);

  return (
    <Input
      type="datetime-local"
      value={display}
      max={maxDisplay || undefined}
      min={minDisplay || undefined}
      onChange={(e) => {
        const raw = e.target.value;
        if (!raw) {
          onChange("");
          return;
        }
        onChange(dateTimeLocalToIso(raw, tz));
      }}
      {...rest}
    />
  );
}

export default TimezoneAwareDateTimeInput;
