import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight,
  Download, Eye, GitCompare, History, Link2Off, Loader2, PackagePlus,
  Plus, RefreshCw, Search, Send, Trash2,
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
import { useQuoteNaming } from "@/hooks/useSalesSettings";
import { quotePath } from "@shared/salesNaming.js";
import InvoiceStatusPanel from "@/components/sales/InvoiceStatusPanel";
import QuoteOpportunitySelect from "./QuoteOpportunitySelect";
import QuoteEventSelect from "./QuoteEventSelect";
import QuoteSalespersonSelect from "./QuoteSalespersonSelect";
import QuoteContactSelect from "./QuoteContactSelect";
import SendQuoteDialog from "./SendQuoteDialog";
import AgreementLegalEditor from "./AgreementLegalEditor";
import AgreementDocument from "./AgreementDocument";
import AgreementSignatureRequests from "./AgreementSignatureRequests";
import AgreementFinalizationPanel from "./AgreementFinalizationPanel";
import { legalHtmlOf } from "./agreementSignature";
import AcceptQuoteButton from "./AcceptQuoteButton";
import { refreshSavedQuoteDraft } from "./quoteDraftRefresh";
import QuoteVersionDocuments, { uniqueQuoteVersions } from "./QuoteVersionDocuments";
import { quotePriceText, quotePriceMinor, quotePriceError } from "./quoteFormValues";
import { clearOpportunityContacts, opportunityContacts, useQuoteOpportunity } from "./useQuoteOpportunity";
import { calculateQuoteLine } from "@shared/salesContracts.js";
import { useCatalogueTaxOptions } from "@/pages/sales/useCatalogue";
import { persistedQuoteLineId, providerTaxOptions, quoteLineIdentityForSaving, quoteLineTaxForSaving, savedLineTaxCode, taxCodeKey, taxCodeLabel } from "@/lib/salesTaxCodes";
import QuoteBillingSettings from "./QuoteBillingSettings";
import BillingSchedule from "./BillingSchedule";
import { billingScheduleOf } from "./billingGroups";
import { useSalesSettingsScope } from "./useSalesSettings";

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

export async function quotePdf(quoteId, version) {
  const params = new URLSearchParams({ action: "pdf" });
  if (version != null) params.set("version", String(version));
  const response = await fetch(`/api/sales/quotes/${quoteId}?${params}`, { credentials: "include" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || payload?.error || `Could not generate PDF (${response.status})`);
  }
  return response.blob();
}

