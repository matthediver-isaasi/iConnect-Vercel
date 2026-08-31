import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { missingPrerequisiteLabel, normalizeSalesAccountingConfiguration, serializeSalesAccountingConfiguration } from "@/lib/salesAccountingConfiguration";

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

export default function SalesAccountingSettingsPanel() {
  const queryClient = useQueryClient();
  const configuration = useQuery({
    queryKey: ["sales-accounting-configuration"],
    queryFn: () => request("/api/sales/accounting/configuration"),
  });
  const normalized = normalizeSalesAccountingConfiguration(configuration.data);
  const [draft, setDraft] = useState({ mappings: {}, quickbooksSalesItemId: null });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!configuration.data) return;
    setDraft({ mappings: normalized.mappings, quickbooksSalesItemId: normalized.quickbooksSalesItemId });
  }, [configuration.data]);
  const save = useMutation({
    mutationFn: () => request("/api/sales/accounting/configuration", {
      method: "PATCH",
      body: JSON.stringify(serializeSalesAccountingConfiguration(normalized, draft)),
    }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["sales-accounting-configuration"] });
    },
  });

  if (configuration.isLoading) return <Card><CardContent className="flex items-center gap-2 p-6 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Loading accounting configuration…</CardContent></Card>;
  if (configuration.error) return <Card className="border-rose-200"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-rose-700"><span><AlertTriangle className="mr-2 inline h-4 w-4" />{configuration.error.message}</span><Button variant="outline" onClick={() => configuration.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></CardContent></Card>;

  const isQuickBooks = normalized.providerKey.includes("quickbooks");
  let draftError = null;
  try {
    serializeSalesAccountingConfiguration(normalized, draft);
  } catch (error) {
    draftError = error.message;
  }
  return <Card>
    <CardHeader className="flex-row items-start justify-between gap-3">
      <div><CardTitle>Accounting configuration</CardTitle><p className="mt-1 text-sm text-slate-500">Map Sales tax rates and items to the connected accounting provider.</p></div>
      <Badge className={normalized.isReady ? "border-0 bg-emerald-100 text-emerald-800" : "border-0 bg-amber-100 text-amber-800"}>{normalized.isReady ? "Ready" : "Configuration required"}</Badge>
    </CardHeader>
    <CardContent className="space-y-5">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active provider</p><p className="mt-1 font-medium">{normalized.providerLabel}</p></div>
      {!normalized.isReady && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-medium">Complete these prerequisites before creating invoices:</p>
        <ul className="mt-1 list-disc pl-5">{(normalized.missing.length ? normalized.missing : ["Choose mappings for every required field below."]).map((item, index) => <li key={`${item}-${index}`}>{missingPrerequisiteLabel(item)}</li>)}</ul>
      </div>}
      <div className="grid gap-4 sm:grid-cols-2">
        {normalized.requiredTaxRates.map((rate) => <div key={rate.value}>
          <Label>Tax rate {rate.label}</Label>
          <Select value={String(draft.mappings[rate.value] || "unmapped")} onValueChange={(selected) => setDraft((old) => ({ ...old, mappings: { ...old.mappings, [rate.value]: selected === "unmapped" ? null : selected } }))}>
            <SelectTrigger><SelectValue placeholder="Select provider tax code" /></SelectTrigger>
            <SelectContent><SelectItem value="unmapped">Not mapped</SelectItem>{normalized.availableTaxCodes.map((taxCode) => <SelectItem key={taxCode.id} value={taxCode.id}>{taxCode.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>)}
        {isQuickBooks && <div>
          <Label>QuickBooks sales item</Label>
          <Select value={String(draft.quickbooksSalesItemId || "unmapped")} onValueChange={(selected) => setDraft((old) => ({ ...old, quickbooksSalesItemId: selected === "unmapped" ? null : selected }))}>
            <SelectTrigger><SelectValue placeholder="Select sales item" /></SelectTrigger>
            <SelectContent><SelectItem value="unmapped">Not selected</SelectItem>{normalized.availableItems.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>}
      </div>
      {save.error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{save.error.message}</p>}
      {draftError && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{draftError}</p>}
      {saved && !save.error && <p className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />Accounting configuration saved.</p>}
      <div className="flex justify-end"><Button disabled={save.isPending || Boolean(draftError)} onClick={() => { setSaved(false); save.mutate(); }}>{save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save accounting configuration</Button></div>
    </CardContent>
  </Card>;
}