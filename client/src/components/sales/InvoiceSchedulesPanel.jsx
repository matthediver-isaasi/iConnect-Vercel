import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { billingValue } from "./billingGroups";
import { billingMoney } from "./BillingSchedule";
import { useInvoiceSchedules } from "./useInvoiceSchedules";
import { invoiceErrorText, invoiceReference, normalizeInvoice } from "@/lib/invoiceStatus";
import { accountingErrorGuidance } from "@/lib/salesAccountingConfiguration";
import { scheduleCommandId, scheduleCustomerMatch } from "./scheduleOperations";
import { useSalesSettingsScope } from "./useSalesSettings";

const label = value => String(value || "pending").replaceAll("_", " ");
const errorText = value => typeof value === "string" ? value : value?.message || (typeof value?.error === "string" ? value.error : value?.error?.message) || value?.details?.message || "";
function CustomerMatchConfirmation({ candidates, rowId, enabled, busy, onConfirm }) {
  const [selected, setSelected] = useState("");
  return <fieldset className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" disabled={!enabled || busy}>
    <legend className="px-1 font-medium text-amber-900">Confirm accounting customer for this group</legend>
    <p className="text-xs text-amber-900">More than one accounting customer matched. Select the intended customer explicitly. This confirmation applies only to this billing group; it does not change the accepted billing recipient.</p>
    {!candidates.length && <p className="text-xs text-amber-900">No customer candidates are available. Reload groups or ask an accounting administrator to review the match before retrying.</p>}
    {candidates.map(candidate => <label key={candidate.providerCustomerId} className="flex cursor-pointer items-start gap-2 rounded-md border bg-background p-3">
      <input type="radio" className="mt-1" name={`schedule-customer-${rowId}`} value={candidate.providerCustomerId} checked={selected === candidate.providerCustomerId} onChange={() => setSelected(candidate.providerCustomerId)} />
      <span className="min-w-0 break-words">{candidate.name || "Accounting customer"}{candidate.email && <span className="block text-xs text-slate-600">{candidate.email}</span>}<span className="block text-xs text-slate-500">Reference: {candidate.providerCustomerId}</span></span>
    </label>)}
    <Button size="sm" className="h-auto min-h-8 w-full whitespace-normal text-left sm:w-auto" disabled={!enabled || busy || !candidates.some(candidate => candidate.providerCustomerId === selected)} onClick={() => {
      if (enabled && !busy && candidates.some(candidate => candidate.providerCustomerId === selected)) onConfirm(selected);
    }}>{busy ? "Processing…" : "Confirm customer and retry this group"}</Button>
    {!enabled && <p className="text-xs text-amber-900">An accounting manager must reload any failed discovery and confirm this selection.</p>}
  </fieldset>;
}

export default function InvoiceSchedulesPanel({ saleId, access, schedules: initial }) {
  const { scopeKey } = useSalesSettingsScope();
  return <ScopedInvoiceSchedulesPanel key={`${scopeKey}-${saleId}`} saleId={saleId} access={access} schedules={initial} />;
}

