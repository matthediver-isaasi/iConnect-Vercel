import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSalesSettings } from "./useSalesSettings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { refreshSalesProjects } from "./useSalesProjectTasks";

function SettingsForm({ settings, canManage, request, query }) {
  const [draftName, setName] = useState(null);
  const name = draftName ?? settings.quoteTaskListName ?? "Quote tasks";
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => query.patch({
      expectedVersion: settings.version, quoteTaskListName: name.trim(),
    }),
    onSuccess: async result => {
      await query.accept(result);
      setName(null);
      refreshSalesProjects(qc);
    },
    onError: error => { if (error.status === 409) query.refetch(); },
  });
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (canManage && !save.isPending && name.trim()) save.mutate(); }}>
    <Label htmlFor="quote-task-list-name">Project task list name</Label>
    <Input id="quote-task-list-name" maxLength={100} value={name} disabled={!canManage || save.isPending}
      onChange={event => setName(event.target.value)} />
    <p className="text-sm text-muted-foreground">When a quote is accepted by the customer or by an administrator, enabled products are added as cards to this list on the opportunity’s linked board. The list is created automatically if needed, or reused if an active list has this name. Standard-task opportunities continue to use standard tasks.</p>
    <p className="text-xs text-muted-foreground">Changing the name affects future task creation and retries only. Existing lists and cards are not renamed or moved. The task option must have been enabled when the quote was issued.</p>
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    {canManage && <Button disabled={save.isPending || !name.trim() || name.trim() === settings.quoteTaskListName} type="submit">{save.isPending ? "Saving…" : "Save task settings"}</Button>}
  </form>;
}

export default function QuoteTaskSettings({ canManage, request }) {
  const query = useSalesSettings(request);
  const settings = query.data || query.lastConfirmedData;
  return <Card><CardHeader><CardTitle>Quote acceptance tasks</CardTitle></CardHeader><CardContent>
    {query.error && <div role="alert"><p>{query.error.message}</p><Button variant="outline" onClick={() => query.refetch()}>Retry</Button></div>}
    {!settings ? !query.error && <p role="status">Loading task settings…</p>
      : <SettingsForm key={query.scopeKey} query={query} settings={settings} canManage={canManage && !query.isError} request={request} />}
  </CardContent></Card>;
}
