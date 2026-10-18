import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSalesSettings, salesSettingsRequest } from "./useSalesSettings";

function VisibilityForm({ query, canManage, request }) {
  const [changes, setChanges] = useState({});
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => query.patch({ ...changes, expectedVersion: (query.data || query.lastConfirmedData).version }),
    onSuccess: async result => { await query.accept(result); setChanges({}); setSaved(true); },
    onError: error => { if (error.status === 409) query.refetch(); },
  });
  return <form className="space-y-3" onSubmit={event => {
    event.preventDefault();
    if (canManage && !save.isPending && Object.keys(changes).length) save.mutate();
  }}>
    <p className="text-sm text-muted-foreground">Choose which identifiers appear in internal Sales screens. Hidden values are retained. New items receive an automatic internal code when it is hidden.</p>
    {[["showInternalCode", "Show internal code"], ["showSku", "Show SKU"]].map(([key, label]) =>
      <label key={key} className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={changes[key] ?? (query.data || query.lastConfirmedData)[key]} disabled={!canManage || save.isPending}
          onChange={event => { setChanges(current => ({ ...current, [key]: event.target.checked })); setSaved(false); }} />
        {label}
      </label>)}
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message} Your choices are retained; review and retry.</p>}
    {saved && <p role="status" className="text-sm">Catalogue visibility saved.</p>}
    {canManage && <Button type="submit" disabled={save.isPending || !Object.keys(changes).length}>{save.isPending ? "Saving…" : "Save catalogue visibility"}</Button>}
  </form>;
}

export default function CatalogueVisibilitySettings({ canManage, request = salesSettingsRequest }) {
  const query = useSalesSettings(request);
  return <Card><CardHeader><CardTitle>Catalogue identifiers</CardTitle></CardHeader><CardContent>
    {query.isError && <div role="alert"><p>{query.error.message}</p><Button variant="outline" onClick={() => query.refetch()}>Retry</Button></div>}
    {!(query.data || query.lastConfirmedData) ? !query.isError && <p role="status">Loading catalogue settings…</p>
      : <VisibilityForm key={query.scopeKey} query={query} canManage={canManage && !query.isError} request={request} />}
  </CardContent></Card>;
}
