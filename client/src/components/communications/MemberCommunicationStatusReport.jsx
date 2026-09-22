import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const DEFAULT_FILTERS = {
  search: "",
  organizationId: "all",
  roleId: "all",
  globalOptOut: "all",
  categoryId: "all",
  categoryStatus: "all",
};
const PAGE_SIZES = [25, 50, 100];

const buildParams = (filters, page, limit) => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  Object.entries(filters).forEach(([key, value]) => {
    if (value && value !== "all") params.set(key, value);
  });
  return params.toString();
};

const getCategories = (data) => data?.categories || data?.meta?.categories || [];
const getRows = (data) => data?.rows || data?.members || [];
const getSummary = (data) => data?.summary || data?.totals || {};
const getTotal = (data) => Number(data?.total ?? data?.pagination?.total ?? 0);

export const categoryStatus = (row, category) => {
  const raw = row?.categoryStatuses?.[category.id] ?? row?.category_statuses?.[category.id] ?? row?.preferences?.[category.id];
  if (raw && typeof raw === "object") {
    const value = raw.optedIn ?? raw.opted_in ?? raw.isSubscribed ?? raw.is_subscribed ?? raw.status;
    if (raw.available === false || raw.eligible === false) return { value, unavailable: true, reason: raw.reason || raw.unavailableReason };
    return { value, unavailable: false };
  }
  const unavailable = row?.unavailableCategoryIds?.includes(category.id) || row?.unavailable_category_ids?.includes(category.id);
  return { value: raw, unavailable, reason: unavailable ? "Unavailable for this member" : "" };
};

