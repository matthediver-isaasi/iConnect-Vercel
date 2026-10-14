import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
const sameClasses = (a, b) => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
const validSettings = settings => settings && Array.isArray(settings.printedClasses) && Array.isArray(settings.onlineClasses) && Number.isInteger(settings.revision);

function ClassCounts({ title, rows, testId }) {
  return <section className="mt-5" aria-label={title}>
    <h3 className="font-semibold text-sm mb-2">{title}</h3>
    <div className="overflow-x-auto rounded-lg border nmc-rule"><table className="w-full text-sm" data-testid={testId}>
      <caption className="sr-only">{title} record counts</caption>
      <thead className="nmc-sheet-head"><tr><th scope="col" className="px-4 py-3 text-left font-medium">Member class</th><th scope="col" className="px-4 py-3 text-right font-medium">Records</th></tr></thead>
      <tbody>{rows?.length ? rows.map(row => <tr key={row.value} className="border-t nmc-rule"><th scope="row" className="px-4 py-3 text-left font-medium">{row.label || row.value}</th><td className="px-4 py-3 text-right tabular-nums">{displayCount(row.count)}</td></tr>) : <tr><td colSpan={2} className="px-4 py-3 text-muted-foreground">No member classes reported in this group.</td></tr>}</tbody>
    </table></div>
  </section>;
}

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
  const [tab, setTab] = useState("report");
  const [savedSettings, setSavedSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsSuccess, setSettingsSuccess] = useState("");
  const [conflict, setConflict] = useState(false);
  const queryClient = useQueryClient();
  const dirty = !!(draft && savedSettings && (!sameClasses(draft.printedClasses, savedSettings.printedClasses) || !sameClasses(draft.onlineClasses, savedSettings.onlineClasses)));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const settingsController = useRef(null);
  const exportController = useRef(null);
  const accessRef = useRef(allowed);
  accessRef.current = allowed;
  useEffect(() => {
    if (!allowed) {
      exportController.current?.abort();
      settingsController.current?.abort();
      setExportError("");
    }
    return () => { exportController.current?.abort(); settingsController.current?.abort(); };
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
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (validSettings(query.data?.settings) && !dirtyRef.current && !settingsController.current) {
      setSavedSettings(query.data.settings);
      setDraft(query.data.settings);
    }
  }, [query.data]);

  const selectClass = (group, value, selected) => {
    if (settingsController.current || exporting || query.isFetching) return;
    const other = group === "printedClasses" ? "onlineClasses" : "printedClasses";
    setDraft(previous => ({
      ...previous,
      [group]: selected ? [...new Set([...previous[group], value])] : previous[group].filter(item => item !== value),
      [other]: selected ? previous[other].filter(item => item !== value) : previous[other],
    }));
    setSettingsSuccess("");
    setSettingsError("");
  };

  const saveSettings = async () => {
    if (!accessRef.current || !dirty || conflict || settingsController.current || exporting || query.isFetching || draft.printedClasses.some(value => draft.onlineClasses.includes(value))) return;
    const controller = new AbortController();
    settingsController.current = controller;
    setSaving(true);
    setSettingsError("");
    setSettingsSuccess("");
    try {
      const response = await fetch(NMC_REPORT_ENDPOINT, {
        method: "PUT", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printedClasses: draft.printedClasses, onlineClasses: draft.onlineClasses, revision: savedSettings.revision }),
      });
      const body = await response.json().catch(() => null);
      if (!accessRef.current || controller.signal.aborted) return;
      if (response.status === 409) {
        setConflict(true);
        throw new Error("Another administrator changed the journal settings. Reload saved settings before making further changes. Reloading will discard your unsaved selections.");
      }
      if (!response.ok) throw new Error(body?.error || `Could not save journal settings (${response.status}).`);
      if (!validSettings(body?.settings)) {
        setConflict(true);
        throw new Error("The save response was incomplete. Reload saved settings before trying again.");
      }
      setSavedSettings(body.settings);
      setDraft(body.settings);
      dirtyRef.current = false;
      queryClient.setQueryData(["nmc-membership-report", branding?.id, access.memberInfo?.id], old => old ? { ...old, settings: body.settings } : old);
      const refreshed = await query.refetch();
      if (!accessRef.current || controller.signal.aborted) return;
      if (!refreshed.isError && validSettings(refreshed.data?.settings)) {
        setSavedSettings(refreshed.data.settings);
        setDraft(refreshed.data.settings);
      }
      setSettingsSuccess(refreshed.isError ? "Journal settings saved. The report could not be refreshed; retry the report before downloading." : "Journal settings saved. The report now uses these selections.");
    } catch (error) {
      if (error?.name !== "AbortError" && accessRef.current) setSettingsError(error?.message || "Could not save journal settings. Please retry.");
    } finally {
      if (settingsController.current === controller) {
        settingsController.current = null;
        setSaving(false);
      }
    }
  };

  const reloadSettings = async () => {
    if (!accessRef.current || saving || query.isFetching) return;
    setSettingsError("");
    const refreshed = await query.refetch();
    if (!accessRef.current) return;
    if (refreshed.isError || !validSettings(refreshed.data?.settings)) {
      setSettingsError("Could not reload saved settings. Your unsaved selections have been kept. Please retry.");
      return;
    }
    setSavedSettings(refreshed.data.settings);
    setDraft(refreshed.data.settings);
    dirtyRef.current = false;
    setConflict(false);
    setSettingsSuccess("Saved settings reloaded. Review the selections before editing again.");
  };

  const downloadExcel = async () => {
    if (!accessRef.current || exportController.current || dirtyRef.current || settingsController.current || conflict || query.isFetching || query.isError) return;
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
  const pending = reasonEntries(report?.pendingCounts);
  const excluded = reasonEntries(report?.excludedCounts);
  const options = report?.classOptions || [];
  const unknownValues = draft ? [...new Set([...draft.printedClasses, ...draft.onlineClasses])].filter(value => !options.some(option => option.value === value)) : [];
  const classOptions = [...options, ...unknownValues.map(value => ({ value, label: value, unknown: true }))];
  const overlap = draft?.printedClasses.some(value => draft.onlineClasses.includes(value));
  return (
    <div className="nmc-report p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="nmc-label mb-2">BNMS · Membership administration</p>
          <h1 className="nmc-heading text-2xl md:text-3xl font-bold flex items-center gap-3" data-testid="text-page-title"><BookOpen className="h-7 w-7 shrink-0" aria-hidden="true" />NMC Membership Report</h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-xl">Journal fulfilment counts and delivery settings, with separate diagnostics for membership evidence requiring review.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => { if (!dirtyRef.current && !settingsController.current && !conflict) query.refetch(); }} disabled={query.isFetching || exporting || dirty || saving || conflict} aria-label="Refresh NMC membership report" data-testid="button-refresh-nmc-report"><RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />Refresh</Button>
          <Button className="nmc-download" onClick={downloadExcel} disabled={exporting || !report || query.isError || query.isFetching || dirty || saving || conflict} data-testid="button-download-nmc-report"><Download className="h-4 w-4 mr-2" aria-hidden="true" />{exporting ? "Preparing Excel…" : "Download Excel"}</Button>
        </div>
      </header>

      <div className="nmc-tabs" aria-label="Report views">
        <Button variant={tab === "report" ? "secondary" : "ghost"} aria-pressed={tab === "report"} onClick={() => setTab("report")}>Report</Button>
        <Button variant={tab === "settings" ? "secondary" : "ghost"} aria-pressed={tab === "settings"} onClick={() => setTab("settings")} data-testid="tab-nmc-settings">Settings</Button>
      </div>
      {(dirty || saving) && <p role="status" className="text-sm">{saving ? "Saving journal settings and refreshing the report…" : "You have unsaved journal settings. Save or discard your changes before refreshing or downloading."}</p>}
      {settingsError && <Alert variant="destructive" role="alert"><AlertTitle>Journal settings need attention</AlertTitle><AlertDescription data-testid="text-nmc-settings-error">{settingsError}</AlertDescription></Alert>}
      {settingsSuccess && <p role="status" className="text-sm" data-testid="text-nmc-settings-success">{settingsSuccess}</p>}
      {tab === "settings" && <Card className="nmc-panel">
        <CardHeader><CardTitle className="text-lg">Journal delivery settings</CardTitle><p className="text-sm text-muted-foreground">Choose the member classes for printed and online-only fulfilment. Selecting a class in one group moves it out of the other. Classes left unselected receive neither through this report. Either group can be empty.</p></CardHeader>
        <CardContent className="space-y-5">
          {!draft ? <p role="status">Journal settings are not available yet. {query.isFetching ? "Loading saved settings…" : "Refresh the report to try again."}</p> : <>
            {unknownValues.length > 0 && <p className="text-sm" role="status">Some saved classes are no longer in the available member classes. They remain selected below as “Unavailable saved class” until you remove them. Restore their class definition before assigning them to another group.</p>}
            {overlap && <p role="alert" className="text-sm">A class is selected in both groups. Deselect it in one group before saving.</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{[["printedClasses", "Printed journal"], ["onlineClasses", "Online-only journal"]].map(([group, title]) => <fieldset key={group} disabled={saving || exporting || query.isFetching || conflict}>
              <legend className="font-semibold mb-2">{title} <span className="text-muted-foreground font-normal">({draft[group].length} classes)</span></legend>
              {classOptions.length ? classOptions.map(option => <label key={option.value} className="nmc-class-option"><input type="checkbox" disabled={option.unknown && !savedSettings[group].includes(option.value)} checked={draft[group].includes(option.value)} onChange={event => selectClass(group, option.value, event.target.checked)} data-testid={`nmc-${group}-${option.value}`} /><span className="break-all">{option.label}{option.unknown && <span className="block text-xs text-muted-foreground">Unavailable saved class</span>}</span></label>) : <p className="text-sm text-muted-foreground">No member classes available.</p>}
            </fieldset>)}</div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={saveSettings} disabled={!dirty || saving || exporting || query.isFetching || conflict || overlap} data-testid="button-save-nmc-settings">{saving ? "Saving…" : "Save settings"}</Button>
              <Button variant="outline" disabled={!dirty || saving || query.isFetching || conflict} onClick={() => { setDraft(savedSettings); setSettingsError(""); setSettingsSuccess(""); }} data-testid="button-discard-nmc-settings">Discard changes</Button>
              {conflict && <Button variant="outline" onClick={reloadSettings} disabled={saving || query.isFetching} data-testid="button-reload-nmc-settings">{query.isFetching ? "Reloading…" : "Reload saved settings (discard edits)"}</Button>}
            </div>
            <p className="text-xs text-muted-foreground">Only Save settings changes journal fulfilment selections. Membership records, payments and addresses are not changed.</p>
          </>}
        </CardContent>
      </Card>}
      <div hidden={tab !== "report"} className="space-y-6">
      {exportError && <Alert variant="destructive" role="alert"><AlertCircle className="h-4 w-4" /><AlertTitle>Download unsuccessful</AlertTitle><AlertDescription data-testid="text-export-error">{exportError} Use Download Excel to try again.</AlertDescription></Alert>}
      {exporting && <p className="text-sm text-muted-foreground" role="status">Preparing your workbook. Membership records will not be changed.</p>}
      {query.isLoading ? <ReportSkeleton /> : query.isError ? (
        <Alert variant="destructive" role="alert"><AlertCircle className="h-4 w-4" /><AlertTitle>Report could not be loaded</AlertTitle><AlertDescription><p data-testid="text-report-error">{query.error.message}</p><Button variant="outline" size="sm" className="mt-3" disabled={dirty || saving || conflict || exporting || query.isFetching} onClick={() => query.refetch()}>Retry report</Button></AlertDescription></Alert>
      ) : report ? (
        <>
          <section className="nmc-summary rounded-xl p-5 md:p-6 flex flex-col md:flex-row md:items-center justify-between gap-6" aria-label="Report summary">
            <div><p className="nmc-label">Report date · UTC</p><p className="text-xl font-semibold mt-2" data-testid="text-report-date"><time dateTime={report.reportDate}>{formatNmcReportDate(report.reportDate)}</time></p><p className="text-xs text-muted-foreground mt-1">Date-only snapshot; no local timezone adjustment.</p></div>
            <div className="md:border-l nmc-rule md:pl-8"><p className="nmc-label">Total workbook records</p><p className="nmc-number text-4xl font-semibold mt-1" data-testid="text-nmc-total">{displayCount(report.total)}</p></div>
            <div className="flex items-start gap-2 max-w-xs text-sm"><ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" /><p>Read-only reporting.<br /><span className="text-muted-foreground">No membership, payment or address data is changed by this report.</span></p></div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-6">
            <Card className="nmc-panel">
              <CardHeader className="pb-3"><CardTitle className="text-lg flex items-center gap-2"><FileSpreadsheet className="h-5 w-5" aria-hidden="true" />Workbook contents</CardTitle><p className="text-sm text-muted-foreground">Printed and online-only fulfilment use the saved member class selections. Review diagnostics are separate and do not appear as rows in the workbook.</p></CardHeader>
              <CardContent>
                {report.total === 0 && <div className="rounded-lg border nmc-rule p-5 mb-4" data-testid="text-nmc-empty"><p className="font-semibold">No fulfilment records in this workbook</p><p className="text-sm text-muted-foreground mt-1">Check the separate review diagnostics, excluded reasons and reporting rules below. Refresh after correcting source records.</p></div>}
                {report.sheets.length ? <div className="overflow-x-auto rounded-lg border nmc-rule"><table className="w-full text-sm" data-testid="table-nmc-sheets"><caption className="sr-only">Excel worksheet record counts</caption><thead className="nmc-sheet-head"><tr><th scope="col" className="px-4 py-3 text-left font-medium">Worksheet</th><th scope="col" className="px-4 py-3 text-right font-medium">Records</th></tr></thead><tbody>{report.sheets.map((sheet, index) => <tr key={`${sheet.name}-${index}`} className="border-t nmc-rule"><th scope="row" className="px-4 py-3 text-left font-medium break-words">{sheet.name}</th><td className="px-4 py-3 text-right tabular-nums">{displayCount(sheet.count)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-muted-foreground py-4">No worksheets were returned.</p>}
                 <ClassCounts title="Printed journal — member classes" rows={report.classCounts?.printed} testId="table-nmc-printed-classes" />
                 <ClassCounts title="Online-only journal — member classes" rows={report.classCounts?.online} testId="table-nmc-online-classes" />
              </CardContent>
            </Card>

            <Card className={`nmc-panel ${reviews.length || pending.length ? "nmc-review" : ""}`} data-testid="nmc-review-before-fulfilment">
              <CardHeader className="pb-3"><CardTitle className="text-lg">Review before fulfilment</CardTitle><p className="text-sm">Review counts are diagnostics, not workbook rows or confirmed journal recipients. Investigate the reasons below in the source membership records; no Review worksheet is included.</p></CardHeader>
              <CardContent>
                {pending.length > 0 && <section className="mb-4 border-b nmc-rule pb-4" aria-label="First payment progress">
                  <h3 className="font-semibold text-sm mb-2">First payment progress</h3>
                  <ul className="divide-y divide-current/10" data-testid="list-nmc-payment-progress">{pending.map(([reason, value]) => <li className="py-3 first:pt-0" key={reason}>
                    <div className="flex items-start justify-between gap-3"><h4 className="font-semibold text-sm">{nmcReasonLabel(reason)}</h4><Badge variant="outline" className="shrink-0 tabular-nums">{displayCount(value)}</Badge></div>
                    <p className="text-sm mt-2 leading-relaxed">{nmcReviewGuidance(reason)}</p>
                  </li>)}</ul>
                </section>}
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
            <dt className="font-semibold">Journal delivery</dt><dd>Saved printed and online-only member class selections determine delivery groups. Change these in Settings and save before downloading. Blank address fields remain blank in the workbook; they are never replaced with guessed values.</dd>
          </dl>
          <details className="border-t nmc-rule pt-4" open>
            <summary className="font-semibold">Imported records and Honorary memberships</summary>
            <p className="mt-3 text-muted-foreground">Imported Active status plus a legacy expiry alone is review only, not automatic fulfilment evidence. Check the underlying membership history before resolving it.</p>
            <p className="mt-2 text-muted-foreground">Active Honorary memberships with no expiry and no membership history are recognised as non-expiring.</p>
          </details>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
