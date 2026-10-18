import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import AgreementLegalEditor from "./AgreementLegalEditor";
import { salesSettingsRequest, useSalesSettings } from "./useSalesSettings";

function TermsForm({ query, settings, canManage }) {
  // Null is pristine. Unrelated settings saves reconcile the server version,
  // while a dirty template remains local across refreshes and CAS conflicts.
  const [draft, setDraft] = useState(null);
  const saved = typeof settings.partnershipTermsHtml === "string" ? settings.partnershipTermsHtml : "";
  const available = typeof settings.partnershipTermsHtml === "string";
  const value = draft ?? saved;
  const dirty = value !== saved;
  const save = useMutation({
    mutationFn: () => query.patch({ expectedVersion: settings.version, partnershipTermsHtml: value }),
    onSuccess: async result => {
      await query.accept(result);
      setDraft(null);
    },
    onError: async error => {
      if (error.status === 409) await query.refetch();
    },
  });
  const editable = canManage && available && !save.isPending;
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    if (editable && query.ready && !query.isFetching && dirty) save.mutate();
  }}>
    <p className="text-sm text-muted-foreground">Maintain the standard partnership terms for this tenant. Agreement authors insert the saved template as an editable snapshot. Existing quotes and agreements are never changed by a template update.</p>
    {!available && <p role="alert" className="text-sm text-destructive">The partnership terms setting is unavailable. Reload after the Sales settings migration is applied.</p>}
    <AgreementLegalEditor templateMode value={value} disabled={!editable} onChange={html => {
      save.reset();
      const next = html.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|\s/g, "") ? html : "";
      setDraft(next === saved ? null : next);
    }} />
    {!value && <p className="text-sm text-muted-foreground">No standard terms are configured. Agreement authors cannot insert standard terms until a template is saved.</p>}
    {save.error && <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{save.error.status === 409 ? "Sales settings changed elsewhere. Your edits are preserved. Review them and retry saving with the latest version." : save.error.message}</p>
      {save.error.status === 409 && <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh latest settings</Button>}
    </div>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Standard partnership terms saved.</p>}
    {!canManage && <p className="text-xs text-muted-foreground">You need permission to manage Sales settings to make changes.</p>}
    {canManage && <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={!editable || !query.ready || query.isFetching || !dirty}>{save.isPending ? "Saving…" : save.error?.status === 409 ? "Retry saving standard terms" : "Save standard terms"}</Button>
      <Button type="button" variant="outline" disabled={save.isPending || !dirty} onClick={() => { setDraft(null); save.reset(); }}>Discard edits</Button>
    </div>}
  </form>;
}

export default function PartnershipTermsSettings({ canManage, request = salesSettingsRequest }) {
  const query = useSalesSettings(request);
  const settings = query.data || query.lastConfirmedData;
  return <Card><CardHeader><CardTitle>Standard partnership terms</CardTitle></CardHeader><CardContent>
    {query.error && <div role="alert" className="mb-4 space-y-2"><p>{query.error.message}</p><Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry loading settings</Button></div>}
    {settings ? <TermsForm key={query.scopeKey} query={query} settings={settings} canManage={canManage && !query.isError} />
      : !query.error && <div role="status" className="space-y-3"><p>Loading standard partnership terms…</p><div className="h-40 rounded-md bg-muted motion-safe:animate-pulse" /></div>}
  </CardContent></Card>;
}