const countCsvDataRows = (csv) => {
  let records = csv.length ? 1 : 0;
  let inQuotes = false;
  for (let index = 0; index < csv.length; index += 1) {
    if (csv[index] === '"') {
      if (inQuotes && csv[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && csv[index] === "\n") records += 1;
  }
  return Math.max(0, records - 1);
};

const filenameFrom = (response) => {
  const match = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i);
  return match?.[1] || "member-communication-status.csv";
};

export default function MemberCommunicationStatusReport({ active }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [exportMessage, setExportMessage] = useState("");

  const reportQuery = useQuery({
    queryKey: ["member-communication-status-report", filters, page, limit],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(`/api/admin/communications/status-report?${buildParams(filters, page, limit)}`, { credentials: "include" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The communication status report could not be loaded.");
      return response.json();
    },
    staleTime: 15_000,
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      setExportMessage("Preparing the complete filtered CSV…");
      const expectedCount = Number(reportQuery.data?.pagination?.total);
      if (!Number.isInteger(expectedCount) || expectedCount < 0) {
        throw new Error("The report total is unavailable. Refresh the report before exporting.");
      }
      const response = await fetch("/api/admin/communications/status-report-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== "all" && value !== "")),
          expectedCount,
        }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The CSV could not be created.");
      const rowCountHeader = response.headers.get("x-export-row-count");
      const exportedCount = Number(rowCountHeader);
      if (!rowCountHeader || !Number.isInteger(exportedCount) || exportedCount !== expectedCount) {
        throw new Error(`The export returned ${exportedCount} rows; ${expectedCount} matching members were expected. No file was downloaded.`);
      }
      const csv = await response.text();
      const actualCount = countCsvDataRows(csv);
      if (actualCount !== expectedCount) {
        throw new Error(`The export contained ${actualCount} rows; ${expectedCount} matching members were expected. No file was downloaded.`);
      }
      return { blob: new Blob([csv], { type: "text/csv;charset=utf-8" }), filename: filenameFrom(response), count: expectedCount };
    },
    onSuccess: ({ blob, filename, count }) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportMessage(`Downloaded ${count} matching member${count === 1 ? "" : "s"}.`);
    },
    onError: (error) => setExportMessage(error.message),
  });

  useEffect(() => {
    if (!active) setExportMessage("");
  }, [active]);

  const data = reportQuery.data;
  const categories = getCategories(data);
  const rows = getRows(data);
  const summary = getSummary(data);
  const total = getTotal(data);
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const filterOptions = data?.options || {};
  const organizations = filterOptions.organizations || [];
  const roles = filterOptions.roles || [];
  const summaryCards = useMemo(() => [
    ["Filtered members", summary.filteredMembers ?? summary.totalMembers ?? total],
    ["Globally opted out", summary.globallyOptedOut ?? summary.globalOptOutYes ?? 0],
    ["Not globally opted out", summary.notGloballyOptedOut ?? summary.globalOptOutNo ?? 0],
    ["At least one category opt-in", summary.withAnyCategoryOptIn ?? summary.anyExplicitCategoryOptIn ?? summary.anyCategoryOptIn ?? 0],
  ], [summary, total]);

  const updateFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };
  const reset = () => {
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  };

  if (!active) return null;

  return (
    <section className="space-y-5" data-testid="member-communication-status-report">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Member Communication Status</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">Read-only stored consent for current members. Global opt-out overrides category preferences for communications, but does not change the consent shown below. These are consent counts, not delivery-eligibility counts.</p>
        </div>
        <Button onClick={() => exportMutation.mutate()} disabled={reportQuery.isLoading || exportMutation.isPending} className="shrink-0" data-testid="button-download-communication-status">
          <Download className="mr-2 h-4 w-4" />
          {exportMutation.isPending ? "Preparing download…" : "Download CSV"}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map(([label, value]) => <Card key={label} className="border-slate-200 shadow-none"><CardContent className="p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-2xl font-semibold text-slate-900">{Number(value).toLocaleString()}</p></CardContent></Card>)}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div className="xl:col-span-2"><Label htmlFor="status-search">Search member</Label><div className="relative mt-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input id="status-search" className="pl-9" value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} placeholder="Name or email" /></div></div>
          <FilterSelect label="Organisation" value={filters.organizationId} onChange={(value) => updateFilter("organizationId", value)} items={organizations} placeholder="All organisations" />
          <FilterSelect label="Member role" value={filters.roleId} onChange={(value) => updateFilter("roleId", value)} items={roles} placeholder="All roles" />
          <FilterSelect label="Global opt-out" value={filters.globalOptOut} onChange={(value) => updateFilter("globalOptOut", value)} items={[{ id: "yes", name: "Yes" }, { id: "no", name: "No" }]} placeholder="All statuses" />
          <FilterSelect label="Category consent" value={filters.categoryId} onChange={(value) => updateFilter("categoryId", value)} items={categories.map((category) => ({ id: category.id, name: `${category.name}${category.active === false ? " — inactive" : ""}${category.publicOnly === true ? " — public only" : ""}`, category }))} placeholder="All categories" />
          <FilterSelect label="Category status" value={filters.categoryStatus} onChange={(value) => updateFilter("categoryStatus", value)} items={[{ id: "opted_in", name: "Opted in" }, { id: "not_opted_in", name: "Not opted in" }]} placeholder="All statuses" />
        </div>
        <div className="mt-4 flex justify-end"><Button variant="outline" size="sm" onClick={reset} disabled={JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS)}>Reset filters</Button></div>
      </div>

      {exportMessage && <p className={`text-sm ${exportMutation.isError ? "text-red-700" : "text-slate-600"}`} role="status">{exportMessage}</p>}
      {reportQuery.isError ? <ReportError message={reportQuery.error.message} retry={() => reportQuery.refetch()} /> : reportQuery.isLoading ? <ReportSkeleton /> : rows.length === 0 ? <EmptyState title="No members match these filters" detail="Try clearing one or more filters to see the current member population." /> : (
        <>
          {categories.length === 0 && <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">No communication categories exist yet. Member identity and global suppression status remain available below.</div>}
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-max w-full border-collapse text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
              <th className="sticky left-0 z-20 w-56 min-w-56 max-w-56 border-b border-r border-slate-200 bg-slate-50 px-4 py-3">Member</th>
              <th className="min-w-56 border-b border-r border-slate-200 bg-slate-50 px-4 py-3">Organisation</th>
              {categories.map((category) => <th key={category.id} className="min-w-40 border-b border-slate-200 px-4 py-3"><div>{category.name}</div><div className="mt-1 normal-case font-normal text-slate-400">ID: {category.id}{category.active === false ? " · inactive" : ""}{category.publicOnly === true ? " · public only" : ""}</div></th>)}
              <th className="min-w-32 border-b border-slate-200 px-4 py-3">Global opt-out</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => <tr key={row.memberId || row.member_id || row.id} className="hover:bg-slate-50">
                <td className="sticky left-0 z-10 w-56 min-w-56 max-w-56 border-r border-slate-100 bg-white px-4 py-3 break-words"><div className="font-medium text-slate-900">{row.name || [row.firstName || row.first_name, row.lastName || row.last_name].filter(Boolean).join(" ") || "Unnamed member"}</div><div className="text-slate-500">{row.email || "No email"}</div><div className="text-xs text-slate-400">ID: {row.memberId || row.member_id || row.id}</div></td>
                <td className="border-r border-slate-100 px-4 py-3 text-slate-700">{row.organizationName || row.organization_name || "No organisation"}</td>
                {categories.map((category) => { const status = categoryStatus(row, category); const opted = status.value === true || status.value === "opted_in"; return <td key={category.id} className="px-4 py-3"><span className={opted ? "font-medium text-emerald-700" : "text-slate-600"}>{opted ? "Opted in" : "Not opted in"}</span>{status.unavailable && <div className="mt-1 text-xs text-slate-500" title={status.reason}>Unavailable{status.reason ? ` — ${status.reason.replace(/_/g, " ")}` : ""}</div>}</td>; })}
                <td className="px-4 py-3 font-medium">{row.globalOptOut === true || row.global_opt_out === true || row.communications_opted_out_all === true ? <span className="text-amber-700">Yes</span> : <span className="text-slate-700">No</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        </>
      )}
      {!reportQuery.isLoading && !reportQuery.isError && rows.length > 0 && <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm text-slate-600">Showing {((page - 1) * limit) + 1}–{Math.min(page * limit, total)} of {total.toLocaleString()} members</p><div className="flex items-center gap-2"><Select value={String(limit)} onValueChange={(value) => { setLimit(Number(value)); setPage(1); }}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>)}</SelectContent></Select><Button variant="outline" size="sm" onClick={() => setPage((current) => current - 1)} disabled={page === 1}><ChevronLeft className="mr-1 h-4 w-4" />Previous</Button><span className="text-sm text-slate-600">Page {page} of {pageCount}</span><Button variant="outline" size="sm" onClick={() => setPage((current) => current + 1)} disabled={page >= pageCount}>Next<ChevronRight className="ml-1 h-4 w-4" /></Button></div></div>}
    </section>
  );
}

function FilterSelect({ label, value, onChange, items, placeholder }) {
  return <div><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger className="mt-1"><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent><SelectItem value="all">{placeholder}</SelectItem>{items.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name || item.label}</SelectItem>)}</SelectContent></Select></div>;
}

function EmptyState({ title, detail }) {
  return <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center"><p className="font-medium text-slate-800">{title}</p><p className="mt-1 text-sm text-slate-500">{detail}</p></div>;
}

function ReportError({ message, retry }) {
  return <div className="rounded-lg border border-red-200 bg-red-50 px-5 py-8 text-center"><AlertTriangle className="mx-auto h-6 w-6 text-red-600" /><p className="mt-2 font-medium text-red-900">Unable to load this report</p><p className="mt-1 text-sm text-red-700">{message}</p><Button variant="outline" size="sm" className="mt-4" onClick={retry}><RefreshCw className="mr-2 h-4 w-4" />Try again</Button></div>;
}

function ReportSkeleton() {
  return <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">{[1, 2, 3, 4, 5].map((row) => <div key={row} className="h-12 animate-pulse rounded bg-slate-100" />)}</div>;
}