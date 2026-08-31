import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Check, ChevronLeft, ChevronRight,
  GitCompare, History, Loader2, PackagePlus, Plus, RefreshCw, Search, Send,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { calculateQuoteLine } from "@shared/salesContracts.js";

const list = (value) => Array.isArray(value) ? value : value?.items || value?.data || value?.results || value?.quotes || [];
const idOf = (value) => value?.id || value?._id;
const pick = (value, camel, snake, fallback = "") => value?.[camel] ?? value?.[snake] ?? fallback;
const nameOf = (value) => value?.name || value?.title || value?.displayName || value?.display_name || [value?.first_name, value?.last_name].filter(Boolean).join(" ") || "";
const minor = (value) => Math.round(Number(value || 0));
const money = (value, currency = "GBP") => {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor(value) / 100); }
  catch { return `${currency} ${(minor(value) / 100).toFixed(2)}`; }
};
const dateText = (value) => value ? new Date(value).toLocaleDateString() : "—";

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

const emptyLine = () => ({
  key: crypto.randomUUID(), type: "free_text", productId: "", bundleId: "", description: "",
  quantity: 1, standardUnitPriceMinor: 0, quotedUnitPriceMinor: 0, discountBps: 0, taxRateBps: 2000,
});

const blankQuote = (opportunityId = "") => ({
  opportunityId, customerContactId: "", billingContactId: "", eventId: "", eventKind: "simple", issueDate: new Date().toISOString().slice(0, 10),
  validUntil: "", purchaseOrderReference: "", customerReference: "", notes: "", currency: "GBP",
  taxTreatment: "exclusive", paymentTerms: "30 days", salespersonId: "", address: {
    addressee: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "United Kingdom",
  }, lines: [],
});

function normalizeLine(line, index) {
  return {
    ...emptyLine(), ...line, key: idOf(line) || line.key || `line-${index}`,
    type: line.kind || line.type || line.line_type || (line.catalogueId || line.catalogue_id ? "product" : "free_text"),
    productId: pick(line, "catalogueId", "catalogue_id", pick(line, "productId", "product_id")), bundleId: pick(line, "catalogueId", "catalogue_id", pick(line, "bundleId", "bundle_id")),
    standardUnitPriceMinor: pick(line, "standardUnitPriceMinor", "standard_unit_price_minor", 0),
    quotedUnitPriceMinor: pick(line, "quotedUnitPriceMinor", "quoted_unit_price_minor", 0),
    discountBps: pick(line, "discountBps", "discount_bps", 0), taxRateBps: pick(line, "taxRateBps", "tax_rate_bps", 0),
  };
}

function normalizeQuote(payload, opportunityId = "") {
  const root = payload?.quote || payload?.data?.quote || payload?.data || payload || {};
  // Detail responses keep quote identity at the root and the immutable/editable
  // values in currentVersion. Always prefer that authoritative version.
  const version = root.currentVersion || root.current_version || root;
  const quote = { ...root, ...version };
  const address = quote.address || quote.addressSnapshot || quote.address_snapshot || quote.billingAddress || quote.billing_address || {};
  return {
    ...blankQuote(opportunityId), ...quote,
    id: idOf(root) || idOf(quote), opportunityId: pick(quote, "opportunityId", "opportunity_id", opportunityId),
    customerContactId: pick(quote, "customerContactId", "customer_contact_id", idOf(quote.customer_contact_snapshot)),
    billingContactId: pick(quote, "billingContactId", "billing_contact_id", idOf(quote.billing_contact_snapshot)),
    eventId: idOf(quote.event) || idOf(quote.event_snapshot) || pick(quote, "eventId", "event_id"),
    eventKind: quote.event?.kind || quote.event_snapshot?.kind || (quote.event_snapshot?.event_state ? "complex" : "simple"),
    issueDate: String(pick(quote, "issueDate", "issue_date")).slice(0, 10),
    validUntil: String(pick(quote, "validUntil", "valid_until")).slice(0, 10),
    purchaseOrderReference: pick(quote, "purchaseOrderReference", "purchase_order_reference"),
    customerReference: pick(quote, "customerReference", "customer_reference"),
    taxTreatment: pick(quote, "taxTreatment", "tax_treatment", "exclusive"),
    paymentTerms: pick(quote, "paymentTerms", "payment_terms", "30 days"),
    salespersonId: idOf(quote.salesperson) || idOf(quote.salesperson_snapshot) || pick(quote, "salespersonId", "salesperson_id"),
    address: {
      addressee: address.addressee || address.name || "", line1: address.line1 || address.line_1 || "",
      line2: address.line2 || address.line_2 || "", city: address.city || "", region: address.region || address.county || "",
      postalCode: address.postalCode || address.postal_code || "", country: address.country || "",
    },
    lines: list(version.lines || version.line_items || version.sales_quote_line).map(normalizeLine),
    status: root.status || quote.status, rowVersion: quote.rowVersion ?? quote.row_version ?? root.rowVersion ?? root.row_version,
    versionNumber: quote.versionNumber ?? quote.version_number ?? version.versionNumber ?? version.version_number,
    permissions: payload?.permissions || payload?.capabilities || root.permissions || quote.permissions || {},
  };
}

