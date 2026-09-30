import React, { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Download, Lock, Activity, ChevronDown, ChevronRight, AlertCircle, X,
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const FEATURE_ID = "page_MonthlyFinanceReport";

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-GB", { style: "currency", currency: "GBP" });
}

function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const TYPE_LABELS = {
  voucher_awarded: "Voucher Awarded",
  booking_usage: "Booking Usage",
  cancellation_refund: "Cancellation Refund",
  expiry: "Expiry",
  credit_adjustment: "Credit Adjustment",
  debit_adjustment: "Debit Adjustment",
};

function typeLabel(t) {
  return TYPE_LABELS[t] || t;
}

const SUMMARY_COLS = [
  { key: "opening_balance", label: "Opening" },
  { key: "allocated", label: "Allocated" },
  { key: "used", label: "Used" },
  { key: "expired", label: "Expired" },
  { key: "adjustments_positive", label: "Adj (+)" },
  { key: "adjustments_negative", label: "Adj (−)" },
  { key: "reinstated", label: "Reinstated" },
  { key: "closing_balance", label: "Closing" },
  { key: "reserved_future", label: "Reserved" },
  { key: "available_balance", label: "Available" },
];

const EMPTY_DETAIL_FILTERS = {
  voucher_status: "",
  allocation_from: "",
  allocation_to: "",
  expiry_from: "",
  expiry_to: "",
  event_id: "",
  type: "",
  funding_source: "",
};

