import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSalesSettingsScope } from "./useSalesSettings";
import { useHistoricalInvoices } from "./useHistoricalInvoices";
import { billingMoney } from "./BillingSchedule";
import { billingValue } from "./billingGroups";

export default function HistoricalInvoices(props) {
  const { scopeKey } = useSalesSettingsScope();
  if (!props.quoteId) return null;
  return <ScopedHistoricalInvoices key={`${scopeKey}-${props.quoteId}-${props.savedRevision}`} {...props} />;
}

function ScopedHistoricalInvoices({ quoteId, canManageAccounting, disabled, hasUnsavedEdits, savedRevision }) {
  const query = useHistoricalInvoices(quoteId, canManageAccounting, disabled || hasUnsavedEdits, savedRevision);
  const [drafts, setDrafts] = useState({});
  const [completed, setCompleted] = useState("");
  const stages = query.data?.stages || [];
  const busy = query.record.isPending;
  const patch = (id, value) => {
    query.record.reset();
    setCompleted("");
    setDrafts(old => ({ ...old, [id]: { ...old[id], ...value } }));
  };
  return <section className="space-y-3 border-t pt-4" aria-label="Historical invoices">
    <div><h3 className="text-sm font-semibold">Historical invoices</h3>
      <p className="mt-1 text-xs text-slate-500">Record an existing invoice against a saved billing stage to prevent a new invoice being issued for it. This cannot be undone here. It does not mark payment as received, verify the invoice with your accounting provider or send email.</p>
    </div>
    {hasUnsavedEdits && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Save your proposal changes first. Historical invoices apply only to saved billing stages.</p>}
    {!canManageAccounting && <p className="text-xs text-slate-500">Manage Accounting permission is required to record historical invoices.</p>}
    {query.isPending && <div role="status" className="space-y-2"><span className="sr-only">Loading saved billing stages</span><div className="h-20 animate-pulse rounded bg-muted" /><div className="h-20 animate-pulse rounded bg-muted" /></div>}
    {query.error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{query.error.message} Reload successfully before recording an invoice.</p><Button type="button" size="sm" variant="outline" disabled={busy || query.isFetching} onClick={() => query.refetch()}>Retry loading billing stages</Button></div>}
    {!query.isPending && !query.error && !stages.length && <p className="rounded-md border border-dashed p-4 text-sm text-slate-500">No saved billing stages are available. Save a staged billing schedule to record existing invoices.</p>}
    <ol className="space-y-3">{stages.map(stage => {
      const linked = stage.invoiceNumber != null;
      const draft = drafts[stage.groupId] || {};
      const snapshot = stage.groupSnapshot;
      const snapshotKey = JSON.stringify(snapshot);
      const confirmed = Boolean(draft.confirmed) && draft.snapshotKey === snapshotKey;
      const gross = billingValue(snapshot, "grossMinor", "gross_minor", null);
      const amount = gross == null ? "Amount unavailable" : `${billingMoney(gross, snapshot.currency)} ${snapshot.currency || "GBP"}`;
      const locked = !query.actionReady || busy || !snapshot;
      return <li key={stage.groupId} className="space-y-2 rounded-md border bg-slate-50/50 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="text-sm font-medium">{stage.name}</h4><p className="text-sm font-semibold tabular-nums">{amount}</p></div>
        {linked ? <div className="space-y-1 text-xs"><p className="font-medium text-emerald-800">Invoicing complete — existing invoice</p><p className="break-words">Invoice reference: <span className="font-semibold">{stage.invoiceNumber}</span></p><p className="text-slate-500">Payment not verified · Delivery not required</p></div>
          : stage.canRecord ? <div className="space-y-2">
            <label className="block text-xs font-medium">Existing invoice number for {stage.name}
              <Input className="mt-1 bg-background" maxLength={100} disabled={locked} value={draft.invoiceNumber || ""} onChange={event => patch(stage.groupId, { invoiceNumber: event.target.value, confirmed: false })} />
            </label>
            <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" disabled={locked} checked={confirmed} onChange={event => patch(stage.groupId, { confirmed: event.target.checked, snapshotKey })} /><span>I confirm the existing invoice covers {stage.name} ({amount}) and no new invoice should be issued for this stage.</span></label>
            <Button type="button" size="sm" variant="outline" className="h-auto min-h-8 whitespace-normal text-left" disabled={locked || !draft.invoiceNumber?.trim() || !confirmed} onClick={() => {
              if (locked || !confirmed) return;
              query.record.mutate({ groupId: stage.groupId, invoiceNumber: draft.invoiceNumber, confirmed }, {
                onSuccess: () => { setDrafts({}); setCompleted(`Existing invoice recorded for ${stage.name}. No new invoice will be issued for this stage.`); },
              });
            }}>{busy && query.record.variables?.groupId === stage.groupId ? "Recording…" : `Record existing invoice for ${stage.name}`}</Button>
          </div> : <p className="text-xs text-slate-500">Recording unavailable — {String(stage.status || "not eligible").replaceAll("_", " ")}. Reload stages if the status has changed.</p>}
      </li>;
    })}</ol>
    {query.record.error && <p role="alert" className="text-sm text-destructive">{query.record.error.message} Reload stages before retrying if the outcome is uncertain.</p>}
    {completed && <p role="status" className="text-sm text-emerald-800">{completed}</p>}
    <Button type="button" size="sm" variant="outline" disabled={busy || query.isFetching} onClick={() => { query.record.reset(); setDrafts({}); setCompleted(""); query.refetch(); }}>Reload billing stages</Button>
  </section>;
}