function statusBadge(status) {
  const tones = { draft: "bg-slate-100 text-slate-700", issued: "bg-blue-100 text-blue-800", sent: "bg-blue-100 text-blue-800", accepted: "bg-emerald-100 text-emerald-800", converted: "bg-emerald-100 text-emerald-800", rejected: "bg-rose-100 text-rose-800", declined: "bg-rose-100 text-rose-800", expired: "bg-amber-100 text-amber-800", superseded: "bg-violet-100 text-violet-800" };
  return <Badge className={`border-0 capitalize ${tones[status] || tones.draft}`}>{String(status || "draft").replaceAll("_", " ")}</Badge>;
}

function QuotesList() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["sales-quotes", search, status, page],
    queryFn: () => {
      const params = new URLSearchParams({ search, page: String(page), limit: "20" });
      if (status !== "all") params.set("status", status);
      return request(`/api/sales/quotes?${params}`);
    },
  });
  const rows = list(query.data);
  const total = Number(query.data?.total ?? rows.length);
  const pages = Math.max(1, Number(query.data?.totalPages || query.data?.total_pages || Math.ceil(total / 20)));
  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row">
      <div className="relative flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input className="pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search quote, customer or opportunity…" /></div>
      <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}><SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{["draft", "issued", "sent", "accepted", "converted", "rejected", "declined", "expired", "superseded"].map((item) => <SelectItem value={item} key={item} className="capitalize">{item}</SelectItem>)}</SelectContent></Select>
      <Button onClick={() => navigate("/sales/quotes/new")}><Plus className="mr-2 h-4 w-4" />Create quote</Button>
    </div>
    {query.isLoading ? <Loading /> : query.error ? <Failure error={query.error} retry={query.refetch} /> : !rows.length ? <Card><CardContent className="py-16 text-center"><PackagePlus className="mx-auto h-9 w-9 text-slate-300" /><h3 className="mt-3 font-semibold">No quotes found</h3><p className="mt-1 text-sm text-slate-500">Create a quote from an opportunity to start building your offer.</p></CardContent></Card> :
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Quote</th><th className="px-4 py-3">Customer / opportunity</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Valid until</th><th className="px-4 py-3 text-right">Total</th></tr></thead><tbody>{rows.map((raw) => { const row = normalizeQuote(raw); return <tr key={idOf(row)} onClick={() => navigate(`/sales/quotes/${idOf(row)}`)} className="cursor-pointer border-t hover:bg-blue-50/40"><td className="px-4 py-3"><p className="font-semibold text-slate-900">{row.number || row.quoteNumber || row.quote_number || "Draft quote"}</p><p className="text-xs text-slate-500">Version {row.versionNumber || row.version_number || row.version || 1}</p></td><td className="px-4 py-3"><p>{nameOf(row.organisation_snapshot || row.customer || row.organization) || row.customer_name || "—"}</p><p className="text-xs text-slate-500">{nameOf(row.opportunity) || row.opportunity_name || "—"}</p></td><td className="px-4 py-3">{statusBadge(row.status)}</td><td className="px-4 py-3">{dateText(row.validUntil || row.valid_until)}</td><td className="px-4 py-3 text-right font-semibold">{money(row.grossTotalMinor ?? row.gross_total_minor ?? row.gross_minor ?? row.totalMinor ?? row.total_minor, row.currency)}</td></tr>; })}</tbody></table></div></Card>}
    {pages > 1 && <div className="flex items-center justify-between text-sm text-slate-500"><span>{total} quotes · Page {page} of {pages}</span><div className="flex gap-2"><Button variant="outline" size="icon" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" disabled={page === pages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
  </div>;
}

