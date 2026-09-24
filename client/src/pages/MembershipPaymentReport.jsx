import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CreditCard, Download, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const FEATURE_ID = "commerce.membership-payment-report";
const MEMBERS_PERMISSION = "crm.members";
const PAGE_SIZE = 25;

const FALLBACK_METHODS = [
  { value: "all", label: "All payment methods" },
  { value: "card", label: "Card" },
  { value: "monthly_card", label: "Monthly card" },
  { value: "direct_debit", label: "Direct Debit" },
  { value: "monthly_direct_debit", label: "Monthly Direct Debit" },
  { value: "upfront", label: "Upfront" },
  { value: "invoice", label: "Invoice" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
];

function humanise(value) {
  if (!value) return "Unknown";
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value) {
  if (!value) return "Unknown";
  const parsed = new Date(String(value).includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function exportFilename(response, method) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  const plain = disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
  let supplied = encoded ? decodeURIComponent(encoded) : quoted || plain;
  supplied = supplied?.split(/[\\/]/).pop().replace(/[\r\n"]/g, "");
  return supplied || `individual-membership-payment-report-${method}.csv`;
}

export default function MembershipPaymentReport() {
  const { isFeatureExcluded, isAccessReady, sessionValidated } = useMemberAccess();
  const [page, setPage] = useState(1);
  const [paymentMethod, setPaymentMethod] = useState("all");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportInFlight = useRef(false);
  const hasReportAccess = isAccessReady && sessionValidated && !isFeatureExcluded(FEATURE_ID);
  const clientCanViewMembers = isAccessReady && !isFeatureExcluded(MEMBERS_PERMISSION);

  useEffect(() => {
    if (isAccessReady && !hasReportAccess) {
      window.location.href = createPageUrl("Events");
    }
  }, [hasReportAccess, isAccessReady]);

  const query = useQuery({
    queryKey: ["membership-payment-report", page, paymentMethod],
    queryFn: async () => {
      const params = new URLSearchParams({
        method: paymentMethod,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const response = await fetch(`/api/admin/membership-payment-report?${params}`, {
        credentials: "include",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Failed to load membership payments");
      return body;
    },
    enabled: hasReportAccess,
    keepPreviousData: true,
    staleTime: 30_000,
  });

  const methods = useMemo(() => {
    const returned = Array.isArray(query.data?.methods) ? query.data.methods : [];
    const byValue = new Map(FALLBACK_METHODS.map((item) => [item.value, item]));
    for (const item of returned) {
      if (item?.value && item?.label) byValue.set(item.value, item);
    }
    return [...byValue.values()];
  }, [query.data?.methods]);
  const methodLabels = useMemo(
    () => new Map(methods.map((method) => [method.value, method.label])),
    [methods],
  );

  const rows = Array.isArray(query.data?.rows) ? query.data.rows : [];
  const total = Number(query.data?.total) || 0;
  const responsePageSize = Number(query.data?.pageSize) || PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / responsePageSize));
  const canViewMembers = clientCanViewMembers && query.data?.canViewMembers === true;

  const changeMethod = (value) => {
    setPaymentMethod(value);
    setPage(1);
    setExportError("");
  };

  const downloadCsv = async () => {
    if (exportInFlight.current) return;
    exportInFlight.current = true;
    setIsExporting(true);
    setExportError("");
    try {
      const params = new URLSearchParams({ format: "csv", method: paymentMethod });
      const response = await fetch(`/api/admin/membership-payment-report?${params}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Failed to export membership payments");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename(response, paymentMethod);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setExportError(error?.message || "Failed to export membership payments");
    } finally {
      exportInFlight.current = false;
      setIsExporting(false);
    }
  };

  if (!hasReportAccess) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <div className="flex items-center gap-2">
          <CreditCard className="h-6 w-6 text-slate-600" />
          <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">
            Individual Membership Payment Report
          </h1>
        </div>
        <p className="mt-1 text-slate-600">
          Current individual membership payment methods and the next evidenced collection date.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="membership-payment-method">Payment method</Label>
              <Select value={paymentMethod} onValueChange={changeMethod}>
                <SelectTrigger id="membership-payment-method" className="w-64" data-testid="select-payment-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((method) => (
                    <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {!query.isLoading && !query.error && (
                <p className="text-sm text-slate-500" data-testid="text-result-count">
                  {total} member{total === 1 ? "" : "s"}
                </p>
              )}
              <Button
                variant="outline"
                onClick={downloadCsv}
                disabled={isExporting}
                data-testid="button-download-payment-report"
              >
                {isExporting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {isExporting ? "Downloading…" : "Download CSV"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {exportError && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription data-testid="text-export-error">{exportError}</AlertDescription>
            </Alert>
          )}
          {query.isLoading ? (
            <div className="space-y-2" data-testid="membership-payment-loading">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : query.error ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription data-testid="text-report-error">{query.error.message}</AlertDescription>
            </Alert>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500" data-testid="text-no-payment-rows">
              No individual memberships match this payment method.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-slate-50 text-left text-slate-600">
                      <th className="px-3 py-2 font-medium">Member</th>
                      <th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 font-medium">Tier</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Payment method</th>
                      <th className="px-3 py-2 font-medium whitespace-nowrap">Next payment</th>
                      <th className="px-3 py-2 font-medium">Schedule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.memberId} className="border-b last:border-0" data-testid={`row-payment-${row.memberId}`}>
                        <td className="px-3 py-2 font-medium">
                          {canViewMembers ? (
                            <Link className="text-primary hover:underline" to={`/members/${encodeURIComponent(row.memberId)}`}>
                              {row.name || "Unknown"}
                            </Link>
                          ) : row.name || "Unknown"}
                        </td>
                        <td className="px-3 py-2">{row.email || "Unknown"}</td>
                        <td className="px-3 py-2">{row.tier || "Unknown"}</td>
                        <td className="px-3 py-2"><Badge variant="outline">{humanise(row.status)}</Badge></td>
                        <td className="px-3 py-2">
                          {methodLabels.get(row.paymentMethod) || humanise(row.paymentMethod)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatDate(row.nextPaymentDate)}</td>
                        <td className="px-3 py-2">{humanise(row.scheduleState)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between gap-3">
                  <Button variant="outline" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={page <= 1 || query.isFetching}>Previous</Button>
                  <span className="text-sm text-slate-600">Page {page} of {totalPages}</span>
                  <Button variant="outline" size="sm" onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                    disabled={page >= totalPages || query.isFetching}>Next</Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}