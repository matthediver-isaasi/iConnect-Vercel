import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { salesSettingsRequest, useSalesSettings } from "./useSalesSettings";
import { quoteNamingErrors, quotePath, resolveQuoteNaming, suggestQuoteSlug } from "@shared/salesNaming.js";

function NamingForm({ query, settings, canManage }) {
  // Null means pristine: a shared-cache update may reconcile that field.
  // Dirty fields stay local, including when another settings card saves.
  const [draft, setDraft] = useState({});
  const [customSegment, setCustomSegment] = useState(false);
  const saved = resolveQuoteNaming(settings);
  const values = {
    quoteSingularName: draft.quoteSingularName ?? saved.singular,
    quotePluralName: draft.quotePluralName ?? saved.plural,
    quoteUrlSegment: draft.quoteUrlSegment ?? saved.slug,
  };
  const patch = { ...values, quoteSingularName: values.quoteSingularName.trim(), quotePluralName: values.quotePluralName.trim() };
  const errors = quoteNamingErrors(patch);
  const dirty = patch.quoteSingularName !== saved.singular || patch.quotePluralName !== saved.plural || patch.quoteUrlSegment !== saved.slug;
  const save = useMutation({
    mutationFn: () => query.patch({ expectedVersion: settings.version, ...patch }),
    onSuccess: async result => {
      await query.accept(result);
      setDraft({});
      setCustomSegment(false);
    },
    onError: async error => {
      if (error.status === 409) await query.refetch();
    },
  });
  const change = (key, value) => {
    save.reset();
    const savedValues = { quoteSingularName: saved.singular, quotePluralName: saved.plural, quoteUrlSegment: saved.slug };
    setDraft(previous => ({
      ...previous,
      [key]: value === savedValues[key] ? null : value,
      ...(key === "quotePluralName" && !customSegment ? {
        quoteUrlSegment: suggestQuoteSlug(value) === saved.slug ? null : suggestQuoteSlug(value),
      } : {}),
    }));
    if (key === "quoteUrlSegment") setCustomSegment(true);
  };
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    if (canManage && query.ready && !query.isFetching && !save.isPending && dirty && !errors.length) save.mutate();
  }}>
    <p className="text-sm text-muted-foreground">Choose how commercial offers are named throughout Sales. These display names do not change permissions, financial records or API endpoints.</p>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="quote-singular-name">Singular name</Label>
        <Input id="quote-singular-name" value={values.quoteSingularName}
          disabled={!canManage || save.isPending} onChange={event => change("quoteSingularName", event.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="quote-plural-name">Plural name</Label>
        <Input id="quote-plural-name" value={values.quotePluralName}
          disabled={!canManage || save.isPending} onChange={event => change("quotePluralName", event.target.value)} />
      </div>
    </div>
    <div className="space-y-2">
      <Label htmlFor="quote-url-segment">URL segment</Label>
      <Input id="quote-url-segment" value={values.quoteUrlSegment} maxLength={100} autoCapitalize="none" spellCheck={false}
        aria-describedby="quote-url-help quote-url-preview"
        disabled={!canManage || save.isPending} onChange={event => change("quoteUrlSegment", event.target.value)} />
      <p id="quote-url-help" className="text-xs text-muted-foreground">Suggested from the plural name until you edit it. Use lowercase letters, digits and single hyphens.</p>
      {canManage && customSegment && <Button type="button" variant="outline" size="sm" disabled={save.isPending} onClick={() => {
        save.reset();
        setCustomSegment(false);
        setDraft(previous => ({ ...previous, quoteUrlSegment: suggestQuoteSlug(values.quotePluralName) }));
      }}>Use suggested URL segment</Button>}
      <p id="quote-url-preview" className="break-all text-sm">Path preview: <code>{quotePath({ slug: values.quoteUrlSegment })}</code></p>
    </div>
    <p className="text-xs text-muted-foreground">The permanent compatibility path <code>/sales/quotes</code> continues to work. Previous custom URL aliases are not retained after you change the segment; update saved bookmarks and internal links. Project task lists are named separately below and are not renamed by these settings.</p>
    {errors.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm text-destructive">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
    {save.error && <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{save.error.status === 409 ? "Sales settings changed elsewhere. Your edits are preserved. Review them and retry saving with the latest version." : save.error.message}</p>
      {save.error.status === 409 && <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh latest settings</Button>}
    </div>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Naming settings saved.</p>}
    {!canManage && <p className="text-xs text-muted-foreground">You need permission to manage Sales settings to make changes.</p>}
    {canManage && <Button type="submit" disabled={!query.ready || query.isFetching || save.isPending || !dirty || errors.length > 0}>
      {save.isPending ? "Saving…" : save.error?.status === 409 ? "Retry saving naming settings" : "Save naming settings"}
    </Button>}
  </form>;
}

export default function QuoteNamingSettings({ canManage, request = salesSettingsRequest }) {
  const query = useSalesSettings(request);
  const settings = query.data || query.lastConfirmedData;
  return <Card><CardHeader><CardTitle>Module naming</CardTitle></CardHeader><CardContent>
    {query.error && <div role="alert" className="mb-4 space-y-2"><p>{query.error.message}</p><Button variant="outline" onClick={() => query.refetch()}>Retry loading settings</Button></div>}
    {settings ? <NamingForm key={query.scopeKey} query={query} settings={settings} canManage={canManage && !query.isError} />
      : !query.error && <div role="status" className="space-y-3"><p>Loading naming settings…</p><div className="h-10 rounded-md bg-muted motion-safe:animate-pulse" /></div>}
  </CardContent></Card>;
}
