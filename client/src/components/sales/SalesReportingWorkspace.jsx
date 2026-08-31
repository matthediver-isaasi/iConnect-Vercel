import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, CalendarClock, ChevronLeft, ChevronRight,
  CircleDollarSign, Download, FileText, Loader2, RefreshCw, Save, Target,
  TrendingUp, Trophy,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatSalesMoney } from "@/lib/salesMoney";

const REPORTS = [
  ["pipeline", "Pipeline"], ["owners", "Owners"], ["products", "Products"],
  ["bundles", "Bundles"], ["categories", "Categories"], ["organisations", "Organisations"],
  ["events", "Events"], ["conversion", "Conversion"], ["loss_reasons", "Loss reasons"],
  ["deal_size", "Deal size"], ["sales_cycle", "Sales cycle"],
];
const EMPTY_FILTERS = { dateFrom: "", dateTo: "", currency: "all", status: "all", ownerId: "all", organizationId: "all", eventId: "all", productId: "all" };
const STORAGE_KEY = "sales_report_saved_filters";

async function getReport(params) {
  const response = await fetch(`/api/sales/reports?${params}`, { credentials: "include" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || payload?.error || `Unable to load sales reporting (${response.status})`);
  return payload || {};
}

const list = (value) => Array.isArray(value) ? value : value?.items || value?.data || [];
const label = (value) => value?.label || value?.name || value?.title || value?.display_name || String(value ?? "—");
const id = (value) => value?.id || value?._id || value?.value;
const titleCase = (value) => String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const currency = (value, code = "GBP", minorUnits = false) =>
  formatSalesMoney(value, code, { minorUnits });
const displayValue = (value, column, row) => {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return label(value);
  const type = column?.type || column?.format;
  if (type === "currency" || type === "money" || /Minor$/i.test(column?.key || "")) {
    return currency(value, row.currency || column.currency, true);
  }
  if (type === "date" || /date|created|updated/i.test(column?.key || "")) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleDateString();
  }
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
};

function QueryState({ query, empty, children }) {
  if (query.isLoading) return <div className="grid min-h-56 place-items-center" role="status"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /><span className="sr-only">Loading sales data</span></div>;
  if (query.error) return <Card className="border-rose-200"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-rose-700"><span><AlertTriangle className="mr-2 inline h-4 w-4" />{query.error.message}</span><Button variant="outline" onClick={() => query.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></CardContent></Card>;
  if (empty) return <Card><CardContent className="p-10 text-center"><FileText className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 font-medium text-slate-700">No sales data yet</p><p className="mt-1 text-sm text-slate-500">Data will appear here when commercial activity matches this view.</p></CardContent></Card>;
  return children;
}

function SummaryCard({ title, value, icon: Icon, hint }) {
  return <Card><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-slate-500">{title}</p><p className="mt-2 text-2xl font-bold text-slate-950">{value}</p>{hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}</div><span className="rounded-lg bg-blue-50 p-2 text-blue-700"><Icon className="h-5 w-5" /></span></div></CardContent></Card>;
}

function ActivityList({ title, rows, emptyText }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent className="space-y-2">
    {!list(rows).length ? <p className="py-5 text-center text-sm text-slate-500">{emptyText}</p> : list(rows).slice(0, 8).map((row, index) => {
      const opportunityId = row.opportunityId || row.opportunity_id || (row.type === "opportunity" ? id(row) : null);
       const content = <div className="flex items-center justify-between gap-4 rounded-lg border p-3 hover:bg-slate-50"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-900">{label(row)}</p><p className="mt-0.5 truncate text-xs text-slate-500">{row.organizationName || row.organisation_name || row.description || row.status || "Sales activity"}</p></div><div className="shrink-0 text-right"><p className="text-sm font-semibold">{row.value != null || row.amount != null ? currency(row.value ?? row.amount, row.currency, true) : ""}</p>{(row.date || row.createdAt || row.expectedCloseDate) && <p className="text-xs text-slate-500">{new Date(row.date || row.createdAt || row.expectedCloseDate).toLocaleDateString()}</p>}</div></div>;
      return opportunityId ? <Link key={id(row) || index} to={`/sales/opportunities/${opportunityId}`}>{content}</Link> : <div key={id(row) || index}>{content}</div>;
    })}
  </CardContent></Card>;
}