function ScopedInvoiceSchedulesPanel({ saleId, access, schedules: initial }) {
  const query = useInvoiceSchedules(saleId, access.canViewInvoice, access.canRetryInvoice);
  if (!access.canViewInvoice) return null;
  const payload = query.data?.data || query.data;
  const schedules = Array.isArray(payload) ? payload : payload?.schedules || initial || [];
  const busy = query.retry.isPending || query.refresh.isPending;
  const reloadGroups = () => { query.retry.reset(); query.refresh.reset(); return query.refetch(); };
  return <Card className="border-blue-100"><CardHeader className="flex-row flex-wrap items-center justify-between gap-2"><div><CardTitle>Grouped invoices</CardTitle><p className="mt-1 text-sm text-slate-500">Creation, payment and delivery are tracked separately for every accepted billing group.</p></div><Button variant="outline" disabled={!saleId || query.isFetching || busy} onClick={reloadGroups}>Reload groups</Button></CardHeader>
    <CardContent className="space-y-4">
      {!saleId && <p role="alert" className="text-sm text-amber-800">The accepted sale reference is unavailable. Reload this record to view its billing groups. Manual whole-sale invoicing is disabled.</p>}
      {query.isPending && saleId && !schedules.length && <div role="status" className="space-y-2"><span className="sr-only">Loading invoice groups</span>{[1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />)}</div>}
      {query.error && <div role="alert" className="text-sm text-destructive"><p>{query.error.message} Previously loaded groups are retained; group operations are disabled until reloading succeeds.</p><Button variant="outline" disabled={busy || query.isFetching} onClick={reloadGroups}>Retry loading groups</Button></div>}
      {!query.isPending && !query.error && !schedules.length && <div className="rounded-lg border border-dashed p-5 text-sm text-slate-500">No invoice schedules were returned for this sale. Refresh or ask an administrator to review acceptance; do not create a replacement whole-sale invoice.</div>}
      <ol className="space-y-3">{schedules.map(row => {
        const snapshot = row.snapshot || {};
        const invoice = normalizeInvoice(row.invoice);
        const gross = billingValue(snapshot, "grossMinor", "gross_minor", null);
        const zero = gross !== null && Number(gross) === 0;
        const actionError = [query.retry, query.refresh].filter(mutation => scheduleCommandId(mutation.variables) === row.id)
          .sort((a, b) => b.submittedAt - a.submittedAt)[0]?.error;
        const storedError = billingValue(row, "lastError", "last_error");
        const retryAt = billingValue(row, "retryAt", "retry_at");
        const lastError = actionError ? invoiceErrorText(actionError) : errorText(storedError);
        const match = scheduleCustomerMatch(actionError || storedError);
        const guidance = accountingErrorGuidance(actionError || { payload: storedError || {} });
        const uncertain = /unknown|uncertain|reconcil|review/i.test(`${row.status} ${billingValue(row, "deliveryStatus", "delivery_status")}`);
        const retryAllowed = !uncertain && (billingValue(row, "canRetry", "can_retry", null)
          ?? billingValue(row.permissions, "canRetrySchedule", "can_retry_schedule", null)
          ?? (["failed", "blocked", "creation_failed", "delivery_failed"].includes(row.status)
            || ["failed", "send_failed"].includes(billingValue(row, "deliveryStatus", "delivery_status"))));
        return <li key={row.id} className="space-y-3 rounded-lg border bg-slate-50/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{snapshot.name || row.name || "Billing group"}</h3><p className="mt-1 text-xs text-slate-500">{row.id}</p></div><div className="text-right"><p className="font-semibold">{gross === null ? "Amount unavailable" : billingMoney(gross, snapshot.currency)}</p><Badge variant="outline" className="mt-1 capitalize">{zero ? "No invoice required" : label(row.status)}</Badge></div></div>
          {retryAt && billingValue(row, "deliveryStatus", "delivery_status") === "rejected" && <p className="text-xs text-slate-600">Next delivery retry after <time dateTime={retryAt}>{retryAt}</time>. Reload groups after this time.</p>}
          <dl className="grid gap-3 text-xs sm:grid-cols-3">{[["Planned issue", billingValue(row, "plannedIssueDate", "planned_issue_date")], ["Actual issue", billingValue(row, "issueDate", "issue_date")], ["Payment due", billingValue(row, "dueDate", "due_date")], ["Accounting", label(billingValue(row, "accountingState", "accounting_state", row.status))], ["Payment status", invoice ? label(invoice.status) : "No invoice"], ["Delivery", zero ? "Not required" : label(billingValue(row, "deliveryStatus", "delivery_status"))], ["Invoice", invoice ? invoiceReference(row.invoice) : "Not yet created"]].map(([title, value]) => <div key={title}><dt className="text-slate-500">{title}</dt><dd className="mt-1 break-words font-medium">{value || "Not yet resolved"}</dd></div>)}</dl>
          {lastError && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{lastError}</p>}
          {(guidance || row.status === "blocked") && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><p>{guidance?.message || "Review the blocking error before retrying. Accepted prices, tax and recipient snapshots cannot be rewritten here."}</p><a className="mt-1 inline-block font-semibold text-blue-700 underline" href={`/sales/settings${saleId ? `?saleId=${encodeURIComponent(saleId)}` : ""}`}>Review Sales accounting settings</a></div>}
          {match.ambiguous && !zero && <CustomerMatchConfirmation key={`${query.scopeKey}-${row.id}-${JSON.stringify(match.candidates)}`} candidates={match.candidates} rowId={row.id} enabled={access.canRetryInvoice && query.actionReady && retryAllowed} busy={busy} onConfirm={providerCustomerId => query.retry.mutate({ scheduleId: row.id, providerCustomerId, confirmCustomerMatch: true })} />}
          <div className="flex flex-wrap gap-2">{invoice?.externalUrl && <Button asChild size="sm" variant="outline"><a href={invoice.externalUrl} target="_blank" rel="noreferrer">Open provider invoice</a></Button>}
            {access.canRetryInvoice && retryAllowed && !zero && !match.ambiguous && <Button size="sm" variant="outline" disabled={busy || !query.actionReady} onClick={() => query.retry.mutate(row.id)}>{query.retry.isPending && scheduleCommandId(query.retry.variables) === row.id ? "Retrying…" : "Retry this group"}</Button>}
            {access.canRetryInvoice && invoice && !zero && billingValue(row, "canRefresh", "can_refresh", true) !== false && <Button size="sm" variant="outline" disabled={busy || !query.actionReady} onClick={() => query.refresh.mutate(row.id)}>{query.refresh.isPending && scheduleCommandId(query.refresh.variables) === row.id ? "Refreshing payment status…" : "Refresh payment status"}</Button>}
          </div>
          {uncertain && <p className="text-xs text-amber-800">Outcome requires reconciliation or review. Do not recreate the invoice or resend email manually.</p>}
        </li>;
      })}</ol>
      <p className="text-xs text-slate-500">A single issued group does not mean the sale is fully invoiced. Retries never bypass acceptance, eligibility dates or accounting ownership.</p>
    </CardContent>
  </Card>;
}