function Field({ label, children, wide }) {
  return <div className={wide ? "sm:col-span-2" : ""}><Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</Label>{children}</div>;
}

function lineTotals(line) {
  try {
    const calculated = calculateQuoteLine({
      quantity: String(line.quantity || "0"),
      quotedUnitPriceMinor: minor(line.quotedUnitPriceMinor),
      discountBps: minor(line.discountBps),
      taxRateBps: minor(line.taxRateBps),
    });
    return { net: calculated.netMinor, tax: calculated.taxMinor, gross: calculated.grossMinor };
  } catch {
    return { net: 0, tax: 0, gross: 0 };
  }
}

function LinesEditor({ form, setForm, products, bundles, readOnly, canOverride }) {
  const patch = (index, changes) => setForm((old) => ({ ...old, lines: old.lines.map((line, i) => i === index ? { ...line, ...changes } : line) }));
  const add = (type) => setForm((old) => ({ ...old, lines: [...old.lines, { ...emptyLine(), type }] }));
  const choose = (index, type, id) => {
    const source = (type === "product" ? products : bundles).find((item) => String(idOf(item)) === String(id));
    const price = type === "product" ? pick(source, "standardPriceMinor", "standard_price_minor", 0) : pick(source, "sellingPriceMinor", "selling_price_minor", 0);
    patch(index, { [`${type}Id`]: id, description: source?.name || "", standardUnitPriceMinor: price, quotedUnitPriceMinor: price, taxRateBps: pick(source, "taxRateBps", "tax_rate_bps", 2000) });
  };
  const move = (index, direction) => setForm((old) => { const lines = [...old.lines]; [lines[index], lines[index + direction]] = [lines[index + direction], lines[index]]; return { ...old, lines }; });
  return <Card><CardHeader className="flex-row flex-wrap items-center justify-between gap-2"><div><CardTitle>Quote lines</CardTitle><p className="mt-1 text-sm text-slate-500">Add catalogue items, bundles or a custom line. Prices are entered in minor units.</p></div>{!readOnly && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => add("product")}><Plus className="mr-1 h-3.5 w-3.5" />Product</Button><Button size="sm" variant="outline" onClick={() => add("bundle")}><Plus className="mr-1 h-3.5 w-3.5" />Bundle</Button><Button size="sm" variant="outline" onClick={() => add("free_text")}><Plus className="mr-1 h-3.5 w-3.5" />Free text</Button></div>}</CardHeader><CardContent>
    {!form.lines.length ? <p className="rounded-lg border border-dashed py-10 text-center text-sm text-slate-500">No lines yet.</p> : <div className="space-y-3">{form.lines.map((line, index) => {
      const totals = lineTotals(line);
      return <div key={line.key} className="rounded-xl border bg-slate-50/50 p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(180px,1.4fr)_90px_120px_120px_100px_90px_105px_auto]">
          <div><Label>Description / item</Label>{line.type === "product" || line.type === "bundle" ? <Select disabled={readOnly} value={String(line[`${line.type}Id`] || "")} onValueChange={(id) => choose(index, line.type, id)}><SelectTrigger className="bg-white"><SelectValue placeholder={`Choose ${line.type}`} /></SelectTrigger><SelectContent>{(line.type === "product" ? products : bundles).map((item) => <SelectItem key={idOf(item)} value={String(idOf(item))}>{nameOf(item)}</SelectItem>)}</SelectContent></Select> : <Input disabled={readOnly} value={line.description} onChange={(e) => patch(index, { description: e.target.value })} placeholder="Description" />}</div>
          <div><Label>Quantity</Label><Input disabled={readOnly} type="number" min="0" step="0.01" value={line.quantity} onChange={(e) => patch(index, { quantity: e.target.value })} /></div>
          <div><Label>Standard</Label><Input disabled={readOnly || line.type !== "free_text"} type="number" min="0" value={line.standardUnitPriceMinor} onChange={(e) => patch(index, { standardUnitPriceMinor: e.target.value, quotedUnitPriceMinor: e.target.value })} /></div>
          <div><Label>Quoted</Label><Input disabled={readOnly || !canOverride} title={!canOverride ? "You do not have permission to override prices" : ""} type="number" min="0" value={line.quotedUnitPriceMinor} onChange={(e) => patch(index, { quotedUnitPriceMinor: e.target.value })} /></div>
          <div><Label>Discount %</Label><Input disabled={readOnly || !canOverride} title={!canOverride ? "You do not have permission to apply discounts" : ""} type="number" min="0" max="100" step=".01" value={Number(line.discountBps || 0) / 100} onChange={(e) => patch(index, { discountBps: Math.round(Number(e.target.value) * 100) })} /></div>
          <div><Label>Tax %</Label><Input disabled={readOnly} type="number" min="0" step=".01" value={Number(line.taxRateBps || 0) / 100} onChange={(e) => patch(index, { taxRateBps: Math.round(Number(e.target.value) * 100) })} /></div>
          <div className="text-right"><Label>Gross</Label><p className="pt-2 font-semibold">{money(totals.gross, form.currency)}</p><p className="text-[11px] text-slate-500">net {money(totals.net, form.currency)} · tax {money(totals.tax, form.currency)}</p></div>
          {!readOnly && <div className="flex items-end gap-1"><Button variant="ghost" size="icon" disabled={!index} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></Button><Button variant="ghost" size="icon" disabled={index === form.lines.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></Button><Button variant="ghost" size="icon" onClick={() => setForm((old) => ({ ...old, lines: old.lines.filter((_, i) => i !== index) }))}><Trash2 className="h-4 w-4 text-rose-600" /></Button></div>}
        </div>
        {line.type !== "free_text" && <Input disabled={readOnly} className="mt-2 bg-white" value={line.description} onChange={(e) => patch(index, { description: e.target.value })} aria-label="Line description" />}
      </div>;
    })}</div>}
  </CardContent></Card>;
}

