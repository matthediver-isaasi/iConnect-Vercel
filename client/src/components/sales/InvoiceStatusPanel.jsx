import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FileText, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ambiguousCustomerCandidates, historicalInvoices, invoiceErrorText, invoicePermissions, invoiceReference, normalizeInvoice } from "@/lib/invoiceStatus";
import { accountingErrorGuidance } from "@/lib/salesAccountingConfiguration";

const detailText = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name || value.displayName || value.display_name || "";
};

export default function InvoiceStatusPanel({ invoice, invoices, activeProvider, permissions, error, onCreate, onRetry, onRefresh }) {
  const access = invoicePermissions(permissions);
  const normalized = normalizeInvoice(invoice);
  const history = access.canViewInvoice ? historicalInvoices(invoices, invoice) : [];
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState(null);
  const [providerCustomerId, setProviderCustomerId] = useState("");
  const visibleInvoice = access.canViewInvoice ? normalized : null;
  const canRetry = access.canRetryInvoice && Boolean(onRetry || onCreate);
  const canCreate = access.canCreateInvoice && !normalized && Boolean(onCreate);
  const externalGuidance = accountingErrorGuidance(error) || accountingErrorGuidance({ payload: visibleInvoice?.raw });
  if (!visibleInvoice && !history.length && !canCreate && !canRetry && !externalGuidance) return null;

  const run = async (name, action, command = {}) => {
    setPendingAction(name);
    setActionError(null);
    try {
      await action(command);
    } catch (error) {
      setActionError(error);
    } finally {
      setPendingAction("");
    }
  };
  const busy = Boolean(pendingAction);
  const effectiveError = actionError || (externalGuidance ? error : null);
  const status = visibleInvoice?.status || (effectiveError ? "error" : "not created");
  const candidates = ambiguousCustomerCandidates(effectiveError);
  const configurationGuidance = accountingErrorGuidance(effectiveError) || externalGuidance;

  return <Card className="border-blue-100">
    <CardHeader className="flex-row items-center justify-between gap-3">
      <div>
        <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5 text-blue-600" />Invoice</CardTitle>
        <p className="mt-1 text-sm text-slate-500">Invoice creation and accounting status.</p>
      </div>
      <Badge variant="outline" className="capitalize">{status.replaceAll("_", " ")}</Badge>
    </CardHeader>
    <CardContent className="space-y-4">
      {visibleInvoice && <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Provider</p><p className="mt-1 font-medium">{visibleInvoice.provider === "Accounting provider" ? detailText(activeProvider) || visibleInvoice.provider : visibleInvoice.provider}</p></div>
        <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Invoice</p><p className="mt-1 font-medium">{invoiceReference(invoice)}</p></div>
        <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Created</p><p className="mt-1">{visibleInvoice.createdAt ? new Date(visibleInvoice.createdAt).toLocaleString() : "—"}{detailText(visibleInvoice.createdBy) ? ` by ${detailText(visibleInvoice.createdBy)}` : ""}</p></div>
      </div>}
      {visibleInvoice?.creationDetail && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{detailText(visibleInvoice.creationDetail) || String(visibleInvoice.creationDetail)}</p>}
      {(visibleInvoice?.error || effectiveError) && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{effectiveError ? invoiceErrorText(effectiveError) : (detailText(visibleInvoice.error) || String(visibleInvoice.error))}</div>}
      {configurationGuidance && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{configurationGuidance.message}</p><Link className="mt-1 inline-block font-semibold text-blue-700 hover:underline" to={configurationGuidance.href}>Open Sales settings</Link></div>}
      {candidates.length > 0 && <fieldset className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        <legend className="px-1 font-medium text-amber-900">Choose the customer to use</legend>
        <p className="mb-2 text-amber-800">More than one customer matched. Confirm the intended customer before creating the invoice.</p>
        <div className="space-y-2">{candidates.map((candidate) => <label key={candidate.providerCustomerId} className="flex cursor-pointer items-center gap-2 rounded border bg-white p-2">
          <input type="radio" name="invoice-customer-match" value={candidate.providerCustomerId} checked={providerCustomerId === candidate.providerCustomerId} onChange={() => setProviderCustomerId(candidate.providerCustomerId)} />
          <span>{candidate.name || "Customer"}{candidate.email ? <span className="text-slate-500"> · {candidate.email}</span> : ""}</span>
        </label>)}</div>
        <Button className="mt-3" disabled={busy || !providerCustomerId} onClick={() => run("confirm-customer", onCreate || onRetry, { providerCustomerId, confirmCustomerMatch: true })}>{pendingAction === "confirm-customer" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Confirm customer and create invoice</Button>
      </fieldset>}
      {visibleInvoice?.pending && <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Invoice creation is in progress.</p>}
      <div className="flex flex-wrap gap-2">
        {canCreate && <Button disabled={busy} onClick={() => run("create", onCreate)}>{pendingAction === "create" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create invoice</Button>}
        {canRetry && (visibleInvoice?.failed || effectiveError || !normalized) && <Button disabled={busy} onClick={() => run("retry", onRetry || onCreate)}>{pendingAction === "retry" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Retry invoice creation</Button>}
        {visibleInvoice?.externalUrl && <Button variant="outline" asChild><a href={visibleInvoice.externalUrl} target="_blank" rel="noreferrer">View in {visibleInvoice.provider}<ExternalLink className="ml-2 h-4 w-4" /></a></Button>}
        {visibleInvoice && onRefresh && <Button variant="outline" disabled={busy || visibleInvoice.pending} onClick={() => run("refresh", onRefresh)}>{pendingAction === "refresh" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Refresh status</Button>}
      </div>
      {history.length > 0 && <div className="border-t pt-4">
        <p className="mb-2 text-sm font-semibold">Previous provider invoices</p>
        <div className="space-y-2">{history.map((historical, index) => <div key={historical.id || `${historical.provider}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-slate-50 p-3 text-sm">
          <div><p className="font-medium">{historical.provider}</p><p className="text-slate-600">{invoiceReference(historical.raw)} · {historical.createdAt ? new Date(historical.createdAt).toLocaleString() : "Creation time unavailable"}</p></div>
          <div className="flex items-center gap-2"><Badge variant="outline" className="capitalize">{historical.status.replaceAll("_", " ")}</Badge>{historical.externalUrl && <Button variant="outline" size="sm" asChild><a href={historical.externalUrl} target="_blank" rel="noreferrer">Open invoice<ExternalLink className="ml-2 h-3.5 w-3.5" /></a></Button>}</div>
        </div>)}</div>
      </div>}
    </CardContent>
  </Card>;
}