function openBlob(blob, filename, preview = false) {
  const url = URL.createObjectURL(blob);
  if (preview) window.open(url, "_blank", "noopener,noreferrer");
  else {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const emptyLine = () => ({
  key: crypto.randomUUID(), type: "free_text", productId: "", bundleId: "", description: "",
  quantity: 1, standardUnitPriceMinor: 0, quotedUnitPriceMinor: 0, discountBps: 0, taxRateBps: 0,
  taxCode: null, taxChanged: false, legacyTax: false, persistedLineId: null,
});

const blankQuote = (opportunityId = "") => ({
  opportunityId, customerContactId: "", billingContactId: "", eventId: "", eventKind: "simple", issueDate: new Date().toISOString().slice(0, 10),
  validUntil: "", purchaseOrderReference: "", customerReference: "", notes: "", currency: "GBP",
  taxTreatment: "exclusive", paymentTerms: "30 days", salespersonId: "", address: {
    addressee: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "United Kingdom",
  }, lines: [], scheduledBilling: false, remainderPaymentTermsId: "", legalHtml: "",
});

function normalizeLine(line, index) {
  return {
    ...emptyLine(), ...line, key: idOf(line) || line.key || `line-${index}`,
    persistedLineId: persistedQuoteLineId(line),
    type: line.kind || line.catalogue_kind || line.type || line.line_type || (line.catalogueId || line.catalogue_id ? "product" : "free_text"),
    productId: pick(line, "catalogueId", "catalogue_id", pick(line, "productId", "product_id")), bundleId: pick(line, "catalogueId", "catalogue_id", pick(line, "bundleId", "bundle_id")),
    standardUnitPriceMinor: pick(line, "standardUnitPriceMinor", "standard_unit_price_minor", 0),
    quotedUnitPriceMinor: pick(line, "quotedUnitPriceMinor", "quoted_unit_price_minor", 0),
    discountBps: pick(line, "discountBps", "discount_bps", 0), taxRateBps: pick(line, "taxRateBps", "tax_rate_bps", 0),
    taxCode: savedLineTaxCode(line), taxChanged: false, legacyTax: !savedLineTaxCode(line),
  };
}

export function normalizeQuote(payload, opportunityId = "") {
  const root = payload?.quote || payload?.data?.quote || payload?.data || payload || {};
  // Detail responses keep quote identity at the root and the immutable/editable
  // values in currentVersion. Always prefer that authoritative version.
  const version = root.currentVersion || root.versions?.find(item => Number(item.version_number) === Number(root.current_version)) || (typeof root.current_version === "object" ? root.current_version : root);
  const quote = { ...root, ...version };
  // `invoice: null` is meaningful after an accounting-provider switch: do not
  // fall back to a historical version's invoice in that case.
  const invoiceSource = [payload, root, quote].find((value) => Object.prototype.hasOwnProperty.call(value || {}, "invoice"));
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
    paymentTerms: quote.terms_snapshot?.text || quote.terms?.text || pick(quote, "paymentTerms", "payment_terms", "30 days"),
    legalHtml: legalHtmlOf(quote),
    scheduledBilling: pick(quote, "scheduledBilling", "scheduled_billing", Boolean(billingScheduleOf(quote))),
    remainderPaymentTermsId: pick(quote, "remainderPaymentTermsId", "remainder_payment_terms_id"),
    billingSchedule: billingScheduleOf(quote),
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
    invoice: invoiceSource ? invoiceSource.invoice : null,
    saleId: quote.saleId ?? quote.sale_id ?? root.saleId ?? root.sale_id ?? payload?.saleId ?? payload?.sale_id ?? null,
    activeProvider: payload?.activeProvider ?? payload?.active_provider ?? root.activeProvider ?? root.active_provider ?? quote.activeProvider ?? quote.active_provider ?? null,
    invoices: payload?.invoices ?? payload?.invoiceHistory ?? payload?.invoice_history
      ?? root.invoices ?? root.invoiceHistory ?? root.invoice_history
      ?? quote.invoices ?? quote.invoiceHistory ?? quote.invoice_history ?? [],
  };
}

function statusBadge(status) {
  const tones = { draft: "bg-slate-100 text-slate-700", issued: "bg-blue-100 text-blue-800", send_attempt: "bg-slate-100 text-slate-700", sent: "bg-blue-100 text-blue-800", send_failed: "bg-rose-100 text-rose-800", viewed: "bg-cyan-100 text-cyan-800", downloaded: "bg-cyan-100 text-cyan-800", accepted: "bg-emerald-100 text-emerald-800", converted: "bg-emerald-100 text-emerald-800", rejected: "bg-rose-100 text-rose-800", declined: "bg-rose-100 text-rose-800", revoked: "bg-rose-100 text-rose-800", expired: "bg-amber-100 text-amber-800", superseded: "bg-violet-100 text-violet-800" };
  return <Badge className={`border-0 capitalize ${tones[status] || tones.draft}`}>{String(status || "draft").replaceAll("_", " ")}</Badge>;
}

export function QuotesList({ opportunityId = "" }) {
  const naming = useQuoteNaming();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["sales-quotes", search, status, page, opportunityId],
    queryFn: () => {
      const params = new URLSearchParams({ search, page: String(page), limit: "20" });
      if (opportunityId) params.set("opportunityId", opportunityId);
      if (status !== "all") params.set("status", status);
      return request(`/api/sales/quotes?${params}`);
    },
  });
  const rows = list(query.data);
  const total = Number(query.data?.total ?? rows.length);
  const pages = Math.max(1, Number(query.data?.totalPages || query.data?.total_pages || Math.ceil(total / 20)));
  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row">
      <div className="relative flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input className="pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={`Search ${naming.singular}, customer or opportunity…`} /></div>
      <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}><SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{["draft", "issued", "sent", "accepted", "converted", "rejected", "declined", "expired", "superseded"].map((item) => <SelectItem value={item} key={item} className="capitalize">{item}</SelectItem>)}</SelectContent></Select>
      <Button onClick={() => navigate(`${quotePath(naming, "new")}${opportunityId ? `?opportunityId=${encodeURIComponent(opportunityId)}` : ""}`)}><Plus className="mr-2 h-4 w-4" />Create {naming.singular}</Button>
    </div>
    {query.isLoading ? <Loading /> : query.error ? <Failure error={query.error} retry={query.refetch} /> : !rows.length ? <Card><CardContent className="py-16 text-center"><PackagePlus className="mx-auto h-9 w-9 text-slate-300" /><h3 className="mt-3 font-semibold">No {naming.plural} found</h3><p className="mt-1 text-sm text-slate-500">Create a {naming.singular} from an opportunity to start building your offer.</p></CardContent></Card> :
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">{naming.singular}</th><th className="px-4 py-3">Customer / opportunity</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Valid until</th><th className="px-4 py-3 text-right">Total</th></tr></thead><tbody>{rows.map((raw) => { const row = normalizeQuote(raw); return <tr key={idOf(row)} onClick={() => navigate(quotePath(naming, idOf(row)))} className="cursor-pointer border-t hover:bg-blue-50/40"><td className="px-4 py-3"><p className="font-semibold text-slate-900">{row.number || row.quoteNumber || row.quote_number || `Draft ${naming.singular}`}</p><p className="text-xs text-slate-500">Version {row.versionNumber || row.version_number || row.version || 1}</p></td><td className="px-4 py-3"><p>{nameOf(row.organisation_snapshot || row.customer || row.organization) || row.customer_name || "—"}</p><p className="text-xs text-slate-500">{nameOf(row.opportunity) || row.opportunity_name || "—"}</p></td><td className="px-4 py-3">{statusBadge(row.status)}</td><td className="px-4 py-3">{dateText(row.validUntil || row.valid_until)}</td><td className="px-4 py-3 text-right font-semibold">{money(row.grossTotalMinor ?? row.gross_total_minor ?? row.gross_minor ?? row.totalMinor ?? row.total_minor, row.currency)}</td></tr>; })}</tbody></table></div></Card>}
    {pages > 1 && <div className="flex items-center justify-between text-sm text-slate-500"><span>{total} {naming.plural} · Page {page} of {pages}</span><div className="flex gap-2"><Button variant="outline" size="icon" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" disabled={page === pages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
  </div>;
}

function Field({ label, children, wide }) {
  return <div className={wide ? "sm:col-span-2" : ""}><Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</Label>{children}</div>;
}

function lineTotals(line) {
  try {
    const calculated = calculateQuoteLine({
      quantity: String(line.quantity || "0"),
      quotedUnitPriceMinor: quotePriceMinor(line, "quotedUnitPriceMinor"),
      discountBps: minor(line.discountBps),
      taxRateBps: minor(line.taxRateBps),
    });
    return { net: calculated.netMinor, tax: calculated.taxMinor, gross: calculated.grossMinor };
  } catch {
    return { net: 0, tax: 0, gross: 0 };
  }
}

export function LinesEditor({ form, setForm, products, bundles, readOnly, canOverride }) {
  const { singular } = useQuoteNaming();
  const taxOptions = useCatalogueTaxOptions(!readOnly);
  const taxItems = providerTaxOptions(taxOptions.data);
  const patch = (index, changes) => setForm((old) => ({ ...old, lines: old.lines.map((line, i) => i === index ? { ...line, ...changes } : line) }));
  const add = (type) => setForm((old) => ({ ...old, lines: [...old.lines, { ...emptyLine(), type }] }));
  const choose = (index, type, id) => {
    const source = (type === "product" ? products : bundles).find((item) => String(idOf(item)) === String(id));
    const price = type === "product" ? pick(source, "standardPriceMinor", "standard_price_minor", 0) : pick(source, "sellingPriceMinor", "selling_price_minor", 0);
    patch(index, { [`${type}Id`]: id, description: source?.name || "", standardUnitPriceMinor: price, quotedUnitPriceMinor: price, standardUnitPriceMinorInput: undefined, quotedUnitPriceMinorInput: undefined, ...(type === "product" ? { taxRateBps: pick(source, "taxRateBps", "tax_rate_bps", 0), taxCode: source?.taxCode || null, legacyTax: false, taxChanged: false } : {}) });
  };
  const move = (index, direction) => setForm((old) => { const lines = [...old.lines]; [lines[index], lines[index + direction]] = [lines[index + direction], lines[index]]; return { ...old, lines }; });
  return <Card><CardHeader className="flex-row flex-wrap items-center justify-between gap-2"><div><CardTitle>{singular} lines</CardTitle><p className="mt-1 text-sm text-slate-500">Add catalogue items, bundles or a custom line. Enter prices in {form.currency}, e.g. 40.00.</p></div>{!readOnly && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => add("product")}><Plus className="mr-1 h-3.5 w-3.5" />Product</Button><Button size="sm" variant="outline" onClick={() => add("bundle")}><Plus className="mr-1 h-3.5 w-3.5" />Bundle</Button><Button size="sm" variant="outline" onClick={() => add("free_text")}><Plus className="mr-1 h-3.5 w-3.5" />Free text</Button></div>}</CardHeader><CardContent>
    {!form.lines.length ? <p className="rounded-lg border border-dashed py-10 text-center text-sm text-slate-500">No lines yet.</p> : <div className="space-y-3">{form.lines.map((line, index) => {
      const totals = lineTotals(line);
      return <div key={line.key} className="min-w-0 rounded-xl border bg-slate-50/50 p-3">
        <div className="grid gap-3 [&>div]:min-w-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
          <div><Label>Description / item</Label>{line.type === "product" || line.type === "bundle" ? <Select disabled={readOnly} value={String(line[`${line.type}Id`] || "")} onValueChange={(id) => choose(index, line.type, id)}><SelectTrigger className="bg-white"><SelectValue placeholder={`Choose ${line.type}`} /></SelectTrigger><SelectContent>{(line.type === "product" ? products : bundles).map((item) => <SelectItem key={idOf(item)} value={String(idOf(item))}>{nameOf(item)}</SelectItem>)}</SelectContent></Select> : <Input disabled={readOnly} value={line.description} onChange={(e) => patch(index, { description: e.target.value })} placeholder="Description" />}</div>
          <div><Label>Quantity</Label><Input disabled={readOnly} type="number" min="0" step="0.01" value={line.quantity} onChange={(e) => patch(index, { quantity: e.target.value })} /></div>
          <div><Label>Standard ({form.currency})</Label><Input aria-label={`Line ${index + 1} standard price`} disabled={readOnly || line.type !== "free_text"} type="text" inputMode="decimal" value={quotePriceText(line, "standardUnitPriceMinor")} onChange={(e) => patch(index, { standardUnitPriceMinorInput: e.target.value, quotedUnitPriceMinorInput: e.target.value })} /></div>
          <div><Label>Quoted ({form.currency})</Label><Input aria-label={`Line ${index + 1} quoted price`} disabled={readOnly || !canOverride} title={!canOverride ? "You do not have permission to override prices" : ""} type="text" inputMode="decimal" value={quotePriceText(line, "quotedUnitPriceMinor")} onChange={(e) => patch(index, { quotedUnitPriceMinorInput: e.target.value })} /></div>
          <div><Label>Discount %</Label><Input disabled={readOnly || !canOverride} title={!canOverride ? "You do not have permission to apply discounts" : ""} type="number" min="0" max="100" step=".01" value={Number(line.discountBps || 0) / 100} onChange={(e) => patch(index, { discountBps: Math.round(Number(e.target.value) * 100) })} /></div>
          <div><Label>Tax %</Label><Input readOnly aria-label={`Line ${index + 1} tax rate`} value={Number(line.taxRateBps || 0) / 100} /></div>
          <div className="break-words text-right"><Label>Gross</Label><p className="pt-2 font-semibold">{money(totals.gross, form.currency)}</p><p className="text-[11px] text-slate-500">net {money(totals.net, form.currency)} · tax {money(totals.tax, form.currency)}</p></div>
          {!readOnly && <div className="flex flex-wrap items-end justify-end gap-1"><Button variant="ghost" size="icon" aria-label={`Move line ${index + 1} up`} disabled={!index} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label={`Move line ${index + 1} down`} disabled={index === form.lines.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label={`Delete line ${index + 1}`} onClick={() => setForm((old) => ({ ...old, lines: old.lines.filter((_, i) => i !== index) }))}><Trash2 className="h-4 w-4 text-rose-600" /></Button></div>}
        </div>
        {quotePriceError(line) && <p role="alert" className="mt-2 text-sm text-rose-700">{quotePriceError(line)}</p>}
        {line.type !== "free_text" && <Input disabled={readOnly} className="mt-2 bg-white" value={line.description} onChange={(e) => patch(index, { description: e.target.value })} aria-label="Line description" />}
        <div className="mt-3">
          <Label>Provider VAT code</Label>
          {line.type === "product" || readOnly ? <p className="mt-1 text-xs text-slate-600">{line.taxCode ? taxCodeLabel(line.taxCode) : line.legacyTax ? "Legacy tax — no saved provider code. Existing tax is preserved." : "Uses the selected product’s provider code automatically."}</p> : <>
            <select aria-label={`Line ${index + 1} provider VAT code`} className="mt-1 h-9 w-full rounded-md border border-input bg-white px-3 text-sm disabled:opacity-50" disabled={taxOptions.isPending || taxOptions.isError} value={line.taxChanged ? taxCodeKey(line.taxCode) : ""} onChange={(event) => {
              if (!event.target.value) {
                const saved = form.lines[index];
                patch(index, { taxCode: saved.originalTaxCode || null, taxRateBps: saved.originalTaxRateBps ?? 0, legacyTax: saved.originalLegacyTax ?? false, taxChanged: false });
                return;
              }
              const code = taxItems.find((item) => taxCodeKey(item) === event.target.value && item.selectable);
              if (code) patch(index, { ...(!line.taxChanged ? { originalTaxCode: line.taxCode, originalTaxRateBps: line.taxRateBps, originalLegacyTax: line.legacyTax } : {}), taxCode: code, taxRateBps: code.rateBps, taxChanged: true });
            }}>
              <option value="">{line.taxChanged ? "Undo tax selection" : line.taxCode ? `Keep saved: ${taxCodeLabel(line.taxCode)}` : line.legacyTax ? "Keep legacy tax — no saved provider code" : "Choose a synced provider VAT code"}</option>
              {taxItems.filter((code) => taxCodeKey(code)).map((code) => <option key={taxCodeKey(code)} value={taxCodeKey(code)} disabled={!code.selectable}>{taxCodeLabel(code)} · {Number(code.rateBps) / 100}%</option>)}
            </select>
            {!line.taxChanged && line.legacyTax && <p className="mt-1 text-xs text-slate-500">Existing tax is preserved until you explicitly choose a provider code.</p>}
          </>}
        </div>
      </div>;
    })}</div>}
    {!readOnly && <div className="mt-3 text-xs text-slate-500">{taxOptions.isPending ? <p role="status" className="animate-pulse rounded bg-slate-100 p-3">Loading synced VAT codes…</p> : taxOptions.isError ? <p role="alert">{taxOptions.error?.message || "VAT codes could not be loaded."} <Button variant="link" className="h-auto p-0 text-xs" onClick={() => taxOptions.refetch()}>Retry</Button></p> : !taxItems.some((item) => item.selectable) ? <p>No synced provider VAT codes are available. Sync tax codes in your accounting integration settings. Existing saved tax can still be retained.</p> : <p>Choose provider codes directly. Tax rates are derived from the selected code; product lines use their catalogue code.</p>}</div>}
  </CardContent></Card>;
}

function HistoryPanel({ quoteId, version, versions: rawVersions }) {
  const [compareTo, setCompareTo] = useState("");
  const versions = uniqueQuoteVersions(rawVersions);
  const history = useQuery({ queryKey: ["quote-history", quoteId], queryFn: () => request(`/api/sales/quotes/${quoteId}?resource=history`) });
  const compare = useQuery({ queryKey: ["quote-compare", quoteId, compareTo, version], queryFn: () => request(`/api/sales/quotes/${quoteId}?resource=compare&from=${encodeURIComponent(compareTo)}&to=${encodeURIComponent(version)}`), enabled: Boolean(compareTo && version) });
  const rows = list(history.data?.history || history.data);
  return <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4" />Status & version history</CardTitle></CardHeader><CardContent>{history.isLoading ? <Loading /> : !rows.length ? <p className="py-6 text-center text-sm text-slate-500">No history recorded.</p> : <ol className="space-y-4">{rows.map((item, index) => <li className="border-l-2 border-blue-200 pl-4" key={idOf(item) || index}><div className="flex items-center gap-2">{statusBadge(item.status || item.toStatus || item.to_status)}<span className="text-sm font-medium">{item.action || item.event || `Version ${item.versionNumber || item.version_number || item.version || ""}`}</span></div><p className="mt-1 text-xs text-slate-500">{nameOf(item.actor || item.createdBy || item.created_by)} · {new Date(item.createdAt || item.created_at || Date.now()).toLocaleString()}</p>{item.note && <p className="mt-1 text-sm">{item.note}</p>}</li>)}</ol>}</CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><GitCompare className="h-4 w-4" />Compare versions</CardTitle></CardHeader><CardContent><Select disabled={versions.length < 2} value={compareTo} onValueChange={value => { if (value) setCompareTo(value); }}><SelectTrigger><SelectValue placeholder={versions.length < 2 ? "No other versions to compare" : "Choose a version to compare"} /></SelectTrigger><SelectContent>{versions.filter(item => String(item.number) !== String(version)).map(item => <SelectItem key={item.number} value={String(item.number)}>Version {item.number}</SelectItem>)}</SelectContent></Select>{compare.isFetching && <Loading />}{compare.error && <p className="mt-4 text-sm text-rose-700">{compare.error.message}</p>}{compare.data && <Comparison data={compare.data} />}</CardContent></Card>
  </div>;
}

function DeliveryHistory({ quoteId }) {
  const { singular } = useQuoteNaming();
  const history = useQuery({
    queryKey: ["quote-delivery-history", quoteId],
    queryFn: () => request(`/api/sales/quotes/${quoteId}?action=delivery-history`),
  });
  const rows = list(history.data?.history || history.data?.deliveries || history.data);
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Send className="h-4 w-4" />Delivery history</CardTitle></CardHeader><CardContent>
    {history.isLoading ? <Loading /> : history.error ? <Failure error={history.error} retry={history.refetch} /> : !rows.length ? <p className="py-8 text-center text-sm text-slate-500">This {singular} has not been delivered yet.</p> :
      <ol className="space-y-4">{rows.map((item, index) => {
        // Delivery history deliberately consumes only fields exposed by the
        // delivery-history DTO; never render request metadata or token values.
        const state = String(item.eventType || item.event_type || item.status || item.event || "sent")
          .replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
        const labels = { send_attempt: "Send attempted", sent: "Sent", send_failed: "Send failed", viewed: "Viewed", downloaded: "Downloaded", accepted: "Accepted", declined: "Declined", expired: "Expired", revoked: "Link revoked" };
        const recipient = item.recipientEmail || item.recipient_email || item.recipient || "Customer";
        const occurredAt = item.occurredAt || item.occurred_at || item.createdAt || item.created_at;
        const version = item.versionNumber || item.version_number;
        const errorMessage = item.errorMessage || item.error_message;
        return <li key={idOf(item) || index} className="flex gap-3 border-l-2 border-blue-200 pl-4">
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2">{statusBadge(state)}<span className="text-sm font-medium">{labels[state] || "Delivery event"}</span></div>
            <p className="mt-1 text-xs text-slate-500">{recipient}{occurredAt ? ` · ${new Date(occurredAt).toLocaleString()}` : ""}{version ? ` · Version ${version}` : ""}</p>
            {errorMessage && <p className="mt-1 text-sm text-rose-700">{errorMessage}</p>}
          </div>
        </li>;
      })}</ol>}
  </CardContent></Card>;
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
  const scope = useSalesSettingsScope();
  const naming = useQuoteNaming();
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const opportunityId = new URLSearchParams(location.search).get("opportunityId") || "";
  const isNew = !id || id === "new";
  const detail = useQuery({ queryKey: ["sales-quote", id, scope.scopeKey], queryFn: async () => {
    const data = await request(`/api/sales/quotes/${id}`);
    if (!data?.id || (!data.currentVersion && !data.versions?.length)) throw new Error(`The ${naming.singular} details were not returned. Please retry loading this ${naming.singular}.`);
    return data;
  }, enabled: scope.ready && !isNew, refetchOnMount: "always" });
  const products = useQuery({ queryKey: ["quote-products", scope.scopeKey], enabled: scope.ready, queryFn: () => request("/api/sales/catalogue/products") });
  const bundles = useQuery({ queryKey: ["quote-bundles", scope.scopeKey], enabled: scope.ready, queryFn: () => request("/api/sales/catalogue/bundles") });
  const taxOptions = useCatalogueTaxOptions(true);
  const [form, setForm] = useState(() => blankQuote(opportunityId));
  const opportunity = useQuoteOpportunity({ opportunityId: form.opportunityId, isNew, setForm, request });
  const [loadedId, setLoadedId] = useState(null);
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [sendOpen, setSendOpen] = useState(false);
  const [signingRequest, setSigningRequest] = useState(null);
  useEffect(() => {
    if (!isNew && detail.data && loadedId !== id) { const next = normalizeQuote(detail.data); setForm(next); setSavedFingerprint(JSON.stringify(next)); setLoadedId(id); }
  }, [detail.data, id, isNew, loadedId]);
  useEffect(() => {
    if (isNew) setForm((old) => old.opportunityId === opportunityId ? old : clearOpportunityContacts(old, opportunityId));
  }, [isNew, opportunityId]);
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
  const savedContacts = opportunityContacts(detail.data?.opportunity || { contacts: detail.data?.contacts || [] });
  const contacts = isNew ? (opportunity.ready ? opportunity.contacts : []) : savedContacts.length ? savedContacts : opportunity.contacts;
  const contactsDisabled = readOnly || (isNew && !opportunity.ready);
  const contactsLoading = !savedContacts.length && Boolean(form.opportunityId) && opportunity.isPending;
  const contactsError = !savedContacts.length && opportunity.isError;
  const opportunityName = opportunity.data?.name || nameOf(quote.opportunity || quote.opportunity_snapshot) || quote.opportunity_name || "";
  const totals = useMemo(() => form.lines.reduce((sum, line) => { const values = lineTotals(line); return { net: sum.net + values.net, tax: sum.tax + values.tax, gross: sum.gross + values.gross }; }, { net: 0, tax: 0, gross: 0 }), [form.lines]);
  const invalidPrices = form.lines.some(line => Boolean(quotePriceError(line)));
  const [schedulePreview, setSchedulePreview] = useState(null);
  const payload = () => ({
    opportunityId: form.opportunityId, customerContactId: form.customerContactId || null, billingContactId: form.billingContactId || null,
    address: form.address, event: form.eventId ? { id: form.eventId, kind: form.eventKind || "simple" } : null, issueDate: form.issueDate || null, validUntil: form.validUntil || null,
    purchaseOrderReference: form.purchaseOrderReference || null, customerReference: form.customerReference || null, notes: form.notes,
    currency: form.currency, taxTreatment: form.taxTreatment, paymentTerms: form.paymentTerms, terms: form.paymentTerms, salespersonId: form.salespersonId || null,
    legalHtml: form.legalHtml || "",
    scheduledBilling: Boolean(form.scheduledBilling), remainderPaymentTermsId: form.scheduledBilling ? form.remainderPaymentTermsId || null : null,
    lines: form.lines.map((line) => ({ ...quoteLineIdentityForSaving(line), kind: line.type, catalogueId: line.type === "product" ? line.productId || null : line.type === "bundle" ? line.bundleId || null : null, description: line.description, quantity: String(line.quantity || "0"), quotedUnitPriceMinor: quotePriceMinor(line, "quotedUnitPriceMinor"), ...(line.type === "free_text" ? { standardUnitPriceMinor: quotePriceMinor(line, "standardUnitPriceMinor") } : {}), discountBps: minor(line.discountBps), ...quoteLineTaxForSaving(line, providerTaxOptions(taxOptions.data), !taxOptions.isPending && !taxOptions.isError) })),
    expectedVersion: quote.rowVersion,
  });
  const preview = useMutation({
    mutationFn: () => request(`/api/sales/quotes${isNew ? "" : `/${id}`}?action=preview`, { method: "POST", body: JSON.stringify(payload()) }),
    onSuccess: (data) => {
      setServerTotals(data?.quote?.totals || data?.totals || data?.preview?.totals || data?.currentVersion?.totals || data);
      setSchedulePreview({ schedule: billingScheduleOf(data?.preview || data), fingerprint: JSON.stringify(form) });
    },
    onError: (error) => toast({ title: `Could not recalculate ${naming.singular}`, description: error.message, variant: "destructive" }),
  });
  const [serverTotals, setServerTotals] = useState(null);
  const isDirty = JSON.stringify(form) !== savedFingerprint;
  const save = useMutation({
    mutationFn: async () => {
      const submittedFingerprint = JSON.stringify(form);
      const data = await request(isNew ? "/api/sales/quotes" : `/api/sales/quotes/${id}`, { method: isNew ? "POST" : "PATCH", body: JSON.stringify(payload()) });
      return { data, submittedFingerprint };
    },
    onSuccess: async ({ data, submittedFingerprint }) => {
      const saved = normalizeQuote(data);
      setSavedFingerprint(submittedFingerprint);
      setServerTotals(data?.totals || data?.currentVersion?.totals || null);
      qc.invalidateQueries({ queryKey: ["sales-quotes"] });
      if (isNew && saved.id) {
        toast({ title: `Draft ${naming.singular} saved` });
        navigate(quotePath(naming, saved.id), { replace: true });
      } else {
        try {
          await refreshSavedQuoteDraft({ refetch: detail.refetch, normalize: normalizeQuote, submittedFingerprint, setForm, setSavedFingerprint });
          toast({ title: `Draft ${naming.singular} saved` });
        } catch (error) {
          toast({ title: "Draft saved, but could not reload it", description: "Your entered values have been kept. Reload the page before saving again.", variant: "destructive" });
        }
      }
    },
    onError: (error) => { if ([409, 412].includes(error.status)) detail.refetch(); toast({ title: [409, 412].includes(error.status) ? `${naming.singular} changed elsewhere` : `Could not save ${naming.singular}`, description: [409, 412].includes(error.status) ? "The latest version has been loaded. Review it before trying again." : error.message, variant: "destructive" }); },
  });
  const action = useMutation({
    mutationFn: ({ action: actionName, extra = {} }) => request(`/api/sales/quotes/${id}?action=${actionName}`, { method: "POST", body: JSON.stringify({ expectedVersion: quote.rowVersion, ...extra }) }),
    onSuccess: (data, variables) => { const result = normalizeQuote(data); qc.invalidateQueries({ queryKey: ["sales-quotes"] }); qc.invalidateQueries({ queryKey: ["sales-quote", id] }); qc.invalidateQueries({ queryKey: ["quote-history", id] }); toast({ title: variables.action === "amend" ? "Amendment created" : variables.action === "issue" ? `${naming.singular} issued` : variables.extra?.status === "accepted" ? `${naming.singular} accepted` : `${naming.singular} status updated` }); if (variables.action === "amend" && result.id) navigate(quotePath(naming, result.id)); },
    onError: (error) => toast({ title: `${naming.singular} action failed`, description: error.message, variant: "destructive" }),
  });
  const deliveryAction = useMutation({
    mutationFn: ({ action: actionName, extra = {} }) => request(`/api/sales/quotes/${id}?action=${actionName}`, { method: "POST", body: JSON.stringify(extra) }),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ["sales-quotes"] });
      qc.invalidateQueries({ queryKey: ["sales-quote", id] });
      qc.invalidateQueries({ queryKey: ["quote-delivery-history", id] });
      qc.invalidateQueries({ queryKey: ["quote-signing-requests", id] });
      if (variables.action === "send") setSendOpen(false);
      if (variables.action === "request-signature") setSendOpen(false);
      if (["send", "request-signature"].includes(variables.action)) setSigningRequest(null);
      toast({ title: variables.action === "send" ? `${naming.singular} sent` : variables.action === "request-signature" ? "Colleague signature requested" : "Customer link revoked" });
    },
    onError: (error) => toast({ title: "Delivery action failed", description: error.message, variant: "destructive" }),
  });
  const pdf = useMutation({
    mutationFn: ({ preview: shouldPreview, version = quote.versionNumber || quote.version_number || 1 }) => quotePdf(id, version).then((blob) => ({ blob, shouldPreview, version })),
    onSuccess: ({ blob, shouldPreview, version }) => openBlob(blob, `${quote.number || quote.quoteNumber || quote.quote_number || "quote"}-v${version}.pdf`, shouldPreview),
    onError: (error) => toast({ title: "Could not load PDF", description: error.message, variant: "destructive" }),
  });
  const invoiceAction = async (actionName, command = {}) => {
    const result = await request(`/api/sales/quotes/${id}?action=${actionName}`, { method: "POST", body: JSON.stringify(command) });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["sales-quote", id] }),
      qc.invalidateQueries({ queryKey: ["sales-quotes"] }),
    ]);
    return result;
  };
  if (!isNew && detail.isLoading) return <Loading />;
  if (!isNew && detail.error) return <Failure error={detail.error} retry={detail.refetch} />;
  if (!isNew && loadedId !== id) return <Loading />;
  const patch = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><Button variant="outline" size="icon" onClick={() => navigate(quotePath(naming))}><ArrowLeft className="h-4 w-4" /></Button><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-bold">{isNew ? `Create ${naming.singular}` : quote.number || quote.quoteNumber || quote.quote_number || naming.singular}</h2>{statusBadge(status)}{!isNew && <Badge variant="outline">Version {quote.versionNumber || quote.version_number || quote.version || 1}</Badge>}</div><p className="mt-1 text-sm text-slate-500">{readOnly ? "Issued versions are immutable. Create an amendment to make changes." : `Build and save a customer-ready ${naming.singular}.`}</p></div></div><div className="flex flex-wrap gap-2">
      {!readOnly && <Button variant="outline" disabled={invalidPrices || preview.isPending || (isNew && !opportunity.ready) || !form.lines.length} onClick={() => preview.mutate()}>{preview.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Recalculate</Button>}
      {!readOnly && <Button variant="outline" disabled={invalidPrices || save.isPending || !form.opportunityId || (isNew && !opportunity.ready) || !form.lines.length} onClick={() => save.mutate()}>{save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save draft</Button>}
      {!isNew && status === "draft" && allowed(["canIssue", "can_issue", "issue"], false) && <Button disabled={action.isPending || !form.lines.length || isDirty} title={isDirty ? "Save the latest draft before issuing" : "Finalise this version so it can be sent"} onClick={() => action.mutate({ action: "issue" })}><Send className="mr-2 h-4 w-4" />Issue {naming.singular}</Button>}
      {!isNew && <><Button variant="outline" disabled={pdf.isPending || isDirty} title={isDirty ? "Save your changes before generating a PDF" : ""} onClick={() => pdf.mutate({ preview: true })}><Eye className="mr-2 h-4 w-4" />{status === "draft" ? "Preview draft PDF" : "Preview PDF"}</Button><Button variant="outline" disabled={pdf.isPending || isDirty} onClick={() => pdf.mutate({ preview: false })}><Download className="mr-2 h-4 w-4" />Download PDF</Button></>}
      {!isNew && ["issued", "sent"].includes(status) && <Button disabled={deliveryAction.isPending} onClick={() => setSendOpen(true)}><Send className="mr-2 h-4 w-4" />Send</Button>}
      {!isNew && ["issued", "sent"].includes(status) && <Button variant="outline" disabled={deliveryAction.isPending} onClick={() => deliveryAction.mutate({ action: "revoke" })}><Link2Off className="mr-2 h-4 w-4" />Revoke link</Button>}
      {!isNew && !["draft", "superseded", "accepted", "converted", "declined", "rejected", "expired"].includes(status) && allowed(["canAmend", "can_amend", "amend"], false) && <Button onClick={() => action.mutate({ action: "amend" })}><RefreshCw className="mr-2 h-4 w-4" />Amend</Button>}
      {!isNew && <AcceptQuoteButton status={status} permitted={allowed(["canTransition", "can_transition", "transition"], false)} pending={action.isPending} onAccept={extra => action.mutateAsync({ action: "transition", extra })} />}
      {!isNew && status === "accepted" && allowed(["canTransition", "can_transition", "transition"], false) && <Button variant="outline" onClick={() => action.mutate({ action: "transition", extra: { status: "converted" } })}>Convert</Button>}
    </div></div>
    {!isNew && status === "draft" && <p className="rounded border bg-slate-50 p-3 text-sm">Save draft → preview the draft PDF → Issue {naming.singular} → Send. Issuing locks this version for delivery.{!allowed(["canIssue"], false) && ` Your role does not have permission to issue ${naming.plural}.`}{isDirty && " Save your latest changes first."}</p>}
    {!isNew && <SendQuoteDialog quote={quote} signingRequest={signingRequest} onRequestSignature={extra => deliveryAction.mutateAsync({ action: "request-signature", extra })} request={request} quoteId={id} version={quote.versionNumber || quote.version_number || quote.version} contacts={contacts} open={sendOpen} onOpenChange={value => { setSendOpen(value); if (!value) setSigningRequest(null); }} pending={deliveryAction.isPending} initialRecipient={signingRequest?.draft?.recipient || quote.agreement?.contact?.email || contacts.find(contact => contact.id === form.billingContactId)?.email || contacts.find(contact => contact.id === form.customerContactId)?.email || quote.recipient || quote.customerEmail || quote.customer_email || ""} onSend={(extra) => deliveryAction.mutateAsync({ action: "send", extra })} />}
    {!isNew && form.legalHtml && status !== "draft" && <AgreementSignatureRequests quoteId={id} request={request} requestedId={new URLSearchParams(location.search).get("signingRequest")} onSign={item => { setSigningRequest(item); setSendOpen(true); }} />}
    {!isNew && form.legalHtml && ["accepted", "converted"].includes(status) && <AgreementFinalizationPanel agreement={quote.agreement || detail.data?.agreement} onFinalize={() => request(`/api/sales/quotes/${id}?action=finalize-agreement`, { method: "POST", body: JSON.stringify({ version: quote.versionNumber || quote.version_number }) })} onRefresh={() => detail.refetch()} onDownload={() => pdf.mutate({ preview: false })} />}
    {!isNew && (["accepted", "converted"].includes(status) || Boolean(quote.saleId)) && <InvoiceStatusPanel scheduledBilling={quote.scheduledBilling || Boolean(quote.billingSchedule)} saleId={quote.saleId} invoice={quote.invoice} invoices={quote.invoices} activeProvider={quote.activeProvider} permissions={permissions} error={action.error} onCreate={(command) => invoiceAction("create-invoice", command)} onRetry={(command) => invoiceAction("create-invoice", command)} onRefresh={quote.invoice ? () => invoiceAction("refresh-invoice-status") : undefined} />}
    {isNew && !form.opportunityId && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Choose an active opportunity below. Its organisation, currency and primary contact will be used for this {naming.singular}.</div>}
    {form.opportunityId && opportunity.isError && <Failure error={opportunity.error} retry={opportunity.refetch} />}
    {isNew && form.opportunityId && !opportunity.ready && !opportunity.isError && <p role="status" className="animate-pulse rounded-lg bg-slate-100 p-3 text-sm text-slate-500">Loading the selected opportunity’s customer details…</p>}
    <Tabs defaultValue="quote"><TabsList><TabsTrigger value="quote">{naming.singular}</TabsTrigger>{!isNew && <><TabsTrigger value="delivery">Delivery</TabsTrigger><TabsTrigger value="history">History & compare</TabsTrigger></>}</TabsList>
      <TabsContent value="quote" className="space-y-5">
        <Card><CardHeader><CardTitle>Customer & commercial details</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Opportunity">{isNew ? <QuoteOpportunitySelect value={form.opportunityId} name={opportunityName} request={request} onChange={(value) => setForm((old) => old.opportunityId === value ? old : clearOpportunityContacts(old, value))} /> : <p className="rounded-md border bg-slate-50 px-3 py-2 text-sm">{opportunityName || (opportunity.isError ? "Opportunity unavailable" : "Loading opportunity…")}</p>}{opportunity.ready && opportunity.data?.organization?.name && <p className="mt-1 text-xs text-slate-500">{opportunity.data.organization.name}</p>}</Field>
          <Field label="Customer contact"><QuoteContactSelect label="Customer contact" contacts={contacts} value={form.customerContactId} loading={contactsLoading} error={contactsError} disabled={contactsDisabled} emptyLabel="Not selected" onChange={value => patch("customerContactId", value)} /></Field>
          <Field label="Billing contact"><QuoteContactSelect label="Billing contact" contacts={contacts} value={form.billingContactId} loading={contactsLoading} error={contactsError} disabled={contactsDisabled} emptyLabel="Same as customer" onChange={value => patch("billingContactId", value)} /></Field>
          <Field label="Event"><QuoteEventSelect disabled={readOnly} value={form.eventId} kind={form.eventKind} request={request} onChange={event => setForm(old => ({ ...old, eventId: event?.id || "", eventKind: event?.kind || "simple" }))} /></Field>
          <Field label="Issue date"><Input disabled={readOnly} type="date" value={form.issueDate} onChange={(e) => patch("issueDate", e.target.value)} /></Field>
          <Field label="Valid until"><Input disabled={readOnly} type="date" value={form.validUntil} onChange={(e) => patch("validUntil", e.target.value)} /></Field>
          <Field label="PO reference"><Input disabled={readOnly} value={form.purchaseOrderReference} onChange={(e) => patch("purchaseOrderReference", e.target.value)} /></Field>
          <Field label="Customer reference"><Input disabled={readOnly} value={form.customerReference} onChange={(e) => patch("customerReference", e.target.value)} /></Field>
          <Field label="Salesperson"><QuoteSalespersonSelect disabled={readOnly} value={form.salespersonId} snapshot={form.salesperson_snapshot || form.salesperson} onChange={value => patch("salespersonId", value)} request={request} /></Field>
          <Field label="Currency"><Input disabled={readOnly || form.lines.length > 0} maxLength={3} value={form.currency} onChange={(e) => patch("currency", e.target.value.toUpperCase())} /></Field>
          <Field label="Payment terms"><Input disabled={readOnly} value={form.paymentTerms} onChange={(e) => patch("paymentTerms", e.target.value)} /></Field>
          <Field label="Internal / customer notes" wide><Textarea disabled={readOnly} rows={3} value={form.notes} onChange={(e) => patch("notes", e.target.value)} /></Field>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Billing address snapshot</CardTitle><p className="text-sm text-slate-500">New {naming.plural} start with the organisation’s invoicing address, where available. You can change it here without changing the organisation. Free-text address lines are copied as saved; check the city, postcode and country before issuing.</p></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[["addressee", "Addressee"], ["line1", "Address line 1"], ["line2", "Address line 2 / remaining address"], ["city", "City"], ["region", "County / region"], ["postalCode", "Postcode"], ["country", "Country"]].map(([key, label]) => {
          const AddressInput = key === "line2" ? Textarea : Input;
          return <Field key={key} label={label}><AddressInput aria-label={label} disabled={readOnly || (isNew && !opportunity.ready)} value={form.address[key]} onChange={(e) => setForm((old) => ({ ...old, address: { ...old.address, [key]: e.target.value } }))} /></Field>;
        })}</CardContent></Card>
        <LinesEditor form={form} setForm={setForm} products={list(products.data)} bundles={list(bundles.data)} readOnly={readOnly} canOverride={canOverride} />
        <QuoteBillingSettings form={form} setForm={setForm} readOnly={readOnly} />
        <Card><CardHeader><CardTitle>Agreement terms and signatures</CardTitle><p className="text-sm text-muted-foreground">Review the quote first, add legal terms, then save and issue this version before signing and sending.</p></CardHeader><CardContent className="space-y-5"><AgreementLegalEditor value={form.legalHtml} onChange={value => patch("legalHtml", value)} disabled={readOnly} fields={[{ label: "Customer", value: form.address.addressee }, { label: "Payment terms", value: form.paymentTerms }, { label: "Customer reference", value: form.customerReference }]} />{form.legalHtml && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-semibold">Full agreement preview{isDirty ? " · Unsaved draft" : ""}</summary><div className="mt-4"><AgreementDocument draft={isDirty || isNew} quote={isDirty || isNew ? { ...form, totals: { netMinor: totals.net, taxMinor: totals.tax, grossMinor: totals.gross } } : quote} sender={quote.agreement?.sender} recipient={quote.agreement?.customer || quote.agreement?.contact} /></div></details>}</CardContent></Card>
        {form.scheduledBilling && <BillingSchedule schedule={isDirty ? schedulePreview?.schedule || form.billingSchedule : quote.billingSchedule || schedulePreview?.schedule} pending={isDirty && schedulePreview?.fingerprint !== JSON.stringify(form)} />}
        {form.scheduledBilling && !form.billingSchedule && !schedulePreview?.schedule && <p className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-slate-600">Recalculate to preview group contents, exact amounts and relative issue dates before acceptance. The server derives the schedule from this version’s line economics.</p>}
        <Card><CardContent className="flex flex-col items-end gap-1 p-5 text-sm"><p className="mb-2 w-full text-xs text-slate-500">{serverTotals ? "Server-calculated totals" : "Local estimate — save or recalculate for final server totals"}</p><div className="flex w-full max-w-xs justify-between"><span>Net</span><strong>{money(serverTotals?.netMinor ?? serverTotals?.net_minor ?? serverTotals?.netTotalMinor ?? serverTotals?.net_total_minor ?? totals.net, form.currency)}</strong></div><div className="flex w-full max-w-xs justify-between"><span>Tax</span><strong>{money(serverTotals?.taxMinor ?? serverTotals?.tax_minor ?? serverTotals?.taxTotalMinor ?? serverTotals?.tax_total_minor ?? totals.tax, form.currency)}</strong></div><div className="mt-2 flex w-full max-w-xs justify-between border-t pt-2 text-lg"><span>Gross total</span><strong>{money(serverTotals?.grossMinor ?? serverTotals?.gross_minor ?? serverTotals?.grossTotalMinor ?? serverTotals?.gross_total_minor ?? totals.gross, form.currency)}</strong></div></CardContent></Card>
      </TabsContent>
      {!isNew && <TabsContent value="delivery"><DeliveryHistory quoteId={id} /></TabsContent>}
      {!isNew && <TabsContent value="history" className="space-y-4"><QuoteVersionDocuments versions={uniqueQuoteVersions(detail.data?.versions || [])} currentVersion={quote.versionNumber || quote.version_number || quote.version} onPdf={pdf.mutate} pending={pdf.isPending} dirty={isDirty} /><HistoryPanel quoteId={id} version={quote.versionNumber || quote.version_number || quote.version} versions={detail.data?.versions || []} /></TabsContent>}
    </Tabs>
  </div>;
}

function Loading() { return <div className="grid min-h-48 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /></div>; }
function Failure({ error, retry }) { return <Card className="border-rose-200"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-rose-700"><span><AlertTriangle className="mr-2 inline h-4 w-4" />{error.message}</span><Button variant="outline" onClick={() => retry()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></CardContent></Card>; }

export default function QuotesWorkspace() {
  const { id } = useParams();
  const scope = useSalesSettingsScope();
  return id ? <QuoteEditor key={`${id}-${scope.scopeKey}`} /> : <QuotesList />;
}