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
 * Resolve a wall-clock minute without date-fns' implicit DST disambiguation.
 * Zero matches is a clock gap; two matches is a repeated minute. Sampling
 * offsets either side also handles non-hour transitions (e.g. Lord Howe).
 */
export function resolveStrictLocalDateTime(localValue, tz) {
  if (!localValue) return { candidates: [], error: "Choose a date and time." };
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue)) {
      throw new Error("Invalid local date");
    }
    const wall = new Date(`${localValue}:00Z`);
    if (wall.toISOString().slice(0, 16) !== localValue) throw new Error("Invalid local date");
    const offsets = new Set();
    for (let hours = -48; hours <= 48; hours += 6) {
      const sample = new Date(wall.getTime() + hours * 3600000);
      const zoned = formatInTimeZone(sample, tz, "yyyy-MM-dd'T'HH:mm:ss");
      offsets.add(new Date(`${zoned}Z`).getTime() - sample.getTime());
    }
    const candidates = [...offsets]
      .map(offset => new Date(wall.getTime() - offset).toISOString())
      .filter(iso => formatIsoForDateTimeLocal(iso, tz) === localValue)
      .sort();
    return {
      candidates,
      error: candidates.length === 0
        ? "This local time does not exist because the clocks change. Choose another time."
        : candidates.length > 1
          ? "This local time occurs twice because the clocks change. Select which occurrence to use."
          : "",
    };
  } catch {
    return { candidates: [], error: "Enter a valid date, time and timezone." };
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
 *   strict    - opt in to rejecting clock gaps and explicit overlap selection
 *   pendingLocalValue - in strict mode, persist onChange's second argument
 *               `localValue` here, and its `error` in the form's validation state.
 *               Unresolved input emits "" rather than retaining a stale instant;
 *               resolved input emits ISO plus { localValue: undefined, error: "" }.
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
  strict = false,
  pendingLocalValue,
  ...rest
}) {
  const display = formatIsoForDateTimeLocal(value, tz, isReady);
  const maxDisplay = formatIsoForDateTimeLocal(max, tz, isReady);
  const minDisplay = formatIsoForDateTimeLocal(min, tz, isReady);

  // Strict mode is opt-in; existing event date inputs retain their behaviour.
  // Pending text belongs to the caller so collapsing an editor cannot bypass
  // validation or silently restore the last valid timestamp.
  if (strict) {
    const raw = pendingLocalValue ?? display;
    const pending = pendingLocalValue !== undefined;
    const resolution = pending ? resolveStrictLocalDateTime(raw, tz) : null;
    const errorId = rest.id ? `${rest.id}-error` : undefined;
    return (
      <div className="space-y-2">
        <Input
          {...rest}
          type="datetime-local"
          value={raw}
          max={maxDisplay || undefined}
          min={minDisplay || undefined}
          aria-invalid={Boolean(resolution?.error)}
          aria-describedby={resolution?.error ? errorId : rest["aria-describedby"]}
          onChange={(e) => {
            const localValue = e.target.value;
            const result = resolveStrictLocalDateTime(localValue, tz);
            onChange(result.candidates.length === 1 ? result.candidates[0] : "", {
              localValue: result.candidates.length === 1 ? undefined : localValue,
              error: result.error,
            });
          }}
        />
        {resolution?.error && <p id={errorId} role="alert" className="text-sm text-destructive">{resolution.error}</p>}
        {resolution?.candidates.length > 1 && (
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Choose the intended occurrence</legend>
            {resolution.candidates.map((iso, index) => (
              <label key={iso} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${rest.id || "datetime"}-occurrence`}
                  value={iso}
                  checked={false}
                  onChange={() => onChange(iso, { localValue: undefined, error: "" })}
                />
                {index === 0 ? "First" : "Second"} occurrence — {formatInTimeZone(iso, tz, "zzz (XXX)")} ({iso})
              </label>
            ))}
          </fieldset>
        )}
      </div>
    );
  }

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
