import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDownToLine, Landmark } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { loadCompletePayout } from "@/lib/stripePayoutLoader.mjs";
import { payoutMoney, payoutCsv, payoutContactLabel } from "../../../shared/stripePayoutReport.mjs";
import "./StripePayoutReport.css";

const FEATURE_ID = "commerce.stripe-payout-report";
const dateInput = (date) => date.toISOString().slice(0, 10);
const humanise = (value) => value ? String(value).replace(/_/g, " ") : "Unknown";
const text = (value) => value === null || value === undefined || value === "" ? "—" : String(value);
const money = (amount, currency) => Number.isSafeInteger(amount) && currency ? payoutMoney(amount, currency) : "—";

function formatDate(value) {
  if (!value) return "—";
  const parsed = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
}

function LoadingRows({ label }) {
  return <div role="status" aria-label={label} className="space-y-2">
    <p className="text-sm text-muted-foreground">{label}</p>
    <Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" />
  </div>;
}

function InvoiceEvidence({ invoices = [] }) {
  // A conflicting copy must not leave a clickable copy of the same invoice.
  const distinct = new Map();
  invoices.forEach((invoice) => {
    const key = `${invoice.provider || ""}:${invoice.id || invoice.number || invoice.url || ""}`;
    const previous = distinct.get(key);
    distinct.set(key, { ...previous, ...invoice, conflict: !!(previous?.conflict || invoice.conflict) });
  });
  if (!distinct.size) return <span className="text-muted-foreground">No invoice evidence</span>;
  return [...distinct.entries()].map(([key, invoice]) => {
    let safeUrl = null;
    try {
      const url = new URL(invoice.url);
      if (["https:", "http:"].includes(url.protocol) && !invoice.conflict) safeUrl = url.href;
    } catch { /* Missing or invalid evidence is displayed without a link. */ }
    return <div key={key} className="payout-invoice">
      <div className="font-medium">{safeUrl
        ? <a href={safeUrl} target="_blank" rel="noopener noreferrer">{invoice.number || invoice.id || "Invoice"}</a>
        : text(invoice.number || invoice.id)}</div>
      <div className="text-xs text-muted-foreground">Provider: {text(invoice.provider)}</div>
      <div className="payout-id">ID: {text(invoice.id)}</div>
      {invoice.number && <div className="text-xs">Number: {invoice.number}</div>}
      <div className="payout-contact text-xs">Xero customer/contact: {payoutContactLabel(invoice)}</div>
      {invoice.conflict && <div className="text-xs text-amber-800">Conflicting evidence · link withheld</div>}
    </div>;
  });
}

