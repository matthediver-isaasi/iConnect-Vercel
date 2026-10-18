import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { salesSettingsRequest, useSalesSettings } from "./useSalesSettings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { refreshSalesProjects } from "./useSalesProjectTasks";
import { resolveQuoteNaming } from "@shared/salesNaming.js";

function SettingsForm({ query, settings, canManage }) {
  const [draft, setDraft] = useState(null);
  const name = draft ?? settings.quoteTaskListName ?? "Quote tasks";
  const dirty = name.trim() !== (settings.quoteTaskListName ?? "Quote tasks");
  const naming = resolveQuoteNaming(settings);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => query.patch({
      expectedVersion: settings.version, quoteTaskListName: name.trim(),
    }),
    onSuccess: async result => {
      await query.accept(result);
      setDraft(null);
      refreshSalesProjects(qc);
    },
    onError: async error => {
      if (error.status === 409) await query.refetch();
    },
  });
  return <form className="space-y-3" onSubmit={event => {
    event.preventDefault();
    if (canManage && query.ready && !query.isFetching && !save.isPending && name.trim() && [...name.trim()].length <= 100 && dirty) save.mutate();
  }}>
    <Label htmlFor="quote-task-list-name">Project task list name</Label>
    <Input id="quote-task-list-name" maxLength={100} value={name} disabled={!canManage || save.isPending}
      onChange={event => { setDraft(event.target.value === (settings.quoteTaskListName ?? "Quote tasks") ? null : event.target.value); save.reset(); }} />
    <p className="text-sm text-muted-foreground">When a {naming.singular.toLowerCase()} is accepted by the customer or by an administrator, enabled products are added as cards to this list on the opportunity’s linked board. The list is created automatically if needed, or reused if an active list has this name. Standard-task opportunities continue to use standard tasks.</p>
    <p className="text-xs text-muted-foreground">Changing the name affects future task creation and retries only. Existing lists and cards are not renamed or moved. The task option must have been enabled when the {naming.singular.toLowerCase()} was issued.</p>
    {(!name.trim() || [...name.trim()].length > 100) && <p role="alert" className="text-sm text-destructive">Project task list name must contain 1–100 characters.</p>}
    {save.error && <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{save.error.message}{save.error.status === 409 && " Sales settings changed elsewhere. Your task list name is preserved. Review it and retry saving with the latest version."}</p>
      {save.error.status === 409 && <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh latest settings</Button>}
    </div>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Task settings saved.</p>}
    {!canManage && <p className="text-xs text-muted-foreground">You need permission to manage Sales settings to make changes.</p>}
    {canManage && <Button disabled={!query.ready || query.isFetching || save.isPending || !name.trim() || [...name.trim()].length > 100 || !dirty} type="submit">{save.isPending ? "Saving…" : save.error?.status === 409 ? "Retry saving task settings" : "Save task settings"}</Button>}
  </form>;
}

export default function QuoteTaskSettings({ canManage, request = salesSettingsRequest }) {
  const query = useSalesSettings(request);
  const settings = query.data || query.lastConfirmedData;
  const naming = resolveQuoteNaming(settings);
  return <Card><CardHeader><CardTitle>{naming.singular} acceptance tasks</CardTitle></CardHeader><CardContent>
    {query.error && <div role="alert" className="mb-4 space-y-2"><p>{query.error.message}</p><Button variant="outline" onClick={() => query.refetch()}>Retry</Button></div>}
    {settings ? <SettingsForm key={query.scopeKey} query={query} settings={settings} canManage={canManage && !query.isError} />
      : !query.error && <div role="status" className="space-y-3"><p>Loading task settings…</p><div className="h-10 rounded-md bg-muted motion-safe:animate-pulse" /></div>}
  </CardContent></Card>;
}
