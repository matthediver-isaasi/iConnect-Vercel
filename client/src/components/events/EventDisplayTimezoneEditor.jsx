import React, { useId, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import TimezoneSelect from "@/components/TimezoneSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_TIMEZONE_LABEL_LENGTH, canonicalTimezone } from "../../../../shared/eventDisplayTimezones.js";

export default function EventDisplayTimezoneEditor({ value = [], onChange, disabled = false }) {
  const id = useId();
  const [newTimezone, setNewTimezone] = useState("");
  const duplicate = value.some((entry) => canonicalTimezone(entry.timezone) === canonicalTimezone(newTimezone));

  const update = (index, patch) => {
    onChange(value.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  };
  const move = (index, direction) => {
    const next = [...value];
    const destination = index + direction;
    if (destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <legend className="px-1 text-sm font-medium text-slate-900">Event display timezones</legend>
      <p className="text-sm text-slate-500">
        Show event times in the regions your audience uses, in this order. This only changes the display, not the event schedule.
      </p>
      {value.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-500">
          No display timezones selected. Events keep their existing time display.
        </div>
      ) : (
        <ol className="space-y-3" aria-label="Display timezone order">
          {value.map((entry, index) => (
            <li key={entry.timezone} className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-all text-sm font-medium text-slate-700">
                  <span className="mr-2 text-slate-400">{index + 1}.</span>{entry.timezone}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${entry.timezone} up`}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8" disabled={disabled || index === value.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${entry.timezone} down`}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-red-600" disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))} aria-label={`Remove ${entry.timezone}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-label-${index}`} className="text-xs text-slate-600">Label (optional)</Label>
                <Input id={`${id}-label-${index}`} value={entry.label || ""} maxLength={MAX_TIMEZONE_LABEL_LENGTH} placeholder="e.g., London" disabled={disabled} onChange={(e) => update(index, { label: e.target.value.slice(0, MAX_TIMEZONE_LABEL_LENGTH) })} aria-describedby={`${id}-label-help`} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <p id={`${id}-label-help`} className="text-xs text-slate-500">
        Labels can contain up to {MAX_TIMEZONE_LABEL_LENGTH} characters. Leave blank to use the timezone's default label.
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${id}-timezone`} className="text-sm">Add a timezone</Label>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <TimezoneSelect id={`${id}-timezone`} value={newTimezone} onChange={setNewTimezone} />
          </div>
          <Button type="button" variant="outline" disabled={disabled || !newTimezone || duplicate} onClick={() => {
            onChange([...value, { timezone: newTimezone, label: "" }]);
            setNewTimezone("");
          }}>
            <Plus className="mr-2 h-4 w-4" /> Add timezone
          </Button>
        </div>
        {duplicate && <p role="status" className="text-xs text-slate-500">This timezone is already in the list.</p>}
      </div>
    </fieldset>
  );
}