function HistoryPanel({ quoteId, version }) {
  const [compareTo, setCompareTo] = useState("");
  const history = useQuery({ queryKey: ["quote-history", quoteId], queryFn: () => request(`/api/sales/quotes/${quoteId}?resource=history`) });
  const compare = useQuery({ queryKey: ["quote-compare", quoteId, compareTo, version], queryFn: () => request(`/api/sales/quotes/${quoteId}?resource=compare&from=${encodeURIComponent(compareTo)}&to=${encodeURIComponent(version)}`), enabled: Boolean(compareTo && version) });
  const rows = list(history.data?.history || history.data);
  return <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4" />Status & version history</CardTitle></CardHeader><CardContent>{history.isLoading ? <Loading /> : !rows.length ? <p className="py-6 text-center text-sm text-slate-500">No history recorded.</p> : <ol className="space-y-4">{rows.map((item, index) => <li className="border-l-2 border-blue-200 pl-4" key={idOf(item) || index}><div className="flex items-center gap-2">{statusBadge(item.status || item.toStatus || item.to_status)}<span className="text-sm font-medium">{item.action || item.event || `Version ${item.versionNumber || item.version_number || item.version || ""}`}</span></div><p className="mt-1 text-xs text-slate-500">{nameOf(item.actor || item.createdBy || item.created_by)} · {new Date(item.createdAt || item.created_at || Date.now()).toLocaleString()}</p>{item.note && <p className="mt-1 text-sm">{item.note}</p>}</li>)}</ol>}</CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><GitCompare className="h-4 w-4" />Compare versions</CardTitle></CardHeader><CardContent><Select value={compareTo} onValueChange={setCompareTo}><SelectTrigger><SelectValue placeholder="Choose a version to compare" /></SelectTrigger><SelectContent>{rows.filter((item) => String(item.versionNumber || item.version_number || item.version) !== String(version)).map((item, index) => { const value = String(item.versionNumber || item.version_number || item.version || index + 1); return <SelectItem key={value} value={value}>Version {value}</SelectItem>; })}</SelectContent></Select>{compare.isFetching && <Loading />}{compare.error && <p className="mt-4 text-sm text-rose-700">{compare.error.message}</p>}{compare.data && <Comparison data={compare.data} />}</CardContent></Card>
  </div>;
}