export default function StripePayoutReport() {
  const { isFeatureExcluded, isAccessReady, sessionValidated } = useMemberAccess();
  const hasAccess = isAccessReady && sessionValidated && !isFeatureExcluded(FEATURE_ID);
  const [mode, setMode] = useState("live");
  const [from, setFrom] = useState(() => dateInput(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(() => dateInput(new Date()));
  const [cursors, setCursors] = useState([null]);
  const [listing, setListing] = useState({ payouts: [], next: null });
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [listRetry, setListRetry] = useState(0);
  const [selected, setSelected] = useState(null);
  const [report, setReport] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const [progress, setProgress] = useState(null);
  const [exportError, setExportError] = useState("");
  const listController = useRef(null);
  const detailController = useRef(null);
  const cursor = cursors[cursors.length - 1];
  const validDates = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  useEffect(() => {
    if (isAccessReady && !hasAccess) window.location.href = createPageUrl("Events");
  }, [hasAccess, isAccessReady]);

  useEffect(() => {
    if (!hasAccess || !validDates) return;
    const controller = new AbortController();
    listController.current = controller;
    setListLoading(true);
    setListError("");
    const params = new URLSearchParams({ mode, from, to });
    if (cursor) params.set("cursor", cursor);
    (async () => {
      try {
        const response = await fetch(`/api/admin/stripe-payout-report?${params}`, {
          credentials: "include", signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Unable to load payouts.");
        if (!Array.isArray(body.payouts)) throw new Error("Invalid payout response. Please retry.");
        if (!controller.signal.aborted) setListing(body);
      } catch (error) {
        if (!controller.signal.aborted) setListError(error.message || "Unable to load payouts.");
      } finally {
        if (!controller.signal.aborted) setListLoading(false);
      }
    })();
    return () => controller.abort();
  }, [hasAccess, validDates, mode, from, to, cursor, listRetry]);

  useEffect(() => {
    if (!hasAccess || !validDates || !selected || selected.supported === false || selected.automatic === false) return;
    const controller = new AbortController();
    detailController.current = controller;
    setDetailLoading(true);
    setDetailError("");
    setReport(null);
    setProgress(null);
    (async () => {
      try {
        const result = await loadCompletePayout(selected.id, mode, {
          signal: controller.signal,
          onProgress: (value) => { if (!controller.signal.aborted) setProgress(value); },
        });
        if (!controller.signal.aborted) setReport(result);
      } catch (error) {
        if (!controller.signal.aborted) setDetailError(error.message || "Unable to retrieve payout transactions.");
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [hasAccess, validDates, selected, mode, detailRetry]);

  const clearSelection = () => {
    detailController.current?.abort();
    setSelected(null);
    setReport(null);
    setDetailError("");
    setExportError("");
    setDetailLoading(false);
    setProgress(null);
  };
  const changeFilter = (setter, value) => {
    listController.current?.abort();
    clearSelection();
    setListLoading(true);
    setListing({ payouts: [], next: null });
    setListError("");
    setCursors([null]);
    setter(value);
  };
  const changePage = (nextCursors) => {
    listController.current?.abort();
    clearSelection();
    setListLoading(true);
    setCursors(nextCursors);
  };
  const selectPayout = (payout) => {
    if (selected?.id === payout.id) return;
    clearSelection();
    setDetailLoading(payout.supported !== false && payout.automatic !== false);
    setSelected(payout);
  };
  const unsupported = selected && (selected.supported === false || selected.automatic === false || report?.payout?.supported === false);
  const canExport = hasAccess && report?.complete === true && !detailLoading && !detailError && !unsupported;
  const download = () => {
    if (!canExport) return;
    setExportError("");
    try {
      const blob = new Blob([payoutCsv(report)], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `stripe-payout-${mode}-${String(report.payout.id).replace(/[^a-zA-Z0-9_-]/g, "_")}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setExportError(error.message || "Unable to export CSV."); }
  };

  if (!hasAccess) return <div className="p-6"><LoadingRows label="Checking report access…" /></div>;
  const rows = report?.rows || [];
  const matched = rows.filter((row) => row.status === "Matched").length;

  return <div className="stripe-payout-report min-w-0 space-y-6 p-4 sm:p-6 lg:p-8" data-testid="stripe-payout-report">
    <header className="payout-heading">
      <div className="payout-kicker">Finance / Read-only</div>
      <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold"><Landmark className="h-6 w-6 shrink-0" aria-hidden="true" />Stripe Payout Reconciliation</h1>
      <p className="mt-2 text-sm text-muted-foreground">Trace payout transactions to stored invoice evidence. No payments or invoices are changed.</p>
    </header>

    <Card className="min-w-0">
      <CardHeader className="pb-3"><CardTitle className="text-lg">Payouts</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="payout-filters flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end">
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Stripe mode</legend>
            <div className="flex gap-1 rounded-md border p-1">
              {["live", "test"].map((value) => <Button key={value} type="button" size="sm" variant={mode === value ? "default" : "ghost"}
                aria-pressed={mode === value} onClick={() => { if (mode !== value) changeFilter(setMode, value); }}>
                {value === "live" ? "Live" : "Test"}
              </Button>)}
            </div>
          </fieldset>
          <div className="space-y-1"><Label htmlFor="payout-from">Arrival from</Label>
            <Input id="payout-from" type="date" value={from} onChange={(event) => changeFilter(setFrom, event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="payout-to">Arrival to</Label>
            <Input id="payout-to" type="date" value={to} onChange={(event) => changeFilter(setTo, event.target.value)} /></div>
        </div>
        <p className="text-xs text-muted-foreground">Mode is independent of payment settings. Dates filter payout arrival, not payment dates.</p>
        {mode === "test" && <Badge variant="outline">Test data · not live funds</Badge>}
        {!validDates ? <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>Enter an arrival date range with “from” on or before “to”.</AlertDescription></Alert>
          : listLoading ? <LoadingRows label="Loading payouts…" />
          : listError ? <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{listError} <Button variant="outline" size="sm" onClick={() => setListRetry((value) => value + 1)}>Retry</Button></AlertDescription></Alert>
          : listing.payouts.length === 0 ? <div className="payout-empty"><Landmark className="mx-auto mb-3 h-7 w-7 text-muted-foreground" aria-hidden="true" /><p className="font-medium">No payouts in this range</p><p className="mt-1 text-sm text-muted-foreground">Choose another arrival range or Stripe mode.</p></div>
          : <div className="payout-scroll" role="region" aria-label="Payouts" tabIndex={0}>
            <table style={{ minWidth: 850 }}>
              <thead><tr>{["Payout", "Arrival", "Amount", "Currency", "Status", "Type", "Report"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{listing.payouts.map((payout) => <tr key={payout.id} className={selected?.id === payout.id ? "payout-selected" : ""}>
                <td className="payout-id">{payout.id}</td><td className="whitespace-nowrap">{formatDate(payout.arrivalDate)}</td>
                <td className="payout-number">{money(payout.amount, payout.currency)}</td><td>{text(payout.currency).toUpperCase()}</td>
                <td className="capitalize">{humanise(payout.status)}</td><td>{payout.automatic === false ? "Manual" : payout.automatic === true ? "Automatic" : "Unknown"}{payout.supported === false && <div className="text-xs text-amber-800">Unsupported</div>}</td>
                <td><Button variant="outline" size="sm" onClick={() => selectPayout(payout)} aria-pressed={selected?.id === payout.id} aria-label={`View payout ${payout.id}`}>{selected?.id === payout.id ? "Selected" : "View"}</Button></td>
              </tr>)}</tbody>
            </table>
          </div>}
        {validDates && !listError && <div className="flex items-center justify-between gap-3">
          <Button variant="outline" size="sm" disabled={cursors.length === 1 || listLoading} onClick={() => changePage(cursors.slice(0, -1))}>Previous</Button>
          <span className="text-xs text-muted-foreground">Page {cursors.length}</span>
          <Button variant="outline" size="sm" disabled={!listing.next || listLoading} onClick={() => changePage([...cursors, listing.next])}>Next</Button>
        </div>}
      </CardContent>
    </Card>

    <Card className="min-w-0" aria-busy={detailLoading}>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><CardTitle className="text-lg">Payout detail</CardTitle><p className="payout-id mt-2 text-muted-foreground">{selected?.id || "Select a payout to inspect its transactions"}</p></div>
        <Button variant="outline" onClick={download} disabled={!canExport}><ArrowDownToLine className="mr-2 h-4 w-4" aria-hidden="true" />Download CSV</Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {exportError && <Alert variant="destructive"><AlertDescription>{exportError}</AlertDescription></Alert>}
        {!selected ? <div className="payout-empty"><p className="font-medium">From bank arrival to invoice evidence</p><p className="mt-2 text-sm text-muted-foreground">Select View above. All balance transactions are retrieved before export is available.</p></div>
          : unsupported ? <Alert><AlertCircle className="h-4 w-4" /><AlertDescription><strong>Unsupported payout</strong><p>{selected.limitation || report?.payout?.limitation || "Manual or instant payouts cannot be reliably reconciled to a complete transaction set. Export is unavailable."}</p></AlertDescription></Alert>
          : detailLoading ? <LoadingRows label={`Retrieving all transactions…${typeof progress === "number" ? ` ${progress} retrieved` : ""}`} />
          : detailError ? <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{detailError} <Button size="sm" variant="outline" onClick={() => setDetailRetry((value) => value + 1)}>Retry</Button></AlertDescription></Alert>
          : report ? <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span>Payout <strong className="payout-number">{money(report.payout.amount, report.payout.currency)}</strong></span>
              <span>Arrival <strong>{formatDate(report.payout.arrivalDate)}</strong></span>
              <span className="capitalize">Status <strong>{humanise(report.payout.status)}</strong></span>
            </div>
            <div className="payout-checks" aria-label="Independent reconciliation checks">
              <span className="payout-check" data-tone={report.complete ? "good" : "review"}>Retrieval: <strong>{report.complete ? "Complete" : "Incomplete"}</strong></span>
              <span className="payout-check" data-tone={report.balanced ? "good" : "review"}>Balance: <strong>{!report.complete ? "Not assessed" : report.balanced ? "Balanced" : "Review required"}</strong></span>
              <span className="payout-check" data-tone={rows.length && matched === rows.length ? "good" : "review"}>Invoices: <strong>{matched} / {rows.length} matched{!report.complete ? " · partial" : ""}</strong></span>
              <span className="payout-check">Variance (net − payout): <strong>{report.variance == null ? "Not assessed" : money(report.variance, report.payout.currency)}</strong></span>
            </div>
            {!report.complete && <Alert><AlertDescription>Retrieval is incomplete. Totals are partial and export is disabled. <Button variant="outline" size="sm" onClick={() => setDetailRetry((value) => value + 1)}>Retry retrieval</Button></AlertDescription></Alert>}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Currency totals</h3>
              <div className="payout-scroll" role="region" aria-label="Currency totals" tabIndex={0}>
                <table><thead><tr><th scope="col">Currency</th><th scope="col">Gross</th><th scope="col">Fee</th><th scope="col">Net</th></tr></thead>
                  <tbody>{Object.entries(report.totals || {}).map(([currency, total]) => <tr key={currency}><td>{currency.toUpperCase()}</td>{["gross", "fee", "net"].map((field) => <td key={field} className="payout-number">{money(total[field], currency)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Balance transactions <span className="font-normal text-muted-foreground">({rows.length})</span></h3>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">One row per Stripe balance transaction. All dates UTC. Multiple invoices are evidence only; no payment allocation is inferred. Refund links refer to original invoices, not credit notes.</p>
              {!rows.length ? <div className="payout-empty">No balance transactions returned.</div> : <div className="payout-scroll" role="region" aria-label="Balance transactions and invoice evidence" tabIndex={0}>
                <table style={{ minWidth: 1770 }}>
                  <thead><tr>{["Transaction / type", "Payment date", "Balance date", "Currency", "Gross", "Fee", "Net", "Stripe identifiers", "Sources", "Invoices", "Match / reason"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
                  <tbody>{rows.map((row) => <tr key={row.id}>
                    <td><div className="payout-id">{row.id}</div><div className="mt-1 capitalize">{humanise(row.type)}</div></td>
                    <td><div className="whitespace-nowrap">{formatDate(row.paymentDate)}</div><div className="payout-id mt-1">{text(row.paymentDate)}</div></td>
                    <td><div className="whitespace-nowrap">{formatDate(row.balanceDate)}</div><div className="payout-id mt-1">{text(row.balanceDate)}</div></td>
                    <td>{text(row.currency).toUpperCase()}</td>
                    {["gross", "fee", "net"].map((field) => <td key={field} className="payout-number">{money(row[field], row.currency)}</td>)}
                    <td className="payout-evidence"><dl>{[["Source", "sourceId"], ["Charge", "chargeId"], ["Refund", "refundId"], ["Payment intent", "paymentIntentId"], ["Stripe invoice", "stripeInvoiceId"]].map(([label, field]) => <div key={field} className="contents"><dt>{label}</dt><dd className="payout-id">{text(row[field])}</dd></div>)}</dl></td>
                    <td style={{ minWidth: 210 }}>{row.sources?.length ? row.sources.map((source, index) => <div className="payout-id mb-2" key={index}>{text(source)}</div>) : <span className="text-muted-foreground">No stored source</span>}</td>
                    <td style={{ minWidth: 230 }}><InvoiceEvidence invoices={row.invoices} /></td>
                    <td style={{ minWidth: 270 }}><Badge variant="outline">{text(row.status)}</Badge><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{text(row.reason)}</p></td>
                  </tr>)}</tbody>
                </table>
              </div>}
            </div>
            <p className="text-xs text-muted-foreground">Complete retrieval, payout balance and invoice matching are separate checks. A balanced payout may still contain unmatched invoices.</p>
          </> : null}
      </CardContent>
    </Card>
  </div>;
}
