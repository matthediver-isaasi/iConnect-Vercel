import React, { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Download, Eye, History, Loader2 } from "lucide-react";
import MonthlyCollectionTable from "./MonthlyCollectionTable";

export function formatHistoricalDdAmount(amountMinor, currency = "GBP") {
  if (!Number.isInteger(amountMinor)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}

export function formatHistoricalDdDate(value, options = {}) {
  const date = value ? new Date(`${String(value).slice(0, 10)}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-GB", {
    month: options.monthOnly ? "long" : "short",
    year: "numeric",
    ...(options.monthOnly ? {} : { day: "numeric" }),
    timeZone: "UTC",
  });
}

export function historicalInvoiceFilename(contentDisposition, payment) {
  const clean = (value) => String(value)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const fallback = clean(
    `historical-dd-invoice-${payment?.xero_invoice_number || payment?.id || "download"}.pdf`,
  );
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition || "")?.[1];
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(contentDisposition || "")?.[1];
  const unquoted = /filename\s*=\s*([^;\s]+)/i.exec(contentDisposition || "")?.[1];
  let candidate = encoded || quoted || unquoted || fallback;
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = fallback;
    }
  }
  candidate = clean(candidate);
  if (!candidate || candidate === "." || candidate === "..") candidate = fallback;
  return candidate.toLowerCase().endsWith(".pdf") ? candidate : `${candidate}.pdf`;
}

async function invoiceError(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  return new Error(payload.error || fallback);
}

export function HistoricalDdPaymentsTable({ payments, request = fetch }) {
  const [loading, setLoading] = useState(null);
  const [invoiceErrorMessage, setInvoiceErrorMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const mountedRef = useRef(false);
  const controllersRef = useRef(new Set());
  const previewUrlRef = useRef(null);

  const revokePreview = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current.clear();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, []);

  const fetchInvoice = async (payment, inline, controller) => {
    const params = new URLSearchParams({ recordId: payment.id });
    if (inline) params.set("inline", "true");
    const response = await request(`/api/membership/historical-dd-invoice?${params.toString()}`, {
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw await invoiceError(
        response,
        inline ? "Failed to load historical invoice" : "Failed to download historical invoice",
      );
    }
    const blob = await response.blob();
    return {
      blob,
      filename: historicalInvoiceFilename(
        response.headers?.get?.("content-disposition"),
        payment,
      ),
    };
  };

  const runInvoiceAction = async (payment, action) => {
    const inline = action === "view";
    setInvoiceErrorMessage(null);
    setLoading({ id: payment.id, action });
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      const result = await fetchInvoice(payment, inline, controller);
      if (!mountedRef.current || controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(result.blob);
      if (inline) {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = objectUrl;
        setPreview({
          objectUrl,
          filename: result.filename,
          invoiceNumber: payment.xero_invoice_number,
        });
      } else {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = result.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
      }
    } catch (error) {
      if (error?.name !== "AbortError" && mountedRef.current) {
        setInvoiceErrorMessage({
          id: payment.id,
          message: error?.message || "Failed to access historical invoice",
        });
      }
    } finally {
      controllersRef.current.delete(controller);
      if (mountedRef.current) setLoading(null);
    }
  };

  const downloadPreview = () => {
    if (!preview?.objectUrl) return;
    const link = document.createElement("a");
    link.href = preview.objectUrl;
    link.download = preview.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <div className="space-y-2">
      <MonthlyCollectionTable testId="table-historical-dd">
          {payments.map((payment) => (
            <tr className="border-b last:border-0" key={payment.id} data-testid={`row-historical-dd-${payment.id}`}>
              <td className="p-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span>{formatHistoricalDdDate(payment.charge_date)}</span>
                  <span className="text-xs text-muted-foreground">Collection</span>
                  <Badge variant="secondary">{payment.provider_status === "paid_out" ? "Paid out" : payment.provider_status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Nominal period: {formatHistoricalDdDate(payment.period, { monthOnly: true })}
                  {" · "}Imported historical payment
                </p>
              </td>
              <td className="p-2 text-right whitespace-nowrap">
                {formatHistoricalDdAmount(payment.amount_minor, payment.currency)}
              </td>
              <td className="p-2">
                <Badge variant="outline">Imported evidence</Badge>
              </td>
              <td className="p-2">
                <div className="space-y-2">
                  <span>{payment.xero_invoice_number || "—"}</span>
                  {payment.invoice_available && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!!loading}
                        aria-label={`View invoice ${payment.xero_invoice_number || payment.id}`}
                        aria-busy={loading?.id === payment.id && loading.action === "view"}
                        data-testid={`button-view-historical-dd-invoice-${payment.id}`}
                        onClick={() => runInvoiceAction(payment, "view")}
                      >
                        {loading?.id === payment.id && loading.action === "view"
                          ? <Loader2 className="animate-spin" />
                          : <Eye />}
                        View
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!!loading}
                        aria-label={`Download invoice ${payment.xero_invoice_number || payment.id}`}
                        aria-busy={loading?.id === payment.id && loading.action === "download"}
                        data-testid={`button-download-historical-dd-invoice-${payment.id}`}
                        onClick={() => runInvoiceAction(payment, "download")}
                      >
                        {loading?.id === payment.id && loading.action === "download"
                          ? <Loader2 className="animate-spin" />
                          : <Download />}
                        Download
                      </Button>
                    </div>
                  )}
                  {invoiceErrorMessage?.id === payment.id && (
                    <div
                      className="flex items-start gap-1 text-xs text-destructive"
                      role="alert"
                      data-testid={`historical-dd-invoice-error-${payment.id}`}
                    >
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{invoiceErrorMessage.message}</span>
                    </div>
                  )}
                </div>
              </td>
            </tr>
          ))}
      </MonthlyCollectionTable>
      <p className="p-3 text-xs text-muted-foreground border-t">
        Imported historical records are read-only and never trigger a collection, retry, refund or accounting action.
      </p>
      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) revokePreview(); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              Invoice {preview?.invoiceNumber || ""}
            </DialogTitle>
            <DialogDescription>
              Historical invoice PDF
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <iframe
                className="h-[70vh] w-full rounded border"
                src={`${preview.objectUrl}#view=Fit&navpanes=0&toolbar=0`}
                title={`Invoice ${preview.invoiceNumber || "PDF"}`}
                data-testid="historical-dd-invoice-preview"
              />
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={downloadPreview}>
                  <Download />
                  Download
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function HistoricalDdPayments({
  memberId,
  embedded = false,
  monthlyHistory = false,
  request = fetch,
  activeTenantId = null,
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["historical-dd-payments", activeTenantId, memberId],
    queryFn: async () => {
      const response = await request(`/api/membership/historical-dd?memberId=${encodeURIComponent(memberId)}`, {
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to load historical Direct Debit payments");
      if (!Array.isArray(payload.payments)) throw new Error("Invalid historical Direct Debit response");
      return payload.payments;
    },
    enabled: !!memberId,
    retry: false,
  });

  if (!memberId) return null;
  if (isLoading) return monthlyHistory
    ? <p className="text-sm text-muted-foreground" role="status">Loading monthly collection history…</p>
    : null;
  const body = error ? (
    <div className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="historical-dd-error">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{error.message}</span>
    </div>
  ) : !data?.length ? null : (
    <HistoricalDdPaymentsTable
      key={`${activeTenantId || "portal"}:${memberId}`}
      payments={data}
      request={request}
    />
  );

  if (!body) return null;
  if (embedded) return (
    <div className="space-y-2 mb-4" data-testid="historical-dd-embedded">
      {monthlyHistory && <p className="text-sm font-medium">Monthly instalment history</p>}
      {body}
    </div>
  );
  return (
    <Card data-testid="card-historical-dd">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="w-4 h-4" />
          Historical Direct Debit payments
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}