import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { AlertCircle, BookOpen, Download, FileSpreadsheet, RefreshCw, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { createPageUrl } from "@/utils";
import { canAccessNmcReport, formatNmcReportDate, NMC_REPORT_ENDPOINT, nmcExportFilename, nmcReasonLabel, nmcReviewGuidance } from "@/lib/nmcMembershipReport.mjs";
import "./NMCMembershipReport.css";

const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const displayCount = value => count(value).toLocaleString("en-GB");
const reasonEntries = values => Object.entries(values || {}).filter(([, value]) => count(value) > 0);

function ReportSkeleton() {
  return <div className="space-y-4 p-4 md:p-6 max-w-7xl mx-auto" role="status" aria-label="Loading NMC membership report" data-testid="nmc-report-loading">
    <Skeleton className="h-9 w-72 max-w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-64 w-full" />
  </div>;
}

export default function NMCMembershipReport() {
  const access = useMemberAccess();
  const { branding, loading: brandingLoading } = useTenantBranding();
  const allowed = !brandingLoading && canAccessNmcReport({ ...access, brandingId: branding?.id });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportController = useRef(null);
  const accessRef = useRef(allowed);
  accessRef.current = allowed;
  useEffect(() => {
    if (!allowed) {
      exportController.current?.abort();
      setExportError("");
    }
    return () => exportController.current?.abort();
  }, [allowed]);

  const query = useQuery({
    queryKey: ["nmc-membership-report", branding?.id, access.memberInfo?.id],
    enabled: allowed,
    queryFn: async ({ signal }) => {
      if (!accessRef.current) throw new Error("Report access is unavailable.");
      const response = await fetch(NMC_REPORT_ENDPOINT, { credentials: "include", signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || `Could not load the report (${response.status}).`);
      if (!body || !Array.isArray(body.sheets) || !body.reportDate || !Number.isFinite(body.total)) throw new Error("The report response was incomplete. Please retry.");
      return body;
    },
    staleTime: 30_000,
    retry: false,
  });

  const downloadExcel = async () => {
    if (!accessRef.current || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError("");
    try {
      const response = await fetch(`${NMC_REPORT_ENDPOINT}?format=xlsx`, { credentials: "include", signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Could not download Excel (${response.status}).`);
      }
      if ((response.headers.get("content-type") || "").includes("application/json")) throw new Error("The server did not return an Excel workbook. Please retry.");
      const blob = await response.blob();
      if (!accessRef.current || controller.signal.aborted) return;
      if (!blob.size) throw new Error("The Excel workbook was empty. Please retry.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = nmcExportFilename(response, query.data?.reportDate);
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (error?.name !== "AbortError" && accessRef.current) setExportError(error?.message || "Could not download the Excel workbook. Please retry.");
    } finally {
      if (exportController.current === controller) {
        exportController.current = null;
        setExporting(false);
      }
    }
  };

  if (brandingLoading || !access.isAccessReady) return <ReportSkeleton />;
  if (!allowed) return <Navigate to={createPageUrl("Events")} replace />;

  const report = query.data;
  const reviews = reasonEntries(report?.reviewCounts);
  const excluded = reasonEntries(report?.excludedCounts);
  return (
    <div className="nmc-report p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="nmc-label mb-2">BNMS · Membership administration</p>
          <h1 className="nmc-heading text-2xl md:text-3xl font-bold flex items-center gap-3" data-testid="text-page-title"><BookOpen className="h-7 w-7 shrink-0" aria-hidden="true" />NMC Membership Report</h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-xl">A read-only journal fulfilment workbook, with separate on-screen diagnostics for membership evidence requiring review.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching || exporting} aria-label="Refresh NMC membership report" data-testid="button-refresh-nmc-report"><RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />Refresh</Button>
          <Button className="nmc-download" onClick={downloadExcel} disabled={exporting || !report || query.isError || query.isFetching} data-testid="button-download-nmc-report"><Download className="h-4 w-4 mr-2" aria-hidden="true" />{exporting ? "Preparing Excel…" : "Download Excel"}</Button>
        </div>
      </header>

      {exportError && <Alert variant="destructive" role="alert"><AlertCircle className="h-4 w-4" /><AlertTitle>Download unsuccessful</AlertTitle><AlertDescription data-testid="text-export-error">{exportError} Use Download Excel to try again.</AlertDescription></Alert>}
      {exporting && <p className="text-sm text-muted-foreground" role="status">Preparing your workbook. Membership records will not be changed.</p>}
      {query.isLoading ? <ReportSkeleton /> : query.isError ? (
        <Alert variant="destructive" role="alert"><AlertCircle className="h-4 w-4" /><AlertTitle>Report could not be loaded</AlertTitle><AlertDescription><p data-testid="text-report-error">{query.error.message}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>Retry report</Button></AlertDescription></Alert>
      ) : report ? (
        <>
          <section className="nmc-summary rounded-xl p-5 md:p-6 flex flex-col md:flex-row md:items-center justify-between gap-6" aria-label="Report summary">
            <div><p className="nmc-label">Report date · UTC</p><p className="text-xl font-semibold mt-2" data-testid="text-report-date"><time dateTime={report.reportDate}>{formatNmcReportDate(report.reportDate)}</time></p><p className="text-xs text-muted-foreground mt-1">Date-only snapshot; no local timezone adjustment.</p></div>
            <div className="md:border-l nmc-rule md:pl-8"><p className="nmc-label">Total workbook records</p><p className="nmc-number text-4xl font-semibold mt-1" data-testid="text-nmc-total">{displayCount(report.total)}</p></div>
            <div className="flex items-start gap-2 max-w-xs text-sm"><ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" /><p>Read-only reporting.<br /><span className="text-muted-foreground">No membership, payment or address data is changed by this report.</span></p></div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-6">
            <Card className="nmc-panel">
              <CardHeader className="pb-3"><CardTitle className="text-lg flex items-center gap-2"><FileSpreadsheet className="h-5 w-5" aria-hidden="true" />Workbook contents</CardTitle><p className="text-sm text-muted-foreground">Four fulfilment worksheets. Review diagnostics are separate and do not appear as rows in the workbook.</p></CardHeader>
              <CardContent>
                {report.total === 0 && <div className="rounded-lg border nmc-rule p-5 mb-4" data-testid="text-nmc-empty"><p className="font-semibold">No fulfilment records in this workbook</p><p className="text-sm text-muted-foreground mt-1">Check the separate review diagnostics, excluded reasons and reporting rules below. Refresh after correcting source records.</p></div>}
                {report.sheets.length ? <div className="overflow-x-auto rounded-lg border nmc-rule"><table className="w-full text-sm" data-testid="table-nmc-sheets"><caption className="sr-only">Excel worksheet record counts</caption><thead className="nmc-sheet-head"><tr><th scope="col" className="px-4 py-3 text-left font-medium">Worksheet</th><th scope="col" className="px-4 py-3 text-right font-medium">Records</th></tr></thead><tbody>{report.sheets.map((sheet, index) => <tr key={`${sheet.name}-${index}`} className="border-t nmc-rule"><th scope="row" className="px-4 py-3 text-left font-medium break-words">{sheet.name}</th><td className="px-4 py-3 text-right tabular-nums">{displayCount(sheet.count)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-muted-foreground py-4">No worksheets were returned.</p>}
              </CardContent>
            </Card>

            <Card className={`nmc-panel ${reviews.length ? "nmc-review" : ""}`}>
              <CardHeader className="pb-3"><CardTitle className="text-lg">Review before fulfilment</CardTitle><p className="text-sm">Review counts are diagnostics, not workbook rows or confirmed journal recipients. Investigate the reasons below in the source membership records; no Review worksheet is included.</p></CardHeader>
              <CardContent>
                {reviews.length ? <ul className="divide-y divide-current/10" data-testid="list-nmc-review-reasons">{reviews.map(([reason, value]) => <li className="py-3 first:pt-0" key={reason}><div className="flex items-start justify-between gap-3"><h3 className="font-semibold text-sm">{nmcReasonLabel(reason)}</h3><Badge variant="outline" className="shrink-0 tabular-nums">{displayCount(value)}</Badge></div><p className="text-sm mt-2 leading-relaxed">{nmcReviewGuidance(reason)}</p></li>)}</ul> : <p className="text-sm py-3" data-testid="text-nmc-no-review">No review reasons reported for this snapshot.</p>}
                <p className="text-xs mt-4 text-muted-foreground">Reason counts are shown as returned by the report; do not assume they are mutually exclusive.</p>
              </CardContent>
            </Card>
          </div>

          <Card className="nmc-panel"><CardHeader className="pb-3"><CardTitle className="text-lg">Excluded records</CardTitle><p className="text-sm text-muted-foreground">Not included in the fulfilment report. These counts explain the exclusions, not additional recipients.</p></CardHeader><CardContent>{excluded.length ? <dl className="divide-y nmc-rule" data-testid="list-nmc-excluded-reasons">{excluded.map(([reason, value]) => <div key={reason} className="flex justify-between gap-4 py-3 first:pt-0"><dt className="text-sm">{nmcReasonLabel(reason)}</dt><dd className="font-semibold tabular-nums">{displayCount(value)}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">No excluded reasons reported for this snapshot.</p>}</CardContent></Card>
        </>
      ) : null}

      <Card className="nmc-panel">
        <CardHeader className="pb-3"><CardTitle className="text-lg">How to read this report</CardTitle><p className="text-sm text-muted-foreground">The rules behind the snapshot. Eligibility is calculated by the report service, not in your browser.</p></CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <dl className="grid grid-cols-1 md:grid-cols-[12rem_minmax(0,1fr)] gap-x-6 gap-y-3">
            <dt className="font-semibold">Dates and active status</dt><dd>The report date is a UTC date-only value. Membership remains Active through the expiry date, including that day.</dd>
            <dt className="font-semibold">90-day inclusion window</dt><dd>The cut-off includes expiry + 90 calendar days. The last day is included. This is exactly 90 days, not three months.</dd>
            <dt className="font-semibold">Completed months</dt><dd>Months since expiry means completed calendar months, with anniversaries clamped to the last day of shorter months. For example, 31 January to 28 February in a non-leap year is one completed month. Active memberships show 0.</dd>
            <dt className="font-semibold">Journal delivery</dt><dd>All non-NMC membership classes are Online-only. Blank address fields remain blank in the workbook; they are never replaced with guessed values.</dd>
          </dl>
          <details className="border-t nmc-rule pt-4" open>
            <summary className="font-semibold">Imported records and Honorary memberships</summary>
            <p className="mt-3 text-muted-foreground">Imported Active status plus a legacy expiry alone is review only, not automatic fulfilment evidence. Check the underlying membership history before resolving it.</p>
            <p className="mt-2 text-muted-foreground">Active Honorary memberships with no expiry and no membership history are recognised as non-expiring.</p>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
