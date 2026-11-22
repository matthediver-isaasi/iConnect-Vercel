import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Download, Eye, FileSpreadsheet, Loader2, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ReportViewerFilters from "@/components/reports/ReportViewerFilters";
import { EMPTY_REPORT_QUERY } from "../../../shared/reportViewerQuery.mjs";

const API = "/api/public/custom-object-report";
const PAGE_SIZE = 50;

async function post(body, signal, internal = false) {
  const response = await fetch(internal ? "/api/internal-reports/view" : API, {
    method: "POST", credentials: internal ? "include" : "omit", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "The report is temporarily unavailable.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function SharedCustomObjectReport({ internalMode = false }) {
  const { token = "", objectId = "", reportId = "" } = useParams();
  const requestIdentity = internalMode ? `${objectId}:${reportId}` : token;
  const request = (body, signal) => {
    const { token: _externalToken, ...payload } = body;
    return post(internalMode
    ? { object_id: objectId, report_id: reportId, ...payload }
    : { token, ...body }, signal, internalMode);
  };
  const [password, setPassword] = useState("");
  const [grant, setGrant] = useState("");
  const [report, setReport] = useState(null);
  const [preview, setPreview] = useState(null);
  const [jobId, setJobId] = useState("");
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [progress, setProgress] = useState("");
  const [internalRetryAvailable, setInternalRetryAvailable] = useState(false);
  const [viewerQuery, setViewerQuery] = useState(EMPTY_REPORT_QUERY);
  const [appliedQueryKey, setAppliedQueryKey] = useState(JSON.stringify(EMPTY_REPORT_QUERY));
  const [reportColumns, setReportColumns] = useState([]);
  const queryRef = useRef(EMPTY_REPORT_QUERY);
  const queryEpoch = useRef(0);
  const snapshotRef = useRef("");
  const queryEdited = useRef(false);
  const queryKey = JSON.stringify(viewerQuery);
  const queryUpdating = queryKey !== appliedQueryKey;
  const queryActive = Boolean(viewerQuery.search.trim() || viewerQuery.filters.length);
  const controller = useRef(null);
  const grantRef = useRef("");
  const reportRef = useRef(null);
  const mountedRef = useRef(false);
  const routeTokenRef = useRef(requestIdentity);
  const routeEpochRef = useRef(0);
  const autoUnlockFor = useRef("");
  const internalRetryUsed = useRef(false);

  const clearAccess = useCallback((isUnavailable = false) => {
    controller.current?.abort();
    controller.current = null;
    grantRef.current = "";
    reportRef.current = null;
    queryEpoch.current += 1; snapshotRef.current = "";
    queryEdited.current = false;
    queryRef.current = EMPTY_REPORT_QUERY; setViewerQuery(EMPTY_REPORT_QUERY);
    setAppliedQueryKey(JSON.stringify(EMPTY_REPORT_QUERY)); setReportColumns([]);
    setGrant(""); setReport(null); setPreview(null); setJobId(""); setPage(1);
    setProgress(""); setPending(false); setUnavailable(isUnavailable);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    routeTokenRef.current = requestIdentity;
    routeEpochRef.current += 1;
    internalRetryUsed.current = false;
    setInternalRetryAvailable(false);
    queryEpoch.current += 1; snapshotRef.current = "";
    queryEdited.current = false;
    queryRef.current = EMPTY_REPORT_QUERY; setViewerQuery(EMPTY_REPORT_QUERY);
    setAppliedQueryKey(JSON.stringify(EMPTY_REPORT_QUERY)); setReportColumns([]);
    controller.current?.abort();
    controller.current = null;
    grantRef.current = "";
    reportRef.current = null;
    setPassword(""); setGrant(""); setReport(null); setPreview(null); setJobId(""); setPage(1);
    setPending(false); setError(""); setProgress(""); setUnavailable(false);
    return () => {
      if (routeTokenRef.current === requestIdentity) {
        mountedRef.current = false;
        routeTokenRef.current = "";
        routeEpochRef.current += 1;
        controller.current?.abort();
        controller.current = null;
        grantRef.current = "";
        reportRef.current = null;
      }
    };
  }, [requestIdentity]);

  useEffect(() => {
    const previousTitle = document.title;
    const robots = document.createElement("meta");
    robots.name = "robots"; robots.content = "noindex, nofollow, noarchive";
    const referrer = document.createElement("meta");
    referrer.name = "referrer"; referrer.content = "no-referrer";
    document.head.append(robots, referrer);
    document.title = "Shared report";
    return () => {
      controller.current?.abort();
      document.title = previousTitle;
      robots.remove(); referrer.remove();
      clearAccess();
    };
  }, [clearAccess]);

  const classifyError = (err) => {
    if (internalMode && (err.status === 403 || err.status === 404)) {
      clearAccess(true);
      setError("You do not have access to this report, or it is no longer available.");
    }
    else if (internalMode && err.status === 409) {
      clearAccess(false);
      autoUnlockFor.current = requestIdentity;
      if (!internalRetryUsed.current) {
        setInternalRetryAvailable(true);
        setError("Report access changed while you were viewing it. Request one fresh read-only session to continue.");
      } else {
        setInternalRetryAvailable(false);
        setError("Report access changed again. Reload the report or contact an administrator.");
      }
    }
    else if (err.status === 404) { clearAccess(true); setError("This report link is unavailable."); }
    else if (err.status === 401) {
      clearAccess(false);
      setError(internalMode ? "Your session has expired. Sign in again to view this report." : "Access has expired or the password is incorrect. Enter the password to continue.");
    }
    else {
      setPreview(null);
      setJobId("");
      setError(err.name === "AbortError" ? "" : err.message || "The report is temporarily unavailable.");
    }
  };

  const runRequest = async (fn) => {
    controller.current?.abort();
    const activeController = new AbortController();
    const requestToken = requestIdentity;
    const requestEpoch = routeEpochRef.current;
    controller.current = activeController;
    setPending(true); setError("");
    try {
      const result = await fn(activeController.signal);
      if (activeController.signal.aborted || !mountedRef.current
        || routeTokenRef.current !== requestToken || routeEpochRef.current !== requestEpoch) return null;
      return result;
    }
    catch (err) {
      if (!activeController.signal.aborted && mountedRef.current
        && routeTokenRef.current === requestToken && routeEpochRef.current === requestEpoch) classifyError(err);
      return null;
    }
    finally {
      if (controller.current === activeController) {
        controller.current = null;
        if (mountedRef.current && routeTokenRef.current === requestToken
          && routeEpochRef.current === requestEpoch) setPending(false);
      }
    }
  };

  const unlock = async (event) => {
    event?.preventDefault();
    if (pending || unavailable) return;
    const entered = password;
    await runRequest(async (signal) => {
      const result = await request({ action: "unlock", ...(!internalMode && entered ? { password: entered } : {}) }, signal);
      if (signal.aborted || !mountedRef.current || routeTokenRef.current !== requestIdentity) return;
      if (!result?.access_grant || !result?.report) throw new Error("The report could not be opened. Please try again.");
      grantRef.current = result.access_grant;
      reportRef.current = result.report;
      setGrant(result.access_grant); setReport(result.report);
      setPassword(""); setUnavailable(false); setPreview(null); setJobId(""); setPage(1);
    });
  };

  useEffect(() => {
    if (!internalMode || !objectId || !reportId || autoUnlockFor.current === requestIdentity) return;
    autoUnlockFor.current = requestIdentity;
    unlock();
    // Automatically unlock exactly once per object/report route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalMode, requestIdentity]);

  const fetchPage = async (targetPage, snapshotId, criteria = queryRef.current) => {
    if (!grantRef.current) return;
    const epoch = queryEpoch.current, routeEpoch = routeEpochRef.current;
    const identity = requestIdentity;
    const isCurrent = () => mountedRef.current && grantRef.current && queryEpoch.current === epoch
      && routeTokenRef.current === identity && routeEpochRef.current === routeEpoch;
    const result = await runRequest(async (signal) => request({
      action: "preview", grant: grantRef.current, page: targetPage, pageSize: PAGE_SIZE,
      viewer_query: criteria,
      ...(snapshotId ? { job_id: snapshotId, preview_action: "page" } : {}),
      ...(!snapshotId ? { preview_action: "start" } : {}),
    }, signal));
    if (!result || !isCurrent()) return;
    let data = result;
    let id = result.sort_job?.id || snapshotId;
    snapshotRef.current = id || "";
    setJobId(id || "");
    if (result.sort_job && result.sort_job.status !== "complete") {
      setProgress("Preparing a private report snapshot");
      let current = result;
      for (let attempts = 0; attempts < 80 && current?.sort_job?.status !== "complete"; attempts += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        if (!isCurrent()) return;
        const next = await runRequest((signal) => request({
          token, action: "preview", grant: grantRef.current, job_id: id,
          preview_action: "process", page: targetPage, pageSize: PAGE_SIZE,
          viewer_query: criteria,
        }, signal));
        if (!next || !isCurrent()) return;
        current = next;
      }
      if (current?.sort_job?.status !== "complete" || !Array.isArray(current.data)) {
        setError("The report snapshot did not finish. Refresh to try again."); setProgress(""); return;
      }
      data = current;
    }
    setProgress("");
    if (!isCurrent()) return;
    setReportColumns(Array.isArray(data.columns) ? data.columns : []);
    setAppliedQueryKey(JSON.stringify(criteria));
    setPreview(data); setPage(targetPage); setJobId(id || data.sort_job?.id || "");
  };

  const changeQuery = next => {
    if (JSON.stringify(next) === JSON.stringify(queryRef.current)) return;
    queryEpoch.current += 1;
    controller.current?.abort();
    controller.current = null;
    queryEdited.current = true;
    queryRef.current = next;
    setViewerQuery(next); setPage(1); setPending(true); setError("");
  };
  useEffect(() => {
    if (!grant || !queryEdited.current) return undefined;
    const timer = window.setTimeout(() => {
      queryEdited.current = false;
      fetchPage(1, snapshotRef.current, queryRef.current);
    }, 350);
    return () => window.clearTimeout(timer);
    // Input changes cancel older requests immediately; only the final value is sent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, grant]);

  useEffect(() => {
    if (!grant) return undefined;
    let stopped = false;
    const revalidate = async () => {
      if (stopped || document.visibilityState === "hidden" || !grantRef.current) return;
      try {
        const result = await request({ token, action: "check", grant: grantRef.current });
        if (!stopped && result?.report) { reportRef.current = result.report; setReport(result.report); }
      } catch (err) {
        if (!stopped) classifyError(err);
      }
    };
    const onFocus = () => revalidate();
    const onVisibility = () => { if (document.visibilityState === "visible") revalidate(); };
    const timer = window.setInterval(revalidate, 30_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisibility); };
  }, [grant, token]);

  useEffect(() => {
    if (grant && !preview && !pending && !unavailable) fetchPage(1, "");
    // The initial snapshot is created once for each access grant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grant]);

  const refresh = () => { queryEpoch.current += 1; snapshotRef.current = ""; setPreview(null); setJobId(""); fetchPage(1, ""); };
  const changePage = (nextPage) => {
    if (jobId) fetchPage(nextPage, jobId);
  };

  const exportCsv = async () => {
    if (!grantRef.current || reportRef.current?.allow_csv !== true || pending || queryUpdating || !preview) return;
    const exportQueryEpoch = queryEpoch.current;
    const exportQuery = queryRef.current;
    await runRequest(async (signal) => {
    const exportToken = requestIdentity;
      const exportEpoch = routeEpochRef.current;
      const exportGrant = grantRef.current;
      const parts = [];
      const assertExportCurrent = () => {
        if (signal.aborted || !mountedRef.current || routeTokenRef.current !== exportToken
        || routeEpochRef.current !== exportEpoch || grantRef.current !== exportGrant || queryEpoch.current !== exportQueryEpoch) {
          const aborted = new Error("The export was cancelled because access changed.");
          aborted.name = "AbortError";
          throw aborted;
        }
      };
      try {
        let job = await request({ token: exportToken, action: "export", grant: exportGrant, export_action: "start", viewer_query: exportQuery }, signal);
        assertExportCurrent();
        const id = job.id;
        if (!id) throw new Error("The CSV export could not be started.");
        setProgress("Preparing CSV export");
        for (let attempts = 0; !["complete", "failed"].includes(job.status) && attempts < 100; attempts += 1) {
          assertExportCurrent();
          job = await request({ token: exportToken, action: "export", grant: exportGrant, export_action: "process", job_id: id }, signal);
          assertExportCurrent();
          if (job.status !== "complete" && job.status !== "failed") await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        if (job.status === "failed") throw new Error("The CSV export could not be completed.");
        if (job.status !== "complete") throw new Error("The CSV export did not finish. Try again.");
        for (let index = 0; index < (Number(job.chunk_count) || 0); index += 1) {
          assertExportCurrent();
          const chunk = await request({ token: exportToken, action: "export", grant: exportGrant, export_action: "chunk", job_id: id, chunk_index: index }, signal);
          assertExportCurrent();
          if (typeof chunk.csv_text !== "string") throw new Error("The CSV export was incomplete.");
          parts.push(chunk.csv_text);
        }
        assertExportCurrent();
        const status = await request({ token: exportToken, action: "export", grant: exportGrant, export_action: "status", job_id: id }, signal);
        assertExportCurrent();
        if (status.status !== "complete") throw new Error("Access changed before the download was ready. Try again.");
        const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
        assertExportCurrent();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = status.filename || job.filename || "shared-report.csv";
        document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
      } finally {
        parts.length = 0;
      }
    });
    setProgress("");
  };

  const columns = Array.isArray(preview?.columns) ? preview.columns : [];
  const rows = Array.isArray(preview?.data) ? preview.data : [];
  const retryInternalUnlock = () => {
    if (pending || unavailable || !internalRetryAvailable || internalRetryUsed.current) return;
    internalRetryUsed.current = true;
    setInternalRetryAvailable(false);
    setError("");
    autoUnlockFor.current = "";
    unlock();
  };
  return (
    <main className="min-h-[100dvh] bg-[#eef4f2] px-4 py-10 text-slate-800 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex items-center gap-3 border-b border-teal-900/10 pb-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-800 text-white"><FileSpreadsheet className="h-5 w-5" /></span>
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-800">iConnect · {internalMode ? "internal report access" : "secure report access"}</p>
            <p className="mt-0.5 text-sm text-slate-600">{internalMode ? "A read-only saved view available to your role" : "A saved view shared by an association administrator"}</p></div>
        </header>
        {!grant && internalMode ? <section className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8" aria-live="polite">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><LockKeyhole className="h-6 w-6" /></div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{unavailable ? "Report unavailable" : error && !pending ? "Access needs attention" : "Opening report"}</h1>
          {!error && <p role="status" className="mt-2 flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Verifying your sign-in and report access…</p>}
          {error && <p role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
          {error && !unavailable && ((internalRetryAvailable && error.includes("fresh read-only session")) || error.includes("session has expired")) && <div className="mt-4 flex flex-wrap gap-2">
            {internalRetryAvailable && error.includes("fresh read-only session") && <Button type="button" onClick={retryInternalUnlock} disabled={pending} className="bg-teal-800 hover:bg-teal-900">
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Retry access check
            </Button>}
            {error.includes("session has expired") && <Button type="button" variant="outline" onClick={() => { window.location.assign(`/Login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); }}>Sign in</Button>}
          </div>}
          <p className="mt-6 flex items-center gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500"><ShieldCheck className="h-4 w-4 shrink-0 text-teal-700" />Internal read-only access is checked against your current role. No CRM or report-builder access is granted.</p>
        </section> : !grant ? <section className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><LockKeyhole className="h-6 w-6" /></div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{unavailable ? "Link unavailable" : "Private report"}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{unavailable ? "This link may have been revoked or replaced. Ask the person who shared it for a current link." : "Enter the password provided by the report owner. The report name stays hidden until access is verified."}</p>
          {!unavailable && <form className="mt-6 space-y-4" onSubmit={unlock}>
            <div className="space-y-2"><Label htmlFor="shared-report-password">Access password</Label>
              <Input id="shared-report-password" type="password" autoComplete="current-password" maxLength={128}
                value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
              <p className="text-xs text-slate-500">If the owner has not set a password, leave this blank.</p></div>
            {error && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
            <Button type="submit" className="w-full bg-teal-800 hover:bg-teal-900" disabled={pending}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}Open report
            </Button>
          </form>}
          {unavailable && error && <p role="alert" className="mt-4 text-sm text-rose-800">{error}</p>}
          <p className="mt-6 flex items-center gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500"><ShieldCheck className="h-4 w-4 shrink-0 text-teal-700" />This link provides report-only access. It does not sign you in to iConnect.</p>
        </section> : <section>
          <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-800">{internalMode ? "Internal report" : "Shared report"}</p>
              <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight text-slate-900">{report?.name || "Report"}</h1>
              <p className="mt-1 text-sm text-slate-600">A read-only snapshot of the saved report.</p></div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={refresh} disabled={pending}><RefreshCw className="mr-2 h-4 w-4" />Refresh data</Button>
              {report?.allow_csv === true && <Button type="button" onClick={exportCsv} disabled={pending || queryUpdating || !preview} className="bg-teal-800 hover:bg-teal-900"><Download className="mr-2 h-4 w-4" />Download CSV</Button>}
            </div>
          </div>
          {reportColumns.length > 0 && <ReportViewerFilters columns={reportColumns} query={viewerQuery} onChange={changeQuery} updating={pending && queryUpdating} />}
          {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
          {progress && <p role="status" className="mb-4 flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />{progress}</p>}
          <div aria-busy={pending} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {!preview ? <div className="p-10 text-center text-sm text-slate-500">{error ? "The report could not be loaded. Adjust the filters or refresh to try again." : "Preparing report snapshot…"}</div> : <>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-sm">
                  <thead className="bg-[#e8f1ee] text-xs uppercase tracking-wide text-slate-600"><tr>
                    {columns.map((column, index) => <th key={`${column.label || "column"}-${index}`} scope="col" className="whitespace-nowrap border-b border-slate-200 px-4 py-3 font-semibold">{column.label || `Column ${index + 1}`}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row, index) => <tr key={row.id || index} className="hover:bg-teal-50/40">
                      {(Array.isArray(row.values) ? row.values : []).map((value, cellIndex) => <td key={cellIndex} className="max-w-[28rem] break-words px-4 py-3 align-top text-slate-700">{value == null || value === "" ? <span className="text-slate-400">—</span> : String(value)}</td>)}
                    </tr>)}
                    {!rows.length && <tr><td colSpan={Math.max(columns.length, 1)} className="px-4 py-12 text-center text-slate-500">{queryActive ? 'No rows match your search and filters.' : 'No rows in this report snapshot.'}</td></tr>}
                  </tbody>
                </table>
              </div>
              <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                <span>{Number(preview.total) || 0} {queryActive ? 'matching rows' : 'rows'} · page {preview.page || page}</span>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={pending || queryUpdating || page <= 1} onClick={() => changePage(page - 1)}><ArrowLeft className="mr-1 h-4 w-4" />Previous</Button>
                  <Button type="button" variant="outline" size="sm" disabled={pending || queryUpdating || !preview.has_more} onClick={() => changePage(page + 1)}>Next</Button>
                </div>
              </footer>
            </>}
          </div>
          {!report?.allow_csv && <p className="mt-3 text-xs text-slate-500">CSV download is not enabled for this report.</p>}
        </section>}
        <footer className="mt-8 text-center text-xs text-slate-500">Shared through iConnect · Membership and department data remain outside the CRM workspace</footer>
      </div>
    </main>
  );
}