function Comparison({ data }) {
  if (data?.from && data?.to) {
    const snapshot = (value) => {
      const quote = normalizeQuote(value);
      const total = value.grossMinor ?? value.gross_minor ?? value.grossTotalMinor ?? value.gross_total_minor ?? quote.grossMinor ?? quote.gross_minor ?? quote.grossTotalMinor;
      return <div className="rounded-lg border p-3 text-sm"><p className="font-semibold">Version {value.versionNumber || value.version_number || value.version || "—"}</p><p className="mt-1">{statusBadge(value.status)}</p><p className="mt-2 text-slate-600">{quote.lines.length} line{quote.lines.length === 1 ? "" : "s"} · {money(total, quote.currency)}</p><ul className="mt-2 list-disc pl-4 text-xs text-slate-600">{quote.lines.map((line, index) => <li key={index}>{line.quantity} × {line.description || line.productId || line.bundleId || "Catalogue item"}</li>)}</ul></div>;
    };
    return <div className="mt-4 grid gap-3 sm:grid-cols-2"><div><p className="mb-1 text-xs font-semibold uppercase text-slate-500">From</p>{snapshot(data.from)}</div><div><p className="mb-1 text-xs font-semibold uppercase text-slate-500">To</p>{snapshot(data.to)}</div></div>;
  }
  const changes = list(data?.changes || data?.differences || data);
  if (!changes.length) return <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No differences between these versions.</p>;
  return <div className="mt-4 space-y-2">{changes.map((change, index) => <div key={index} className="rounded-lg border p-3 text-sm"><p className="font-semibold">{change.field || change.path || change.type || "Change"}</p><div className="mt-1 grid grid-cols-2 gap-2 text-xs"><span className="rounded bg-rose-50 p-2 text-rose-800">{String(change.before ?? change.oldValue ?? change.old_value ?? "—")}</span><span className="rounded bg-emerald-50 p-2 text-emerald-800">{String(change.after ?? change.newValue ?? change.new_value ?? "—")}</span></div></div>)}</div>;
}

