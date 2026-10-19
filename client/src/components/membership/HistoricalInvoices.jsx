import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Eye, FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useHistoricalInvoices, useHistoricalInvoiceTenant, HISTORICAL_INVOICES_PAGE_SIZE } from "@/hooks/useHistoricalInvoices";
import { historicalInvoiceFilename } from "./HistoricalDdPayments";

export function formatHistoricalInvoiceDate(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "Unknown";
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return "Unknown";
  return `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
}

export function formatHistoricalInvoiceAmount(amountMinor, currency) {
  if (!Number.isInteger(amountMinor)) return "—";
  if (!currency) return `${(amountMinor / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (currency not supplied)`;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} (currency not supplied)`;
  }
}

export function historicalInvoiceUrl(recordId, inline = false) {
  return `/api/membership/historical-invoice?${new URLSearchParams({ recordId, inline: String(inline) })}`;
}

export function historicalStoredInvoiceFilename(disposition, record) {
  return historicalInvoiceFilename(disposition, {
    id: record.id,
    xero_invoice_number: record.invoice_number,
  }).replace(/^historical-dd-invoice-/, "historical-invoice-");
}

export function HistoricalInvoicesTable({ records, canAccessInvoices, tenantId, request = fetch }) {
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [preview, setPreview] = useState(null);
  const mounted = useRef(false);
  const controllers = useRef(new Set());
  const previewUrl = useRef(null);
  const busyRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllers.current.forEach(controller => controller.abort());
      controllers.current.clear();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);

  const closePreview = () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setPreview(null);
  };
  const download = (url, filename) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const runAction = async (record, action) => {
    if (!canAccessInvoices || record.can_download !== true || busyRef.current) return;
    busyRef.current = true;
    setBusy({ id: record.id, action });
    setActionError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const response = await request(historicalInvoiceUrl(record.id, action === "view"), {
        credentials: "include",
        signal: controller.signal,
        headers: tenantId ? { "X-Tenant-Id": tenantId } : {},
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Historical invoice could not be accessed");
      }
      const blob = await response.blob();
      if (!blob.size || (blob.type && !["application/pdf", "application/octet-stream"].includes(blob.type.split(";")[0]))) {
        throw new Error("The historical invoice response was not a PDF");
      }
      if (!mounted.current || controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const filename = historicalStoredInvoiceFilename(response.headers?.get?.("content-disposition"), record);
      if (action === "view") {
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = objectUrl;
        setPreview({ objectUrl, filename, number: record.invoice_number });
      } else {
        try { download(objectUrl, filename); } finally { URL.revokeObjectURL(objectUrl); }
      }
    } catch (error) {
      if (mounted.current && error?.name !== "AbortError") {
        setActionError({ id: record.id, action, message: error.message || "Historical invoice could not be accessed" });
      }
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm" data-testid="table-historical-invoices">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="p-3 text-left">Date &amp; description</th>
              <th scope="col" className="p-3 text-left">Invoice number</th>
              <th scope="col" className="p-3 text-left">Kind &amp; status</th>
              <th scope="col" className="p-3 text-right">Amount</th>
              <th scope="col" className="p-3 text-left">Document</th>
            </tr>
          </thead>
          <tbody>{records.map(record => (
            <tr key={record.id} className="border-t align-top" data-testid={`row-historical-invoice-${record.id}`}>
              <td className="p-3 min-w-[180px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{formatHistoricalInvoiceDate(record.invoice_date)}</span>
                  <Badge variant="secondary">Historical</Badge>
                </div>
                <p className="mt-1 text-muted-foreground">{record.description || "Description not supplied"}</p>
              </td>
              <td className="p-3">
                {canAccessInvoices && record.can_download === true ? (
                  <Button variant="link" className="h-auto p-0" disabled={!!busy}
                    onClick={() => runAction(record, "view")}>
                    {record.invoice_number || "View invoice"}
                  </Button>
                ) : (record.invoice_number || "Not supplied")}
              </td>
              <td className="p-3">
                <p>{({ invoice: "Invoice", credit: "Credit", overpayment: "Overpayment" })[record.record_kind] || "Unknown kind"}</p>
                <Badge variant="outline" className="mt-1">
                  {record.accounting_status_checked_at
                    ? record.accounting_payment_status || record.accounting_status || "Unknown status"
                    : record.status || "Unknown status"}
                </Badge>
                {record.accounting_status_checked_at && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Xero checked {formatHistoricalInvoiceDate(record.accounting_status_checked_at.slice(0, 10))}
                    {record.accounting_status_refresh_pending ? " · refresh pending" : ""}
                  </p>
                )}
                {record.status && record.accounting_status_checked_at && (
                  <p className="mt-1 text-xs text-muted-foreground">Imported status: {record.status}</p>
                )}
                {!record.accounting_status_checked_at && record.record_kind === "invoice" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Xero status not yet verified{record.accounting_status_refresh_pending ? " · refresh pending" : ""}
                  </p>
                )}
              </td>
              <td className="p-3 text-right">{formatHistoricalInvoiceAmount(record.amount_minor, record.currency)}</td>
              <td className="p-3 min-w-[175px]">
                {canAccessInvoices && record.can_download === true ? (
                  <div className="flex flex-wrap gap-2">
                    {["view", "download"].map(action => (
                      <Button key={action} type="button" variant="outline" size="sm" disabled={!!busy}
                        aria-label={`${action === "view" ? "View" : "Download"} invoice ${record.invoice_number || record.id}`}
                        aria-busy={busy?.id === record.id && busy.action === action}
                        onClick={() => runAction(record, action)}>
                        {action === "view" ? <Eye className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                        {busy?.id === record.id && busy.action === action ? "Loading…" : action === "view" ? "View" : "Download"}
                      </Button>
                    ))}
                  </div>
                ) : <p className="text-xs text-muted-foreground">{canAccessInvoices ? "Document unavailable" : "Invoice access denied"}</p>}
                {actionError?.id === record.id && (
                  <div role="alert" className="mt-2 space-y-2 text-xs text-destructive">
                    <p>{actionError.message}</p>
                    <Button type="button" variant="outline" size="sm" disabled={!!busy}
                      onClick={() => runAction(record, actionError.action)}>Retry</Button>
                  </div>
                )}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Imported historical records are read-only. They do not establish current membership entitlement or change payment status.</p>
      <Dialog open={!!preview} onOpenChange={open => { if (!open) closePreview(); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Invoice {preview?.number || ""}</DialogTitle>
            <DialogDescription>Historical invoice PDF</DialogDescription>
          </DialogHeader>
          {preview && <>
            <iframe title={`Historical invoice ${preview.number || "PDF"}`} className="h-[70vh] w-full rounded border"
              src={`${preview.objectUrl}#view=Fit&navpanes=0&toolbar=0`} />
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={() => download(preview.objectUrl, preview.filename)}>
                <Download className="h-4 w-4" />Download
              </Button>
            </div>
          </>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HistoricalInvoicesContent({ memberId, tenantId, embedded, request }) {
  const [page, setPage] = useState(0);
  const { data, isLoading, isFetching, error, refetch } = useHistoricalInvoices({
    memberId, page, activeTenantId: tenantId, request,
  });
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / HISTORICAL_INVOICES_PAGE_SIZE));
  const body = isLoading ? (
    <div role="status" aria-label="Loading historical invoices" className="space-y-3 animate-pulse">
      {[0, 1, 2].map(row => <div key={row} className="h-12 rounded bg-muted" />)}
      <span className="sr-only">Loading historical invoices…</span>
    </div>
  ) : error ? (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4" /><span>{error.message}</span>
      <Button type="button" size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()}>Retry</Button>
    </div>
  ) : (
    <>
      {data?.records.length ? (
        <HistoricalInvoicesTable key={page} records={data.records} canAccessInvoices={data.canAccessInvoices} tenantId={tenantId} request={request} />
      ) : <p className="py-6 text-center text-sm text-muted-foreground">No historical invoices found{page > 0 ? " on this page" : ""}.</p>}
      {(totalPages > 1 || page > 0) && (
        <nav aria-label="Historical invoice pages" className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Page {page + 1} of {totalPages} · {data?.total || 0} records</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={page === 0 || isFetching} onClick={() => setPage(value => value - 1)}>
              <ChevronLeft className="h-4 w-4" />Previous
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={page + 1 >= totalPages || isFetching} onClick={() => setPage(value => value + 1)}>
              Next<ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </nav>
      )}
    </>
  );
  if (embedded) return <section className="space-y-3" data-testid="historical-invoices-embedded"><h3 className="text-sm font-medium">Historical invoices</h3>{body}</section>;
  return (
    <Card data-testid="card-historical-invoices">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" />Historical invoices</CardTitle></CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

export default function HistoricalInvoices({ memberId, activeTenantId = null, embedded = false, request = fetch }) {
  const tenantId = useHistoricalInvoiceTenant(activeTenantId);
  if (!memberId) return null;
  return <HistoricalInvoicesContent key={`${tenantId || "portal"}:${memberId}`} memberId={memberId} tenantId={tenantId} embedded={embedded} request={request} />;
}