export default function MonthlyFinanceReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [month, setMonth] = useState(currentMonth);
  const [balanceFilter, setBalanceFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("all");
  const [expandedOrgId, setExpandedOrgId] = useState(null);
  const [detailFilters, setDetailFilters] = useState(EMPTY_DETAIL_FILTERS);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded(FEATURE_ID)) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const summaryQuery = useQuery({
    queryKey: ["voucher-monthly-report", "summary", month],
    queryFn: async () => {
      const res = await fetch(`/api/admin/voucher-monthly-report?month=${encodeURIComponent(month)}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load the monthly summary");
      }
      return res.json();
    },
    enabled: accessChecked && /^\d{4}-\d{2}$/.test(month),
    staleTime: 30 * 1000,
  });

  const detailParams = useMemo(() => {
    const p = new URLSearchParams({ month, view: "detail" });
    if (expandedOrgId) p.set("organization_id", expandedOrgId);
    for (const [k, v] of Object.entries(detailFilters)) {
      if (v) p.set(k, v);
    }
    return p.toString();
  }, [month, expandedOrgId, detailFilters]);

  const detailQuery = useQuery({
    queryKey: ["voucher-monthly-report", "detail", detailParams],
    queryFn: async () => {
      const res = await fetch(`/api/admin/voucher-monthly-report?${detailParams}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load supporting transactions");
      }
      return res.json();
    },
    enabled: accessChecked && !!expandedOrgId,
    staleTime: 30 * 1000,
  });

  const summaryRows = useMemo(() => {
    let rows = summaryQuery.data?.rows || [];
    if (orgFilter !== "all") rows = rows.filter((r) => r.organization_id === orgFilter);
    if (balanceFilter === "positive") rows = rows.filter((r) => r.closing_balance > 0.005);
    else if (balanceFilter === "zero") rows = rows.filter((r) => Math.abs(r.closing_balance) <= 0.005);
    else if (balanceFilter === "negative") rows = rows.filter((r) => r.closing_balance < -0.005);
    return rows;
  }, [summaryQuery.data, orgFilter, balanceFilter]);

  const totals = useMemo(() => {
    const t = {};
    for (const col of SUMMARY_COLS) {
      t[col.key] = summaryRows.reduce((sum, r) => sum + (Number(r[col.key]) || 0), 0);
    }
    return t;
  }, [summaryRows]);

  const closed = summaryQuery.data?.closed;
  const hasActiveDetailFilters = Object.values(detailFilters).some(Boolean);

  const handleMonthChange = (value) => {
    if (value && value > currentMonth()) return;
    setMonth(value);
    setExpandedOrgId(null);
    setDetailFilters(EMPTY_DETAIL_FILTERS);
  };

  const toggleOrg = (orgId) => {
    setExpandedOrgId((prev) => (prev === orgId ? null : orgId));
    setDetailFilters(EMPTY_DETAIL_FILTERS);
  };

  const handleExport = () => {
    const p = new URLSearchParams({ month });
    if (orgFilter !== "all") p.set("organization_id", orgFilter);
    if (balanceFilter !== "all") p.set("balance", balanceFilter);
    window.open(`/api/admin/voucher-monthly-report/export?${p.toString()}`, "_blank");
  };

  if (!accessChecked) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">Monthly Finance Report</h1>
          <p className="text-slate-600 mt-1">
            Monthly voucher position per organisation, with the supporting transactions behind each figure.
          </p>
        </div>
        <Button onClick={handleExport} disabled={!summaryQuery.data} data-testid="button-export-report">
          <Download className="w-4 h-4 mr-2" />
          Export to Excel
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="report-month">Reporting month</Label>
              <Input
                id="report-month"
                type="month"
                value={month}
                max={currentMonth()}
                onChange={(e) => handleMonthChange(e.target.value)}
                className="w-44"
                data-testid="input-report-month"
              />
            </div>
            <div className="space-y-1">
              <Label>Organisation</Label>
              <Select value={orgFilter} onValueChange={(v) => { setOrgFilter(v); setExpandedOrgId(null); }}>
                <SelectTrigger className="w-64" data-testid="select-organisation-filter">
                  <SelectValue placeholder="All organisations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All organisations</SelectItem>
                  {(summaryQuery.data?.rows || []).map((r) => (
                    <SelectItem key={r.organization_id} value={r.organization_id}>
                      {r.organization_name || r.organization_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Closing balance</Label>
              <Select value={balanceFilter} onValueChange={setBalanceFilter}>
                <SelectTrigger className="w-40" data-testid="select-balance-filter">
                  <SelectValue placeholder="Any balance" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any balance</SelectItem>
                  <SelectItem value="positive">Positive</SelectItem>
                  <SelectItem value="zero">Zero</SelectItem>
                  <SelectItem value="negative">Negative</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="pb-1">
              {summaryQuery.data && (
                closed ? (
                  <Badge variant="secondary" className="gap-1" data-testid="badge-month-status">
                    <Lock className="w-3 h-3" />
                    Closed month — snapshot figures
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1" data-testid="badge-month-status">
                    <Activity className="w-3 h-3" />
                    Open month — live figures
                  </Badge>
                )
              )}
            </div>
          </div>
          {closed && summaryQuery.data?.snapshotGeneratedAt && (
            <CardDescription className="mt-2">
              Snapshot generated {fmtDate(summaryQuery.data.snapshotGeneratedAt)}.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {summaryQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : summaryQuery.error ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription data-testid="text-summary-error">{summaryQuery.error.message}</AlertDescription>
            </Alert>
          ) : summaryRows.length === 0 ? (
            <p className="text-slate-500 text-sm py-8 text-center" data-testid="text-no-summary-rows">
              No voucher activity or balances for this month.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-slate-600">
                    <th className="py-2 pr-3 font-medium">Organisation</th>
                    {SUMMARY_COLS.map((c) => (
                      <th key={c.key} className="py-2 px-2 font-medium text-right whitespace-nowrap">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((r) => (
                    <React.Fragment key={r.organization_id}>
                      <tr
                        className="border-b cursor-pointer hover-elevate"
                        onClick={() => toggleOrg(r.organization_id)}
                        data-testid={`row-summary-${r.organization_id}`}
                      >
                        <td className="py-2 pr-3">
                          <span className="inline-flex items-center gap-1 font-medium text-slate-900">
                            {expandedOrgId === r.organization_id
                              ? <ChevronDown className="w-4 h-4 text-slate-400" />
                              : <ChevronRight className="w-4 h-4 text-slate-400" />}
                            {r.organization_name || r.organization_id}
                          </span>
                        </td>
                        {SUMMARY_COLS.map((c) => (
                          <td key={c.key} className="py-2 px-2 text-right whitespace-nowrap tabular-nums">
                            {fmtMoney(r[c.key])}
                          </td>
                        ))}
                      </tr>
                      {expandedOrgId === r.organization_id && (
                        <tr>
                          <td colSpan={SUMMARY_COLS.length + 1} className="bg-slate-50 p-0">
                            <DetailPanel
                              orgName={r.organization_name}
                              query={detailQuery}
                              filters={detailFilters}
                              setFilters={setDetailFilters}
                              hasActiveFilters={hasActiveDetailFilters}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold text-slate-900">
                    <td className="py-2 pr-3">Total ({summaryRows.length} organisation{summaryRows.length === 1 ? "" : "s"})</td>
                    {SUMMARY_COLS.map((c) => (
                      <td key={c.key} className="py-2 px-2 text-right whitespace-nowrap tabular-nums" data-testid={`text-total-${c.key}`}>
                        {fmtMoney(totals[c.key])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DetailPanel({ orgName, query, filters, setFilters, hasActiveFilters }) {
  const rows = query.data?.rows || [];
  const options = query.data?.options || { types: [], fundingSources: [], events: [] };

  const setF = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Transaction type</Label>
          <Select value={filters.type || "all"} onValueChange={(v) => setF("type", v === "all" ? "" : v)}>
            <SelectTrigger className="w-44" data-testid="select-detail-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {options.types.map((t) => (
                <SelectItem key={t} value={t}>{typeLabel(t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Voucher status</Label>
          <Select value={filters.voucher_status || "all"} onValueChange={(v) => setF("voucher_status", v === "all" ? "" : v)}>
            <SelectTrigger className="w-36" data-testid="select-detail-voucher-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="exhausted">Fully used</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Event</Label>
          <Select value={filters.event_id || "all"} onValueChange={(v) => setF("event_id", v === "all" ? "" : v)}>
            <SelectTrigger className="w-56" data-testid="select-detail-event">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {options.events.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Funding source</Label>
          <Select value={filters.funding_source || "all"} onValueChange={(v) => setF("funding_source", v === "all" ? "" : v)}>
            <SelectTrigger className="w-44" data-testid="select-detail-funding-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {options.fundingSources.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Allocated between</Label>
          <div className="flex items-center gap-1">
            <Input type="date" value={filters.allocation_from} onChange={(e) => setF("allocation_from", e.target.value)} className="w-36" data-testid="input-detail-allocation-from" />
            <span className="text-slate-400 text-xs">and</span>
            <Input type="date" value={filters.allocation_to} onChange={(e) => setF("allocation_to", e.target.value)} className="w-36" data-testid="input-detail-allocation-to" />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Voucher expiry between</Label>
          <div className="flex items-center gap-1">
            <Input type="date" value={filters.expiry_from} onChange={(e) => setF("expiry_from", e.target.value)} className="w-36" data-testid="input-detail-expiry-from" />
            <span className="text-slate-400 text-xs">and</span>
            <Input type="date" value={filters.expiry_to} onChange={(e) => setF("expiry_to", e.target.value)} className="w-36" data-testid="input-detail-expiry-to" />
          </div>
        </div>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            onClick={() => setFilters({ ...EMPTY_DETAIL_FILTERS })}
            data-testid="button-clear-detail-filters"
          >
            <X className="w-4 h-4 mr-1" />
            Clear filters
          </Button>
        )}
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : query.error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="text-slate-500 text-sm py-4" data-testid="text-no-detail-rows">
          No supporting transactions for {orgName || "this organisation"} in this month{hasActiveFilters ? " with the current filters" : ""}.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-2 px-2 font-medium whitespace-nowrap">Date</th>
                <th className="py-2 px-2 font-medium whitespace-nowrap">Type</th>
                <th className="py-2 px-2 font-medium whitespace-nowrap">Voucher</th>
                <th className="py-2 px-2 font-medium">Event</th>
                <th className="py-2 px-2 font-medium whitespace-nowrap">Event Date</th>
                <th className="py-2 px-2 font-medium whitespace-nowrap">Booking Ref</th>
                <th className="py-2 px-2 font-medium">Delegate</th>
                <th className="py-2 px-2 font-medium text-right whitespace-nowrap">Amount</th>
                <th className="py-2 px-2 font-medium whitespace-nowrap">Reporting Month</th>
                <th className="py-2 px-2 font-medium">Created By</th>
                <th className="py-2 px-2 font-medium">Notes</th>
                <th className="py-2 px-2 font-medium whitespace-nowrap">Adjustment Ref</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0" data-testid={`row-detail-${r.id}`}>
                  <td className="py-1.5 px-2 whitespace-nowrap">{fmtDate(r.transaction_date)}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap">{typeLabel(r.type)}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap">{r.voucher_code || "—"}</td>
                  <td className="py-1.5 px-2 max-w-[220px] truncate" title={r.event_title || ""}>{r.event_title || "—"}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap">{fmtDate(r.event_date) || "—"}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap">{r.booking_reference || "—"}</td>
                  <td className="py-1.5 px-2 max-w-[180px] truncate" title={r.delegate || ""}>{r.delegate || "—"}</td>
                  <td className={`py-1.5 px-2 text-right whitespace-nowrap tabular-nums ${r.amount < 0 ? "text-red-600" : "text-slate-900"}`}>
                    {fmtMoney(r.amount)}
                  </td>
                  <td className="py-1.5 px-2 whitespace-nowrap">{r.reporting_month}</td>
                  <td className="py-1.5 px-2 max-w-[160px] truncate" title={r.created_by || ""}>{r.created_by || "—"}</td>
                  <td className="py-1.5 px-2 max-w-[220px] truncate" title={r.notes || ""}>{r.notes || "—"}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap">{r.adjustment_reference || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