function QuoteEditor() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const opportunityId = new URLSearchParams(location.search).get("opportunityId") || "";
  const isNew = !id || id === "new";
  const detail = useQuery({ queryKey: ["sales-quote", id], queryFn: () => request(`/api/sales/quotes/${id}`), enabled: !isNew });
  const opportunity = useQuery({ queryKey: ["quote-opportunity", opportunityId], queryFn: () => request(`/api/opportunities/${opportunityId}`), enabled: isNew && Boolean(opportunityId) });
  const products = useQuery({ queryKey: ["quote-products"], queryFn: () => request("/api/sales/catalogue/products") });
  const bundles = useQuery({ queryKey: ["quote-bundles"], queryFn: () => request("/api/sales/catalogue/bundles") });
  const [form, setForm] = useState(() => blankQuote(opportunityId));
  const [loadedId, setLoadedId] = useState(null);
  const [savedFingerprint, setSavedFingerprint] = useState("");
  useEffect(() => {
    if (!isNew && detail.data && loadedId !== id) { const next = normalizeQuote(detail.data); setForm(next); setSavedFingerprint(JSON.stringify(next)); setLoadedId(id); }
  }, [detail.data, id, isNew, loadedId]);
  useEffect(() => {
    if (!isNew || !opportunity.data) return;
    const opp = opportunity.data?.opportunity || opportunity.data?.data?.opportunity || opportunity.data?.data || opportunity.data;
    const contactRoles = list(opportunity.data?.contactRoles || opportunity.data?.contact_roles || opportunity.data?.contacts || opp.contactRoles || opp.contact_roles);
    const primary = contactRoles.find((item) => item.is_primary || item.isPrimary || String(item.role || "").toLowerCase().includes("primary")) || contactRoles[0];
    const contactId = idOf(primary?.member) || primary?.memberId || primary?.member_id || idOf(primary);
    setForm((old) => ({ ...old, opportunityId, organizationId: opp.organization_id || opp.organizationId || old.organizationId, currency: opp.currency || old.currency, customerContactId: contactId || old.customerContactId, billingContactId: contactId || old.billingContactId }));
  }, [isNew, opportunity.data, opportunityId]);
  const quote = !isNew ? normalizeQuote(detail.data) : {};
  const status = quote.status || "draft";
  const permissions = quote.permissions || {};
  const allowed = (keys, fallback) => {
    const value = keys.map((key) => permissions[key]).find((item) => item !== undefined);
    return value === undefined ? fallback : Boolean(value);
  };
  const readOnly = !isNew && (status !== "draft" || !allowed(["canEdit", "can_edit", "edit"], false));
  // Price overrides are sensitive: absence of an explicit capability is denial.
  const canOverride = allowed(["canOverridePrices", "canOverridePrice", "can_override_prices", "can_override_price", "canDiscount", "can_discount", "override"], false);
  const contacts = list(opportunity.data?.contactRoles || opportunity.data?.contact_roles || opportunity.data?.contacts || detail.data?.contacts || detail.data?.opportunity?.contacts);
  const totals = useMemo(() => form.lines.reduce((sum, line) => { const values = lineTotals(line); return { net: sum.net + values.net, tax: sum.tax + values.tax, gross: sum.gross + values.gross }; }, { net: 0, tax: 0, gross: 0 }), [form.lines]);
  const payload = () => ({
    opportunityId: form.opportunityId, customerContactId: form.customerContactId || null, billingContactId: form.billingContactId || null,
    address: form.address, event: form.eventId ? { id: form.eventId, kind: form.eventKind || "simple" } : null, issueDate: form.issueDate || null, validUntil: form.validUntil || null,
    purchaseOrderReference: form.purchaseOrderReference || null, customerReference: form.customerReference || null, notes: form.notes,
    currency: form.currency, taxTreatment: form.taxTreatment, paymentTerms: form.paymentTerms, terms: form.paymentTerms, salespersonId: form.salespersonId || null,
    lines: form.lines.map((line) => ({ kind: line.type, catalogueId: line.type === "product" ? line.productId || null : line.type === "bundle" ? line.bundleId || null : null, description: line.description, quantity: String(line.quantity || "0"), quotedUnitPriceMinor: minor(line.quotedUnitPriceMinor), ...(line.type === "free_text" ? { standardUnitPriceMinor: minor(line.standardUnitPriceMinor) } : {}), discountBps: minor(line.discountBps), taxRateBps: minor(line.taxRateBps) })),
    expectedVersion: quote.rowVersion,
  });
  const preview = useMutation({
    mutationFn: () => request(`/api/sales/quotes${isNew ? "" : `/${id}`}?action=preview`, { method: "POST", body: JSON.stringify(payload()) }),
    onSuccess: (data) => setServerTotals(data?.quote?.totals || data?.totals || data?.preview?.totals || data?.currentVersion?.totals || data),
    onError: (error) => toast({ title: "Could not recalculate quote", description: error.message, variant: "destructive" }),
  });
  const [serverTotals, setServerTotals] = useState(null);
  const isDirty = JSON.stringify(form) !== savedFingerprint;
  const save = useMutation({
    mutationFn: () => request(isNew ? "/api/sales/quotes" : `/api/sales/quotes/${id}`, { method: isNew ? "POST" : "PATCH", body: JSON.stringify(payload()) }),
    onSuccess: (data) => { const saved = normalizeQuote(data); setSavedFingerprint(JSON.stringify(form)); setServerTotals(data?.totals || data?.currentVersion?.totals || null); qc.invalidateQueries({ queryKey: ["sales-quotes"] }); toast({ title: "Draft quote saved" }); if (isNew && saved.id) navigate(`/sales/quotes/${saved.id}`, { replace: true }); else { setLoadedId(null); detail.refetch(); } },
    onError: (error) => { if ([409, 412].includes(error.status)) detail.refetch(); toast({ title: [409, 412].includes(error.status) ? "Quote changed elsewhere" : "Could not save quote", description: [409, 412].includes(error.status) ? "The latest version has been loaded. Review it before trying again." : error.message, variant: "destructive" }); },
  });
  const action = useMutation({
    mutationFn: ({ action: actionName, extra = {} }) => request(`/api/sales/quotes/${id}?action=${actionName}`, { method: "POST", body: JSON.stringify({ expectedVersion: quote.rowVersion, ...extra }) }),
    onSuccess: (data, variables) => { const result = normalizeQuote(data); qc.invalidateQueries({ queryKey: ["sales-quotes"] }); qc.invalidateQueries({ queryKey: ["sales-quote", id] }); toast({ title: variables.action === "amend" ? "Amendment created" : variables.action === "issue" ? "Quote issued" : "Quote status updated" }); if (variables.action === "amend" && result.id) navigate(`/sales/quotes/${result.id}`); },
    onError: (error) => toast({ title: "Quote action failed", description: error.message, variant: "destructive" }),
  });
  if (!isNew && detail.isLoading) return <Loading />;
  if (!isNew && detail.error) return <Failure error={detail.error} retry={detail.refetch} />;
  const patch = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><Button variant="outline" size="icon" onClick={() => navigate("/sales/quotes")}><ArrowLeft className="h-4 w-4" /></Button><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-bold">{isNew ? "Create quote" : quote.number || quote.quoteNumber || quote.quote_number || "Quote"}</h2>{statusBadge(status)}{!isNew && <Badge variant="outline">Version {quote.versionNumber || quote.version_number || quote.version || 1}</Badge>}</div><p className="mt-1 text-sm text-slate-500">{readOnly ? "Issued versions are immutable. Create an amendment to make changes." : "Build and save a customer-ready quote."}</p></div></div><div className="flex flex-wrap gap-2">{!readOnly && <Button variant="outline" disabled={preview.isPending || !form.lines.length} onClick={() => preview.mutate()}>{preview.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Recalculate</Button>}{!readOnly && <Button variant="outline" disabled={save.isPending || !form.opportunityId || !form.lines.length} onClick={() => save.mutate()}>{save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save draft</Button>}{!isNew && status === "draft" && allowed(["canIssue", "can_issue", "issue"], false) && <Button disabled={action.isPending || !form.lines.length || isDirty} title={isDirty ? "Save the latest draft before issuing" : ""} onClick={() => action.mutate({ action: "issue" })}><Send className="mr-2 h-4 w-4" />Issue</Button>}{!isNew && status !== "draft" && status !== "superseded" && allowed(["canAmend", "can_amend", "amend"], false) && <Button onClick={() => action.mutate({ action: "amend" })}><RefreshCw className="mr-2 h-4 w-4" />Amend</Button>}{!isNew && ["issued", "sent"].includes(status) && allowed(["canTransition", "can_transition", "transition"], false) && <><Button variant="outline" onClick={() => action.mutate({ action: "transition", extra: { status: "accepted" } })}><Check className="mr-2 h-4 w-4" />Accept</Button><Button variant="outline" onClick={() => action.mutate({ action: "transition", extra: { status: "declined" } })}>Decline</Button><Button variant="outline" onClick={() => action.mutate({ action: "transition", extra: { status: "expired" } })}>Expire</Button></>}{!isNew && status === "accepted" && allowed(["canTransition", "can_transition", "transition"], false) && <Button variant="outline" onClick={() => action.mutate({ action: "transition", extra: { status: "converted" } })}>Convert</Button>}</div></div>
    {isNew && !opportunityId && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mr-2 inline h-4 w-4" />A quote must be linked to an opportunity. Enter its ID below or start from an opportunity detail page.</div>}
    <Tabs defaultValue="quote"><TabsList><TabsTrigger value="quote">Quote</TabsTrigger>{!isNew && <TabsTrigger value="history">History & compare</TabsTrigger>}</TabsList>
      <TabsContent value="quote" className="space-y-5">
        <Card><CardHeader><CardTitle>Customer & commercial details</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Opportunity"><Input disabled={!isNew || readOnly} value={form.opportunityId} onChange={(e) => patch("opportunityId", e.target.value)} placeholder="Opportunity ID" /></Field>
          <Field label="Customer contact">{contacts.length ? <Select disabled={readOnly} value={String(form.customerContactId || "none")} onValueChange={(value) => patch("customerContactId", value === "none" ? "" : value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Not selected</SelectItem>{contacts.map((contact) => <SelectItem value={String(idOf(contact.member || contact))} key={idOf(contact)}>{nameOf(contact.member || contact)}</SelectItem>)}</SelectContent></Select> : <Input disabled={readOnly} value={form.customerContactId} onChange={(e) => patch("customerContactId", e.target.value)} placeholder="Contact ID" />}</Field>
          <Field label="Billing contact">{contacts.length ? <Select disabled={readOnly} value={String(form.billingContactId || "none")} onValueChange={(value) => patch("billingContactId", value === "none" ? "" : value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Same as customer</SelectItem>{contacts.map((contact) => <SelectItem value={String(idOf(contact.member || contact))} key={idOf(contact)}>{nameOf(contact.member || contact)}</SelectItem>)}</SelectContent></Select> : <Input disabled={readOnly} value={form.billingContactId} onChange={(e) => patch("billingContactId", e.target.value)} placeholder="Contact ID" />}</Field>
          <Field label="Event"><Input disabled={readOnly} value={form.eventId} onChange={(e) => patch("eventId", e.target.value)} placeholder="Optional event ID" /></Field>
          <Field label="Issue date"><Input disabled={readOnly} type="date" value={form.issueDate} onChange={(e) => patch("issueDate", e.target.value)} /></Field>
          <Field label="Valid until"><Input disabled={readOnly} type="date" value={form.validUntil} onChange={(e) => patch("validUntil", e.target.value)} /></Field>
          <Field label="PO reference"><Input disabled={readOnly} value={form.purchaseOrderReference} onChange={(e) => patch("purchaseOrderReference", e.target.value)} /></Field>
          <Field label="Customer reference"><Input disabled={readOnly} value={form.customerReference} onChange={(e) => patch("customerReference", e.target.value)} /></Field>
          <Field label="Salesperson"><Input disabled={readOnly} value={form.salespersonId} onChange={(e) => patch("salespersonId", e.target.value)} placeholder="Member ID" /></Field>
          <Field label="Currency"><Input disabled={readOnly || form.lines.length > 0} maxLength={3} value={form.currency} onChange={(e) => patch("currency", e.target.value.toUpperCase())} /></Field>
          <Field label="Tax treatment"><Select disabled={readOnly} value={form.taxTreatment} onValueChange={(value) => patch("taxTreatment", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exclusive">Tax exclusive</SelectItem><SelectItem value="inclusive">Tax inclusive</SelectItem><SelectItem value="exempt">Exempt</SelectItem></SelectContent></Select></Field>
          <Field label="Payment terms"><Input disabled={readOnly} value={form.paymentTerms} onChange={(e) => patch("paymentTerms", e.target.value)} /></Field>
          <Field label="Internal / customer notes" wide><Textarea disabled={readOnly} rows={3} value={form.notes} onChange={(e) => patch("notes", e.target.value)} /></Field>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Billing address snapshot</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[["addressee", "Addressee"], ["line1", "Address line 1"], ["line2", "Address line 2"], ["city", "City"], ["region", "County / region"], ["postalCode", "Postcode"], ["country", "Country"]].map(([key, label]) => <Field key={key} label={label}><Input disabled={readOnly} value={form.address[key]} onChange={(e) => setForm((old) => ({ ...old, address: { ...old.address, [key]: e.target.value } }))} /></Field>)}</CardContent></Card>
        <LinesEditor form={form} setForm={setForm} products={list(products.data)} bundles={list(bundles.data)} readOnly={readOnly} canOverride={canOverride} />
        <Card><CardContent className="flex flex-col items-end gap-1 p-5 text-sm"><p className="mb-2 w-full text-xs text-slate-500">{serverTotals ? "Server-calculated totals" : "Local estimate — save or recalculate for final server totals"}</p><div className="flex w-full max-w-xs justify-between"><span>Net</span><strong>{money(serverTotals?.netMinor ?? serverTotals?.net_minor ?? serverTotals?.netTotalMinor ?? serverTotals?.net_total_minor ?? totals.net, form.currency)}</strong></div><div className="flex w-full max-w-xs justify-between"><span>Tax</span><strong>{money(serverTotals?.taxMinor ?? serverTotals?.tax_minor ?? serverTotals?.taxTotalMinor ?? serverTotals?.tax_total_minor ?? totals.tax, form.currency)}</strong></div><div className="mt-2 flex w-full max-w-xs justify-between border-t pt-2 text-lg"><span>Gross total</span><strong>{money(serverTotals?.grossMinor ?? serverTotals?.gross_minor ?? serverTotals?.grossTotalMinor ?? serverTotals?.gross_total_minor ?? totals.gross, form.currency)}</strong></div></CardContent></Card>
      </TabsContent>
      {!isNew && <TabsContent value="history"><HistoryPanel quoteId={id} version={quote.versionNumber || quote.version_number || quote.version} /></TabsContent>}
    </Tabs>
  </div>;
}

function Loading() { return <div className="grid min-h-48 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /></div>; }
function Failure({ error, retry }) { return <Card className="border-rose-200"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-rose-700"><span><AlertTriangle className="mr-2 inline h-4 w-4" />{error.message}</span><Button variant="outline" onClick={() => retry()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></CardContent></Card>; }

export default function QuotesWorkspace() {
  const { id } = useParams();
  return id ? <QuoteEditor /> : <QuotesList />;
}