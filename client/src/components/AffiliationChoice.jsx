import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export default function AffiliationChoice({ name, title, help, value, options, onChange, disabled, prerequisite, issue, emptyLabel = "Choose an option" }) {
  const [search, setSearch] = useState("");
  const id = `affiliation-${name}`;
  const current = options.find(option => option.id === value);
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const suggestion = options.length === 1 && value !== options[0].id ? options[0] : null;
  const visible = current && !filtered.some(option => option.id === value) ? [current, ...filtered] : filtered;
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">{title}</Label>
      <p id={`${id}-help`} className="text-sm text-muted-foreground">{help}</p>
      {prerequisite && <p className="text-sm text-muted-foreground">{prerequisite} Any saved choice is kept until you change it.</p>}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <input type="search" aria-label={`Search ${title.toLowerCase()}`} placeholder="Search choices…" value={search}
          disabled={disabled || !!prerequisite || !options.length}
          onChange={event => setSearch(event.target.value)}
          className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60" />
        <select id={id} value={value || ""} disabled={disabled || !!prerequisite}
          aria-describedby={`${id}-help${issue ? ` ${id}-error` : ""}`} aria-invalid={!!issue}
          onChange={event => onChange(event.target.value || null)}
          className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60">
          <option value="">{emptyLabel}</option>
          {value && !current && <option value={value}>Saved choice — unavailable for this step (kept)</option>}
          {visible.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </div>
      {!prerequisite && options.length === 0 && <p className="text-sm text-muted-foreground">No compatible choices are available. Ask your system administrator to check the active records and connections.</p>}
      {!prerequisite && options.length > 0 && filtered.length === 0 && <p className="text-sm text-muted-foreground">No matches. Try a different search. Your selection has not changed.</p>}
      {!prerequisite && suggestion && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-sm text-slate-700">
          <span>One compatible choice: <strong className="font-medium">{suggestion.label}</strong></span>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { onChange(suggestion.id); setSearch(""); }}>Confirm suggestion</Button>
        </div>
      )}
      {issue && <p id={`${id}-error`} role="alert" className="text-sm text-red-700">{issue}</p>}
    </div>
  );
}
