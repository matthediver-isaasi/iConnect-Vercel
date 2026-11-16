import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isValidWebinarDuration, webinarDurationFromParts, WEBINAR_DURATION_ERROR } from "@shared/zoomWebinarDuration.js";

// Mount a fresh instance when opening a dialog or selecting a different webinar.
// Keep raw text locally: a blank field is an editable draft, never a default.
export default function WebinarDurationFields({ id, durationMinutes, onChange }) {
  const [hours, setHours] = useState(() => isValidWebinarDuration(durationMinutes) ? String(Math.floor(durationMinutes / 60)) : "");
  const [minutes, setMinutes] = useState(() => isValidWebinarDuration(durationMinutes) ? String(durationMinutes % 60) : "");
  const invalid = webinarDurationFromParts(hours, minutes) === null;
  const helpId = `${id}-help`;

  const changeHours = (event) => {
    const value = event.target.value;
    setHours(value);
    onChange(webinarDurationFromParts(value, minutes));
  };
  const changeMinutes = (event) => {
    const value = event.target.value;
    setMinutes(value);
    onChange(webinarDurationFromParts(hours, value));
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Duration</legend>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-hours`}>Hours</Label>
          <Input id={`${id}-hours`} type="text" inputMode="numeric"
            value={hours} onChange={changeHours}
            aria-invalid={invalid} aria-describedby={helpId} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-minutes`}>Minutes</Label>
          <Input id={`${id}-minutes`} type="text" inputMode="numeric"
            value={minutes} onChange={changeMinutes}
            aria-invalid={invalid} aria-describedby={helpId} />
        </div>
      </div>
      <p id={helpId} className={`text-sm ${invalid ? "text-destructive" : "text-slate-500"}`} role={invalid ? "alert" : undefined}>
        {invalid ? WEBINAR_DURATION_ERROR : "Use whole hours and minutes (0–59). Minimum duration: 1 minute."}
      </p>
    </fieldset>
  );
}