export function SalesDashboard() {
  const query = useQuery({ queryKey: ["sales-reports", "dashboard"], queryFn: () => getReport(new URLSearchParams({ view: "dashboard" })), staleTime: 30_000 });
  const data = query.data || {};
  const summary = data.summary || {};
  const currencyRows = list(data.byCurrency);
  const hasData = Object.keys(summary).length || currencyRows.length || list(data.recentActivity).length || list(data.recentWins).length;
  const cards = [
    ["Open pipeline", summary.pipelineValue ?? summary.openPipeline ?? summary.pipeline_value, TrendingUp, summary.openOpportunities != null ? `${summary.openOpportunities} opportunities` : null],
    ["Weighted pipeline", summary.weightedPipeline ?? summary.weightedValue ?? summary.weighted_pipeline, Target, null],
    ["Won", summary.wonValue ?? summary.wonRevenue ?? summary.won_value, Trophy, summary.wonCount != null ? `${summary.wonCount} won` : null],
    ["Outstanding quotes", summary.outstandingQuoteValue ?? summary.quoteValue ?? summary.outstanding_quotes_value, FileText, summary.outstandingQuotes ?? list(data.outstandingQuotes).length],
  ];
  return <QueryState query={query} empty={!hasData}><div className="space-y-5">
    {data.definitions?.description && <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">{data.definitions.description}</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([name, value, icon, hint]) => <SummaryCard key={name} title={name} value={summary.currency ? currency(value, summary.currency, true) : "By currency"} icon={icon} hint={hint} />)}</div>
    {currencyRows.length > 0 && <Card><CardHeader><CardTitle className="text-base">Pipeline by currency</CardTitle></CardHeader><CardContent className="space-y-4">{currencyRows.map((row, index) => {
      const amount = Number(row.value ?? row.amount ?? row.total ?? 0);
      const max = Math.max(...currencyRows.map((item) => Number(item.value ?? item.amount ?? item.total ?? 0)), 1);
       return <div key={row.currency || index}><div className="mb-1 flex justify-between text-sm"><span className="font-medium">{row.currency || "Unspecified"}</span><span>{currency(amount, row.currency, true)}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.max(2, amount / max * 100)}%` }} /></div></div>;
    })}</CardContent></Card>}
    <div className="grid gap-5 xl:grid-cols-2"><ActivityList title="Recent activity" rows={data.recentActivity} emptyText="No recent activity." /><ActivityList title="Recent wins" rows={data.recentWins} emptyText="No recent wins." /><ActivityList title="Expected closes" rows={data.expectedCloses} emptyText="No expected closes." /><ActivityList title="Overdue tasks" rows={data.overdueTasks} emptyText="No overdue tasks." /></div>
    {list(data.outstandingQuotes).length > 0 && <ActivityList title="Outstanding quotes" rows={data.outstandingQuotes} emptyText="No outstanding quotes." />}
  </div></QueryState>;
}

function facetOptions(facets, key) {
  const aliases = {
    currency: ["currency", "currencies"],
    status: ["status", "statuses"],
    owners: ["owners", "owner"],
    events: ["events", "event"],
    products: ["products", "product"],
    organizations: ["organizations", "organisations", "organization", "organisation"],
    organisations: ["organisations", "organizations", "organisation", "organization"],
  };
  const value = (aliases[key] || [key]).map((candidate) => facets?.[candidate]).find(Boolean);
  return list(value);
}

function DrilldownValue({ column, row, children }) {
  const key = column.key || column.id || "";
  const relatedId = row[`${key}Id`] || row[`${key}_id`] || (/(opportunity|quote|organization|organisation|event)_?id/i.test(key) ? row[key] : null);
  let to;
  if (/opportunity/i.test(key) && relatedId) to = `/sales/opportunities/${relatedId}`;
  else if (/quote/i.test(key) && relatedId) to = `/sales/quotes/${relatedId}`;
  else if (/organi[sz]ation/i.test(key) && relatedId) to = `/organisations/${relatedId}`;
  else if (/event/i.test(key) && relatedId) to = `/events/${relatedId}`;
  return to ? <Link className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline" to={to}>{children}<ArrowRight className="h-3 w-3" /></Link> : children;
}

export function SalesReports() {
  const [report, setReport] = useState("pipeline");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [saved, setSaved] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } });
  const [saveName, setSaveName] = useState("");
  useEffect(() => setPage(1), [report, filters]);
  const params = useMemo(() => {
    const result = new URLSearchParams({ view: "report", report, page: String(page), pageSize: "25" });
    Object.entries(filters).forEach(([key, value]) => { if (value && value !== "all") result.set(key, value); });
    return result;
  }, [report, page, filters]);
  const query = useQuery({ queryKey: ["sales-reports", report, page, filters], queryFn: () => getReport(params), placeholderData: (previous) => previous });
  const data = query.data || {};
  const columns = list(data.columns).map((item) => typeof item === "string" ? { key: item, label: titleCase(item) } : { ...item, key: item.key || item.id || item.field });
  const rows = list(data.rows);
  const pagination = data.pagination || {};
  const total = Number(pagination.total ?? data.total ?? rows.length);
  const pageSize = Number(pagination.pageSize ?? pagination.page_size ?? 25);
  const pages = Number(pagination.pages ?? pagination.totalPages) || Math.max(1, Math.ceil(total / pageSize));
  const definitions = list(data.definitions?.reports || data.definitions);
  const activeDefinition = definitions.find((item) => (item.key || item.id) === report);
  const setFilter = (key, value) => setFilters((old) => ({ ...old, [key]: value }));
  const saveFilters = () => {
    if (!saveName.trim()) return;
    const next = [...saved.filter((item) => item.name !== saveName.trim()), { name: saveName.trim(), report, filters }];
    setSaved(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setSaveName("");
  };
  const exportCsv = () => {
    const csv = new URLSearchParams(params); csv.set("format", "csv");
    window.location.assign(`/api/sales/reports?${csv}`);
  };
  return <div className="space-y-5">
    <Card><CardContent className="p-4 sm:p-5"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div><Label>Report</Label><Select value={report} onValueChange={setReport}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{REPORTS.map(([value, text]) => <SelectItem key={value} value={value}>{text}</SelectItem>)}</SelectContent></Select></div>
      <div><Label htmlFor="sales-date-from">From</Label><Input id="sales-date-from" type="date" value={filters.dateFrom} onChange={(event) => setFilter("dateFrom", event.target.value)} /></div>
      <div><Label htmlFor="sales-date-to">To</Label><Input id="sales-date-to" type="date" value={filters.dateTo} onChange={(event) => setFilter("dateTo", event.target.value)} /></div>
      {[["currency", "Currency"], ["status", "Status"], ["owners", "Owner"], ["events", "Event"], ["products", "Product"]].map(([key, text]) => {
        const filterKey = key === "owners" ? "ownerId" : key === "events" ? "eventId" : key === "products" ? "productId" : key;
        const options = facetOptions(data.facets, key);
        return <div key={key}><Label>{text}</Label><Select value={filters[filterKey]} onValueChange={(value) => setFilter(filterKey, value)}><SelectTrigger><SelectValue placeholder={`All ${text.toLowerCase()}`} /></SelectTrigger><SelectContent><SelectItem value="all">All {text.toLowerCase()}</SelectItem>{options.map((option, index) => <SelectItem key={id(option) || option.value || index} value={String(id(option) || option.value || option)}>{label(option)}</SelectItem>)}</SelectContent></Select></div>;
      })}
      <div><Label>Organisation</Label><Select value={filters.organizationId} onValueChange={(value) => setFilter("organizationId", value)}><SelectTrigger><SelectValue placeholder="All organisations" /></SelectTrigger><SelectContent><SelectItem value="all">All organisations</SelectItem>{facetOptions(data.facets, "organizations").map((option, index) => <SelectItem key={id(option) || index} value={String(id(option) || option.value || option)}>{label(option)}</SelectItem>)}</SelectContent></Select></div>
    </div>
    <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4"><div><Label htmlFor="sales-save-name" className="sr-only">Saved filter name</Label><Input id="sales-save-name" className="w-40" value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="Filter name" /></div><Button variant="outline" onClick={saveFilters} disabled={!saveName.trim()}><Save className="mr-2 h-4 w-4" />Save filters</Button>
      {saved.length > 0 && <Select onValueChange={(name) => { const item = saved.find((entry) => entry.name === name); if (item) { setReport(item.report); setFilters({ ...EMPTY_FILTERS, ...item.filters }); } }}><SelectTrigger className="w-44"><SelectValue placeholder="Load saved filters" /></SelectTrigger><SelectContent>{saved.map((item) => <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>)}</SelectContent></Select>}
      <Button variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</Button><Button className="ml-auto" variant="outline" onClick={exportCsv}><Download className="mr-2 h-4 w-4" />Export CSV</Button>
    </div></CardContent></Card>
    {(activeDefinition?.description || data.definitions?.description) && <p className="text-sm text-slate-600">{activeDefinition?.description || data.definitions.description}</p>}
    <QueryState query={query} empty={!rows.length}><div className="space-y-3">
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>{columns.map((column) => <th key={column.key} className="whitespace-nowrap px-4 py-3">{column.label || titleCase(column.key)}{column.description && <span className="ml-1 normal-case text-slate-400" title={column.description}>ⓘ</span>}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={id(row) || rowIndex} className="border-t hover:bg-slate-50">{columns.map((column) => <td key={column.key} className="max-w-xs px-4 py-3"><DrilldownValue column={column} row={row}>{displayValue(row[column.key], column, row)}</DrilldownValue></td>)}</tr>)}</tbody>{data.totals && <tfoot className="border-t-2 bg-slate-50 font-semibold"><tr>{columns.map((column, index) => <td key={column.key} className="px-4 py-3">{index === 0 && data.totals[column.key] == null ? "Totals" : displayValue(data.totals[column.key], column, data.totals)}</td>)}</tr></tfoot>}</table></div></Card>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500"><span>{total.toLocaleString()} results · Page {page} of {pages}</span><div className="flex gap-2"><Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1 || query.isFetching} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pages || query.isFetching} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>
    </div></QueryState>
  </div>;
}

export function OrganisationCommercial({ organizationId, enabled = true }) {
  const query = useQuery({ queryKey: ["sales-reports", "organisation", organizationId], enabled: enabled && Boolean(organizationId), queryFn: () => getReport(new URLSearchParams({ view: "organisation", organizationId })) });
  const data = query.data || {};
  const sections = [["Opportunities", data.opportunities], ["Quotes", data.quotes], ["Sales", data.sales], ["Invoices", data.invoices], ["Allocations", data.allocations]];
  const hasData = Object.keys(data.summary || {}).length || sections.some(([, rows]) => list(rows).length);
  return <QueryState query={query} empty={!hasData}><div className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Object.entries(data.summary || {}).filter(([key]) => key !== "currency").map(([key, value]) => <SummaryCard key={key} title={titleCase(key)} value={/valueMinor|amountMinor|revenueMinor|salesValue/i.test(key) ? (data.summary.currency ? currency(value, data.summary.currency, true) : "By currency") : displayValue(value, { key }, {})} icon={/invoice|quote/i.test(key) ? FileText : /date|due/i.test(key) ? CalendarClock : CircleDollarSign} />)}</div>
    <div className="grid gap-5 lg:grid-cols-2">{sections.map(([name, rows]) => <ActivityList key={name} title={name} rows={rows} emptyText={`No ${name.toLowerCase()} for this organisation.`} />)}</div>
  </div></QueryState>;
}