import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { salesSettingsRequest, useSalesSettings } from "./useSalesSettings";

const empty = { issueDelays: [], paymentTerms: [] };
function PresetForm({ query, settings, canManage }) {
  const [draft, setDraft] = useState(null);
  const presets = draft ?? settings.billingPresets ?? empty;
  const invalid = Object.values(presets).some(rows => rows.some(row => !row.name.trim() || !/^\d+$/.test(String(row.days)) || !Number.isSafeInteger(Number(row.days)) || (row.isDefault && !row.isActive)));
  const save = useMutation({
    mutationFn: () => query.patch({ expectedVersion: settings.version, billingPresets: Object.fromEntries(Object.entries(presets).map(([key, rows]) => [key, rows.map(row => ({ ...row, name: row.name.trim(), days: Number(row.days) }))])) }),
    onSuccess: async result => { await query.accept(result); setDraft(null); },
    onError: async error => { if (error.status === 409) await query.refetch(); },
  });
  const change = (key, rows) => { setDraft({ ...presets, [key]: rows }); save.reset(); };
  return <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (canManage && query.ready && !query.isFetching && !save.isPending && draft && !invalid) save.mutate(); }}>
    <p className="text-sm text-muted-foreground">Invoice issue timing and time to pay are separate. Changes apply to new selections only; issued and accepted commitments keep their saved terms. Remove an option below, then save billing presets to confirm. Existing saved billing terms are not changed.</p>
    {[["issueDelays", "Invoice issue delays", "Calendar days after acceptance, before an invoice is issued"], ["paymentTerms", "Payment terms", "Calendar days after invoice issue, before payment is due"]].map(([key, title, help]) => <fieldset key={key} disabled={!canManage || save.isPending} className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend><p className="text-xs text-muted-foreground">{help}. Zero means the same day.</p>
      {!presets[key]?.length && <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">No presets configured. Add a named option for your sales team.</p>}
      {(presets[key] || []).map((row, index, rows) => {
        const patch = values => change(key, rows.map((item, i) => i === index ? { ...item, ...values } : item));
        return <div key={row.id} className="grid gap-3 rounded-md border bg-slate-50/50 p-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">Preset name<Input aria-label={`${title} name ${index + 1}`} required maxLength={100} value={row.name} onChange={event => patch({ name: event.target.value })} /></label>
          <label className="space-y-1 text-xs">{key === "issueDelays" ? "Issue delay (days)" : "Time to pay (days)"}<Input aria-label={`${title} days ${index + 1}`} required type="number" min="0" step="1" value={row.days} onChange={event => patch({ days: event.target.value })} /></label>
          <div className="flex flex-wrap gap-4 text-xs sm:col-span-2">
            <label className="flex items-center gap-2"><input type="checkbox" checked={row.isActive} onChange={event => patch({ isActive: event.target.checked, ...(!event.target.checked ? { isDefault: false } : {}) })} />Active for new selections</label>
            <label className="flex items-center gap-2"><input type="radio" name={`default-${key}`} disabled={!row.isActive} checked={row.isDefault} onChange={() => change(key, rows.map(item => ({ ...item, isDefault: item.id === row.id })))} />Default for new selections</label>
            {row.isDefault && <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => patch({ isDefault: false })}>Clear default</Button>}
            {canManage && <Button type="button" variant="outline" size="sm" className="text-destructive sm:ml-auto" aria-label={`Remove ${key === "issueDelays" ? "invoice issue delay" : "payment terms"} ${row.name || index + 1}`} onClick={() => change(key, rows.filter(item => item.id !== row.id))}>Remove</Button>}
          </div>
        </div>;
      })}
      {canManage && <Button type="button" size="sm" variant="outline" onClick={() => change(key, [...(presets[key] || []), { id: crypto.randomUUID(), name: "", days: 0, isActive: true, isDefault: false }])}>Add {key === "issueDelays" ? "issue delay" : "payment terms"}</Button>}
    </fieldset>)}
    {invalid && <p role="alert" className="text-sm text-destructive">Each preset needs a name and a non-negative whole number of days. Defaults must be active.</p>}
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}{save.error.status === 409 && " Settings changed elsewhere. Your preset draft is preserved; review and retry against the latest version."}</p>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Billing presets saved.</p>}
    {!canManage && <p className="text-xs text-muted-foreground">You need permission to manage Sales settings to make changes.</p>}
    {canManage && <Button type="submit" disabled={!draft || invalid || !query.ready || query.isFetching || save.isPending}>{save.isPending ? "Saving…" : "Save billing presets"}</Button>}
  </form>;
}

export default function BillingPresetSettings({ canManage, request = salesSettingsRequest }) {
  const query = useSalesSettings(request);
  const settings = query.data || query.lastConfirmedData;
  return <Card><CardHeader><CardTitle>Billing presets</CardTitle></CardHeader><CardContent>
    {query.error && <div role="alert" className="mb-4 space-y-2"><p>{query.error.message}</p><Button variant="outline" onClick={() => query.refetch()}>Retry billing presets</Button></div>}
    {settings ? <PresetForm key={query.scopeKey} query={query} settings={settings} canManage={canManage && !query.isError} /> : !query.error && <div role="status" className="h-32 animate-pulse rounded-md bg-muted"><span className="sr-only">Loading billing presets</span></div>}
  </CardContent></Card>;
}
