import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, XCircle } from "lucide-react";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const pick = (value, camel, snake, fallback = "") => value?.[camel] ?? value?.[snake] ?? fallback;
const items = (value) => Array.isArray(value) ? value : value?.items || value?.data || [];
const currencyText = (value, currency = "GBP") => {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Math.round(Number(value || 0)) / 100); }
  catch { return `${currency} ${(Math.round(Number(value || 0)) / 100).toFixed(2)}`; }
};
const dateText = (value) => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "long" }) : "—";
const outcomeKey = (value) => String(value || "").replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();

async function publicRequest(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

const outcomeCopy = {
  expired: ["This quote has expired", "The secure link is no longer valid. Please contact the sender for a new quote."],
  revoked: ["This link has been revoked", "Please contact the sender if you still need to review this quote."],
  superseded: ["A newer quote is available", "This version was superseded and can no longer be accepted."],
  declined: ["Quote declined", "Your decision has been recorded. No further action is needed."],
  already_declined: ["Quote already declined", "A decline has already been recorded for this quote. No further action is needed."],
  rejected: ["Quote declined", "Your decision has been recorded. No further action is needed."],
  accepted: ["Quote already accepted", "Acceptance has been recorded and this quote cannot be accepted again."],
  already_accepted: ["Quote already accepted", "Acceptance has already been recorded for this quote. No further action is needed."],
  converted: ["Quote already accepted", "This quote has already progressed to a confirmed sale."],
  capacity_conflict: ["Availability has changed", "We could not complete acceptance because one or more items no longer have enough capacity. Please contact the sender."],
  conflict: ["This quote could not be accepted", "The quote may already have been actioned, or availability may have changed. Refresh the link or contact the sender."],
};

function Outcome({ status, message }) {
  const copy = outcomeCopy[status] || ["Quote unavailable", message || "This quote cannot currently be viewed or actioned."];
  const positive = ["accepted", "already_accepted", "converted"].includes(status);
  const Icon = positive ? CheckCircle2 : ["declined", "already_declined", "rejected"].includes(status) ? XCircle : AlertTriangle;
  return <Card className="mx-auto max-w-xl text-center"><CardContent className="px-6 py-12"><Icon className={`mx-auto h-12 w-12 ${positive ? "text-emerald-600" : "text-amber-600"}`} /><h1 className="mt-5 text-2xl font-bold text-slate-950">{copy[0]}</h1><p className="mt-2 text-slate-600">{message || copy[1]}</p></CardContent></Card>;
}

function DecisionForm({ decision, pending, onSubmit, onCancel }) {
  const [form, setForm] = useState({ name: "", role: "", purchaseOrderReference: "", customerReference: "", declineReason: "", agreement: false });
  const patch = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const accepting = decision === "accept";
  return <Card className={accepting ? "border-emerald-200" : "border-rose-200"}><CardHeader><CardTitle>{accepting ? "Accept quote" : "Decline quote"}</CardTitle></CardHeader><CardContent className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <div><Label htmlFor={`${decision}-name`}>Your name</Label><Input id={`${decision}-name`} value={form.name} onChange={(event) => patch("name", event.target.value)} /></div>
      <div><Label htmlFor={`${decision}-role`}>Role / job title</Label><Input id={`${decision}-role`} value={form.role} onChange={(event) => patch("role", event.target.value)} /></div>
      <div><Label htmlFor={`${decision}-po`}>Purchase order reference (optional)</Label><Input id={`${decision}-po`} value={form.purchaseOrderReference} onChange={(event) => patch("purchaseOrderReference", event.target.value)} /></div>
      <div><Label htmlFor={`${decision}-reference`}>Customer reference (optional)</Label><Input id={`${decision}-reference`} value={form.customerReference} onChange={(event) => patch("customerReference", event.target.value)} /></div>
    </div>
    {accepting && <label className="flex items-start gap-3 rounded-lg bg-slate-50 p-4 text-sm"><Checkbox checked={form.agreement} onCheckedChange={(value) => patch("agreement", value === true)} /><span>I confirm that I am authorised to accept this quote and agree to its prices, terms, and conditions.</span></label>}
    {!accepting && <div><Label htmlFor="decline-reason">Reason (optional)</Label><Textarea id="decline-reason" value={form.declineReason} onChange={(event) => patch("declineReason", event.target.value)} placeholder="Tell the sender why you are declining" /></div>}
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" onClick={onCancel}>Cancel</Button><Button variant={accepting ? "default" : "destructive"} disabled={pending || !form.name.trim() || !form.role.trim() || (accepting && !form.agreement)} onClick={() => onSubmit(form)}>{pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{accepting ? "Confirm acceptance" : "Confirm decline"}</Button></div>
  </CardContent></Card>;
}

export default function PublicSalesQuote() {
  const { token } = useParams();
  const [decision, setDecision] = useState("");
  const [result, setResult] = useState(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const path = `/api/public/sales-quote/${encodeURIComponent(token || "")}`;
  const query = useQuery({ queryKey: ["public-sales-quote", token], queryFn: () => publicRequest(path), retry: false });
  const submit = useMutation({
    mutationFn: (form) => publicRequest(`${path}/${decision}`, {
      method: "POST",
      body: JSON.stringify({
        decision: decision === "accept" ? "accepted" : "declined",
        name: form.name.trim(),
        role: form.role.trim(),
        purchaseOrderReference: form.purchaseOrderReference.trim() || null,
        customerReference: form.customerReference.trim() || null,
        declineReason: decision === "decline" ? form.declineReason.trim() || null : null,
        agreement: decision === "accept" && form.agreement === true,
        idempotencyKey,
      }),
    }),
    onSuccess: (data) => setResult(data),
  });
  const root = query.data?.data || query.data || {};
  const quoteRoot = root.quote || root.salesQuote || root.sales_quote || root;
  const snapshot = quoteRoot.snapshot || quoteRoot.currentVersion || quoteRoot.current_version || quoteRoot.version || quoteRoot;
  const quote = { ...quoteRoot, ...snapshot };
  const branding = root.tenant || root.branding || quote.branding || {};
  const lines = items(quote.lines || quote.lineItems || quote.line_items);
  const totals = quote.totals || {};
  const currency = quote.currency || "GBP";
  const status = outcomeKey(result?.status || result?.outcome || (result ? (decision === "accept" ? "accepted" : "declined") : "") || quote.linkStatus || quote.link_status || quote.status);
  const decisionErrorStatus = outcomeKey(submit.error?.payload?.outcome || submit.error?.payload?.status || submit.error?.payload?.code);
  const actionable = ["issued", "sent", "viewed", ""].includes(status);
  const address = quote.address || quote.addressSnapshot || quote.address_snapshot || {};
  const primary = branding.primaryColor || branding.primary_color || "#2563eb";
  const total = useMemo(() => totals.grossMinor ?? totals.gross_minor ?? quote.grossMinor ?? quote.gross_minor ?? quote.grossTotalMinor ?? quote.gross_total_minor ?? lines.reduce((sum, line) => sum + Number(line.grossMinor ?? line.gross_minor ?? 0), 0), [lines, quote, totals]);

  if (query.isLoading) return <main className="grid min-h-screen place-items-center bg-slate-50"><Loader2 className="h-9 w-9 animate-spin text-blue-600" /></main>;
  if (query.error) {
    const errorStatus = outcomeKey(query.error.payload?.outcome || query.error.payload?.status || query.error.payload?.code || (query.error.status === 410 ? "expired" : "unavailable"));
    return <main className="min-h-screen bg-slate-50 px-4 py-16"><Outcome status={errorStatus} message={query.error.message} /></main>;
  }
  if (outcomeCopy[decisionErrorStatus]) return <main className="min-h-screen bg-slate-50 px-4 py-16"><Outcome status={decisionErrorStatus} message={submit.error.message} /></main>;
  if (!actionable || result) return <main className="min-h-screen bg-slate-50 px-4 py-16"><Outcome status={status} message={result?.message} /></main>;

  return <main className="min-h-screen bg-slate-100">
    <header className="border-b bg-white"><div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">{(branding.logoUrl || branding.logo_url) ? <img src={branding.logoUrl || branding.logo_url} referrerPolicy="no-referrer" alt={branding.name || "Organisation"} className="h-10 max-w-40 object-contain" /> : <div className="grid h-10 w-10 place-items-center rounded-lg text-white" style={{ backgroundColor: primary }}><FileText className="h-5 w-5" /></div>}<span className="truncate font-semibold text-slate-900">{branding.name || quote.sellerName || quote.seller_name || "Sales quote"}</span></div>
      <Button asChild variant="outline"><a href={`${path}/download`} download><Download className="mr-2 h-4 w-4" />PDF</a></Button>
    </div></header>
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <Card><CardContent className="p-5 sm:p-8">
        <div className="flex flex-col justify-between gap-5 border-b pb-6 sm:flex-row"><div><p className="text-sm font-semibold uppercase tracking-wider" style={{ color: primary }}>Quote</p><h1 className="mt-1 text-2xl font-bold text-slate-950 sm:text-3xl">{quote.number || quote.quoteNumber || quote.quote_number || "Sales quote"}</h1><Badge className="mt-3">Version {quote.versionNumber || quote.version_number || 1}</Badge></div><dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm"><dt className="text-slate-500">Issued</dt><dd>{dateText(pick(quote, "issueDate", "issue_date"))}</dd><dt className="text-slate-500">Valid until</dt><dd>{dateText(pick(quote, "validUntil", "valid_until"))}</dd></dl></div>
        <div className="grid gap-5 border-b py-6 sm:grid-cols-2"><div><p className="text-xs font-semibold uppercase text-slate-500">Prepared for</p><p className="mt-2 font-semibold">{quote.customerName || quote.customer_name || quote.organisationName || quote.organisation_name || quote.organisation?.name || address.addressee || "Customer"}</p>{[address.line1 || address.line_1, address.line2 || address.line_2, address.city, address.region, address.postalCode || address.postal_code, address.country].filter(Boolean).map((part) => <p key={part} className="text-sm text-slate-600">{part}</p>)}</div><div><p className="text-xs font-semibold uppercase text-slate-500">References</p><p className="mt-2 text-sm">PO: {pick(quote, "purchaseOrderReference", "purchase_order_reference", "—")}</p><p className="text-sm">Customer: {pick(quote, "customerReference", "customer_reference", "—")}</p></div></div>
        <div className="-mx-5 overflow-x-auto sm:-mx-8"><table className="w-full min-w-[620px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-5 py-3 sm:px-8">Description</th><th className="px-3 py-3 text-right">Qty</th><th className="px-3 py-3 text-right">Unit price</th><th className="px-5 py-3 text-right sm:px-8">Total</th></tr></thead><tbody>{lines.map((line, index) => <tr key={line.id || index} className="border-t"><td className="px-5 py-4 sm:px-8"><strong>{line.description || line.name || "Item"}</strong>{line.detail && <p className="text-xs text-slate-500">{line.detail}</p>}</td><td className="px-3 py-4 text-right">{line.quantity}</td><td className="px-3 py-4 text-right">{currencyText(line.quotedUnitPriceMinor ?? line.quoted_unit_price_minor ?? line.unitPriceMinor ?? line.unit_price_minor, currency)}</td><td className="px-5 py-4 text-right font-semibold sm:px-8">{currencyText(line.grossMinor ?? line.gross_minor ?? line.totalMinor ?? line.total_minor, currency)}</td></tr>)}</tbody></table></div>
        <div className="ml-auto mt-6 max-w-sm space-y-2 text-sm"><div className="flex justify-between"><span>Net</span><span>{currencyText(totals.netMinor ?? totals.net_minor ?? quote.netMinor ?? quote.net_minor ?? quote.netTotalMinor ?? quote.net_total_minor, currency)}</span></div><div className="flex justify-between"><span>Tax</span><span>{currencyText(totals.taxMinor ?? totals.tax_minor ?? quote.taxMinor ?? quote.tax_minor ?? quote.taxTotalMinor ?? quote.tax_total_minor, currency)}</span></div><div className="flex justify-between border-t pt-3 text-xl font-bold"><span>Total</span><span>{currencyText(total, currency)}</span></div></div>
        {(quote.terms || quote.paymentTerms || quote.payment_terms || quote.notes) && <div className="mt-8 rounded-lg bg-slate-50 p-4"><p className="font-semibold">Terms</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{typeof quote.terms === "string" ? quote.terms : quote.terms?.text || quote.terms?.paymentTerms || quote.terms?.payment_terms || quote.paymentTerms || quote.payment_terms || ""}{quote.notes ? `\n\n${quote.notes}` : ""}</p></div>}
      </CardContent></Card>
      {submit.error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertTriangle className="mr-2 inline h-4 w-4" />{submit.error.message}</div>}
      {decision ? <DecisionForm decision={decision} pending={submit.isPending} onCancel={() => setDecision("")} onSubmit={(form) => submit.mutate(form)} /> : <div className="flex flex-col gap-3 sm:flex-row sm:justify-end"><Button size="lg" variant="outline" className="border-rose-300 text-rose-700" onClick={() => setDecision("decline")}>Decline</Button><Button size="lg" style={{ backgroundColor: primary }} onClick={() => setDecision("accept")}>Accept quote</Button></div>}
    </div>
  </main>;
}